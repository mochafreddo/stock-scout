import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run as runCandidate } from './candidate-cli-helper.mjs';

const run = (t, scenario = 'ok', env = {}, args) =>
  runCandidate(t, scenario, env, args, 'buy-candidates');

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
