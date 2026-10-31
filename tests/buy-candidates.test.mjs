import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run as runCandidate } from './candidate-cli-helper.mjs';

const run = (t, scenario = 'ok', env = {}, args) =>
  runCandidate(t, scenario, env, args, 'buy-candidates');

test('stage-specific model overrides reach the selected HTTP stages and public provenance', (t) => {
  const result = run(t, 'ok', { TEST_REPORT_MODEL: 'gpt-6.1-sol' }, (directory) => [
    '--auth-dir',
    directory,
    '--model',
    'gpt-6.1-sol',
    '--calendar-model',
    'calendar-test',
    '--type-model',
    'gpt-6-luna',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const requests = result.requests.filter((row) => row.url.endsWith('/responses'));
  assert.deepEqual(
    requests.map((row) => row.body.model),
    ['calendar-test', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-6.1-sol'],
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.sourceUniverse.calendar.noticeAssessment.model, 'calendar-test');
  assert.equal(report.sourceUniverse.typeAssessment.model.id, 'gpt-6-luna');
  assert.equal(report.model.id, 'gpt-6.1-sol');
});

test('stage-specific model inputs reject missing values before any external request', (t) => {
  for (const overrides of [
    ['--calendar-model', '--type-model'],
    ['--type-model'],
    ['--calendar-model', 'bad model'],
    ['--type-model', 'a'.repeat(101)],
    ['--type-model', 'first', '--type-model', 'second'],
  ]) {
    const result = run(t, 'ok', {}, (directory) => [
      '--auth-dir',
      directory,
      '--model',
      'gpt-6-luna',
      ...overrides,
    ]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error, 'USAGE');
    assert.equal(result.stdout, '');
    assert.equal(result.requests.length, 0);
  }
});

test('unspecified stage models retain the required default model', (t) => {
  for (const [overrides, expected] of [
    [
      ['--calendar-model', 'calendar-test'],
      ['calendar-test', 'gpt-6-luna'],
    ],
    [
      ['--type-model', 'types-test'],
      ['gpt-6-luna', 'types-test'],
    ],
  ]) {
    const result = run(t, 'ok', {}, (directory) => [
      '--auth-dir',
      directory,
      '--model',
      'gpt-6-luna',
      ...overrides,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.requests.filter((row) => row.url.endsWith('/responses')).map((row) => row.body.model),
      [...expected, 'gpt-6-luna', 'gpt-6-luna', 'gpt-6-luna'],
    );
  }
});

test('the shared execution deadline stops a multi-security tool after its first KIS response', (t) => {
  const result = run(t, 'type-batch-execution');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const output = JSON.parse(result.stderr);
  assert.equal(output.error, 'EXECUTION_LIMIT');
  assert.equal(output.usage.kis, 7);
  assert.equal(output.usage.typeModel, 1);
  assert.equal(output.usage.recommendationModel, 0);
  assert.equal(output.diagnostic.typeAssessment.statistics.infoToolCalls, 3);
  const queries = result.requests.filter((row) => row.url.includes('/search-info'));
  assert.equal(queries.length, 1);
  assert.equal(new URL(queries[0].url).searchParams.get('PDNO'), 'AAPL');
});

test('compact summaries retain completed phases and all model requests after detailed observations are truncated', (t) => {
  const result = run(t, 'review-late-error', {
    NYSE_EXTRA: JSON.stringify([
      {
        id: 800,
        publishedDate: 1792706400000,
        subject: 'Options',
        body: '<p>Options notice.</p>',
        marketLinks: ['NYSE AMERICAN OPTIONS'],
        childNotifications: Array.from({ length: 600 }, () => ({
          publishedDate: 1792706400000,
          subject: 'Options',
          body: '<p>Options update.</p>',
        })),
      },
    ]),
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const { observation, usage, error } = JSON.parse(result.stderr);
  assert.equal(error, 'MODEL_INCOMPLETE');
  assert.equal(observation.truncated, true);
  assert.ok(observation.omittedOperations > 0);
  assert.ok(observation.operations.length <= 512);
  assert.ok(Buffer.byteLength(JSON.stringify(observation)) <= 256 * 1024);
  assert.deepEqual(
    observation.summaries.modelRequests.map((row) => row.name),
    [
      'calendar.model.http',
      'types.model.http',
      'recommendation.model.http',
      'recommendation.model.http',
      'review.model.http',
    ],
  );
  assert.equal(
    observation.summaries.stages.find((row) => row.name === 'calendar').status,
    'completed',
  );
  assert.equal(
    observation.summaries.stages.find((row) => row.name === 'types').status,
    'completed',
  );
  assert.equal(
    observation.summaries.stages.find((row) => row.name === 'recommendation').status,
    'failed',
  );
  assert.equal(observation.summaries.stages.filter((row) => row.name === 'ranking').length, 6);
  const daily = observation.summaries.stages.filter((row) => row.name === 'daily');
  assert.equal(daily.length, 2);
  assert.ok(daily.every((row) => row.securityCount === 1 && row.rowCount === null));
  assert.equal(observation.summaries.modelRequests.at(-1).failure.code, 'MODEL_INCOMPLETE');
  assert.equal(usage.calendarModel, 1);
  assert.equal(usage.typeModel, 1);
  assert.equal(usage.recommendationModel, 3);
  assert.equal(result.requests.filter((row) => row.url.endsWith('/responses')).length, 5);
  assert.doesNotMatch(
    JSON.stringify(observation.summaries),
    /synthetic|Bearer|NAS:AAPL|Options update|credentials/,
  );
});

test('recommendation and review share start budgets while recording actual transmitted input sizes', (t) => {
  const result = run(t, 'review-late-error', { TEST_REPORT_STEP_MS: '[20,30,40]' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const { observation, usage } = JSON.parse(result.stderr);
  const requests = observation.summaries.modelRequests.filter((row) =>
    /^(recommendation|review)\./.test(row.name),
  );
  assert.deepEqual(
    requests.map((row) => row.stageRemainingMs),
    [180000, 179980, 179950],
  );
  assert.deepEqual(
    requests.map((row) => row.requestRemainingMs),
    [180000, 179980, 179950],
  );
  assert.deepEqual(
    requests.map((row) => row.executionRemainingMs),
    [600000, 599980, 599950],
  );
  assert.deepEqual(
    requests.map((row) => row.elapsedMs),
    [20, 30, 40],
  );
  assert.ok(requests.every((row) => row.securityCount === 2));
  assert.deepEqual(
    requests.map((row) => row.rowCount),
    [0, 40, 40],
  );
  const sent = result.requests.filter(
    (row) =>
      row.body?.input?.some(
        (item) =>
          item.role === 'user' &&
          /"stage":"(?:recommendation|report_review)"/.test(item.content?.[0]?.text ?? ''),
      ) || row.body?.input?.some((item) => item.type === 'function_call_output'),
  );
  assert.equal(sent.length, 3);
  assert.deepEqual(
    requests.map((row) => row.inputBytes),
    sent.map((row) => Buffer.byteLength(JSON.stringify(row.body))),
  );
  const tool = observation.operations.find((row) => row.name === 'recommendation.tool');
  assert.equal(tool.stageRemainingMs, 179980);
  assert.equal(tool.executionRemainingMs, 599980);
  assert.equal(tool.securityCount, 2);
  assert.equal(tool.rowCount, 40);
  assert.equal(usage.recommendationModel, 3);
});

test('recommendation HTTP row counts reflect partial and repeated daily tool reads', (t) => {
  for (const [scenario, counts] of [
    ['report-partial-tools', [0, 20]],
    ['report-loop', [0, 40, 40]],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    const { observation } = JSON.parse(result.stderr);
    const stage = observation.summaries.stages.find((row) => row.name === 'recommendation');
    assert.equal(stage.rowCount, 40);
    const requests = observation.summaries.modelRequests.filter(
      (row) => row.name === 'recommendation.model.http',
    );
    assert.deepEqual(
      requests.map((row) => row.rowCount),
      counts,
    );
    const outputs = result.requests.flatMap(
      (row) => row.body?.input?.filter((item) => item.type === 'function_call_output') ?? [],
    );
    assert.ok(outputs.length > 0);
    assert.equal(JSON.parse(outputs[0].output).length, scenario === 'report-partial-tools' ? 1 : 2);
  }
});

test('recommendation HTTP message spoof stays unknown with characterized existing MODEL_FAILED output', (t) => {
  const result = run(t, 'report-http-spoof');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const { error, usage, observation } = JSON.parse(result.stderr);
  assert.equal(error, 'MODEL_FAILED');
  const request = observation.operations.find((row) => row.name === 'recommendation.model.http');
  assert.equal(request.httpStatus, 503);
  assert.equal(request.streamEnd, 'eof');
  assert.equal(request.failure.code, 'unknown');
  assert.equal(observation.firstFailure.code, 'unknown');
  assert.equal(observation.finalError.operationId, request.id);
  assert.ok(
    observation.operations
      .filter((row) => row.failure)
      .every((row) => row.failure.code === 'unknown'),
  );
  assert.equal(usage.recommendationModel, 1);
  assert.doesNotMatch(JSON.stringify(observation), /siwc_relogin_required|synthetic-subscription/);
});

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

test('recommendation and review observe SDK events without depending on content type', (t) => {
  for (const contentType of ['Text/Event-Stream', '']) {
    const result = run(t, 'review-late-error', { TEST_REPORT_CONTENT_TYPE: contentType });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.error, 'MODEL_INCOMPLETE');
    const requests = failure.observation.operations.filter((row) =>
      ['recommendation.model.http', 'review.model.http'].includes(row.name),
    );
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.completionEvents, 1);
      assert.ok(request.firstEventAt !== null);
      assert.equal(request.responseFormat, contentType ? 'event_stream' : 'missing');
    }
    assert.equal(requests.at(-1).errorEvents, 1);
    assert.equal(failure.usage.recommendationModel, 3);
  }
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
    ['report-unknown-quota', 'MODEL_FAILED'],
    ['report-spoof-quota', 'MODEL_FAILED'],
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

test('official subscription exhaustion completes the same report with separately authenticated paid requests', (t) => {
  const result = run(t, 'paid-success', { OPENAI_API_KEY: 'synthetic-paid-key' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.model.authentication, 'openai_api');
  assert.equal(report.paid.requests, 3);
  assert.equal(report.paid.reservedUsd, 0.013038);
  assert.equal(report.dataSession.date, '2026-10-16');
  assert.equal(report.targetSession.date, '2026-10-19');
  assert.equal(report.fractionalTrading.status, 'unverified');
  assert.equal(report.candidates[0].referenceClose.value, '11');
  assert.equal(report.semanticReview.supported, true);
  const counted = result.requests.filter((r) => r.url.endsWith('/input_tokens'));
  const generated = result.requests.filter((r) => r.paid && r.url.endsWith('/responses'));
  assert.equal(counted.length, 3);
  for (let i = 0; i < counted.length; i++) {
    for (const [key, value] of Object.entries(counted[i].body))
      assert.deepEqual(generated[i].body[key], value);
    assert.ok(counted[i].body.text.format);
  }
  assert.equal(result.requests.filter((r) => r.paid && r.url.endsWith('/responses')).length, 3);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-paid-key|synthetic-subscription/);
});

test('quota without separate credentials gives safe setup guidance before paid traffic', (t) => {
  const result = run(t, 'paid-success');
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error, 'PAID_CREDENTIALS_MISSING');
  assert.equal(result.requests.filter((r) => r.paid).length, 0);
  assert.equal(result.stdout, '');
  assert.match(failure.guidance, /OPENAI_API_KEY/);
});

test('paid input cap accepts its exact boundary and rejects larger or unknown counts before generation', (t) => {
  for (const [tokens, expected] of [
    ['32000', 0],
    ['32001', 1],
    ['-1', 1],
    ['1.5', 1],
    ['NaN', 1],
  ]) {
    const result = run(t, 'paid-success', {
      OPENAI_API_KEY: 'synthetic-paid-key',
      PAID_INPUT_TOKENS: tokens,
    });
    assert.equal(result.status, expected, result.stderr.slice(0, 100));
    if (expected) {
      assert.equal(JSON.parse(result.stderr).error, 'PAID_BUDGET_UNPROVABLE');
      assert.equal(JSON.parse(result.stderr).usage.recommendationModel, 1);
      assert.equal(result.requests.filter((r) => r.paid && r.url.endsWith('/responses')).length, 0);
      assert.equal(result.stdout, '');
    } else {
      assert.equal(JSON.parse(result.stdout).paid.reservedUsd, 0.036288);
    }
  }
  const unavailable = run(t, 'paid-success', {
    OPENAI_API_KEY: 'synthetic-paid-key',
    PAID_COUNT_FAIL: '1',
  });
  assert.equal(unavailable.status, 1);
  assert.equal(JSON.parse(unavailable.stderr).error, 'PAID_BUDGET_UNPROVABLE');
  assert.equal(
    unavailable.requests.filter((r) => r.paid && r.url.endsWith('/responses')).length,
    0,
  );
});

test('paid unknown-usage failures keep their reservation and never retry or print partial reports', (t) => {
  for (const [failure, expected] of [
    ['network', 'MODEL_FAILED'],
    ['eof', 'MODEL_INCOMPLETE'],
    ['open', 'TARGET_OPEN'],
    ['execution', 'EXECUTION_LIMIT'],
    ['stage', 'MODEL_INCOMPLETE'],
  ]) {
    const result = run(t, 'paid-success', {
      OPENAI_API_KEY: 'synthetic-paid-key',
      PAID_FAILURE: failure,
    });
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stderr);
    assert.equal(output.error, expected, result.stderr.slice(0, 100));
    assert.equal(output.paid.requests, 1);
    assert.equal(output.paid.reservedUsd, 0.004346);
    assert.equal(result.requests.filter((r) => r.paid && r.url.endsWith('/responses')).length, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /synthetic-paid-key|synthetic-subscription/);
  }
});

test('explicit streaming quota switches but an unpriced model never sends paid traffic', (t) => {
  const streamed = run(t, 'paid-sse', { OPENAI_API_KEY: 'synthetic-paid-key' });
  assert.equal(streamed.status, 0, streamed.stderr.slice(0, 100));
  assert.equal(JSON.parse(streamed.stdout).paid.requests, 3);
  const unknown = run(
    t,
    'paid-success',
    { OPENAI_API_KEY: 'synthetic-paid-key', TEST_REPORT_MODEL: 'unknown' },
    (d) => ['--auth-dir', d, '--model', 'unknown'],
  );
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stderr).error, 'PAID_BUDGET_UNPROVABLE');
  assert.equal(unknown.requests.filter((r) => r.paid).length, 0);
});

test('the one-dollar reservation boundary allows exactly one dollar and refuses the next microdollars', (t) => {
  for (const [tokens, status] of [
    ['23616', 0],
    ['23617', 1],
  ]) {
    const result = run(
      t,
      'paid-review',
      {
        OPENAI_API_KEY: 'synthetic-paid-key',
        PAID_INPUT_TOKENS: tokens,
        TEST_REPORT_MODEL: 'gpt-6-astra',
      },
      (d) => ['--auth-dir', d, '--model', 'gpt-6-astra'],
    );
    assert.equal(result.status, status, result.stderr.slice(0, 100));
    if (status === 0) {
      assert.equal(JSON.parse(result.stdout).paid.reservedUsd, 1);
      assert.equal(JSON.parse(result.stdout).paid.requests, 1);
    } else {
      assert.equal(JSON.parse(result.stderr).error, 'PAID_BUDGET_EXCEEDED');
      assert.equal(result.requests.filter((r) => r.paid && r.url.endsWith('/responses')).length, 0);
      assert.equal(result.stdout, '');
    }
  }
  const incompleteBudget = run(
    t,
    'paid-success',
    { OPENAI_API_KEY: 'synthetic-paid-key', TEST_REPORT_MODEL: 'gpt-6-astra' },
    (d) => ['--auth-dir', d, '--model', 'gpt-6-astra'],
  );
  assert.equal(incompleteBudget.status, 1);
  assert.equal(JSON.parse(incompleteBudget.stderr).error, 'PAID_BUDGET_EXCEEDED');
  assert.equal(
    incompleteBudget.requests.filter((r) => r.paid && r.url.endsWith('/responses')).length,
    0,
  );
});

test('paid review interruption preserves accumulated reservations from all previous paid requests', (t) => {
  const result = run(t, 'paid-success', {
    OPENAI_API_KEY: 'synthetic-paid-key',
    PAID_FAILURE: 'eof',
    PAID_FAIL_AT: '3',
  });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stderr);
  assert.equal(output.error, 'MODEL_INCOMPLETE');
  assert.equal(output.paid.requests, 3);
  assert.equal(output.paid.reservedUsd, 0.013038);
  assert.equal(output.usage.recommendationModel, 4);
  assert.equal(result.stdout, '');
});
