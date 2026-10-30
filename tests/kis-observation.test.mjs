import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from './candidate-cli-helper.mjs';

const mock = new URL('./kis-observation-http-mock.mjs', import.meta.url).pathname;
test('KIS recovery stays a recovered first failure when a later model stops the CLI', (t) => {
  const result = run(t, 'rank-expired', { NODE_OPTIONS: `--import=${mock}` });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const output = JSON.parse(result.stderr);
  assert.equal(output.error, 'MODEL_FAILED');
  assert.equal(output.stage, 'assessment');
  assert.equal(output.usage.kis, 8);
  assert.equal(output.usage.issuance, 1);
  const observation = output.observation;
  assert.ok(observation.firstFailure, 'the explicit KIS expiry must be observed');
  assert.equal(observation.firstFailure.code, 'KIS_FAILURE');
  assert.equal(observation.firstFailure.recovered, true);
  assert.equal(observation.firstFailure.propagated, false);
  assert.equal(observation.finalError.code, 'MODEL_FAILED');
  assert.notEqual(observation.finalError.operationId, observation.firstFailure.operationId);
  const expired = observation.operations.find(
    (row) => row.id === observation.firstFailure.operationId,
  );
  assert.equal(expired.name, 'kis.http');
  assert.equal(expired.kind, 'request');
  assert.equal(expired.httpStatus, 200);
  assert.equal(expired.streamEnd, 'eof');
  const logical = observation.operations.find((row) => row.id === expired.parentId);
  assert.ok(logical, 'the request keeps its logical KIS parent');
  assert.equal(logical.name, 'kis');
  assert.equal(logical.status, 'completed');
  assert.equal(observation.operations.filter((row) => row.name === 'kis').length, 6);
  assert.equal(observation.operations.filter((row) => row.name === 'kis.http').length, 7);
  const issuance = observation.operations.find((row) => row.name === 'kis.auth.issuance.http');
  assert.equal(issuance.kind, 'request');
  assert.equal(issuance.streamEnd, 'eof');
  const issuanceParent = observation.operations.find((row) => row.id === issuance.parentId);
  assert.ok(issuanceParent, 'issuance keeps its logical parent');
  assert.equal(issuanceParent.name, 'kis.auth.issuance');
  for (const name of [
    'lock',
    'load',
    'reuse',
    'invalidate',
    'issuance',
    'validation',
    'store',
    'unlock',
  ])
    assert.ok(
      observation.operations.some((row) => row.name === `kis.auth.${name}`),
      name,
    );
  assert.equal(result.requests.find((row) => row.authState).authState.locked, false);
  assert.doesNotMatch(
    result.stderr,
    /test-key|test-secret|test-token|renewed-test-token|Library\/Caches/,
  );
});

test('KIS auth policy failures and second expiry retain existing limits and safe final links', (t) => {
  for (const [mode, error, kis, issuance] of [
    ['locked', 'AUTH_LOCKED', 0, 0],
    ['initial-wait', 'AUTH_COOLDOWN', 0, 0],
    ['issue-invalid', 'AUTH_FAILED', 2, 1],
    ['second-expiry', 'KIS_FAILURE', 3, 1],
  ]) {
    const result = run(t, 'rank-expired', { NODE_OPTIONS: `--import=${mock}`, KIS_TEST: mode });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    const output = JSON.parse(result.stderr);
    assert.equal(output.error, error);
    assert.equal(output.stage, 'ranking');
    assert.equal(output.usage.kis, kis);
    assert.equal(output.usage.issuance, issuance);
    const observation = output.observation;
    assert.equal(observation.firstFailure.recovered, false);
    const final = observation.operations.find(
      (row) => row.id === observation.finalError.operationId,
    );
    assert.ok(final, 'the final public error keeps its observed failure');
    assert.equal(final.failure.code, error);
    assert.equal(final.failure.propagated, true);
    assert.equal(result.requests.find((row) => row.authState).authState.locked, mode === 'locked');
    assert.doesNotMatch(result.stderr, /test-key|test-secret|test-token/);
  }
});

test('KIS body failure and validation stay distinct from HTTP headers and successful EOF', (t) => {
  for (const [mode, end, error] of [
    ['query-shape', 'eof', 'RESPONSE_SHAPE'],
    ['query-read-error', 'read_error', 'REQUEST_FAILED'],
    ['query-timeout', 'cancelled', 'REQUEST_FAILED'],
  ]) {
    const result = run(t, 'ok', {
      NODE_OPTIONS: `--import=${mock}`,
      KIS_TEST: mode,
      ...(mode === 'query-timeout' ? { TEST_TIMEOUT_MATCH: '15000' } : {}),
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    const output = JSON.parse(result.stderr);
    assert.equal(output.error, error);
    assert.equal(output.stage, 'ranking');
    const request = output.observation.operations.find((row) => row.name === 'kis.http');
    assert.ok(request, 'KIS transport is observed');
    assert.equal(request.httpStatus, 200);
    assert.equal(request.streamEnd, end);
    assert.equal(
      request.cancellationSource,
      mode === 'query-timeout' ? 'request_limit' : 'unknown',
    );
    const logical = output.observation.operations.find((row) => row.name === 'kis');
    assert.equal(logical.status, 'failed');
    if (mode === 'query-shape') {
      assert.equal(request.status, 'completed');
      assert.equal(
        output.observation.operations.find((row) => row.name === 'kis.validation').status,
        'failed',
      );
    }
    assert.equal(output.usage.kis, 1);
    assert.equal(output.usage.issuance, 0);
    assert.doesNotMatch(result.stderr, /test-key|test-secret|test-token/);
  }
});

test('KIS cancellation before headers retains the directly connected request deadline', (t) => {
  const result = run(t, 'ok', {
    NODE_OPTIONS: `--import=${mock}`,
    KIS_TEST: 'query-headers-timeout',
    TEST_TIMEOUT_MATCH: '15000',
  });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stderr);
  assert.equal(output.error, 'REQUEST_FAILED');
  const request = output.observation.operations.find((row) => row.name === 'kis.http');
  assert.equal(request.httpStatus, null);
  assert.equal(request.headersAt, null);
  assert.equal(request.streamEnd, 'cancelled');
  assert.equal(request.cancellationSource, 'request_limit');
});

test('KIS issuance rejection preserves the unconsumed body, releases the lock and keeps the original auth error', (t) => {
  const result = run(t, 'rank-expired', {
    NODE_OPTIONS: `--import=${mock}`,
    KIS_TEST: 'issue-http',
  });
  const output = JSON.parse(result.stderr);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(output.error, 'AUTH_FAILED');
  assert.equal(output.stage, 'ranking');
  assert.equal(output.usage.kis, 2);
  assert.equal(output.usage.issuance, 1);
  assert.equal(
    result.requests.some((row) => row.cancelled === 'issuance'),
    false,
  );
  assert.equal(result.requests.find((row) => row.authState).authState.locked, false);
  const request = output.observation.operations.find(
    (row) => row.name === 'kis.auth.issuance.http',
  );
  assert.equal(request.streamEnd, null);
  assert.equal(request.httpStatus, 503);
  assert.equal(request.failure.propagated, true);
  assert.equal(output.observation.firstFailure.recovered, false);
});

test('KIS storage and observation failures preserve issuance state, lock cleanup and the original result', (t) => {
  for (const failure of [
    undefined,
    'TEST_OBSERVATION_ID_FAILURE',
    'TEST_OBSERVATION_SERIALIZATION_FAILURE',
  ]) {
    const result = run(t, 'rank-expired', {
      NODE_OPTIONS: `--import=${mock}`,
      KIS_TEST: 'store-failure',
      ...(failure ? { [failure]: '1' } : {}),
    });
    const output = JSON.parse(result.stderr);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(output.error, 'AUTH_STORAGE');
    assert.equal(output.stage, 'ranking');
    assert.equal(output.usage.kis, 2);
    assert.equal(output.usage.issuance, 1);
    const state = result.requests.find((row) => row.authState).authState;
    assert.equal(state.locked, false);
    assert.equal(state.token, false);
    assert.equal(state.issuance.kind, 'attempt');
    assert.equal(state.issuance.at, Date.parse('2026-10-18T00:00:00Z'));
    if (failure) assert.equal(output.observation.degraded, true);
    else {
      const store = output.observation.operations.find(
        (row) => row.name === 'kis.auth.store' && row.status === 'failed',
      );
      assert.equal(store.failure.code, 'AUTH_STORAGE');
      assert.equal(store.failure.propagated, true);
      assert.equal(output.observation.finalError.operationId, store.id);
    }
    assert.doesNotMatch(result.stderr, /test-key|test-secret|test-token|Library\/Caches/);
  }
});

test('degraded KIS observation still saves the recovered token before the later model failure', (t) => {
  for (const failure of ['TEST_OBSERVATION_ID_FAILURE', 'TEST_OBSERVATION_SERIALIZATION_FAILURE']) {
    const result = run(t, 'rank-expired', { NODE_OPTIONS: `--import=${mock}`, [failure]: '1' });
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stderr);
    assert.equal(output.error, 'MODEL_FAILED');
    assert.equal(output.usage.kis, 8);
    assert.equal(output.usage.issuance, 1);
    assert.equal(output.observation.degraded, true);
    const state = result.requests.find((row) => row.authState).authState;
    assert.equal(state.token, true);
    assert.equal(state.locked, false);
    assert.equal(state.issuance.kind, 'attempt');
    assert.doesNotMatch(result.stderr, /test-key|test-secret|test-token|renewed-test-token/);
  }
});
