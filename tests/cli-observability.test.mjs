import assert from 'node:assert/strict';
import test from 'node:test';
import { run } from './candidate-cli-helper.mjs';
import { runCalendar } from './market-calendar-cli-helper.mjs';

test('standalone calendar records local budgets and transmitted size without an invented execution budget', () => {
  const result = runCalendar([], { SCENARIO: 'model-no-completion' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const { observation } = JSON.parse(result.stderr);
  const calendar = observation.summaries.stages.find((row) => row.name === 'calendar');
  assert.equal(calendar.executionRemainingMs, null);
  assert.equal(calendar.stageRemainingMs, 300000);
  const official = observation.operations.find((row) => row.name === 'calendar.official.http');
  assert.equal(official.stageRemainingMs, 120000);
  assert.equal(official.requestRemainingMs, 15000);
  const request = observation.summaries.modelRequests[0];
  assert.equal(request.executionRemainingMs, null);
  assert.equal(request.stageRemainingMs, 180000);
  assert.equal(request.requestRemainingMs, 180000);
  assert.equal(request.securityCount, null);
  const sent = result.requests.find((row) => row.url.endsWith('/responses'));
  assert.equal(request.inputBytes, Buffer.byteLength(JSON.stringify(sent.body)));
});

test('official fetch cancellation before headers preserves request and collection limit owners', () => {
  for (const [stage, timeout, count, source] of [
    ['', '15000', 1, 'request_limit'],
    ['1', '10000', 2, 'stage_limit'],
  ]) {
    const result = runCalendar([], {
      SCENARIO: 'official-preheader-stall',
      TEST_OFFICIAL_STAGE_LIMIT: stage,
      TEST_TIMEOUT_MATCH: timeout,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.error, 'REQUEST_FAILED');
    const { observation } = failure;
    const request = observation.operations
      .filter((row) => row.name === 'calendar.official.http')
      .at(-1);
    assert.equal(request.httpStatus, null);
    assert.equal(request.headersAt, null);
    assert.equal(request.firstEventAt, null);
    assert.equal(request.streamEnd, 'cancelled');
    assert.equal(request.cancellationSource, source);
    assert.equal(request.status, 'failed');
    assert.equal(observation.firstFailure.operationId, request.id);
    assert.equal(observation.firstFailure.code, 'unknown');
    assert.equal(observation.finalError.operationId, request.id);
    assert.equal(
      observation.operations.find((row) => row.id === request.parentId).name,
      'calendar.collection',
    );
    assert.equal(result.requests.length, count);
    assert.deepEqual(result.streamEvents, []);
  }
});

test('calendar failure distinguishes response headers, explicit completion and natural EOF', () => {
  const result = runCalendar([], { SCENARIO: 'model-no-completion' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error, 'MODEL_INCOMPLETE');
  const observation = failure.observation;
  assert.equal(observation.finalError.code, 'MODEL_INCOMPLETE');
  const request = observation.operations.find((row) => row.name === 'calendar.model.http');
  assert.equal(request.httpStatus, 200);
  assert.equal(request.completionEvents, 0);
  assert.equal(request.streamEnd, 'eof');
  assert.equal(request.status, 'failed');
  assert.ok(request.headersAt !== null);
  assert.ok(request.firstEventAt !== null);
  assert.ok(request.lastEventAt !== null);
  assert.equal(result.requests.filter((row) => row.url.endsWith('/responses')).length, 1);
  assert.doesNotMatch(
    JSON.stringify(observation),
    /synthetic-|private_error|\/private\/|assessments/,
  );
});

test('calendar HTTP error messages cannot impersonate local observation codes', () => {
  const result = runCalendar([], {
    SCENARIO: 'model-http-failure',
    TEST_PROVIDER_MESSAGE: 'siwc_relogin_required',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const { error, observation } = JSON.parse(result.stderr);
  assert.equal(error, 'MODEL_FAILED');
  const request = observation.operations.find((row) => row.name === 'calendar.model.http');
  assert.equal(request.httpStatus, 503);
  assert.equal(request.responseFormat, 'json');
  assert.equal(request.streamEnd, 'eof');
  assert.equal(request.failure.code, 'unknown');
  assert.equal(observation.firstFailure.code, 'unknown');
  assert.equal(observation.finalError.operationId, request.id);
  assert.ok(
    observation.operations
      .filter((row) => row.failure)
      .every((row) => row.failure.code === 'unknown'),
  );
  assert.equal(result.requests.filter((row) => row.url.endsWith('/responses')).length, 1);
  assert.doesNotMatch(result.stderr, /siwc_relogin_required|synthetic-subscription/);
});

test('integrated calendar collection failures keep the same request relation and existing usage', (t) => {
  const result = run(t, 'calendar-http-failure');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.stage, 'calendar');
  assert.equal(failure.error, 'SOURCE_HTTP_FAILURE');
  assert.equal(failure.usage.official, 1);
  const observation = failure.observation;
  const request = observation.operations.find((row) => row.name === 'calendar.official.http');
  const parent = observation.operations.find((row) => row.id === request.parentId);
  assert.equal(parent.name, 'calendar.collection');
  assert.equal(request.httpStatus, 503);
  assert.equal(request.status, 'failed');
  assert.equal(observation.firstFailure.operationId, request.id);
  assert.equal(observation.finalError.code, 'SOURCE_HTTP_FAILURE');
  assert.equal(observation.firstFailure.propagated, true);
  assert.equal(result.requests.length, 1);
});

test('calendar model failure preserves refreshed authentication validation, storage and unlock', () => {
  const result = runCalendar([], {
    SCENARIO: 'model-incomplete',
    AUTH_EXPIRES: '2026-10-26T06:00:00Z',
  });
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error, 'MODEL_INCOMPLETE');
  const observation = failure.observation;
  for (const name of [
    'auth.lock',
    'auth.load',
    'auth.refresh',
    'auth.validation',
    'auth.store',
    'auth.unlock',
  ]) {
    assert.equal(
      observation.operations.find((row) => row.name === name)?.status,
      'completed',
      name,
    );
  }
  const auth = observation.operations.find((row) => row.name === 'auth');
  const model = observation.operations.find((row) => row.name === 'calendar.model');
  assert.equal(auth.parentId, model.id);
  const refresh = observation.operations.find((row) => row.name === 'auth.refresh.http');
  assert.equal(refresh.httpStatus, 200);
  assert.equal(refresh.streamEnd, 'eof');
  assert.equal(result.requests.filter((row) => row.url.endsWith('/oauth/token')).length, 1);
  assert.equal(result.requests.filter((row) => row.url.endsWith('/responses')).length, 1);
  assert.doesNotMatch(
    JSON.stringify(observation),
    /synthetic-|private_error|credentials\.json|access_token/,
  );
});

test('calendar observations distinguish duplicate completion, transport read errors and actual timeout owners', () => {
  for (const [scenario, timeout, end, completions, source] of [
    ['model-duplicate-completion', '', 'eof', 2, 'unknown'],
    ['model-body-error', '', 'read_error', 1, 'unknown'],
    ['model-header-stall', '180000', 'cancelled', 0, 'request_limit'],
    ['model-header-stall', '300000', 'cancelled', 0, 'stage_limit'],
    ['model-incomplete-then-cancel', '180000', 'cancelled', 0, 'request_limit'],
    ['model-completed-then-cancel', '180000', 'cancelled', 1, 'request_limit'],
  ]) {
    const result = runCalendar([], {
      SCENARIO: scenario,
      TEST_TIMEOUT_MATCH: timeout,
      TEST_TIMEOUT_OCCURRENCE: timeout === '180000' ? '2' : '',
    });
    assert.equal(result.status, 1, scenario);
    assert.equal(result.stdout, '', scenario);
    const { observation } = JSON.parse(result.stderr);
    const request = observation.operations.find((row) => row.name === 'calendar.model.http');
    assert.equal(request.httpStatus, 200, scenario);
    assert.equal(request.streamEnd, end, scenario);
    assert.equal(request.completionEvents, completions, scenario);
    assert.equal(request.cancellationSource, source, scenario);
    if (scenario === 'model-header-stall') assert.equal(request.firstEventAt, null);
    if (scenario === 'model-incomplete-then-cancel')
      assert.equal(observation.firstFailure.code, 'MODEL_INCOMPLETE');
    assert.equal(result.requests.filter((row) => row.url.endsWith('/responses')).length, 1);
  }
});

test('SSE observation handles chunk boundaries and degrades oversized metadata without changing the model error', () => {
  const chunked = runCalendar([], { SCENARIO: 'model-no-completion', TEST_SSE_CHUNK_BYTES: '7' });
  assert.equal(chunked.status, 1);
  const chunkFailure = JSON.parse(chunked.stderr);
  assert.equal(chunkFailure.error, 'MODEL_INCOMPLETE');
  const request = chunkFailure.observation.operations.find(
    (row) => row.name === 'calendar.model.http',
  );
  assert.equal(request.completionEvents, 0);
  assert.ok(request.lastEventAt > request.firstEventAt);
  assert.ok(request.endedAt > request.headersAt);
  const oversized = runCalendar([], {
    SCENARIO: 'model-no-completion',
    TEST_EVENT_PADDING_BYTES: '300000',
  });
  assert.equal(oversized.status, 1);
  const failure = JSON.parse(oversized.stderr);
  assert.equal(failure.error, 'MODEL_INCOMPLETE');
  assert.equal(failure.observation.degraded, true);
  assert.equal(
    failure.observation.operations.find((row) => row.name === 'calendar.model.http')
      .completionEvents,
    null,
  );
  assert.equal(
    failure.observation.operations.find((row) => row.name === 'calendar.model.http').eventCounts,
    null,
  );
  assert.doesNotMatch(oversized.stderr, /synthetic-private-event/);
});

test('calendar SSE observation follows SDK parsing across line endings and response content types', async (t) => {
  for (const newline of ['\n', '\r\n', '\r']) {
    for (const [contentType, format] of [
      ['text/event-stream', 'event_stream'],
      ['Text/Event-Stream', 'event_stream'],
      ['application/octet-stream', 'other'],
      ['', 'missing'],
    ]) {
      await t.test(JSON.stringify({ newline, contentType }), () => {
        const result = runCalendar([], {
          SCENARIO: 'model-no-completion',
          TEST_SSE_NEWLINE: newline,
          TEST_SSE_CHUNK_BYTES: '1',
          TEST_MODEL_CONTENT_TYPE: contentType,
        });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        const failure = JSON.parse(result.stderr);
        assert.equal(failure.error, 'MODEL_INCOMPLETE');
        const request = failure.observation.operations.find(
          (row) => row.name === 'calendar.model.http',
        );
        assert.equal(request.httpStatus, 200);
        assert.equal(request.responseFormat, format);
        assert.ok(request.bytes > 0);
        assert.ok(request.firstEventAt !== null);
        assert.ok(request.lastEventAt > request.firstEventAt);
        assert.equal(request.completionEvents, 0);
        assert.equal(request.streamEnd, 'eof');
        assert.equal(failure.observation.degraded, false);
        assert.equal(result.requests.filter((row) => row.url.endsWith('/responses')).length, 1);
      });
    }
  }
});

test('model event categories distinguish output progress from unrecognized events without retaining data', () => {
  for (const [unknown, counts] of [
    ['', { reasoning: 0, output_text: 1, lifecycle: 2, other: 0 }],
    ['1', { reasoning: 0, output_text: 0, lifecycle: 0, other: 1 }],
    ['reasoning', { reasoning: 2, output_text: 0, lifecycle: 0, other: 0 }],
  ]) {
    const result = runCalendar([], {
      SCENARIO: 'model-no-completion',
      TEST_UNKNOWN_MODEL_EVENTS: unknown,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.error, 'MODEL_INCOMPLETE');
    const request = failure.observation.operations.find(
      (row) => row.name === 'calendar.model.http',
    );
    assert.deepEqual(request.eventCounts, counts);
    const official = failure.observation.operations.filter(
      (row) => row.name === 'calendar.official.http',
    );
    assert.ok(official.length > 0);
    assert.ok(official.every((row) => row.eventCounts === null));
    assert.equal(request.completionEvents, 0);
    assert.equal(request.streamEnd, 'eof');
    assert.doesNotMatch(result.stderr, /synthetic-private/);
  }
});

test('calendar diagnostics bound a large official snapshot while retaining the later model failure', () => {
  const extra = [
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
  ];
  const result = runCalendar([], {
    SCENARIO: 'model-no-completion',
    NYSE_EXTRA: JSON.stringify(extra),
  });
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error, 'MODEL_INCOMPLETE');
  const observation = failure.observation;
  assert.equal(observation.truncated, true);
  assert.ok(observation.omittedOperations > 0);
  assert.ok(observation.operations.length <= 512);
  assert.ok(Buffer.byteLength(JSON.stringify(observation)) <= 256 * 1024);
  assert.ok(observation.operations.some((row) => row.id === observation.firstFailure.operationId));
  assert.ok(observation.operations.some((row) => row.id === observation.finalError.operationId));
  assert.ok(
    observation.operations.find((row) => row.id === observation.finalError.operationId)
      .firstEventAt !== null,
  );
  assert.equal(result.requests.filter((row) => row.url.endsWith('/responses')).length, 1);
});

test('observation creation and serialization faults preserve the original failure and authentication cleanup', () => {
  for (const flag of ['TEST_OBSERVATION_ID_FAILURE', 'TEST_OBSERVATION_SERIALIZATION_FAILURE']) {
    const result = runCalendar([], {
      SCENARIO: 'model-incomplete',
      AUTH_EXPIRES: '2026-10-26T06:00:00Z',
      [flag]: '1',
    });
    assert.equal(result.status, 1, flag);
    assert.equal(result.stdout, '', flag);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.error, 'MODEL_INCOMPLETE');
    assert.equal(failure.observation.degraded, true);
    assert.equal(failure.observation.finalError.code, 'MODEL_INCOMPLETE');
    assert.equal(result.auth.locked, false);
    assert.equal(result.auth.expiresAt, Date.parse('2026-10-26T07:00:00Z'));
    assert.equal(result.requests.filter((row) => row.url.endsWith('/oauth/token')).length, 1);
  }
});

test('a completed calendar transport stays completed when result validation fails', () => {
  const result = runCalendar([], {
    NYSE_BODY: 'Routine informational notice.',
    MODEL_RESPONSE: '{"assessments":[]}',
  });
  assert.equal(result.status, 1);
  const { error, observation } = JSON.parse(result.stderr);
  assert.equal(error, 'MODEL_OUTPUT');
  assert.equal(
    observation.operations.find((row) => row.name === 'calendar.model.http').status,
    'completed',
  );
  assert.equal(
    observation.operations.find((row) => row.name === 'calendar.model').status,
    'failed',
  );
  assert.equal(
    observation.operations.find((row) => row.name === 'calendar.validation').status,
    'failed',
  );
});

test('observation failure cannot prevent cancellation of an oversized official response', () => {
  const result = runCalendar([], {
    SCENARIO: 'official-body-limit',
    TEST_OBSERVATION_ID_FAILURE: '1',
  });
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error, 'COLLECTION_LIMIT');
  assert.equal(failure.observation.degraded, true);
  assert.equal(
    failure.observation.operations.find((row) => row.name === 'calendar.official.http').streamEnd,
    'cancelled',
  );
  assert.deepEqual(result.streamEvents, ['cancel']);
  assert.equal(result.requests.length, 1);
});

test('official cancellation rejection stays unknown when its message mimics a local auth error', () => {
  for (const degraded of ['', '1']) {
    const result = runCalendar([], {
      SCENARIO: 'official-body-limit',
      TEST_OBSERVATION_ID_FAILURE: degraded,
      TEST_OFFICIAL_CANCEL_ERROR: 'siwc_relogin_required',
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    const { error, observation } = JSON.parse(result.stderr);
    assert.equal(error, 'REQUEST_FAILED');
    assert.equal(observation.degraded, Boolean(degraded));
    const request = observation.operations.find((row) => row.name === 'calendar.official.http');
    assert.equal(request.httpStatus, 200);
    assert.equal(request.streamEnd, 'cancelled');
    assert.equal(request.failure.code, 'unknown');
    assert.equal(observation.firstFailure.code, 'COLLECTION_LIMIT');
    const body = observation.operations.find((row) => row.name === 'calendar.official.body');
    const cleanup = observation.operations.find((row) => row.name === 'calendar.official.cancel');
    assert.equal(body.parentId, request.id);
    assert.equal(body.failure.code, 'COLLECTION_LIMIT');
    assert.equal(body.failure.propagated, false);
    assert.equal(observation.firstFailure.operationId, body.id);
    assert.equal(observation.firstFailure.propagated, false);
    assert.equal(cleanup.parentId, request.id);
    assert.equal(cleanup.failure.code, 'unknown');
    assert.equal(cleanup.failure.propagated, true);
    assert.equal(observation.finalError.operationId, cleanup.id);
    assert.ok(
      observation.operations
        .filter((row) => row.failure && row.id !== body.id)
        .every((row) => row.failure.code === 'unknown'),
    );
    assert.deepEqual(result.streamEvents, ['cancel']);
    assert.equal(result.requests.length, 1);
    assert.equal(result.auth.locked, false);
    assert.doesNotMatch(result.stderr, /siwc_relogin_required|synthetic-|credentials\.json/);
  }
});

test('model release rejection remains separate from the earlier provider failure', () => {
  const result = runCalendar([], {
    SCENARIO: 'model-incomplete',
    TEST_MODEL_RELEASE_ERROR: 'siwc_relogin_required',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const { error, observation } = JSON.parse(result.stderr);
  const request = observation.operations.find((row) => row.name === 'calendar.model.http');
  assert.equal(request.failure.code, 'MODEL_INCOMPLETE');
  assert.equal(observation.firstFailure.operationId, request.id);
  const cleanup = observation.operations.find((row) => row.name === 'http.release');
  assert.equal(cleanup?.failure.code, 'unknown', `public=${error}`);
  assert.equal(error, 'MODEL_FAILED');
  assert.equal(cleanup.parentId, request.parentId);
  assert.equal(cleanup.relatedRequestId, request.id);
  assert.equal(cleanup.failure.propagated, observation.finalError.operationId === cleanup.id);
  if (cleanup.failure.propagated) assert.equal(observation.firstFailure.propagated, false);
  assert.deepEqual(result.streamEvents, ['model-release']);
  assert.equal(result.requests.filter((row) => row.url.endsWith('/responses')).length, 1);
  assert.doesNotMatch(
    JSON.stringify(observation),
    /siwc_relogin_required|synthetic-|credentials\.json/,
  );
});

test('model malformed SSE cancellation records an independent unknown cleanup rejection', () => {
  const result = runCalendar([], {
    SCENARIO: 'model-incomplete',
    TEST_MODEL_CANCEL_ERROR: 'siwc_relogin_required',
  });
  assert.equal(result.status, 1, result.stderr);
  const { error, observation } = JSON.parse(result.stderr);
  assert.equal(error, 'MODEL_FAILED');
  assert.equal(result.stdout, '');
  const request = observation.operations.find((row) => row.name === 'calendar.model.http');
  const cleanup = observation.operations.find((row) => row.name === 'http.cancel');
  assert.equal(cleanup?.failure.code, 'unknown', `public=${error}; cancels=${result.streamEvents}`);
  assert.equal(cleanup.parentId, request.parentId);
  assert.equal(cleanup.relatedRequestId, request.id);
  assert.equal(cleanup.failure.propagated, observation.finalError.operationId === cleanup.id);
  if (cleanup.failure.propagated) assert.equal(observation.firstFailure.propagated, false);
  assert.equal(observation.firstFailure.operationId, request.id);
  assert.equal(observation.firstFailure.code, 'MODEL_INCOMPLETE');
  assert.deepEqual(result.streamEvents, ['model-cancel']);
  assert.equal(result.requests.filter((row) => row.url.endsWith('/responses')).length, 1);
  assert.doesNotMatch(
    JSON.stringify(observation),
    /siwc_relogin_required|synthetic-|credentials\.json/,
  );
});
