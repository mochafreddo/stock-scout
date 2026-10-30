import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, now, putToken } from './kis-cli-helper.mjs';

test('type assessment CLI rejects missing arguments without credentials or network', () => {
  const result = spawnSync(process.execPath, ['scripts/llm-security-probe.ts'], {
    encoding: 'utf8',
    timeout: 5000,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(legacyFailure(result.stderr), {
    error: 'USAGE',
    diagnostic: { stage: 'input', reason: 'unknown', location: null },
  });
});

function legacyFailure(stderr) {
  const output = JSON.parse(stderr);
  delete output.observation;
  delete output.diagnostic.inputSnapshot;
  delete output.diagnostic.elapsedMs;
  delete output.diagnostic.typeAssessment;
  if (['assessment'].includes(output.diagnostic.stage)) {
    assert.ok(output.diagnostic.statistics);
    delete output.diagnostic.statistics;
  }
  return output;
}

test('CLI connects each type request and information tool to one execution observation', (t) => {
  const result = run(t, 'missing-final-completion', {
    TEST_STATISTICS_CLOCK: '1',
    TEST_STREAM_DELAYS: '[13,29]',
  });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stderr);
  const observation = output.observation;
  assert.ok(observation, result.stderr);
  const requests = observation.operations.filter((row) => row.name === 'types.model.http');
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((row) => [row.httpStatus, row.completionEvents, row.streamEnd]),
    [
      [200, 1, 'eof'],
      [200, 0, 'eof'],
    ],
  );
  assert.ok(requests.every((row) => row.headersAt <= row.endedAt));
  assert.ok(requests.every((row) => row.headersAt < row.endedAt));
  const model = observation.operations.find((row) => row.name === 'types.model');
  assert.ok(requests.every((row) => row.parentId === model.id));
  assert.equal(requests[0].status, 'completed');
  assert.equal(requests[1].status, 'failed');
  const tool = observation.operations.find((row) => row.name === 'types.info_tool');
  assert.equal(tool.parentId, requests[0].id);
  assert.equal(tool.status, 'completed');
  assert.equal(observation.operations.filter((row) => row.name === 'types.info_tool').length, 2);
  const web = observation.operations.find((row) => row.name === 'types.web_tool');
  assert.equal(web.parentId, requests[0].id);
  assert.equal(web.status, 'completed');
  assert.equal(observation.finalError.code, 'MODEL_INCOMPLETE');
  assert.equal(observation.finalError.operationId, requests[1].id);
  assert.doesNotMatch(
    JSON.stringify(observation),
    /synthetic-subscription|test-secret|controlled-security-type/,
  );
});

test('CLI records stage cancellation before headers, during streaming and information waiting', (t) => {
  for (const scenario of ['model-blocked', 'body-blocked', 'info-blocked']) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stderr);
    const request = output.observation.operations.find((row) => row.name === 'types.model.http');
    if (scenario === 'info-blocked') {
      assert.equal(request.streamEnd, 'eof');
      const tool = output.observation.operations.find((row) => row.name === 'types.info_tool');
      assert.equal(tool.status, 'failed');
      assert.equal(tool.cancellationSource, 'stage_limit');
    } else {
      assert.equal(request.streamEnd, 'cancelled', scenario);
      assert.equal(request.cancellationSource, 'stage_limit', scenario);
      assert.equal(request.status, 'failed', scenario);
      assert.equal(request.httpStatus, scenario === 'body-blocked' ? 200 : null);
      assert.equal(request.firstEventAt, null);
    }
  }
});

test('CLI preserves the first provider event failure after cancellation in common observations', (t) => {
  const result = run(t, 'provider-then-blocked', { TEST_STREAM_END: 'response.failed' });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stderr);
  const observation = output.observation;
  const request = observation.operations.filter((row) => row.name === 'types.model.http').at(-1);
  assert.equal(output.diagnostic.typeAssessment.cause, 'provider_failed');
  assert.equal(request.errorEvents, 1);
  assert.equal(request.completionEvents, 1);
  assert.equal(request.streamEnd, 'cancelled');
  assert.equal(request.cancellationSource, 'stage_limit');
  assert.equal(observation.firstFailure.operationId, request.id);
  assert.equal(observation.firstFailure.code, 'MODEL_INCOMPLETE');
  assert.equal(observation.firstFailure.propagated, true);
  assert.equal(observation.finalError.operationId, request.id);
});

test('CLI connects final validation failures without relabeling completed HTTP requests', (t) => {
  const result = run(t, 'ok', { TEST_RESPONSE_STAGE: 'assessment', TEST_RESPONSE_VALUE: '{}' });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stderr);
  assert.equal(output.error, 'MODEL_OUTPUT');
  const observation = output.observation;
  const validation = observation.operations.find((row) => row.name === 'types.validation');
  assert.equal(validation?.status, 'failed');
  assert.equal(observation.finalError.operationId, validation.id);
  assert.ok(
    observation.operations
      .filter((row) => row.name === 'types.model.http')
      .every((row) => row.streamEnd === 'eof' && row.status === 'completed'),
  );
});

test('CLI keeps authentication and final serialization in the same observation owner', (t) => {
  const result = run(t, 'ok', {
    TEST_SERIALIZATION_STAGE: 'output',
    TEST_OUTPUT_SERIALIZATION: '1',
    TEST_SERIALIZATION_EXCEPTION: 'private-output synthetic-subscription',
  });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stderr);
  assert.equal(output.diagnostic.stage, 'output');
  const observation = output.observation;
  assert.equal(observation.operations.find((row) => row.name === 'auth').status, 'completed');
  const serialization = observation.operations.find((row) => row.name === 'output');
  assert.equal(serialization?.status, 'failed');
  assert.equal(observation.finalError.operationId, serialization.id);
  assert.doesNotMatch(result.stderr, /private-output|synthetic-subscription/);
});

test('CLI links mapped ranking failures to the original KIS request in its execution', (t) => {
  const result = run(t, 'ranking-exception', {
    TEST_RANKING_EXCEPTION: 'private-ranking synthetic-subscription',
  });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stderr);
  assert.equal(output.error, 'RANKING_FAILED');
  assert.equal(output.diagnostic.stage, 'ranking');
  assert.equal(output.diagnostic.reason, 'unknown');
  const observation = output.observation;
  const request = observation.operations.find((row) => row.name === 'kis.http');
  assert.equal(request.status, 'failed');
  assert.equal(request.httpStatus, null);
  assert.equal(observation.finalError.operationId, request.id);
  assert.equal(observation.firstFailure.operationId, request.id);
  assert.equal(observation.firstFailure.propagated, true);
  assert.doesNotMatch(result.stderr, /private-ranking|synthetic-subscription/);
  assert.equal(result.requests.length, 1);
});

test('CLI diagnoses missing completion with request-specific stream observations', (t) => {
  const result = run(t, 'missing-final-completion');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const output = JSON.parse(result.stderr);
  assert.equal(output.error, 'MODEL_INCOMPLETE');
  assert.equal(output.diagnostic.reason, 'MODEL_INCOMPLETE');
  assert.equal(output.diagnostic.elapsedMs, 0);
  assert.deepEqual(output.diagnostic.typeAssessment, {
    statistics: {
      status: 'failed',
      elapsedMs: 0,
      modelRequests: 2,
      infoToolCalls: 1,
      observedWebToolCalls: 1,
    },
    cause: 'missing_completion',
    lastProgress: 'model_stream',
    requests: [
      {
        index: 1,
        elapsedMs: 0,
        httpStatus: 200,
        completionEvents: 1,
        status: 'completed',
        cause: 'unknown',
      },
      {
        index: 2,
        elapsedMs: 0,
        httpStatus: 200,
        completionEvents: 0,
        status: 'failed',
        cause: 'missing_completion',
      },
    ],
  });
});

test('CLI measures each model request through body EOF rather than HTTP headers', (t) => {
  const result = run(t, 'missing-final-completion', {
    TEST_STATISTICS_CLOCK: '1',
    TEST_STREAM_DELAYS: '[13,29]',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const diagnostic = JSON.parse(result.stderr).diagnostic;
  assert.equal(diagnostic.elapsedMs, 67);
  assert.equal(diagnostic.typeAssessment.statistics.elapsedMs, 67);
  assert.deepEqual(diagnostic.typeAssessment.requests, [
    {
      index: 1,
      elapsedMs: 20,
      httpStatus: 200,
      completionEvents: 1,
      status: 'completed',
      cause: 'unknown',
    },
    {
      index: 2,
      elapsedMs: 36,
      httpStatus: 200,
      completionEvents: 0,
      status: 'failed',
      cause: 'missing_completion',
    },
  ]);
});

test('CLI preserves the first observed provider failure after valid JSON and completion', (t) => {
  for (const [ending, cause] of [
    ['response.failed', 'provider_failed'],
    ['response.incomplete', 'provider_incomplete'],
    ['error', 'provider_error'],
  ]) {
    const result = run(t, 'ok', { TEST_STREAM_END: ending, TEST_STREAM_DELAYS: '[3,5]' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    const output = JSON.parse(result.stderr);
    assert.equal(output.error, 'MODEL_INCOMPLETE');
    assert.equal(output.diagnostic.typeAssessment.cause, cause);
    const commonRequest = output.observation.operations
      .filter((row) => row.name === 'types.model.http')
      .at(-1);
    assert.equal(commonRequest.completionEvents, 1);
    assert.equal(commonRequest.errorEvents, 1);
    assert.equal(commonRequest.streamEnd, 'eof');
    assert.equal(commonRequest.status, 'failed');
    assert.deepEqual(output.diagnostic.typeAssessment.requests.at(-1), {
      index: 2,
      elapsedMs: 5,
      httpStatus: 200,
      completionEvents: 1,
      status: 'failed',
      cause,
    });
    assert.doesNotMatch(result.stderr, /private-code|private-message|synthetic-subscription/);
  }
});

test('CLI distinguishes HTTP rejection and transport failures without exposing external errors', (t) => {
  for (const [scenario, env, status, httpStatus, completionEvents, cause] of [
    ['auth-failure', {}, 'AUTH_FAILED', 401, null, 'http_error'],
    [
      'ok',
      {
        TEST_HTTP_EXCEPTION_STAGE: 'assessment',
        TEST_HTTP_EXCEPTION: 'private-field synthetic-subscription',
      },
      'MODEL_FAILED',
      null,
      null,
      'transport_error',
    ],
    [
      'ok',
      { TEST_STREAM_END: 'transport', TEST_STREAM_DELAYS: '[3,5]' },
      'MODEL_FAILED',
      200,
      1,
      'transport_error',
    ],
  ]) {
    const result = run(t, scenario, env);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    const output = JSON.parse(result.stderr);
    assert.equal(output.error, status);
    assert.equal(
      output.diagnostic.typeAssessment.cause,
      cause,
      `${scenario}: ${JSON.stringify(env)}`,
    );
    const record = output.diagnostic.typeAssessment.requests.at(-1);
    assert.equal(record.httpStatus, httpStatus);
    assert.equal(record.completionEvents, completionEvents);
    assert.equal(record.cause, cause);
    assert.equal(record.status, 'failed');
    assert.doesNotMatch(result.stderr, /private-field|private-transport|synthetic-subscription/);
  }
});

test('CLI distinguishes blocked model, body and information deadlines from missing completion', (t) => {
  for (const [
    scenario,
    httpStatus,
    completionEvents,
    requestElapsed,
    requestStatus,
    lastProgress,
  ] of [
    ['model-blocked', null, null, 180000, 'cancelled', 'model_request'],
    ['body-blocked', 200, null, 180000, 'cancelled', 'model_request'],
    ['info-blocked', 200, 1, 0, 'completed', 'info_tool'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    const diagnostic = JSON.parse(result.stderr).diagnostic;
    assert.equal(diagnostic.elapsedMs, 180000);
    assert.equal(diagnostic.typeAssessment.cause, 'deadline_exceeded', scenario);
    assert.equal(diagnostic.typeAssessment.lastProgress, lastProgress);
    assert.equal(diagnostic.typeAssessment.statistics.elapsedMs, 180000);
    assert.deepEqual(diagnostic.typeAssessment.requests, [
      {
        index: 1,
        elapsedMs: requestElapsed,
        httpStatus,
        completionEvents,
        status: requestStatus,
        cause: requestStatus === 'completed' ? 'unknown' : 'deadline_exceeded',
      },
    ]);
  }
});

test('CLI measures input failures from execution start and leaves unstarted types unobserved', (t) => {
  const result = run(t, 'ok', {
    TEST_ARGUMENT_EXCEPTION: 'private-input synthetic-subscription',
    TEST_INPUT_DELAY: '41',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const diagnostic = JSON.parse(result.stderr).diagnostic;
  assert.equal(diagnostic.elapsedMs, 41);
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
  assert.doesNotMatch(result.stderr, /private-input|synthetic-subscription/);
});

test('CLI retains duplicate-completion observations and unknown causes without guessing from model text', (t) => {
  const duplicate = run(t, 'duplicate-completion');
  assert.equal(duplicate.status, 1, duplicate.stderr);
  const repeated = JSON.parse(duplicate.stderr).diagnostic.typeAssessment;
  assert.equal(repeated.cause, 'duplicate_completion');
  assert.equal(repeated.requests[0].completionEvents, 2);
  assert.equal(repeated.requests[0].status, 'failed');
  const commonRequest = JSON.parse(duplicate.stderr).observation.operations.find(
    (row) => row.name === 'types.model.http',
  );
  assert.equal(commonRequest.completionEvents, 2);
  assert.equal(commonRequest.streamEnd, 'eof');
  assert.equal(commonRequest.status, 'failed');
  const validation = run(t, 'missing-explanation');
  assert.equal(validation.status, 1, validation.stderr);
  const diagnostic = JSON.parse(validation.stderr).diagnostic;
  assert.equal(diagnostic.reason, 'missing_required_field');
  assert.equal(diagnostic.location, 'judgments[0].evidence[0].explanation');
  assert.equal(diagnostic.typeAssessment.cause, 'unknown');
  assert.equal(diagnostic.typeAssessment.lastProgress, 'validation');
});

test('CLI keeps the provider failure when the stream is later cancelled at the deadline', (t) => {
  const result = run(t, 'provider-then-blocked', { TEST_STREAM_END: 'response.failed' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const output = JSON.parse(result.stderr);
  assert.equal(output.error, 'MODEL_INCOMPLETE');
  assert.equal(output.diagnostic.typeAssessment.cause, 'provider_failed');
  assert.equal(output.diagnostic.typeAssessment.requests[1].cause, 'provider_failed');
  assert.equal(output.diagnostic.typeAssessment.requests[1].elapsedMs, 180000);
  assert.equal(output.diagnostic.typeAssessment.requests[1].status, 'cancelled');
});

function run(t, scenario = 'ok', extraEnv = {}, evaluationInput, credentialOverrides = {}) {
  const f = fixture();
  t.after(f.close);
  putToken(f, 'test-token');
  const directory = join(f.home, 'siwc');
  mkdirSync(directory, { mode: 0o700 });
  const hostId = 'urn:uuid:859484d1-d773-489f-a0dd-a3021048bb7f';
  writeFileSync(join(directory, 'host.json'), JSON.stringify({ hostId }), { mode: 0o600 });
  writeFileSync(
    join(directory, 'credentials.json'),
    JSON.stringify({
      schemaVersion: 1,
      issuer: 'https://auth.openai.com',
      subject: 'synthetic-user',
      clientId: 'oaiapp_synthetic',
      hostId,
      accessToken: 'synthetic-subscription',
      idToken: 'synthetic-identity',
      refreshToken: 'synthetic-refresh',
      tokenType: 'Bearer',
      scopes: [
        'openid',
        'profile',
        'email',
        'offline_access',
        'resource.invoke',
        'chatgpt.tokens.use.direct',
      ],
      expiresAt: now + 3600_000,
      ...credentialOverrides,
    }),
    { mode: 0o600 },
  );
  const trace = join(f.home, 'trace');
  writeFileSync(trace, '', { mode: 0o600 });
  const inputFile = join(f.home, 'case.json');
  if (evaluationInput !== undefined)
    writeFileSync(inputFile, JSON.stringify(evaluationInput), { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      new URL('./llm-security-http-mock.mjs', import.meta.url).pathname,
      'scripts/llm-security-probe.ts',
      directory,
      extraEnv.TEST_MODEL ?? 'gpt-6-luna',
      ...(evaluationInput === undefined
        ? [scenario.startsWith('types') || scenario === 'partial-ranking-incomplete' ? '2' : '1']
        : ['--evaluation-input', inputFile]),
    ],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        PATH: process.env.PATH,
        HOME: f.home,
        KIS_APP_KEY: 'test-key',
        KIS_APP_SECRET: 'test-secret',
        TEST_NOW: String(now),
        TEST_TRACE: trace,
        SCENARIO: scenario,
        ...extraEnv,
      },
    },
  );
  return {
    ...result,
    requests: readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

test('CLI returns final judgments with minimal evidence in one tool-enabled model flow', (t) => {
  const result = run(t, 'integrated-minimal');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.securities[0].included, true);
  assert.deepEqual(output.securities[0].evidence, [
    {
      sourceId: 's1',
      source: 'https://www.sec.gov/controlled-security-type',
      explanation: 'Common stock, matched to NAS/AAPL.',
    },
  ]);
  assert.equal(output.evidenceRecords, undefined);
  const models = result.requests.filter((r) => r.url.endsWith('/responses'));
  assert.equal(models.length, 2);
  for (const request of models) {
    assert.ok(request.body.tools.some((item) => item.type === 'web_search'));
    const prompt = JSON.parse(
      request.body.input.find((item) => item.role === 'user').content[0].text,
    );
    assert.equal(prompt.stage, 'assessment');
    assert.equal(prompt.evidenceRecords, undefined);
  }
});

test('CLI assesses a deduplicated KIS ranking security through namespaced tools and explicit model completion', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'assessed');
  assert.equal(output.validation, 'unverified');
  assert.equal(output.dataSession, null);
  assert.equal(output.securities.length, 1);
  assert.equal(output.securities[0].symbol, 'AAPL');
  assert.equal(output.securities[0].included, true);
  assert.equal(output.securities[0].rankings.length, 2);
  assert.deepEqual(
    output.securities[0].rankings.map((row) => row.kind),
    ['volume', 'amount'],
  );
  assert.equal(
    output.securities[0].evidence[0].source,
    'https://www.sec.gov/controlled-security-type',
  );
  assert.equal(result.requests.filter((r) => r.url.includes('/ranking/')).length, 6);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 2);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /test-token|test-secret|synthetic-subscription|synthetic-refresh/,
  );
});

test('CLI keeps lookup tools available through the final judgment with only registered source IDs', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const finalRequest = result.requests.filter((r) => r.url.endsWith('/responses')).at(-1).body;
  assert.ok(finalRequest.tools.some((item) => item.type === 'web_search'));
  const prompt = JSON.parse(
    finalRequest.input.find((item) => item.role === 'user').content[0].text,
  );
  assert.equal(prompt.evidenceRecords, undefined);
  assert.equal(output.securities[0].evidence[0].sourceId, 's1');
  assert.equal(output.securities[0].evidence[0].explanation, 'Common stock, matched to NAS/AAPL.');
});

test('CLI rejects sensitive final judgment output without partial success', (t) => {
  const result = run(t, 'sensitive-judgment');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(legacyFailure(result.stderr), {
    error: 'SENSITIVE_OUTPUT',
    diagnostic: { stage: 'output', reason: 'SENSITIVE_OUTPUT', location: null },
  });
  assert.doesNotMatch(result.stderr, /synthetic-subscription/);
});

test('CLI stops blocked information lookup or model streaming at the total deadline without partial output', (t) => {
  for (const scenario of ['info-blocked', 'model-blocked']) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(legacyFailure(result.stderr).error, 'MODEL_INCOMPLETE');
    assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 1);
  }
});

test('CLI refuses model fields that could overwrite original ranking identity', (t) => {
  const result = run(t, 'forged-provenance');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(legacyFailure(result.stderr).error, 'MODEL_OUTPUT');
});

test('CLI enforces the model request ceiling across the integrated flow', (t) => {
  const result = run(t, 'model-limit');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(legacyFailure(result.stderr).error, 'MODEL_LIMIT');
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 12);
});

test('CLI rejects malformed evaluation input before reading credentials or sending requests', (t) => {
  const f = fixture();
  t.after(f.close);
  const inputFile = join(f.home, 'case.json');
  writeFileSync(inputFile, JSON.stringify({ securities: [], expected: 'common' }), { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [
      'scripts/llm-security-probe.ts',
      join(f.home, 'missing'),
      'gpt-6-luna',
      '--evaluation-input',
      inputFile,
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: { PATH: process.env.PATH },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(legacyFailure(result.stderr), {
    error: 'USAGE',
    diagnostic: { stage: 'input', reason: 'unknown', location: null },
  });
});

test('CLI evaluates fixed inputs through the same evidence path without inventing rankings', (t) => {
  const result = run(t, 'ok', {}, { securities: [{ exchange: 'NAS', symbol: 'AAPL' }] });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.inputMode, 'evaluation');
  assert.match(output.purpose, /evaluation-only/);
  assert.deepEqual(output.observations, []);
  assert.equal(output.securities[0].included, true);
  assert.equal(output.securities[0].rsym, undefined);
  assert.equal(output.securities[0].rankings, undefined);
  assert.equal(output.securities[0].evidence[0].sourceId, 's1');
  assert.equal(result.requests.filter((r) => r.url.includes('/ranking/')).length, 0);
  assert.equal(result.requests.filter((r) => r.url.includes('/search-info?')).length, 1);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 2);
  assert.equal(result.requests.length, 3);
  const lookup = result.requests.find((r) => r.url.includes('/search-info?'));
  assert.deepEqual(Object.fromEntries(new URL(lookup.url).searchParams), {
    PRDT_TYPE_CD: '512',
    PDNO: 'AAPL',
  });
  for (const request of result.requests.filter((r) => r.url.endsWith('/responses'))) {
    assert.equal(request.body.model, 'gpt-6-luna');
    assert.equal(request.body.stream, true);
    assert.equal(request.body.store, false);
  }
});

test('CLI rejects empty, excessive, duplicate, malformed or answer-bearing evaluation inputs', (t) => {
  for (const input of [
    null,
    [],
    { securities: {} },
    {},
    { securities: [] },
    { securities: null },
    { securities: [{ exchange: 'LON', symbol: 'AAPL' }] },
    { securities: [{ exchange: 'NAS', symbol: 'aapl' }] },
    { securities: [{ exchange: 'NAS', symbol: 'AAPL', expected: 'common' }] },
    { securities: [{ exchange: 'NAS', symbol: 'AAPL' }], expected: ['common'] },
    {
      securities: [
        { exchange: 'NAS', symbol: 'AAPL' },
        { exchange: 'NYS', symbol: 'private-sentinel', 'private-field': 'private-value' },
      ],
    },
    {
      securities: [
        { exchange: 'NAS', symbol: 'AAPL' },
        { exchange: 'NAS', symbol: 'AAPL' },
      ],
    },
    {
      securities: Array.from({ length: 61 }, (_, index) => ({
        exchange: 'NAS',
        symbol: `S${index}`,
      })),
    },
  ]) {
    const result = run(t, 'ok', {}, input);
    assert.equal(result.status, 1, JSON.stringify(input));
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: 'USAGE',
      diagnostic: { stage: 'input', reason: 'unknown', location: null },
    });
    assert.deepEqual(result.requests, []);
  }
});

test('CLI keeps evaluation read, parse and unexpected file failures in input before authentication', (t) => {
  const f = fixture();
  t.after(f.close);
  const invalidJson = join(f.home, 'private-case.json');
  writeFileSync(invalidJson, '{"private-field":"private-value",', { mode: 0o600 });
  for (const path of [join(f.home, 'private-missing.json'), f.home, invalidJson]) {
    const result = run(t, 'ok', {
      TEST_ARGUMENTS: JSON.stringify([
        join(f.home, 'missing-credentials'),
        'gpt-6-luna',
        '--evaluation-input',
        path,
      ]),
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: 'USAGE',
      diagnostic: { stage: 'input', reason: 'unknown', location: null },
    });
    assert.deepEqual(result.requests, []);
  }
  for (const message of ['private-sentinel', 'RANKING_INCOMPLETE', 'siwc_relogin_required']) {
    const result = run(
      t,
      'ok',
      { TEST_EVALUATION_EXCEPTION: message, TEST_STORAGE_EXCEPTION: 'siwc_relogin_required' },
      { securities: [{ exchange: 'NAS', symbol: 'AAPL' }] },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: 'USAGE',
      diagnostic: { stage: 'input', reason: 'unknown', location: null },
    });
    assert.deepEqual(result.requests, []);
  }
});

test('CLI leaves input after valid evaluation data for authentication and subsequent model failures', (t) => {
  const input = { securities: [{ exchange: 'NAS', symbol: 'AAPL' }] };
  const auth = run(t, 'ok', { TEST_STORAGE_EXCEPTION: 'siwc_relogin_required' }, input);
  assert.equal(auth.status, 1, auth.stderr);
  assert.equal(auth.stdout, '');
  assert.deepEqual(legacyFailure(auth.stderr), {
    error: 'siwc_relogin_required',
    action: 'login',
    diagnostic: { stage: 'authentication', reason: 'unknown', location: null },
  });
  assert.deepEqual(auth.requests, []);
  const model = run(t, 'auth-failure', {}, input);
  assert.equal(model.status, 1, model.stderr);
  assert.equal(model.stdout, '');
  assert.deepEqual(legacyFailure(model.stderr), {
    error: 'AUTH_FAILED',
    diagnostic: { stage: 'assessment', reason: 'AUTH_FAILED', location: null },
  });
  assert.equal(model.requests.length, 1);
  assert.equal(model.requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(model.requests[0].body.model, 'gpt-6-luna');
  assert.equal(model.requests[0].body.stream, true);
  assert.equal(model.requests[0].body.store, false);
});

test('CLI binds final IDs to the observed context of the same individual security', (t) => {
  for (const [scenario, reason, location] of [
    ['invented-id', 'unobserved_source', 'judgments[0].evidence[0].sourceId'],
    ['url-instead-of-id', 'unobserved_source', 'judgments[0].evidence[0].sourceId'],
    ['types-cross-id', 'cross_security_evidence', 'judgments[0].evidence[0].sourceId'],
    ['missing-explanation', 'missing_required_field', 'judgments[0].evidence[0].explanation'],
    ['malformed-evidence', 'unknown', 'judgments[0].evidence[0].explanation'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '', scenario);
    assert.deepEqual(
      legacyFailure(result.stderr),
      {
        error: 'MODEL_OUTPUT',
        diagnostic: {
          stage: 'assessment',
          reason,
          location,
        },
      },
      scenario,
    );
  }
});

test('CLI permits work beyond the former retrieval budget and enforces only the total deadline', (t) => {
  for (const scenario of ['past-former-deadline', 'within-deadline']) {
    const result = run(t, scenario);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.limits.retrievalTimeoutSeconds, undefined);
    assert.equal(output.limits.timeoutSeconds, 180);
  }
  const result = run(t, 'assessment-overrun');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(legacyFailure(result.stderr), {
    error: 'MODEL_INCOMPLETE',
    diagnostic: { stage: 'assessment', reason: 'MODEL_INCOMPLETE', location: null },
  });
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 2);
});

test('CLI treats model authentication failure as global failure without paid fallback', (t) => {
  const result = run(t, 'auth-failure');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(legacyFailure(result.stderr).error, 'AUTH_FAILED');
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 1);
  assert.doesNotMatch(result.stderr, /synthetic-subscription/);
});

test('CLI distinguishes explicit subscription exhaustion without sending an unbudgeted paid request', (t) => {
  const result = run(t, 'quota-http');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(legacyFailure(result.stderr).error, 'SUBSCRIPTION_LIMIT');
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 1);
});

test('CLI separates unconfirmed types from confirmed but excluded types', (t) => {
  for (const scenario of ['unknown', 'individual-lookup', 'not-current']) {
    const result = run(t, scenario);
    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'analysis_insufficient');
    assert.equal(output.securities[0].included, false);
    assert.ok(output.securities[0].reason);
  }
  const excluded = run(t, 'excluded');
  assert.equal(excluded.status, 0, excluded.stderr);
  assert.equal(JSON.parse(excluded.stdout).securities[0].included, false);
  assert.equal(JSON.parse(excluded.stdout).status, 'assessed');
});

test('CLI never emits partial success on rank, identity or common lookup failures', (t) => {
  for (const [scenario, code] of [
    ['rank-failure', 'RANKING_FAILED'],
    ['identity-conflict', 'IDENTITY_AMBIGUOUS'],
    ['global-lookup', 'QUERY_FAILED'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '', scenario);
    assert.equal(legacyFailure(result.stderr).error, code, scenario);
  }
});

test('CLI rejects incomplete final and intermediate model steps even when JSON is valid', (t) => {
  for (const scenario of [
    'missing-intermediate-completion',
    'missing-final-completion',
    'duplicate-completion',
    'incomplete',
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario);
    assert.equal(result.stdout, '', scenario);
    assert.ok(
      ['MODEL_FAILED', 'MODEL_INCOMPLETE'].includes(legacyFailure(result.stderr).error),
      result.stderr,
    );
  }
});

test('CLI validates identity, input membership, exactly one result and observed supporting evidence', (t) => {
  for (const scenario of [
    'unobserved-source',
    'off-ranking',
    'missing-result',
    'duplicate-result',
    'malformed-judgment',
    'unknown-unobserved-source',
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario);
    assert.equal(result.stdout, '', scenario);
    assert.equal(legacyFailure(result.stderr).error, 'MODEL_OUTPUT', scenario + result.stderr);
  }
});

test('CLI excludes unsupported fixed types with empty evidence and preserves the rejected type', (t) => {
  for (const [scenario, submittedType] of [
    ['no-evidence', 'common'],
    ['no-evidence-excluded', 'etf'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'analysis_insufficient');
    assert.deepEqual(output.coverage, {
      input: 1,
      included: 0,
      excluded: 1,
      unconfirmed: 1,
      individualLookupFailures: 0,
      inclusionRate: 0,
    });
    const security = output.securities[0];
    assert.equal(security.type, 'unknown');
    assert.equal(security.applicable, false);
    assert.equal(security.included, false);
    assert.deepEqual(security.evidence, []);
    assert.deepEqual(security.typeRejection, {
      submittedType,
      reason: 'missing_type_evidence',
    });
    const models = result.requests.filter((request) => request.url.endsWith('/responses'));
    assert.equal(models.length, 2);
    assert.ok(models.at(-1).body.tools.some((tool) => tool.type === 'web_search'));
    assert.doesNotMatch(result.stdout, /synthetic-subscription|synthetic-identity|test-secret/);
  }
});

test('CLI discloses reduced assessment coverage and lookup failures', (t) => {
  const result = run(t, 'individual-lookup');
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).coverage, {
    input: 1,
    included: 0,
    excluded: 1,
    unconfirmed: 1,
    individualLookupFailures: 1,
    inclusionRate: 0,
  });
});

test('CLI preserves distinct share classes and applies all eligibility types to controlled model responses', (t) => {
  const result = run(t, 'types');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    output.securities.filter((item) => item.included).map((item) => item.symbol),
    ['AAPL', 'GOOG', 'GOOGL', 'BBDO'],
  );
  assert.deepEqual(
    output.securities.filter((item) => !item.included).map((item) => item.symbol),
    ['ACONW', 'BBD', 'BAC/B', 'BAC/L', 'SPY', 'VXX'],
  );
  assert.deepEqual(output.coverage, {
    input: 10,
    included: 4,
    excluded: 6,
    unconfirmed: 0,
    individualLookupFailures: 0,
    inclusionRate: 0.4,
  });
  assert.equal(output.securities.find((item) => item.symbol === 'BBD').type, 'preferred_adr');
  assert.equal(output.securities.find((item) => item.symbol === 'BBDO').type, 'common_adr');
});

test('CLI requires opened source context and rejects failed web research', (t) => {
  for (const scenario of ['search-only']) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '');
  }
  const opened = run(t, 'opened-source');
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(
    JSON.parse(opened.stdout).securities[0].evidence[0].source,
    'https://www.sec.gov/sample',
  );
});

test('CLI preserves request conditions for all six ranking observations', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  const observations = JSON.parse(result.stdout).observations;
  assert.equal(observations.length, 6);
  assert.deepEqual(observations[0].request, {
    path: '/uapi/overseas-stock/v1/ranking/trade-vol',
    trId: 'HHDFS76310010',
    params: { EXCD: 'NAS', NDAY: '0', VOL_RANG: '0', KEYB: '', AUTH: '', PRC1: '', PRC2: '' },
  });
});

test('CLI reports individual web-page failure as incomplete assessment rather than common outage', (t) => {
  const result = run(t, 'search-failed');
  assert.equal(result.status, 2, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'analysis_insufficient');
  assert.equal(output.webFailures.length, 1);
});

test('CLI distinguishes a tolerated page failure from a later output failure', (t) => {
  const result = run(t, 'search-failed', {
    TEST_SERIALIZATION_STAGE: 'output',
    TEST_OUTPUT_SERIALIZATION: '1',
    TEST_SERIALIZATION_EXCEPTION: 'private-output',
  });
  assert.equal(result.status, 1, result.stderr);
  const observation = JSON.parse(result.stderr).observation;
  const web = observation.operations.find((row) => row.name === 'types.web_tool' && row.failure);
  assert.equal(web.status, 'failed');
  assert.equal(web.failure.recovered, true);
  assert.equal(observation.firstFailure.recovered, true);
  const output = observation.operations.find((row) => row.name === 'output');
  assert.equal(observation.finalError.operationId, output.id);
});

test('CLI fails globally on failed search operations and unlocalized web failures', (t) => {
  for (const scenario of ['search-service-failed', 'search-scope-unknown']) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(legacyFailure(result.stderr).error, 'SEARCH_FAILED');
  }
});

test('CLI enforces information and hosted web-call ceilings without a successful partial result', (t) => {
  for (const scenario of ['info-limit', 'web-limit']) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(legacyFailure(result.stderr).error, 'MODEL_LIMIT');
    assert.ok(result.requests.filter((r) => r.url.includes('/search-info?')).length <= 32);
  }
});

test('CLI refuses unbounded paid search even when an API key exists after subscription exhaustion', (t) => {
  const result = run(t, 'quota-http', { OPENAI_API_KEY: 'synthetic-paid' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(legacyFailure(result.stderr).error, 'PAID_BUDGET_UNPROVABLE');
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 1);
  assert.doesNotMatch(result.stderr, /synthetic-paid/);
});

test('CLI reports ranking incompleteness in the ranking stage', (t) => {
  const result = run(t, 'ranking-incomplete');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(legacyFailure(result.stderr), {
    error: 'RANKING_INCOMPLETE',
    diagnostic: { stage: 'ranking', reason: 'RANKING_INCOMPLETE', location: null },
  });
  assert.equal(result.requests.length, 1);
  const url = new URL(result.requests[0].url);
  assert.equal(url.pathname, '/uapi/overseas-stock/v1/ranking/trade-vol');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    EXCD: 'NAS',
    NDAY: '0',
    VOL_RANG: '0',
    KEYB: '',
    AUTH: '',
    PRC1: '',
    PRC2: '',
  });
});

test('CLI carries confirmed identity and sensitive-output reasons from their internal failure sites', (t) => {
  for (const [scenario, reason] of [
    ['identity-conflict', 'IDENTITY_AMBIGUOUS'],
    ['sensitive-judgment', 'SENSITIVE_OUTPUT'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: reason,
      diagnostic: {
        stage: scenario === 'identity-conflict' ? 'ranking' : 'output',
        reason,
        location: null,
      },
    });
    assert.doesNotMatch(result.stderr, /synthetic-subscription/);
  }
});

test('CLI preserves retry time and login guidance with confirmed authentication reasons', (t) => {
  const retryAt = '2026-10-18T00:10:00.000Z';
  const blocked = run(t, 'ok', {}, undefined, {
    expiresAt: now + 300_000,
    earliestRefreshAt: retryAt,
  });
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.equal(blocked.stdout, '');
  assert.deepEqual(legacyFailure(blocked.stderr), {
    error: 'siwc_refresh_not_allowed',
    retryAt,
    diagnostic: { stage: 'authentication', reason: 'siwc_refresh_not_allowed', location: null },
  });
  assert.deepEqual(blocked.requests, []);
  const registration = Object.fromEntries(
    ['accessToken', 'idToken', 'refreshToken', 'tokenType', 'scopes', 'expiresAt'].map((key) => [
      key,
      undefined,
    ]),
  );
  const relogin = run(t, 'ok', {}, undefined, registration);
  assert.equal(relogin.status, 1, relogin.stderr);
  assert.equal(relogin.stdout, '');
  assert.deepEqual(legacyFailure(relogin.stderr), {
    error: 'siwc_relogin_required',
    action: 'login',
    diagnostic: { stage: 'authentication', reason: 'siwc_relogin_required', location: null },
  });
  assert.deepEqual(relogin.requests, []);
});

test('CLI keeps argument failures and unexpected input exceptions in input without requests', (t) => {
  for (const args of [
    [],
    ['ignored', 'bad model', '1'],
    ['ignored', 'gpt-6-luna', '0'],
    ['ignored', 'gpt-6-luna', '1', 'extra'],
    ['ignored', 'gpt-6-luna', '--evaluation-input', 'relative.json'],
    ['ignored', 'gpt-6-luna', '--evaluation-input'],
  ]) {
    const result = run(t, 'ok', { TEST_ARGUMENTS: JSON.stringify(args) });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: 'USAGE',
      diagnostic: { stage: 'input', reason: 'unknown', location: null },
    });
    assert.deepEqual(result.requests, []);
  }
  for (const [message, error] of [
    ['private-sentinel', 'MODEL_FAILED'],
    ['RANKING_INCOMPLETE', 'RANKING_INCOMPLETE'],
    ['siwc_relogin_required', 'siwc_relogin_required'],
  ]) {
    const result = run(t, 'ok', { TEST_ARGUMENT_EXCEPTION: message });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error,
      diagnostic: { stage: 'input', reason: 'unknown', location: null },
      ...(error === 'siwc_relogin_required' ? { action: 'login' } : {}),
    });
    assert.doesNotMatch(result.stderr, /private-sentinel/);
    assert.deepEqual(result.requests, []);
  }
});

test('CLI does not trust known identifiers, prefixes or reason properties on external exceptions', (t) => {
  for (const [message, error] of [
    ['RANKING_INCOMPLETE', 'siwc_refresh_failed'],
    ['siwc_private_sentinel', 'siwc_private_sentinel'],
    ['siwc_relogin_required', 'siwc_relogin_required'],
    ['siwc_refresh_not_allowed', 'siwc_refresh_not_allowed'],
  ]) {
    const result = run(t, 'ok', { TEST_STORAGE_EXCEPTION: message });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error,
      diagnostic: { stage: 'authentication', reason: 'unknown', location: null },
      ...(error === 'siwc_relogin_required' ? { action: 'login' } : {}),
      ...(error === 'siwc_refresh_not_allowed' ? { retryAt: '2026-10-18T00:10:00.000Z' } : {}),
    });
    assert.deepEqual(result.requests, []);
  }
});

test('CLI separates aggregated failures from a confirmed model authentication failure', (t) => {
  for (const [scenario, error, stage, reason] of [
    ['rank-failure', 'RANKING_FAILED', 'ranking', 'unknown'],
    ['global-lookup', 'QUERY_FAILED', 'assessment', 'unknown'],
    ['malformed-judgment', 'MODEL_OUTPUT', 'assessment', 'unknown'],
    ['auth-failure', 'AUTH_FAILED', 'assessment', 'AUTH_FAILED'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error,
      diagnostic: {
        stage,
        reason,
        location: scenario === 'malformed-judgment' ? 'judgments[0].applicable' : null,
      },
    });
  }
});

test('CLI preserves a confirmed sensitive lookup reason while keeping its legacy query error', (t) => {
  const result = run(t, 'sensitive-lookup');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(legacyFailure(result.stderr), {
    error: 'QUERY_FAILED',
    diagnostic: { stage: 'assessment', reason: 'SENSITIVE_OUTPUT', location: null },
  });
  assert.doesNotMatch(result.stderr, /synthetic-subscription/);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 1);
  const lookup = result.requests.filter((r) => r.url.includes('/search-info?'));
  assert.equal(lookup.length, 1);
  assert.deepEqual(Object.fromEntries(new URL(lookup[0].url).searchParams), {
    PRDT_TYPE_CD: '512',
    PDNO: 'AAPL',
  });
});

test('CLI keeps unexpected authentication and dynamic import failures in authentication', (t) => {
  for (const extraEnv of [
    { TEST_STORAGE_EXCEPTION: 'private-sentinel /private/path synthetic-subscription' },
    { TEST_IMPORT_EXCEPTION: 'private-sentinel /private/path synthetic-subscription' },
  ]) {
    const result = run(t, 'ok', extraEnv);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: extraEnv.TEST_STORAGE_EXCEPTION ? 'siwc_refresh_failed' : 'MODEL_FAILED',
      diagnostic: { stage: 'authentication', reason: 'unknown', location: null },
    });
    assert.deepEqual(result.requests, []);
  }
});

test('CLI keeps source rejection in assessment without an extra model request', (t) => {
  const result = run(
    t,
    'unobserved-source',
    {},
    {
      securities: [{ exchange: 'NAS', symbol: 'AAPL' }],
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(legacyFailure(result.stderr), {
    error: 'MODEL_OUTPUT',
    diagnostic: {
      stage: 'assessment',
      reason: 'unobserved_source',
      location: 'judgments[0].evidence[0].sourceId',
    },
  });
  assert.equal(result.requests.length, 3);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 2);
  assert.equal(result.requests.filter((r) => r.url.includes('/ranking/')).length, 0);
});

test('CLI retains assessment diagnostics until final judgment validation and output diagnostics for serialization', (t) => {
  for (const [scenario, stage, error, reason, location = null] of [
    [
      'invented-id',
      'assessment',
      'MODEL_OUTPUT',
      'unobserved_source',
      'judgments[0].evidence[0].sourceId',
    ],
    ['missing-result', 'assessment', 'MODEL_OUTPUT', 'unknown'],
    ['malformed-judgment', 'assessment', 'MODEL_OUTPUT', 'unknown', 'judgments[0].applicable'],
    ['sensitive-judgment', 'output', 'SENSITIVE_OUTPUT', 'SENSITIVE_OUTPUT'],
    ['ambiguous-sensitive', 'assessment', 'SENSITIVE_OUTPUT', 'SENSITIVE_OUTPUT'],
  ]) {
    const result = run(
      t,
      scenario,
      {},
      {
        securities: [{ exchange: 'NAS', symbol: 'AAPL' }],
      },
    );
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error,
      diagnostic: { stage, reason, location },
    });
    assert.equal(result.requests.length, 3);
    const models = result.requests.filter((r) => r.url.endsWith('/responses'));
    assert.equal(models.length, 2);
    assert.ok(models.at(-1).body.tools.some((tool) => tool.type === 'web_search'));
    assert.doesNotMatch(result.stderr, /synthetic-subscription/);
  }
});

test('CLI keeps KIS authentication failure in assessment with a confirmed safe reason', (t) => {
  const result = run(
    t,
    'lookup-auth',
    {},
    {
      securities: [{ exchange: 'NAS', symbol: 'AAPL' }],
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(legacyFailure(result.stderr), {
    error: 'AUTH_FAILED',
    diagnostic: { stage: 'assessment', reason: 'AUTH_FAILED', location: null },
  });
  assert.equal(result.requests.length, 3);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 1);
  const lookup = result.requests[1];
  assert.deepEqual(Object.fromEntries(new URL(lookup.url).searchParams), {
    PRDT_TYPE_CD: '512',
    PDNO: 'AAPL',
  });
  assert.equal(new URL(result.requests[2].url).pathname, '/oauth2/tokenP');
  assert.deepEqual(result.requests[2].body, {
    grant_type: 'client_credentials',
    appkey: 'test-key',
    appsecret: 'test-secret',
  });
  assert.doesNotMatch(result.stderr, /synthetic-subscription|test-token|test-key|test-secret/);
});

test('CLI preserves confirmed execution failure reasons without changing calls or limits', (t) => {
  for (const [scenario, stage, reason, requests] of [
    ['auth-failure', 'assessment', 'AUTH_FAILED', 1],
    ['search-unsupported', 'assessment', 'SEARCH_UNSUPPORTED', 1],
    ['quota-http', 'assessment', 'SUBSCRIPTION_LIMIT', 1],
    ['model-limit', 'assessment', 'MODEL_LIMIT', 12],
    ['assessment-overrun', 'assessment', 'MODEL_INCOMPLETE', 2],
    ['search-service-failed', 'assessment', 'SEARCH_FAILED', 2],
  ]) {
    const result = run(
      t,
      scenario,
      {},
      {
        securities: [{ exchange: 'NAS', symbol: 'AAPL' }],
      },
    );
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: reason,
      diagnostic: { stage, reason, location: null },
    });
    const models = result.requests.filter((r) => r.url.endsWith('/responses'));
    assert.equal(models.length, requests);
    for (const request of models) {
      assert.equal(request.body.model, 'gpt-6-luna');
      assert.equal(request.body.stream, true);
      assert.equal(request.body.store, false);
    }
    assert.equal(result.requests.filter((r) => r.url.includes('/ranking/')).length, 0);
    assert.ok(result.requests.filter((r) => r.url.includes('/search-info?')).length <= 12);
  }
});

test('CLI retains stages for unexpected preparation and final serialization failures without trusting messages', (t) => {
  for (const [stage, serialization, calls] of [
    ['assessment', undefined, 0],
    ['output', '1', 2],
    ['output', '2', 2],
  ]) {
    for (const message of [
      'private-sentinel /private/path synthetic-subscription',
      'AUTH_FAILED',
      'siwc_relogin_required',
    ]) {
      const result = run(
        t,
        'ok',
        {
          TEST_SERIALIZATION_STAGE: stage,
          TEST_OUTPUT_SERIALIZATION: serialization,
          TEST_SERIALIZATION_EXCEPTION: message,
        },
        { securities: [{ exchange: 'NAS', symbol: 'AAPL' }] },
      );
      assert.equal(result.status, 1, stage + result.stderr);
      assert.equal(result.stdout, '');
      assert.deepEqual(legacyFailure(result.stderr), {
        error:
          message === 'AUTH_FAILED' || message === 'siwc_relogin_required'
            ? message
            : 'MODEL_FAILED',
        diagnostic: { stage, reason: 'unknown', location: null },
        ...(message === 'siwc_relogin_required' ? { action: 'login' } : {}),
      });
      assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, calls);
      assert.equal(
        result.requests.filter((r) => r.url.includes('/search-info?')).length,
        calls ? 1 : 0,
      );
      assert.doesNotMatch(
        result.stderr,
        /private-sentinel|private.path|synthetic-subscription|private-field|private-value/,
      );
    }
  }
});

test('CLI leaves unregistered HTTP exceptions unknown within the active model stage', (t) => {
  for (const [stage, calls] of [['assessment', 1]]) {
    for (const message of [
      'AUTH_FAILED',
      'siwc_relogin_required',
      'private-sentinel /private/path synthetic-subscription',
    ]) {
      const result = run(
        t,
        'ok',
        {
          TEST_HTTP_EXCEPTION_STAGE: stage,
          TEST_HTTP_EXCEPTION: message,
        },
        { securities: [{ exchange: 'NAS', symbol: 'AAPL' }] },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      assert.deepEqual(legacyFailure(result.stderr), {
        error: 'MODEL_FAILED',
        diagnostic: { stage, reason: 'unknown', location: null },
      });
      assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, calls);
      assert.equal(
        result.requests.filter((r) => r.url.includes('/search-info?')).length,
        calls === 1 ? 0 : 1,
      );
    }
  }
});

test('CLI preserves ranking failures and confirmed authentication causes without extra requests', (t) => {
  for (const [scenario, count, reason] of [
    ['rank-failure', 5, 'unknown'],
    ['ranking-shape', 1, 'unknown'],
    ['ranking-invalid-row', 1, 'unknown'],
    ['ranking-first-failure', 2, 'unknown'],
    ['ranking-http-auth', 1, 'unknown'],
    ['ranking-auth', 2, 'AUTH_FAILED'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: 'RANKING_FAILED',
      diagnostic: { stage: 'ranking', reason, location: null },
    });
    assert.equal(result.requests.length, count, scenario);
    for (const [index, request] of result.requests.entries()) {
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://openapi.koreainvestment.com:9443');
      if (scenario === 'ranking-auth' && index === 1) {
        assert.equal(url.pathname, '/oauth2/tokenP');
        assert.deepEqual(request.body, {
          grant_type: 'client_credentials',
          appkey: 'test-key',
          appsecret: 'test-secret',
        });
        continue;
      }
      assert.equal(
        url.pathname,
        index % 2 === 0
          ? '/uapi/overseas-stock/v1/ranking/trade-vol'
          : '/uapi/overseas-stock/v1/ranking/trade-pbmn',
      );
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        EXCD: ['NAS', 'NYS', 'AMS'][Math.floor(index / 2)],
        NDAY: '0',
        VOL_RANG: '0',
        KEYB: '',
        AUTH: '',
        PRC1: '',
        PRC2: '',
      });
      assert.equal(request.body, null);
    }
    assert.doesNotMatch(result.stderr, /synthetic-|test-key|test-secret|private-|EGW00123/);
  }
});

test('CLI keeps unexpected ranking HTTP exceptions unknown without trusting messages or fields', (t) => {
  for (const message of [
    'AUTH_FAILED',
    'siwc_relogin_required',
    'private-sentinel /private/path synthetic-subscription',
  ]) {
    const result = run(t, 'ranking-exception', { TEST_RANKING_EXCEPTION: message });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: 'RANKING_FAILED',
      diagnostic: { stage: 'ranking', reason: 'unknown', location: null },
    });
    assert.equal(result.requests.length, 1);
    assert.equal(
      new URL(result.requests[0].url).pathname,
      '/uapi/overseas-stock/v1/ranking/trade-vol',
    );
    assert.doesNotMatch(result.stderr, /private-|synthetic-|EGW00123|siwc_relogin_required/);
  }
});

test('CLI reports integrated failed statistics at the elapsed total deadline', (t) => {
  const result = run(t, 'assessment-overrun');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(withoutSnapshot(result.stderr), {
    error: 'MODEL_INCOMPLETE',
    diagnostic: {
      stage: 'assessment',
      reason: 'MODEL_INCOMPLETE',
      location: null,
      statistics: {
        status: 'failed',
        elapsedMs: 180000,
        modelRequests: 2,
        infoToolCalls: 1,
        observedWebToolCalls: 1,
      },
    },
  });
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 2);
  const lookup = result.requests.find((r) => r.url.includes('/search-info?'));
  assert.deepEqual(Object.fromEntries(new URL(lookup.url).searchParams), {
    PRDT_TYPE_CD: '512',
    PDNO: 'AAPL',
  });
});

test('CLI counts completed tool work in the single flow timing', (t) => {
  const result = run(t, 'past-former-deadline');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).statistics, {
    status: 'completed',
    elapsedMs: 120000,
    modelRequests: 2,
    infoToolCalls: 1,
    observedWebToolCalls: 1,
  });
});

test('CLI counts failed HTTP attempts, tool work and validation time in integrated statistics', (t) => {
  for (const [scenario, extra, elapsedMs, requests, infos, webs] of [
    ['auth-failure', {}, 7, 1, 0, 0],
    ['global-lookup', {}, 18, 1, 1, 1],
    ['unobserved-source', {}, 25, 2, 1, 1],
    ['malformed-judgment', {}, 25, 2, 1, 1],
    ['malformed-judgment', { TEST_WALL_CLOCK_SHIFT: '-60000' }, 25, 2, 1, 1],
    [
      'web-duplicates',
      { TEST_HTTP_EXCEPTION_STAGE: 'assessment', TEST_HTTP_EXCEPTION_AFTER: '1' },
      25,
      2,
      1,
      2,
    ],
    ['ok', { TEST_HTTP_EXCEPTION_STAGE: 'assessment' }, 7, 1, 0, 0],
  ]) {
    const result = run(t, scenario, {
      TEST_STATISTICS_CLOCK: '1',
      TEST_HTTP_EXCEPTION: 'private-field private-value /private/path synthetic-subscription',
      ...extra,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    const diagnostic = JSON.parse(result.stderr).diagnostic;
    assert.equal(diagnostic.stage, 'assessment');
    assert.deepEqual(
      diagnostic.statistics,
      {
        status: 'failed',
        elapsedMs,
        modelRequests: requests,
        infoToolCalls: infos,
        observedWebToolCalls: webs,
      },
      scenario,
    );
    assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, requests);
    assert.equal(result.requests.filter((r) => r.url.includes('/search-info?')).length, infos);
    for (const request of result.requests.filter((r) => r.url.endsWith('/responses'))) {
      assert.equal(request.body.model, 'gpt-6-luna');
      assert.equal(request.body.stream, true);
      assert.equal(request.body.store, false);
    }
    assert.doesNotMatch(
      result.stderr,
      /private-field|private-value|private-id|private.path|synthetic-subscription|test-key|test-secret/,
    );
  }
});

test('CLI reports total blocked time and observed work through cancellation', (t) => {
  for (const [scenario, infos, webs] of [
    ['info-blocked', 1, 1],
    ['model-blocked', 0, 0],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr).diagnostic.statistics, {
      status: 'failed',
      elapsedMs: 180000,
      modelRequests: 1,
      infoToolCalls: infos,
      observedWebToolCalls: webs,
    });
  }
});

test('CLI statistics preserve the existing request and tool ceilings', (t) => {
  for (const [scenario, models, infos, webs] of [
    ['model-limit', 12, 12, 1],
    ['info-limit', 2, 33, 1],
    ['web-limit', 2, 1, 33],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stderr).diagnostic.typeAssessment.requests.length, models);
    assert.deepEqual(JSON.parse(result.stderr).diagnostic.statistics, {
      status: 'failed',
      elapsedMs: 0,
      modelRequests: models,
      infoToolCalls: infos,
      observedWebToolCalls: webs,
    });
    assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, models);
    assert.equal(
      result.requests.filter((r) => r.url.includes('/search-info?')).length,
      Math.min(infos, 32),
    );
  }
});

test('CLI identifies the first missing evidence field at its response location', (t) => {
  const result = run(t, 'missing-explanation');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(legacyFailure(result.stderr), {
    error: 'MODEL_OUTPUT',
    diagnostic: {
      stage: 'assessment',
      reason: 'missing_required_field',
      location: 'judgments[0].evidence[0].explanation',
    },
  });
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 2);
});

test('CLI distinguishes source and reference failures without additional requests', (t) => {
  for (const [scenario, stage, reason, location] of [
    ['unobserved-source', 'assessment', 'unobserved_source', 'judgments[0].evidence[0].sourceId'],
    ['invented-id', 'assessment', 'unobserved_source', 'judgments[0].evidence[0].sourceId'],
    [
      'types-cross-id',
      'assessment',
      'cross_security_evidence',
      'judgments[0].evidence[0].sourceId',
    ],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: 'MODEL_OUTPUT',
      diagnostic: { stage, reason, location },
    });
    const models = result.requests.filter((r) => r.url.endsWith('/responses'));
    assert.equal(models.length, 2);
    assert.equal(models[0].body.model, 'gpt-6-luna');
    assert.equal(models[0].body.stream, true);
    assert.equal(models[0].body.store, false);
    assert.ok(models.at(-1).body.tools.some((tool) => tool.type === 'web_search'));
    assert.doesNotMatch(
      JSON.stringify(withoutSnapshot(result.stderr)),
      /synthetic-|test-key|test-secret|invented|https:/,
    );
  }
});

test('CLI reports safe final response paths and preserves structural validation before reference checks', (t) => {
  const evidence = { sourceId: 's1', explanation: 'Common stock' };
  const judgment = {
    exchange: 'NAS',
    symbol: 'AAPL',
    type: 'common',
    identity: 'confirmed',
    applicable: true,
    reason: 'Common stock',
    evidence: [evidence],
  };
  const missingEvidence = { sourceId: 'private-source synthetic-subscription' };
  const missingJudgment = {
    ...judgment,
    evidence: [{ sourceId: 'private-source synthetic-subscription', explanation: 'Common' }],
  };
  delete missingJudgment.reason;
  for (const [value, reason, location, scenario] of [
    [{}, 'missing_required_field', null],
    [
      { judgments: [{ ...judgment, evidence: ['private-source synthetic-subscription'] }] },
      'unknown',
      'judgments[0].evidence',
    ],
    [
      { judgments: [{ ...judgment, evidence: [{ sourceId: null, explanation: 'Common' }] }] },
      'unknown',
      'judgments[0].evidence[0].sourceId',
    ],
    [
      { judgments: [{ ...judgment, evidence: [missingEvidence] }] },
      'missing_required_field',
      'judgments[0].evidence[0].explanation',
    ],
    [
      {
        judgments: [{ ...judgment, evidence: [{ sourceId: 's999', explanation: 'Common' }] }, null],
      },
      'unknown',
      'judgments[1]',
    ],
    [{ judgments: [missingJudgment] }, 'missing_required_field', 'judgments[0].reason'],
    [{ judgments: [judgment, missingJudgment] }, 'missing_required_field', 'judgments[1].reason'],
    [
      {
        judgments: [
          { ...judgment, symbol: 'GOOG', evidence: [{ sourceId: 's2', explanation: 'Common' }] },
          {
            ...judgment,
            evidence: [
              { sourceId: 'private-source synthetic-subscription', explanation: 'Common' },
            ],
          },
        ],
      },
      'unobserved_source',
      'judgments[1].evidence[0].sourceId',
      'types',
    ],
    [
      { judgments: [{ ...judgment, 'private-field synthetic-subscription': '/private/path' }] },
      'unknown',
      'judgments[0]',
    ],
    [{ judgments: [] }, 'unknown', null],
  ]) {
    const result = run(t, scenario ?? 'ok', {
      TEST_RESPONSE_STAGE: 'assessment',
      TEST_RESPONSE_VALUE: JSON.stringify(value),
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: 'MODEL_OUTPUT',
      diagnostic: { stage: 'assessment', reason, location },
    });
    assert.doesNotMatch(result.stderr, /private-|synthetic-|test-key|test-secret/);
    const models = result.requests.filter((r) => r.url.endsWith('/responses'));
    assert.equal(models.length, 2);
    assert.equal(models.at(-1).body.store, false);
    assert.equal(models.at(-1).body.stream, true);
    const info = result.requests.filter((r) => r.url.includes('/search-info?'));
    assert.equal(info.length, scenario === 'types' ? 10 : 1);
    assert.deepEqual(Object.fromEntries(new URL(info[0].url).searchParams), {
      PRDT_TYPE_CD: '512',
      PDNO: 'AAPL',
    });
  }
});

test('CLI integrates final evidence rejection, original input and total statistics for reordered securities', (t) => {
  const judgment = {
    exchange: 'NAS',
    symbol: 'GOOG',
    type: 'common',
    identity: 'confirmed',
    applicable: true,
    reason: 'Common stock',
    evidence: [{ sourceId: 's2', explanation: 'Common stock' }],
  };
  const invalid = {
    ...judgment,
    symbol: 'AAPL',
    evidence: [{ sourceId: 'private-source synthetic-subscription' }],
  };
  const result = run(t, 'types', {
    TEST_STATISTICS_CLOCK: '1',
    TEST_RESPONSE_STAGE: 'assessment',
    TEST_RESPONSE_VALUE: JSON.stringify({ judgments: [judgment, invalid] }),
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(withoutSnapshot(result.stderr), {
    error: 'MODEL_OUTPUT',
    diagnostic: {
      stage: 'assessment',
      reason: 'missing_required_field',
      location: 'judgments[1].evidence[0].explanation',
      statistics: {
        status: 'failed',
        elapsedMs: 124,
        modelRequests: 2,
        infoToolCalls: 10,
        observedWebToolCalls: 0,
      },
    },
  });
  assert.doesNotMatch(result.stderr, /private-|private.path|synthetic-|test-key|test-secret/);
  const models = result.requests.filter((r) => r.url.endsWith('/responses'));
  assert.equal(models.length, 2);
  const prompt = JSON.parse(
    models[0].body.input.find((item) => item.role === 'user').content[0].text,
  );
  assert.equal(prompt.securities[0].symbol, 'AAPL');
  assert.ok(
    models.every((request) => request.body.tools.some((tool) => tool.type === 'web_search')),
  );
  const lookups = result.requests.filter((request) => request.url.includes('/search-info?'));
  assert.equal(lookups.length, 10);
  assert.deepEqual(Object.fromEntries(new URL(lookups[0].url).searchParams), {
    PRDT_TYPE_CD: '512',
    PDNO: 'AAPL',
  });
});

test('CLI retains original six-ranking input and settings when assessment times out', (t) => {
  const result = run(t, 'info-blocked');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error, 'MODEL_INCOMPLETE');
  const snapshot = failure.diagnostic.inputSnapshot;
  assert.equal(snapshot.model, 'gpt-6-luna');
  assert.equal(snapshot.inputMode, 'rankings');
  assert.equal(snapshot.topPerRanking, 1);
  assert.equal(snapshot.observations.length, 6);
  assert.equal(snapshot.securities[0].exchange, 'NAS');
  assert.equal(snapshot.securities[0].symbol, 'AAPL');
  assert.equal(snapshot.securities[0].rsym, 'DNASAAPL');
  assert.deepEqual(
    snapshot.securities[0].rankings.map(({ kind, rank }) => ({ kind, rank })),
    [
      { kind: 'volume', rank: 1 },
      { kind: 'amount', rank: 1 },
    ],
  );
  assert.doesNotMatch(result.stderr, /synthetic-subscription|synthetic-refresh|test-secret/);
});

function withoutSnapshot(stderr) {
  const output = JSON.parse(stderr);
  delete output.observation;
  delete output.diagnostic.inputSnapshot;
  delete output.diagnostic.elapsedMs;
  delete output.diagnostic.typeAssessment;
  return output;
}

test('CLI preserves empty and partially collected ranking observations on failure', (t) => {
  const empty = run(t, 'empty-rankings');
  assert.equal(empty.status, 1, empty.stderr);
  const failure = JSON.parse(empty.stderr);
  assert.equal(failure.error, 'ANALYSIS_INSUFFICIENT');
  assert.deepEqual(failure.diagnostic.inputSnapshot.securities, []);
  assert.equal(failure.diagnostic.inputSnapshot.observations.length, 6);
  assert.ok(failure.diagnostic.inputSnapshot.observations.every((row) => row.rowCount === 0));
  assert.equal(empty.requests.filter((row) => row.url.endsWith('/responses')).length, 0);
  const partial = run(t, 'rank-failure');
  assert.equal(partial.status, 1, partial.stderr);
  const snapshot = JSON.parse(partial.stderr).diagnostic.inputSnapshot;
  assert.equal(snapshot.observations.length, 4);
  assert.equal(snapshot.securities[0].symbol, 'AAPL');
});

test('CLI reports measured successful coverage and total execution statistics', (t) => {
  const result = run(t, 'ok', { TEST_STATISTICS_CLOCK: '1' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.coverage.inclusionRate, 1);
  assert.deepEqual(output.statistics, {
    status: 'completed',
    elapsedMs: 25,
    modelRequests: 2,
    infoToolCalls: 1,
    observedWebToolCalls: 1,
  });
});

test('CLI omits the entire input snapshot if it contains an existing secret', (t) => {
  const result = run(t, 'ok', { OPENAI_API_KEY: 'AAPL' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error, 'SENSITIVE_OUTPUT');
  assert.equal(failure.diagnostic.inputSnapshot, undefined);
  assert.doesNotMatch(result.stderr, /AAPL|test-key|test-secret|synthetic-/);
  assert.equal(result.requests.filter((row) => row.url.endsWith('/responses')).length, 0);
});

test('CLI snapshot excludes mutations from a ranking that later fails validation', (t) => {
  const result = run(t, 'partial-ranking-incomplete');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error, 'RANKING_INCOMPLETE');
  const snapshot = failure.diagnostic.inputSnapshot;
  assert.equal(snapshot.observations.length, 1);
  assert.deepEqual(
    snapshot.securities[0].rankings.map(({ kind, rank }) => ({ kind, rank })),
    [{ kind: 'volume', rank: 1 }],
  );
  assert.equal(result.requests.filter((row) => row.url.endsWith('/responses')).length, 0);
});

test('CLI binds final source IDs to original KIS sources', (t) => {
  const result = run(t, 'kis-specific', {}, { securities: [{ exchange: 'NYS', symbol: 'BAC/B' }] });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const requests = result.requests.filter((row) => row.url.endsWith('/responses'));
  const info = requests[1].body.input.find((row) => row.type === 'function_call_output');
  const infoOutput = JSON.parse(info.output);
  assert.equal(infoOutput.sourceId, 's1');
  assert.equal(output.securities[0].evidence[0].source, 'kis:NYS:BAC/B');
  assert.equal(output.securities[0].type, 'preferred');
  assert.equal(output.securities[0].evidence[0].sourceId, 's1');
  assert.ok(requests.at(-1).body.tools.some((tool) => tool.type === 'web_search'));
});

test('CLI lists only successful opened sources with stable IDs throughout assessment', (t) => {
  const result = run(t, 'catalog');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.securities[0].evidence[0].source, 'https://www.sec.gov/catalog-source');
  assert.equal(output.securities[0].evidence[0].sourceId, 's1');
  assert.equal(output.webFailures.length, 1);
  const models = result.requests.filter((row) => row.url.endsWith('/responses'));
  assert.equal(models.length, 2);
  const returned = JSON.parse(
    models[1].body.input.find(
      (row) => row.type === 'function_call_output' && row.call_id === 'call_sources',
    ).output,
  );
  assert.deepEqual(returned, [{ id: 's1', source: 'https://www.sec.gov/catalog-source' }]);
  assert.ok(models.at(-1).body.tools.some((tool) => tool.type === 'web_search'));
  assert.equal(result.requests.filter((row) => row.url.includes('/search-info')).length, 0);
});

test('CLI preserves successful hosted web history and emits one JSON failure after a failed page', (t) => {
  const result = run(t, 'catalog-unknown-id');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(error.error, 'MODEL_OUTPUT');
  assert.equal(error.diagnostic.reason, 'unobserved_source');
  assert.equal(error.diagnostic.location, 'judgments[0].evidence[0].sourceId');
  const models = result.requests.filter((row) => row.url.endsWith('/responses'));
  assert.equal(models.length, 2);
  assert.deepEqual(
    models[1].body.input
      .filter((row) => row.type === 'web_search_call')
      .map((row) => row.action.type),
    ['search', 'open_page', 'find_in_page'],
  );
  assert.ok(
    models[1].body.input.some(
      (row) => row.type === 'function_call_output' && row.call_id === 'call_sources',
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(withoutSnapshot(result.stderr)),
    /https:|synthetic-|test-secret/,
  );
});

test('CLI rejects an extra freely written source URL even beside a registered source ID', (t) => {
  const result = run(t, 'ok', {
    TEST_RESPONSE_STAGE: 'assessment',
    TEST_RESPONSE_VALUE: JSON.stringify({
      judgments: [
        {
          exchange: 'NAS',
          symbol: 'AAPL',
          type: 'common',
          identity: 'confirmed',
          applicable: true,
          reason: 'Common stock',
          evidence: [
            { sourceId: 's1', source: 'https://example.org/unread', explanation: 'Common stock' },
          ],
        },
      ],
    }),
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(legacyFailure(result.stderr), {
    error: 'MODEL_OUTPUT',
    diagnostic: {
      stage: 'assessment',
      reason: 'unknown',
      location: 'judgments[0].evidence[0]',
    },
  });
  assert.doesNotMatch(result.stderr, /example.org\/unread/);
});

test('CLI uses luna for development fixtures and preserves explicitly chosen production models', (t) => {
  for (const model of ['gpt-6-luna', 'gpt-6-astra', 'gpt-6.1-sol']) {
    const result = run(t, 'ok', { TEST_MODEL: model });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).model.id, model);
    assert.ok(
      result.requests
        .filter((row) => row.url.endsWith('/responses'))
        .every((row) => row.body.model === model),
    );
  }
});

test('CLI counts source-catalog turns against existing shared time and model ceilings', (t) => {
  for (const [scenario, error, count] of [
    ['catalog-overrun', 'MODEL_INCOMPLETE', 2],
    ['catalog-model-limit', 'MODEL_LIMIT', 12],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, error);
    assert.equal(result.requests.filter((row) => row.url.endsWith('/responses')).length, count);
  }
});

test('CLI rejects unregistered source references and sensitive opened URLs without partial output', (t) => {
  for (const [scenario, error, count] of [
    ['catalog-search-only-id', 'MODEL_OUTPUT', 2],
    ['catalog-sensitive', 'SENSITIVE_OUTPUT', 1],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, error);
    assert.doesNotMatch(result.stderr, /synthetic-subscription|test-secret/);
    assert.equal(result.requests.filter((row) => row.url.endsWith('/responses')).length, count);
  }
});

test('CLI excludes a type confirmed only from a KIS broad stock code and product name', (t) => {
  const result = run(t, 'kis-name-only', {}, { securities: [{ exchange: 'AMS', symbol: 'SPY' }] });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'analysis_insufficient');
  const security = output.securities[0];
  assert.equal(security.type, 'unknown');
  assert.equal(security.applicable, false);
  assert.equal(security.included, false);
  assert.deepEqual(security.typeRejection, {
    submittedType: 'etf',
    reason: 'kis_broad_stock_only',
  });
  assert.equal(security.evidence[0].source, 'kis:AMS:SPY');
  assert.equal(output.lookups[0].record.rows[0].ovrs_stck_dvsn_cd, '01');
  assert.equal(output.coverage.unconfirmed, 1);
  assert.equal(output.statistics.status, 'completed');
  assert.equal(result.requests.filter((request) => request.url.endsWith('/responses')).length, 2);
});

test('CLI preserves unknown exclusions and independent type evidence beside a broad KIS identity record', (t) => {
  const input = { securities: [{ exchange: 'AMS', symbol: 'SPY' }] };
  const unknown = run(t, 'kis-name-unknown', {}, input);
  assert.equal(unknown.status, 2, unknown.stderr);
  const insufficient = JSON.parse(unknown.stdout);
  assert.equal(insufficient.status, 'analysis_insufficient');
  assert.equal(insufficient.securities[0].type, 'unknown');
  assert.equal(insufficient.securities[0].typeRejection, undefined);
  assert.equal(insufficient.coverage.unconfirmed, 1);
  const independent = run(t, 'kis-name-with-web', {}, input);
  assert.equal(independent.status, 0, independent.stderr);
  const assessed = JSON.parse(independent.stdout);
  assert.equal(assessed.securities[0].type, 'etf');
  assert.equal(assessed.securities[0].typeRejection, undefined);
  assert.deepEqual(
    assessed.securities[0].evidence.map((record) => record.source),
    ['kis:AMS:SPY', 'https://www.sec.gov/controlled-security-type'],
  );
  const requests = independent.requests.filter((request) => request.url.endsWith('/responses'));
  assert.equal(requests.length, 2);
  assert.ok(requests.at(-1).body.tools.some((tool) => tool.type === 'web_search'));
});

test('CLI excludes an identity-unconfirmed common stock and preserves the remaining ranking batch', (t) => {
  const result = run(t, 'types-identity-mixed');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'assessed');
  assert.deepEqual(output.coverage, {
    input: 10,
    included: 3,
    excluded: 7,
    unconfirmed: 1,
    individualLookupFailures: 0,
    inclusionRate: 0.3,
  });
  const excluded = output.securities[0];
  assert.equal(excluded.exchange, 'NAS');
  assert.equal(excluded.symbol, 'AAPL');
  assert.equal(excluded.rsym, 'DNASAAPL');
  assert.equal(excluded.rankings[0].kind, 'volume');
  assert.equal(excluded.rankings[0].rank, 1);
  assert.equal(excluded.identity, 'ambiguous');
  assert.equal(excluded.type, 'unknown');
  assert.equal(excluded.applicable, false);
  assert.equal(excluded.included, false);
  assert.deepEqual(excluded.typeRejection, {
    submittedType: 'common',
    reason: 'identity_unconfirmed',
  });
  assert.equal(excluded.reason, 'The listed security identity could not be confirmed.');
  assert.equal(excluded.evidence[0].source, 'kis:NAS:AAPL');
  assert.deepEqual(
    output.securities.filter((row) => row.included).map((row) => row.symbol),
    ['GOOG', 'GOOGL', 'BBDO'],
  );
});

test('CLI reports all identity-unconfirmed securities as analysis insufficient without confirmed types', (t) => {
  const result = run(t, 'identity-all');
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'analysis_insufficient');
  assert.deepEqual(output.coverage, {
    input: 2,
    included: 0,
    excluded: 2,
    unconfirmed: 2,
    individualLookupFailures: 0,
    inclusionRate: 0,
  });
  assert.deepEqual(
    output.securities.map((row) => ({
      symbol: row.symbol,
      identity: row.identity,
      type: row.type,
      applicable: row.applicable,
      included: row.included,
      ...row.typeRejection,
    })),
    [
      {
        symbol: 'AAPL',
        identity: 'ambiguous',
        type: 'unknown',
        applicable: false,
        included: false,
        submittedType: 'common',
        reason: 'identity_unconfirmed',
      },
      {
        symbol: 'SPY',
        identity: 'ambiguous',
        type: 'unknown',
        applicable: false,
        included: false,
        submittedType: 'unknown',
        reason: 'identity_unconfirmed',
      },
    ],
  );
});

test('CLI distinguishes a confirmed excluded ETF from an identity-unconfirmed security in reordered results', (t) => {
  const result = run(t, 'identity-reordered');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'assessed');
  assert.deepEqual(output.coverage, {
    input: 2,
    included: 0,
    excluded: 2,
    unconfirmed: 1,
    individualLookupFailures: 0,
    inclusionRate: 0,
  });
  const [etf, ambiguous] = output.securities;
  assert.equal(etf.symbol, 'SPY');
  assert.equal(etf.exchange, 'AMS');
  assert.equal(etf.rsym, 'DAMSSPY');
  assert.deepEqual(
    etf.rankings.map(({ kind, rank }) => ({ kind, rank })),
    [{ kind: 'amount', rank: 1 }],
  );
  assert.equal(etf.identity, 'confirmed');
  assert.equal(etf.type, 'etf');
  assert.equal(etf.applicable, true);
  assert.equal(etf.included, false);
  assert.equal(etf.typeRejection, undefined);
  assert.equal(ambiguous.symbol, 'AAPL');
  assert.equal(ambiguous.exchange, 'NAS');
  assert.equal(ambiguous.rsym, 'DNASAAPL');
  assert.deepEqual(
    ambiguous.rankings.map(({ kind, rank }) => ({ kind, rank })),
    [{ kind: 'volume', rank: 1 }],
  );
  assert.equal(ambiguous.typeRejection.reason, 'identity_unconfirmed');
});

test('CLI validates every source and original input before excluding ambiguous identities', (t) => {
  for (const [scenario, reason, location] of [
    ['identity-unknown-source', 'unobserved_source', 'judgments[0].evidence[0].sourceId'],
    ['identity-cross-source', 'cross_security_evidence', 'judgments[0].evidence[0].sourceId'],
    ['identity-other-unknown-source', 'unobserved_source', 'judgments[1].evidence[0].sourceId'],
    ['identity-missing', 'unknown', null],
    ['identity-duplicate', 'unknown', 'judgments[2]'],
    ['identity-outside', 'unknown', 'judgments[0]'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: 'MODEL_OUTPUT',
      diagnostic: { stage: 'assessment', reason, location },
    });
    assert.equal(result.requests.filter((row) => row.url.endsWith('/responses')).length, 2);
    assert.equal(result.requests.filter((row) => row.url.includes('/ranking/')).length, 6);
    assert.doesNotMatch(result.stderr, /synthetic-subscription|synthetic-identity|test-secret/);
  }
});

test('CLI continues a ranking batch after individual type rejections and reports reduced coverage', (t) => {
  const result = run(t, 'types-partial-evidence');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'assessed');
  assert.deepEqual(output.coverage, {
    input: 10,
    included: 2,
    excluded: 8,
    unconfirmed: 2,
    individualLookupFailures: 0,
    inclusionRate: 0.2,
  });
  assert.deepEqual(
    output.securities.filter((security) => security.included).map((security) => security.symbol),
    ['GOOGL', 'BBDO'],
  );
  assert.deepEqual(
    output.securities
      .filter((security) => security.type === 'unknown')
      .map((security) => ({
        symbol: security.symbol,
        applicable: security.applicable,
        included: security.included,
        ...security.typeRejection,
      })),
    [
      {
        symbol: 'AAPL',
        applicable: false,
        included: false,
        submittedType: 'common',
        reason: 'kis_broad_stock_only',
      },
      {
        symbol: 'GOOG',
        applicable: false,
        included: false,
        submittedType: 'common',
        reason: 'missing_type_evidence',
      },
    ],
  );
  const rejected = output.securities[0];
  assert.equal(rejected.exchange, 'NAS');
  assert.equal(rejected.rsym, 'DNASAAPL');
  assert.equal(rejected.rankings[0].kind, 'volume');
  assert.equal(rejected.rankings[0].rank, 1);
  assert.equal(rejected.evidence[0].sourceId, 's1');
  assert.equal(rejected.evidence[0].source, 'kis:NAS:AAPL');
  assert.equal(output.securities[2].typeRejection, undefined);
  assert.equal(output.model.requests, 2);
  const models = result.requests.filter((request) => request.url.endsWith('/responses'));
  assert.ok(models.at(-1).body.tools.some((tool) => tool.type === 'web_search'));
  assert.doesNotMatch(result.stdout, /synthetic-subscription|synthetic-identity|test-secret/);
});

test('CLI does not hide reference or identity errors behind individual type rejections', (t) => {
  for (const [scenario, error, reason, location] of [
    [
      'types-partial-invalid-id',
      'MODEL_OUTPUT',
      'unobserved_source',
      'judgments[2].evidence[0].sourceId',
    ],
    [
      'types-partial-cross-id',
      'MODEL_OUTPUT',
      'cross_security_evidence',
      'judgments[2].evidence[0].sourceId',
    ],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error,
      diagnostic: { stage: 'assessment', reason, location },
    });
    assert.equal(result.requests.filter((request) => request.url.endsWith('/responses')).length, 2);
  }
});

test('CLI distinguishes identity exclusion from confirmed-identity type rejections in the same batch', (t) => {
  const result = run(t, 'types-partial-ambiguous');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.coverage.unconfirmed, 3);
  assert.equal(output.coverage.included, 2);
  assert.deepEqual(
    output.securities.slice(0, 3).map((row) => ({
      symbol: row.symbol,
      identity: row.identity,
      type: row.type,
      included: row.included,
      reason: row.typeRejection.reason,
      submittedType: row.typeRejection.submittedType,
    })),
    [
      {
        symbol: 'AAPL',
        identity: 'confirmed',
        type: 'unknown',
        included: false,
        reason: 'kis_broad_stock_only',
        submittedType: 'common',
      },
      {
        symbol: 'GOOG',
        identity: 'confirmed',
        type: 'unknown',
        included: false,
        reason: 'missing_type_evidence',
        submittedType: 'common',
      },
      {
        symbol: 'ACONW',
        identity: 'ambiguous',
        type: 'unknown',
        included: false,
        reason: 'identity_unconfirmed',
        submittedType: 'warrant',
      },
    ],
  );
});

test('CLI does not replace a previously observed specific KIS code with a later broad stock observation', (t) => {
  const result = run(
    t,
    'kis-specific-repeat',
    {},
    { securities: [{ exchange: 'NYS', symbol: 'BAC/B' }] },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    output.lookups.map((lookup) => lookup.record.rows[0].ovrs_stck_dvsn_cd),
    ['04', '01'],
  );
  assert.deepEqual(
    output.lookups.map((lookup) => lookup.sourceId),
    ['s1', 's1'],
  );
  assert.equal(output.securities[0].type, 'preferred');
});
