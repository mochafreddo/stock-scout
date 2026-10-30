import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run as runCandidate } from './candidate-cli-helper.mjs';

const run = (t, scenario = 'ok', env = {}, args) =>
  runCandidate(t, scenario, env, args, 'buy-candidates');

test('failed review exposes linked recommendation round trips, daily reads and validation without raw data', (t) => {
  const result = run(t, 'review-late-error');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const { observation, usage, error } = JSON.parse(result.stderr);
  assert.equal(error, 'MODEL_INCOMPLETE');
  assert.equal(usage.recommendationModel, 3);
  const operations = observation.operations;
  const recommendation = operations.find((row) => row.name === 'recommendation');
  assert.ok(recommendation);
  const model = operations.find((row) => row.name === 'recommendation.model');
  assert.equal(model.parentId, recommendation.id);
  assert.equal(model.status, 'completed');
  const requests = operations.filter((row) => row.name === 'recommendation.model.http');
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.parentId, model.id);
    assert.equal(request.kind, 'request');
    assert.equal(request.httpStatus, 200);
    assert.equal(request.completionEvents, 1);
    assert.equal(request.errorEvents, 0);
    assert.equal(request.streamEnd, 'eof');
    assert.equal(request.status, 'completed');
    assert.notEqual(request.headersAt, null);
    assert.notEqual(request.firstEventAt, null);
    assert.notEqual(request.lastEventAt, null);
  }
  const tool = operations.find((row) => row.name === 'recommendation.tool');
  assert.equal(tool.parentId, requests[0].id);
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.status, 'completed');
  const validation = operations.find((row) => row.name === 'recommendation.validation');
  assert.equal(validation.parentId, model.id);
  assert.equal(validation.status, 'completed');
  const review = operations.find((row) => row.name === 'review');
  assert.equal(review.parentId, recommendation.id);
  const reviewRequest = operations.find((row) => row.name === 'review.model.http');
  assert.equal(reviewRequest.parentId, review.id);
  assert.equal(reviewRequest.completionEvents, 1);
  assert.equal(reviewRequest.errorEvents, 1);
  assert.equal(reviewRequest.status, 'failed');
  assert.equal(observation.firstFailure.operationId, reviewRequest.id);
  assert.equal(observation.finalError.operationId, reviewRequest.id);
  assert.doesNotMatch(JSON.stringify(observation), /synthetic|NAS:AAPL|observations|"123"|Bearer/);
});

test('recommendation and review header stalls preserve actual stage and target cancellation sources', (t) => {
  for (const [scenario, abort, expected, source, requests] of [
    ['report-header-stall', 'stage', 'MODEL_INCOMPLETE', 'stage_limit', 1],
    ['review-header-stall', 'stage', 'MODEL_INCOMPLETE', 'stage_limit', 3],
    ['report-header-stall', 'target', 'TARGET_OPEN', 'target_open', 1],
    ['report-header-stall', 'execution', 'EXECUTION_LIMIT', 'execution_limit', 1],
  ]) {
    const result = run(t, scenario, {
      REPORT_ABORT: abort,
      ...(abort === 'target' ? { TEST_NOW: '2026-10-19T13:29:59Z' } : {}),
      ...(abort === 'execution' ? { TYPE_BEFORE_MS: '450000' } : {}),
    });
    assert.equal(result.status, 1, `${scenario}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    const output = JSON.parse(result.stderr);
    assert.equal(output.error, expected);
    assert.equal(output.usage.recommendationModel, requests);
    const request = output.observation.operations.findLast((row) =>
      ['recommendation.model.http', 'review.model.http'].includes(row.name),
    );
    assert.ok(request, result.stderr);
    assert.equal(request.httpStatus, 200);
    assert.equal(request.firstEventAt, null);
    assert.equal(request.completionEvents, 0);
    assert.equal(request.streamEnd, 'cancelled');
    assert.equal(request.cancellationSource, source);
    assert.equal(request.status, 'failed');
    if (abort === 'stage') {
      assert.equal(request.elapsedMs, 180000);
      assert.equal(request.endedAt - request.headersAt, 180000);
    }
    assert.equal(output.observation.finalError.operationId, request.id);
    assert.ok(result.requests.some((row) => row.streamAborted || row.streamCancelled));
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-subscription|test-secret/);
  }
});

test('daily tool and candidate validation failures retain their own operation and completed HTTP state', (t) => {
  const tool = run(t, 'report-outside-tool');
  const toolOutput = JSON.parse(tool.stderr);
  assert.equal(tool.status, 1, tool.stderr);
  assert.equal(tool.stdout, '');
  const failedTool = toolOutput.observation.operations.find(
    (row) => row.name === 'recommendation.tool',
  );
  assert.equal(failedTool.status, 'failed');
  assert.equal(failedTool.failure.code, 'MODEL_OUTPUT');
  assert.equal(toolOutput.observation.firstFailure.operationId, failedTool.id);
  assert.equal(toolOutput.observation.finalError.operationId, failedTool.id);
  const invalid = run(t, 'ok', {
    REPORT_VALUE: JSON.stringify({ candidates: [], noCandidatesReason: null }),
  });
  assert.equal(invalid.status, 1, invalid.stderr);
  const output = JSON.parse(invalid.stderr);
  const validation = output.observation.operations.find(
    (row) => row.name === 'recommendation.validation',
  );
  assert.equal(validation.status, 'failed');
  assert.equal(output.observation.finalError.operationId, validation.id);
  for (const request of output.observation.operations.filter(
    (row) => row.name === 'recommendation.model.http',
  )) {
    assert.equal(request.streamEnd, 'eof');
    assert.equal(request.status, 'completed');
    assert.equal(request.failure, null);
  }
  assert.equal(output.usage.recommendationModel, 2);
  assert.ok(!output.observation.operations.some((row) => row.name === 'review'));
});

test('request records distinguish missing and duplicate completion, provider failure, EOF and read errors after completion', (t) => {
  for (const [scenario, completions, errors, end, code] of [
    ['report-eof', 0, 0, 'eof', 'MODEL_INCOMPLETE'],
    ['report-duplicate-completion', 2, 0, null, 'MODEL_INCOMPLETE'],
    ['report-incomplete', 0, 1, null, 'MODEL_INCOMPLETE'],
    ['report-late-error', 1, 1, null, 'MODEL_INCOMPLETE'],
    ['report-body-error', 1, 0, 'read_error', 'MODEL_FAILED'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, `${scenario}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    const output = JSON.parse(result.stderr);
    assert.equal(output.error, code, scenario);
    const request = output.observation.operations.findLast(
      (row) => row.name === 'recommendation.model.http',
    );
    assert.equal(request.completionEvents, completions, scenario);
    assert.equal(request.errorEvents, errors, scenario);
    if (end) assert.equal(request.streamEnd, end, scenario);
    assert.equal(request.status, 'failed', scenario);
    assert.equal(output.observation.firstFailure.operationId, request.id, scenario);
    assert.equal(output.observation.finalError.operationId, request.id, scenario);
    assert.equal(
      output.observation.firstFailure.code,
      scenario === 'report-body-error' ? 'unknown' : 'MODEL_INCOMPLETE',
    );
    assert.equal(output.usage.recommendationModel, 2);
    assert.doesNotMatch(
      JSON.stringify(output.observation),
      /synthetic|private-transport|test-secret/,
    );
  }
});

test('observation failures preserve recommendation success, failed review and request counts', (t) => {
  const normal = run(t);
  assert.equal(normal.status, 0, normal.stderr);
  for (const env of [
    { TEST_OBSERVATION_ID_FAILURE: '1' },
    { TEST_OBSERVATION_SERIALIZATION_FAILURE: '1' },
  ]) {
    const success = run(t, 'ok', env);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stdout, normal.stdout);
    assert.equal(success.stderr, '');
    const failed = run(t, 'review-late-error', env);
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(failed.stdout, '');
    const output = JSON.parse(failed.stderr);
    assert.equal(output.error, 'MODEL_INCOMPLETE');
    assert.equal(output.usage.recommendationModel, 3);
    assert.equal(output.observation.degraded, true);
    assert.doesNotMatch(failed.stderr, /synthetic-subscription|test-secret/);
  }
});

test('buy CLI preserves shared type deadline diagnostics before recommending', (t) => {
  const result = run(t, 'type-limit', { TYPE_BEFORE_MS: '31' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const output = JSON.parse(result.stderr);
  assert.equal(output.error, 'MODEL_INCOMPLETE');
  assert.equal(output.diagnostic.elapsedMs, 180031);
  assert.equal(output.diagnostic.typeAssessment.cause, 'deadline_exceeded');
  assert.equal(output.diagnostic.typeAssessment.statistics.elapsedMs, 180000);
  assert.equal(output.usage.recommendationModel, 0);
});

test('buy CLI preserves unstarted and completed type measurements across other failures', (t) => {
  const input = run(t, 'ok', {}, []);
  assert.equal(input.status, 1, input.stderr);
  assert.deepEqual(JSON.parse(input.stderr).diagnostic.typeAssessment, {
    statistics: {
      status: 'not_started',
      elapsedMs: null,
      modelRequests: 0,
      infoToolCalls: 0,
      observedWebToolCalls: 0,
    },
    cause: 'unknown',
    lastProgress: 'not_started',
    requests: [],
  });
  assert.equal(input.requests.length, 0);
  const report = run(t, 'report-incomplete');
  assert.equal(report.status, 1, report.stderr);
  assert.equal(report.stdout, '');
  const type = JSON.parse(report.stderr).diagnostic.typeAssessment;
  assert.equal(type.statistics.status, 'completed');
  assert.equal(type.cause, 'unknown');
  assert.equal(type.requests[0].status, 'completed');
});

test('buy report uses verified completed KIS data through a namespaced tool and prints one grounded candidate', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'buy_candidates');
  assert.equal(output.dataSession.date, '2026-10-16');
  assert.equal(output.targetSession.date, '2026-10-19');
  assert.equal(output.candidates.length, 1);
  const candidate = output.candidates[0];
  assert.equal(candidate.symbol, 'AAPL');
  assert.equal(candidate.companyName, 'Apple');
  assert.equal(candidate.referenceClose.value, '11');
  assert.equal(candidate.referenceClose.date, '2026-10-16');
  assert.equal(candidate.evidence[0].value, '123');
  assert.equal(candidate.evidence[0].field, 'tvol');
  assert.equal(candidate.observation.sessions, 3);
  assert.equal(output.fractionalTrading.status, 'unverified');
  assert.equal(output.sourceUniverse.calendar.noticeCompleteness, 'unverified');
  assert.equal(output.usage.recommendationModel, 3);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /test-secret|test-token|synthetic-subscription/,
  );
});

test('valid no-candidates is normal completion and an unsupported news story is rejected after review', (t) => {
  const empty = run(t, 'report-none');
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).status, 'no_candidates');
  assert.equal(JSON.parse(empty.stdout).candidates.length, 0);
  assert.ok(JSON.parse(empty.stdout).noCandidatesReason);
  const news = run(t, 'report-news');
  assert.equal(news.status, 1, news.stderr);
  assert.equal(news.stdout, '');
  assert.equal(JSON.parse(news.stderr).error, 'REPORT_UNSUPPORTED');
  assert.equal(JSON.parse(news.stderr).stage, 'report_review');
});

test('every recommendation response, including tool steps, must explicitly complete with no later error', (t) => {
  for (const scenario of [
    'report-eof',
    'report-incomplete',
    'report-late-error',
    'report-duplicate-completion',
    'report-missing-tool-completion',
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, `${scenario}: ${result.stderr}`);
    assert.equal(result.stdout, '', scenario);
    assert.equal(JSON.parse(result.stderr).error, 'MODEL_INCOMPLETE', scenario);
  }
});

test('recommendation budgets, session open, authentication, quota and outside-universe tools fail without partial output or paid fallback', (t) => {
  for (const [scenario, expected] of [
    ['report-time', 'MODEL_INCOMPLETE'],
    ['report-execution-time', 'EXECUTION_LIMIT'],
    ['report-open', 'TARGET_OPEN'],
    ['report-loop', 'MODEL_LIMIT'],
    ['report-auth', 'AUTH_FAILED'],
    ['report-quota', 'SUBSCRIPTION_LIMIT'],
    ['report-outside-tool', 'MODEL_OUTPUT'],
    ['report-sensitive', 'SENSITIVE_OUTPUT'],
  ]) {
    const result = run(t, scenario, { OPENAI_API_KEY: 'synthetic-paid-key' });
    assert.equal(result.status, 1, `${scenario}: ${result.stderr}`);
    assert.equal(result.stdout, '', scenario);
    assert.equal(JSON.parse(result.stderr).error, expected, scenario);
    const requests = result.requests.filter((r) =>
      r.body?.input?.some(
        (i) =>
          i.role === 'user' &&
          ['recommendation', 'report_review'].includes(JSON.parse(i.content[0].text).stage),
      ),
    );
    assert.ok(requests.length <= 4);
    assert.equal(JSON.parse(result.stderr).usage.recommendationModel, requests.length);
    assert.equal(JSON.parse(result.stderr).usage.typeModel, 1);
    assert.doesNotMatch(JSON.stringify(result.requests), /synthetic-paid-key/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /synthetic-subscription|synthetic-paid-key|test-secret/,
    );
  }
});

const candidate = {
  securityId: 'NAS:AAPL',
  reason: '완료 일봉을 바탕으로 검토합니다.',
  evidence: [{ observationId: 'NAS:AAPL:2026-10-16:tvol', explanation: '확인한 거래량입니다.' }],
  observationSessions: 3,
  observationReason: '다음 몇 세션의 흐름을 관찰합니다.',
  risks: ['수정주가를 반영하지 않습니다.'],
};

test('at most five distinct eligible securities can be recommended from the six original ranking slots', (t) => {
  const five = run(t, 'ok', { REPORT_COUNT: '5' });
  assert.equal(five.status, 0, five.stderr);
  assert.equal(JSON.parse(five.stdout).candidates.length, 5);
  const six = run(t, 'ok', { REPORT_COUNT: '6' });
  assert.equal(six.status, 1, six.stderr);
  assert.equal(six.stdout, '');
  assert.equal(JSON.parse(six.stderr).error, 'MODEL_OUTPUT');
});

test('missing fields, malformed prose, invented or cross-security observations and duplicate selections are rejected', (t) => {
  const missing = { ...candidate };
  delete missing.observationReason;
  const values = [
    { candidates: [missing], noCandidatesReason: null },
    { candidates: [{ ...candidate, reason: '' }], noCandidatesReason: null },
    { candidates: [{ ...candidate, risks: [] }], noCandidatesReason: null },
    { candidates: [{ ...candidate, observationSessions: 0 }], noCandidatesReason: null },
    { candidates: [{ ...candidate, observationSessions: 21 }], noCandidatesReason: null },
    { candidates: [{ ...candidate, referenceClose: 999 }], noCandidatesReason: null },
    { candidates: [{ ...candidate, securityId: 'NAS:OUTSIDE' }], noCandidatesReason: null },
    {
      candidates: [
        {
          ...candidate,
          evidence: [{ observationId: 'NAS:AAPL:2026-10-19:clos', explanation: '진행 중인 날짜' }],
        },
      ],
      noCandidatesReason: null,
    },
    {
      candidates: [
        {
          ...candidate,
          evidence: [{ observationId: 'NYS:BBDO:2026-10-16:clos', explanation: '다른 증권' }],
        },
      ],
      noCandidatesReason: null,
    },
    { candidates: [candidate, candidate], noCandidatesReason: null },
    { candidates: [], noCandidatesReason: null },
    { candidates: [candidate], noCandidatesReason: '선정 결과와 불일치' },
  ];
  for (const value of values) {
    const result = run(t, 'ok', { REPORT_VALUE: JSON.stringify(value) });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'MODEL_OUTPUT');
  }
  const unread = run(t, 'report-skipped-tools');
  assert.equal(unread.status, 1, unread.stderr);
  assert.equal(unread.stdout, '');
  assert.equal(JSON.parse(unread.stderr).error, 'MODEL_OUTPUT');
});

test('the report CLI preserves empty-universe, analysis-insufficient, data-readiness and input failure contracts', (t) => {
  const empty = run(t, 'all-excluded');
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).status, 'no_candidates');
  assert.equal(JSON.parse(empty.stdout).sourceUniverse.status, 'empty_candidate_universe');
  for (const [scenario, code, status] of [
    ['all-unknown', 'ANALYSIS_INSUFFICIENT', 2],
    ['daily-missing', 'DATA_NOT_READY', 1],
    ['candidate-final-open', 'TARGET_OPEN', 1],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, code);
    assert.equal(JSON.parse(result.stderr).usage.recommendationModel, 0);
  }
  const input = run(t, 'ok', {}, ['--now', '2026-10-18']);
  assert.equal(input.status, 1);
  assert.equal(JSON.parse(input.stderr).error, 'USAGE');
  assert.deepEqual(input.requests, []);
});

test('semantic review must also complete without an error after a valid report JSON', (t) => {
  for (const scenario of ['review-eof', 'review-late-error']) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'MODEL_INCOMPLETE');
    assert.equal(JSON.parse(result.stderr).stage, 'report_review');
  }
});

test('the same completed observation cannot be counted twice as supporting evidence', (t) => {
  const result = run(t, 'ok', {
    REPORT_VALUE: JSON.stringify({
      candidates: [{ ...candidate, evidence: [candidate.evidence[0], candidate.evidence[0]] }],
      noCandidatesReason: null,
    }),
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'MODEL_OUTPUT');
});

test('SDK-rejected tool names and malformed arguments fail even alongside a successful daily tool call', (t) => {
  for (const scenario of ['report-unknown-tool', 'report-invalid-tool-json']) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'MODEL_OUTPUT');
  }
});

test('no eligible security may be skipped even when every selected candidate has valid read evidence', (t) => {
  const result = run(t, 'report-partial-tools');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'MODEL_OUTPUT');
});

test('a report started one second before the target open fails at open without exhausting 600 seconds', (t) => {
  const result = run(t, 'report-open', { TEST_NOW: '2026-10-19T13:29:59Z' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'TARGET_OPEN');
});
