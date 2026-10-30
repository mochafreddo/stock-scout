import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from './candidate-cli-helper.mjs';

test('candidate CLI includes shared type diagnostics and whole execution time on type failure', (t) => {
  const result = run(t, 'type-limit', { TYPE_BEFORE_MS: '31' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const output = JSON.parse(result.stderr);
  assert.equal(output.error, 'MODEL_INCOMPLETE');
  assert.equal(output.stage, 'assessment');
  assert.equal(output.diagnostic.elapsedMs, 180031);
  assert.equal(output.diagnostic.typeAssessment.statistics.elapsedMs, 180000);
  assert.equal(output.diagnostic.typeAssessment.cause, 'deadline_exceeded');
  assert.equal(output.diagnostic.typeAssessment.requests.length, 1);
  assert.equal(output.usage.typeModel, 1);
  const observation = output.observation;
  assert.ok(observation.coverage.includes('calendar'));
  assert.ok(observation.coverage.includes('types'));
  const model = observation.operations.find((row) => row.name === 'types.model');
  const request = observation.operations.find((row) => row.name === 'types.model.http');
  assert.equal(request.parentId, model.id);
  assert.equal(request.httpStatus, 200);
  assert.equal(request.streamEnd, 'eof');
  assert.equal(request.completionEvents, 1);
  assert.equal(model.status, 'failed');
  assert.equal(request.status, 'completed');
  assert.equal(observation.finalError.code, 'MODEL_INCOMPLETE');
});

test('candidate CLI leaves unstarted type measurements null on input failure', (t) => {
  const result = run(t, 'ok', {}, []);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const diagnostic = JSON.parse(result.stderr).diagnostic;
  assert.equal(diagnostic.elapsedMs, 0);
  assert.deepEqual(diagnostic.typeAssessment, {
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
  assert.equal(result.requests.length, 0);
});

test('candidate CLI connects official sessions, six discovery rankings, types and 20 completed daily rows', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'candidate_universe');
  assert.equal(output.dataSession.date, '2026-10-16');
  assert.equal(output.targetSession.date, '2026-10-19');
  assert.deepEqual(output.historyDates, [
    '2026-09-21',
    '2026-09-22',
    '2026-09-23',
    '2026-09-24',
    '2026-09-25',
    '2026-09-28',
    '2026-09-29',
    '2026-09-30',
    '2026-10-01',
    '2026-10-02',
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
    '2026-10-08',
    '2026-10-09',
    '2026-10-12',
    '2026-10-13',
    '2026-10-14',
    '2026-10-15',
    '2026-10-16',
  ]);
  assert.deepEqual(
    output.securities.map((s) => [s.exchange, s.symbol]),
    [
      ['NAS', 'AAPL'],
      ['NYS', 'BBDO'],
    ],
  );
  assert.equal(output.excluded[0].symbol, 'SPY');
  assert.equal(output.securities[0].rankings.length, 2);
  assert.equal(output.securities[0].rankings[0].row.name, 'Apple');
  assert.equal(output.securities[0].daily.rows.length, 20);
  assert.equal(output.calendar.noticeCompleteness, 'unverified');
  const kis = result.requests.filter((r) => r.url.includes('openapi.koreainvestment.com'));
  assert.equal(kis.filter((r) => r.url.includes('/ranking/')).length, 6);
  assert.equal(kis.filter((r) => r.url.includes('/dailyprice')).length, 2);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /test-key|test-secret|test-token|synthetic-subscription|synthetic-refresh/,
  );
});

test('candidate CLI caps each ranking to its original top row even when a later row precedes it', (t) => {
  const result = run(t, 'unsorted-ranks');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    output.securities.map((s) => s.symbol),
    ['AAPL', 'BBDO'],
  );
  assert.ok(output.securities.every((s) => s.rankings.every((rank) => rank.rank === 1)));
});

test('an execution started during the regular session remains rejected after collection crosses close', (t) => {
  const result = run(t, 'cross-close', { TEST_NOW: '2026-10-16T19:59:00Z' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'MARKET_ACTIVE');
  assert.equal(
    result.requests.filter((r) => r.url.includes('openapi.koreainvestment.com')).length,
    0,
  );
});

test('missing selected ranking company or numeric evidence is a whole-execution failure', (t) => {
  for (const field of ['name', 'tvol', 'tamt']) {
    const result = run(t, 'missing-ranking-field', { OMIT_RANKING_FIELD: field });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'RANKING_FAILED');
    const { observation } = JSON.parse(result.stderr);
    const validation = observation.operations.find((row) => row.name === 'ranking.validation');
    assert.equal(validation?.status, 'failed');
    assert.equal(validation.failure.code, 'RANKING_FAILED');
    assert.equal(observation.finalError.operationId, validation.id);
    assert.equal(observation.firstFailure.operationId, validation.id);
    const parent = observation.operations.find((row) => row.id === validation.parentId);
    assert.equal(parent.name, 'ranking');
    const query = observation.operations.find(
      (row) => row.name === 'kis' && row.parentId === parent.id,
    );
    assert.equal(query.status, 'completed');
    const request = observation.operations.find(
      (row) => row.name === 'kis.http' && row.parentId === query.id,
    );
    assert.equal(request.status, 'completed');
    assert.equal(request.streamEnd, 'eof');
    assert.equal(result.requests.filter((row) => row.url.includes('/ranking/')).length, 1);
  }
});

test('empty rankings, identity conflicts and query failures never return partial candidates', (t) => {
  for (const [scenario, code] of [
    ['empty-ranks', 'RANKING_INCOMPLETE'],
    ['conflicting-identity', 'IDENTITY_AMBIGUOUS'],
    ['rank-failure', 'HTTP_FAILURE'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, code);
    assert.doesNotMatch(result.stderr, /test-secret/);
  }
});

test('confirmed ineligible securities produce an empty universe while unknown types fail distinctly', (t) => {
  const empty = run(t, 'all-excluded');
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).status, 'empty_candidate_universe');
  assert.equal(JSON.parse(empty.stdout).excluded.length, 3);
  assert.equal(empty.requests.filter((r) => r.url.includes('/dailyprice')).length, 0);
  const unknown = run(t, 'all-unknown');
  assert.equal(unknown.status, 2, unknown.stderr);
  assert.equal(unknown.stdout, '');
  assert.equal(JSON.parse(unknown.stderr).error, 'ANALYSIS_INSUFFICIENT');
});

test('daily date gaps, duplicates and invalid dates fail without widening the request or shrinking history', (t) => {
  for (const scenario of ['daily-missing', 'daily-duplicate', 'daily-invalid-date']) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'DATA_NOT_READY');
    const { observation } = JSON.parse(result.stderr);
    const validation = observation.operations.find(
      (row) => row.name === 'daily.validation' && row.status === 'failed',
    );
    assert.equal(validation?.failure.code, 'DATA_NOT_READY');
    assert.equal(observation.firstFailure.operationId, validation.id);
    assert.equal(observation.finalError.operationId, validation.id);
    const parent = observation.operations.find((row) => row.id === validation.parentId);
    assert.equal(parent.name, 'daily');
    const query = observation.operations.find(
      (row) => row.name === 'kis' && row.parentId === parent.id,
    );
    assert.equal(query.status, 'completed');
    const request = observation.operations.find(
      (row) => row.name === 'kis.http' && row.parentId === query.id,
    );
    assert.equal(request.status, 'completed');
    assert.equal(request.streamEnd, 'eof');
    assert.equal(result.requests.filter((r) => r.url.includes('/dailyprice')).length, 1);
  }
});

test('daily OHLC must be positive and ordered and volume must be a finite nonnegative number', (t) => {
  for (const [field, value] of [
    ['open', '0'],
    ['high', '8'],
    ['low', '12'],
    ['clos', ''],
    ['tvol', '-1'],
    ['tvol', 'NaN'],
  ]) {
    const result = run(t, 'daily-field', { DAILY_FIELD: field, DAILY_VALUE: value });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'DATA_NOT_READY');
  }
});

test('in-progress rows are excluded while provider zero volume and unconverted amounts are preserved', (t) => {
  const current = run(t, 'daily-current');
  assert.equal(current.status, 0, current.stderr);
  assert.ok(
    JSON.parse(current.stdout).securities.every(
      (s) => s.daily.rows.length === 20 && !s.daily.rows.some((r) => r.xymd === '20261019'),
    ),
  );
  const zero = run(t, 'daily-field', { DAILY_FIELD: 'tvol', DAILY_VALUE: '0' });
  assert.equal(zero.status, 0, zero.stderr);
  assert.equal(JSON.parse(zero.stdout).securities[0].daily.rows[0].tvol, '0');
});

test('KIS structured expiry uses the existing one-requery policy and counts issuance within KIS attempts', (t) => {
  const result = run(t, 'rank-expired');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).usage.kis, 10);
  assert.equal(JSON.parse(result.stdout).usage.issuance, 1);
  assert.equal(result.requests.filter((r) => r.url.includes('/oauth2/tokenP')).length, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /renewed-test-token/);
});

test('calendar, type and whole-execution deadlines and target open all reject partial output', (t) => {
  for (const [scenario, code] of [
    ['calendar-limit', 'EXECUTION_LIMIT'],
    ['type-limit', 'MODEL_INCOMPLETE'],
    ['execution-limit', 'EXECUTION_LIMIT'],
    ['candidate-final-open', 'TARGET_OPEN'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, code);
  }
});

test('calendar and type model budgets remain partitioned at one and twelve actual attempts', (t) => {
  const result = run(t, 'model-budget');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'MODEL_LIMIT');
  assert.equal(JSON.parse(result.stderr).usage.calendarModel, 1);
  assert.equal(JSON.parse(result.stderr).usage.typeModel, 12);
  assert.equal(result.requests.filter((r) => r.url.includes('/responses')).length, 13);
});

test('credential material found in daily evidence fails safely', (t) => {
  const result = run(t, 'daily-sensitive');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'SENSITIVE_OUTPUT');
  assert.doesNotMatch(result.stderr, /test-token/);
});

test('candidate inputs require an explicit model and auth directory and reject historical time flags before HTTP', (t) => {
  for (const args of [
    [],
    ['--at', '2026-10-18T00:00:00Z'],
    ['--auth-dir', 'relative', '--model', 'gpt-6-luna'],
    ['--model', 'gpt-6-luna', '--model', 'other'],
  ]) {
    const result = run(t, 'ok', {}, args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'USAGE');
    assert.equal(result.requests.length, 0);
  }
});

test('candidate sessions survive New York midnight, holidays and DST with official twenty-session history', (t) => {
  for (const [at, data, target, open, first] of [
    ['2026-10-20T03:59:00Z', '2026-10-19', '2026-10-20', '2026-10-20T13:30:00.000Z', '2026-09-22'],
    ['2026-10-20T04:01:00Z', '2026-10-19', '2026-10-20', '2026-10-20T13:30:00.000Z', '2026-09-22'],
    ['2026-12-25T12:00:00Z', '2026-12-24', '2026-12-28', '2026-12-28T14:30:00.000Z', '2026-11-27'],
    ['2026-11-01T06:00:00Z', '2026-10-30', '2026-11-02', '2026-11-02T14:30:00.000Z', '2026-10-05'],
  ]) {
    const result = run(t, 'all-excluded', { TEST_NOW: at });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.dataSession.date, data);
    assert.equal(output.targetSession.date, target);
    assert.equal(output.targetSession.open, open);
    assert.equal(output.historyDates.length, 20);
    assert.equal(output.historyDates[0], first);
    assert.equal(output.historyDates.at(-1), data);
  }
});

test('missing official adjacent-year data for the target or required history fails before ranking', (t) => {
  for (const at of ['2026-12-31T22:00:00Z', '2026-01-05T06:00:00Z']) {
    const result = run(t, 'all-excluded', { TEST_NOW: at });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'CALENDAR_RANGE');
    assert.equal(
      result.requests.filter((r) => r.url.includes('openapi.koreainvestment.com')).length,
      0,
    );
  }
});

test('calendar and type stages reuse a policy-approved SIWC refresh and expose only its request count', (t) => {
  const result = run(t, 'ok', {
    AUTH_EXPIRES: '2026-10-18T00:01:00Z',
    OPENAI_API_KEY: 'paid-synthetic-key',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).usage.refresh, 1);
  assert.equal(
    result.requests.filter((r) => r.url === 'https://auth.openai.com/api/accounts/oauth/token')
      .length,
    1,
  );
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 2);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /synthetic-subscription|synthetic-refresh|paid-synthetic-key/,
  );
});

test('a validated new ID token from the second SIWC refresh cannot leak through the model result', (t) => {
  const result = run(t, 'second-refresh-id', { AUTH_EXPIRES: '2026-10-18T00:01:00Z' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error, 'SENSITIVE_OUTPUT');
  assert.equal(failure.usage.refresh, 2);
  assert.equal(
    result.requests.filter((r) => r.url === 'https://auth.openai.com/api/accounts/oauth/token')
      .length,
    2,
  );
  assert.equal(result.requests.filter((r) => r.url === 'https://auth.openai.com/jwks').length, 2);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /eyJhbGciOiJSUzI1Ni/);
});

test('daily rows for a conflicting supplied security identity fail instead of joining by request alone', (t) => {
  const result = run(t, 'daily-wrong-identity');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'IDENTITY_AMBIGUOUS');
  assert.equal(result.requests.filter((r) => r.url.includes('/dailyprice')).length, 1);
});

test('four zero OHLC prices fail even though their relative ordering is consistent', (t) => {
  const result = run(t, 'daily-zero-prices');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'DATA_NOT_READY');
});
