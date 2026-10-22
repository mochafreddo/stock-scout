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
  if (['retrieval', 'judgment'].includes(output.diagnostic.stage)) {
    assert.ok(output.diagnostic.statistics);
    delete output.diagnostic.statistics;
  }
  return output;
}

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
      'gpt-6.1-sol',
      ...(evaluationInput === undefined
        ? [scenario.startsWith('types') ? '2' : '1']
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
  assert.equal(output.securities[0].evidence[0].source, 'kis:NAS:AAPL');
  assert.equal(result.requests.filter((r) => r.url.includes('/ranking/')).length, 6);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 3);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /test-token|test-secret|synthetic-subscription|synthetic-refresh/,
  );
});

test('CLI gives final judgment only code-assigned evidence IDs and no lookup tools', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const finalRequest = result.requests.filter((r) => r.url.endsWith('/responses')).at(-1).body;
  assert.equal(finalRequest.tools?.length ?? 0, 0);
  const prompt = JSON.parse(
    finalRequest.input.find((item) => item.role === 'user').content[0].text,
  );
  assert.equal(prompt.evidenceRecords[0].id, 'e1');
  assert.equal(prompt.evidenceRecords[0].excerpt, 'Common stock, matched to NAS/AAPL.');
  assert.equal(prompt.evidenceRecords[0].excerptOrigin, 'model_extracted');
  assert.equal(output.securities[0].evidence[0].id, 'e1');
});

test('CLI rejects unsolicited final web calls and sensitive judgment output without partial success', (t) => {
  for (const [scenario, code] of [
    ['judgment-web-call', 'MODEL_OUTPUT'],
    ['sensitive-judgment', 'SENSITIVE_OUTPUT'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '', scenario);
    assert.deepEqual(
      legacyFailure(result.stderr),
      {
        error: code,
        diagnostic: {
          stage: code === 'SENSITIVE_OUTPUT' ? 'output' : 'judgment',
          reason: code === 'SENSITIVE_OUTPUT' ? 'SENSITIVE_OUTPUT' : 'unknown',
          location: null,
        },
      },
      scenario,
    );
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-subscription/);
  }
});

test('CLI stops a blocked retrieval or final judgment at its deadline without partial output', (t) => {
  for (const scenario of ['retrieval-blocked', 'judgment-blocked']) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '', scenario);
    assert.equal(legacyFailure(result.stderr).error, 'MODEL_INCOMPLETE', scenario);
    assert.equal(
      result.requests.filter((r) => r.url.endsWith('/responses')).length,
      scenario === 'retrieval-blocked' ? 1 : 3,
    );
  }
});

test('CLI refuses model fields that could overwrite original ranking identity', (t) => {
  const result = run(t, 'forged-provenance');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(legacyFailure(result.stderr).error, 'MODEL_OUTPUT');
});

test('CLI shares the model request ceiling between retrieval and judgment', (t) => {
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
      'gpt-6.1-sol',
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
  assert.equal(output.securities[0].evidence[0].id, 'e1');
  assert.equal(result.requests.filter((r) => r.url.includes('/ranking/')).length, 0);
  assert.equal(result.requests.filter((r) => r.url.includes('/search-info?')).length, 1);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 3);
  assert.equal(result.requests.length, 4);
  const lookup = result.requests.find((r) => r.url.includes('/search-info?'));
  assert.deepEqual(Object.fromEntries(new URL(lookup.url).searchParams), {
    PRDT_TYPE_CD: '512',
    PDNO: 'AAPL',
  });
  for (const request of result.requests.filter((r) => r.url.endsWith('/responses'))) {
    assert.equal(request.body.model, 'gpt-6.1-sol');
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
        'gpt-6.1-sol',
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
  assert.deepEqual(JSON.parse(auth.stderr), {
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
    diagnostic: { stage: 'retrieval', reason: 'AUTH_FAILED', location: null },
  });
  assert.equal(model.requests.length, 1);
  assert.equal(model.requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(model.requests[0].body.model, 'gpt-6.1-sol');
  assert.equal(model.requests[0].body.stream, true);
  assert.equal(model.requests[0].body.store, false);
});

test('CLI binds final IDs to the observed context of the same individual security', (t) => {
  for (const [scenario, reason, location] of [
    ['invented-id', 'unknown_evidence_id', 'judgments[0].evidence[0]'],
    ['url-instead-of-id', 'unknown_evidence_id', 'judgments[0].evidence[0]'],
    ['types-cross-id', 'cross_security_evidence', 'judgments[0].evidence[0]'],
    ['missing-context', 'missing_required_field', 'evidence[0].subsequentChanges'],
    ['malformed-context-identity', 'unknown', 'evidence[0].exchange'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '', scenario);
    assert.deepEqual(
      legacyFailure(result.stderr),
      {
        error: 'MODEL_OUTPUT',
        diagnostic: {
          stage: scenario.includes('context') ? 'retrieval' : 'judgment',
          reason,
          location,
        },
      },
      scenario,
    );
  }
});

test('CLI reserves final judgment time inside the original total deadline', (t) => {
  const within = run(t, 'within-deadlines');
  assert.equal(within.status, 0, within.stderr);
  assert.equal(JSON.parse(within.stdout).limits.retrievalTimeoutSeconds, 120);
  assert.equal(JSON.parse(within.stdout).limits.timeoutSeconds, 180);
  for (const scenario of ['retrieval-overrun', 'judgment-overrun']) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: 'MODEL_INCOMPLETE',
      diagnostic: {
        stage: scenario === 'retrieval-overrun' ? 'retrieval' : 'judgment',
        reason: 'MODEL_INCOMPLETE',
        location: null,
      },
    });
    assert.equal(
      result.requests.filter((r) => r.url.endsWith('/responses')).length,
      scenario === 'retrieval-overrun' ? 2 : 3,
    );
  }
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
    'no-evidence',
    'missing-result',
    'duplicate-result',
    'ambiguous',
    'malformed-judgment',
    'no-evidence-excluded',
    'unknown-unobserved-source',
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario);
    assert.equal(result.stdout, '', scenario);
    assert.equal(
      legacyFailure(result.stderr).error,
      scenario === 'ambiguous' ? 'IDENTITY_AMBIGUOUS' : 'MODEL_OUTPUT',
      scenario + result.stderr,
    );
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
    ['ambiguous', 'IDENTITY_AMBIGUOUS'],
    ['sensitive-judgment', 'SENSITIVE_OUTPUT'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: reason,
      diagnostic: {
        stage:
          scenario === 'identity-conflict'
            ? 'ranking'
            : scenario === 'ambiguous'
              ? 'judgment'
              : 'output',
        reason,
        location: scenario === 'ambiguous' ? 'judgments[0].identity' : null,
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
  assert.deepEqual(JSON.parse(blocked.stderr), {
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
  assert.deepEqual(JSON.parse(relogin.stderr), {
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
    ['ignored', 'gpt-6.1-sol', '0'],
    ['ignored', 'gpt-6.1-sol', '1', 'extra'],
    ['ignored', 'gpt-6.1-sol', '--evaluation-input', 'relative.json'],
    ['ignored', 'gpt-6.1-sol', '--evaluation-input'],
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
    ['global-lookup', 'QUERY_FAILED', 'retrieval', 'unknown'],
    ['malformed-judgment', 'MODEL_OUTPUT', 'judgment', 'unknown'],
    ['auth-failure', 'AUTH_FAILED', 'retrieval', 'AUTH_FAILED'],
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
    diagnostic: { stage: 'retrieval', reason: 'SENSITIVE_OUTPUT', location: null },
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

test('CLI keeps evidence rejection in retrieval without starting judgment', (t) => {
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
    diagnostic: { stage: 'retrieval', reason: 'unobserved_source', location: 'evidence[0].source' },
  });
  assert.equal(result.requests.length, 3);
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 2);
  assert.equal(result.requests.filter((r) => r.url.includes('/ranking/')).length, 0);
});

test('CLI enters judgment after evidence validation and output after judgment validation', (t) => {
  for (const [scenario, stage, error, reason, location = null] of [
    ['invented-id', 'judgment', 'MODEL_OUTPUT', 'unknown_evidence_id', 'judgments[0].evidence[0]'],
    ['missing-result', 'judgment', 'MODEL_OUTPUT', 'unknown'],
    ['malformed-judgment', 'judgment', 'MODEL_OUTPUT', 'unknown', 'judgments[0].applicable'],
    ['judgment-web-call', 'judgment', 'MODEL_OUTPUT', 'unknown'],
    ['sensitive-judgment', 'output', 'SENSITIVE_OUTPUT', 'SENSITIVE_OUTPUT'],
    [
      'ambiguous-sensitive',
      'judgment',
      'IDENTITY_AMBIGUOUS',
      'IDENTITY_AMBIGUOUS',
      'judgments[0].identity',
    ],
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
    assert.equal(result.requests.length, 4);
    const models = result.requests.filter((r) => r.url.endsWith('/responses'));
    assert.equal(models.length, 3);
    assert.equal(models.at(-1).body.tools?.length ?? 0, 0);
    assert.doesNotMatch(result.stderr, /synthetic-subscription/);
  }
});

test('CLI keeps KIS authentication failure in retrieval with a confirmed safe reason', (t) => {
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
    diagnostic: { stage: 'retrieval', reason: 'AUTH_FAILED', location: null },
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
    ['auth-failure', 'retrieval', 'AUTH_FAILED', 1],
    ['search-unsupported', 'retrieval', 'SEARCH_UNSUPPORTED', 1],
    ['quota-http', 'retrieval', 'SUBSCRIPTION_LIMIT', 1],
    ['model-limit', 'judgment', 'MODEL_LIMIT', 12],
    ['retrieval-overrun', 'retrieval', 'MODEL_INCOMPLETE', 2],
    ['judgment-overrun', 'judgment', 'MODEL_INCOMPLETE', 3],
    ['search-service-failed', 'retrieval', 'SEARCH_FAILED', 2],
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
      assert.equal(request.body.model, 'gpt-6.1-sol');
      assert.equal(request.body.stream, true);
      assert.equal(request.body.store, false);
    }
    assert.equal(result.requests.filter((r) => r.url.includes('/ranking/')).length, 0);
    assert.ok(result.requests.filter((r) => r.url.includes('/search-info?')).length <= 11);
  }
});

test('CLI retains stages for unexpected preparation and final serialization failures without trusting messages', (t) => {
  for (const [stage, serialization, calls] of [
    ['retrieval', undefined, 0],
    ['judgment', undefined, 2],
    ['output', '1', 3],
    ['output', '2', 3],
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
  for (const [stage, calls] of [
    ['retrieval', 1],
    ['judgment', 3],
  ]) {
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
    assert.doesNotMatch(result.stderr, /private-|synthetic-|EGW00123|siwc_/);
  }
});

test('CLI reports failed retrieval and unstarted judgment statistics at the elapsed deadline', (t) => {
  const result = run(t, 'retrieval-overrun');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), {
    error: 'MODEL_INCOMPLETE',
    diagnostic: {
      stage: 'retrieval',
      reason: 'MODEL_INCOMPLETE',
      location: null,
      statistics: {
        retrieval: {
          status: 'failed',
          elapsedMs: 120000,
          modelRequests: 2,
          infoToolCalls: 1,
          observedWebToolCalls: 0,
        },
        judgment: {
          status: 'not_started',
          elapsedMs: null,
          modelRequests: 0,
          infoToolCalls: 0,
          observedWebToolCalls: 0,
        },
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

test('CLI preserves completed retrieval timing when judgment reaches the shared elapsed deadline', (t) => {
  const result = run(t, 'judgment-overrun');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr).diagnostic.statistics, {
    retrieval: {
      status: 'completed',
      elapsedMs: 119000,
      modelRequests: 2,
      infoToolCalls: 1,
      observedWebToolCalls: 0,
    },
    judgment: {
      status: 'failed',
      elapsedMs: 61000,
      modelRequests: 1,
      infoToolCalls: 0,
      observedWebToolCalls: 0,
    },
  });
  const models = result.requests.filter((r) => r.url.endsWith('/responses'));
  assert.equal(models.length, 3);
  assert.equal(models.at(-1).body.tools?.length ?? 0, 0);
});

test('CLI counts failed HTTP attempts and separates stage calls and validation time on other failures', (t) => {
  for (const [scenario, extra, stage, retrievalMs, requests, infos] of [
    ['auth-failure', {}, 'retrieval', 7, 1, 0],
    ['global-lookup', {}, 'retrieval', 18, 1, 1],
    ['unobserved-source', {}, 'retrieval', 25, 2, 1],
    ['malformed-judgment', {}, 'judgment', 25, 2, 1],
    ['malformed-judgment', { TEST_WALL_CLOCK_SHIFT: '-60000' }, 'judgment', 25, 2, 1],
    ['web-duplicates', { TEST_HTTP_EXCEPTION_STAGE: 'judgment' }, 'judgment', 25, 2, 1],
    ['ok', { TEST_HTTP_EXCEPTION_STAGE: 'retrieval' }, 'retrieval', 7, 1, 0],
  ]) {
    const result = run(t, scenario, {
      TEST_STATISTICS_CLOCK: '1',
      TEST_HTTP_EXCEPTION: 'private-field private-value /private/path synthetic-subscription',
      ...extra,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    const diagnostic = JSON.parse(result.stderr).diagnostic;
    assert.equal(diagnostic.stage, stage);
    assert.deepEqual(
      diagnostic.statistics,
      {
        retrieval: {
          status: stage === 'retrieval' ? 'failed' : 'completed',
          elapsedMs: retrievalMs,
          modelRequests: requests,
          infoToolCalls: infos,
          observedWebToolCalls: scenario === 'web-duplicates' ? 2 : 0,
        },
        judgment: {
          status: stage === 'retrieval' ? 'not_started' : 'failed',
          elapsedMs: stage === 'retrieval' ? null : 7,
          modelRequests: stage === 'retrieval' ? 0 : 1,
          infoToolCalls: 0,
          observedWebToolCalls: 0,
        },
      },
      scenario,
    );
    assert.equal(
      result.requests.filter((r) => r.url.endsWith('/responses')).length,
      requests + (stage === 'judgment' ? 1 : 0),
    );
    assert.equal(result.requests.filter((r) => r.url.includes('/search-info?')).length, infos);
    for (const request of result.requests.filter((r) => r.url.endsWith('/responses'))) {
      assert.equal(request.body.model, 'gpt-6.1-sol');
      assert.equal(request.body.stream, true);
      assert.equal(request.body.store, false);
    }
    assert.doesNotMatch(
      result.stderr,
      /private-field|private-value|private-id|private.path|synthetic-subscription|test-key|test-secret/,
    );
  }
});

test('CLI reports blocked stage time through cancellation and preserves unstarted and completed stages', (t) => {
  for (const scenario of ['retrieval-blocked', 'judgment-blocked']) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    const retrieval = scenario === 'retrieval-blocked';
    assert.deepEqual(JSON.parse(result.stderr).diagnostic.statistics, {
      retrieval: {
        status: retrieval ? 'failed' : 'completed',
        elapsedMs: retrieval ? 120000 : 0,
        modelRequests: retrieval ? 1 : 2,
        infoToolCalls: 1,
        observedWebToolCalls: 0,
      },
      judgment: {
        status: retrieval ? 'not_started' : 'failed',
        elapsedMs: retrieval ? null : 180000,
        modelRequests: retrieval ? 0 : 1,
        infoToolCalls: 0,
        observedWebToolCalls: 0,
      },
    });
  }
});

test('CLI statistics preserve the existing request and tool ceilings', (t) => {
  for (const [scenario, models, infos, webs, stage] of [
    ['model-limit', 12, 11, 0, 'judgment'],
    ['info-limit', 2, 33, 0, 'retrieval'],
    ['web-limit', 2, 1, 33, 'retrieval'],
    ['judgment-web-call', 2, 1, 0, 'judgment'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    const stats = JSON.parse(result.stderr).diagnostic.statistics;
    assert.deepEqual(stats.retrieval, {
      status: stage === 'retrieval' ? 'failed' : 'completed',
      elapsedMs: 0,
      modelRequests: models,
      infoToolCalls: infos,
      observedWebToolCalls: webs,
    });
    assert.deepEqual(stats.judgment, {
      status: stage === 'retrieval' ? 'not_started' : 'failed',
      elapsedMs: stage === 'retrieval' ? null : 0,
      modelRequests: scenario === 'judgment-web-call' ? 1 : 0,
      infoToolCalls: 0,
      observedWebToolCalls: scenario === 'judgment-web-call' ? 1 : 0,
    });
    assert.equal(
      result.requests.filter((r) => r.url.endsWith('/responses')).length,
      models + (scenario === 'judgment-web-call' ? 1 : 0),
    );
    assert.equal(
      result.requests.filter((r) => r.url.includes('/search-info?')).length,
      Math.min(infos, 32),
    );
  }
});

test('CLI identifies the first missing evidence field at its response location', (t) => {
  const result = run(t, 'missing-context');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(legacyFailure(result.stderr), {
    error: 'MODEL_OUTPUT',
    diagnostic: {
      stage: 'retrieval',
      reason: 'missing_required_field',
      location: 'evidence[0].subsequentChanges',
    },
  });
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 2);
});

test('CLI distinguishes source and reference failures without additional requests', (t) => {
  for (const [scenario, stage, reason, location] of [
    ['unobserved-source', 'retrieval', 'unobserved_source', 'evidence[0].source'],
    ['invented-id', 'judgment', 'unknown_evidence_id', 'judgments[0].evidence[0]'],
    ['types-cross-id', 'judgment', 'cross_security_evidence', 'judgments[0].evidence[0]'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: 'MODEL_OUTPUT',
      diagnostic: { stage, reason, location },
    });
    const models = result.requests.filter((r) => r.url.endsWith('/responses'));
    assert.equal(models.length, stage === 'retrieval' ? 2 : 3);
    assert.equal(models[0].body.model, 'gpt-6.1-sol');
    assert.equal(models[0].body.stream, true);
    assert.equal(models[0].body.store, false);
    if (stage === 'judgment') assert.equal(models.at(-1).body.tools?.length ?? 0, 0);
    assert.doesNotMatch(result.stderr, /synthetic-|test-key|test-secret|invented|https:/);
  }
});

test('CLI reports safe response paths and preserves the original first-rejection order', (t) => {
  const evidence = {
    exchange: 'NAS',
    symbol: 'AAPL',
    source: 'kis:NAS:AAPL',
    excerpt: 'Common stock',
    identityLink: 'Individual security',
    asOf: '2026-10-18',
    effectiveDate: '2026-10-18',
    subsequentChanges: 'No change',
    currentness: 'Current',
  };
  const judgment = {
    exchange: 'NAS',
    symbol: 'AAPL',
    type: 'common',
    identity: 'confirmed',
    applicable: true,
    reason: 'Common stock',
    evidence: ['e1'],
  };
  const missingEvidence = { ...evidence, source: 'private-source synthetic-subscription' };
  delete missingEvidence.subsequentChanges;
  const missingJudgment = { ...judgment, evidence: ['private-id synthetic-subscription'] };
  delete missingJudgment.reason;
  const reordered = [
    { ...judgment, symbol: 'GOOG', evidence: ['e2'] },
    { ...judgment, evidence: ['private-id synthetic-subscription'] },
  ];
  for (const [stage, value, reason, location, scenario] of [
    [
      'retrieval',
      { evidence: [missingEvidence, null] },
      'missing_required_field',
      'evidence[0].subsequentChanges',
    ],
    [
      'retrieval',
      { evidence: [{ ...evidence, exchange: null, source: 'unread' }] },
      'unknown',
      'evidence[0].exchange',
    ],
    [
      'retrieval',
      { evidence: [{ ...evidence, symbol: 'GOOG' }] },
      'cross_security_evidence',
      'evidence[0].source',
      'types',
    ],
    ['retrieval', { evidence: [null] }, 'unknown', 'evidence[0]'],
    ['retrieval', { evidence: null }, 'unknown', null],
    ['retrieval', {}, 'missing_required_field', null],
    ['judgment', {}, 'missing_required_field', null],
    [
      'judgment',
      { judgments: [{ ...judgment, evidence: ['e999'] }, null] },
      'unknown',
      'judgments[1]',
    ],
    ['judgment', { judgments: [missingJudgment] }, 'missing_required_field', 'judgments[0].reason'],
    [
      'judgment',
      { judgments: [judgment, missingJudgment] },
      'missing_required_field',
      'judgments[1].reason',
    ],
    [
      'judgment',
      { judgments: reordered },
      'unknown_evidence_id',
      'judgments[1].evidence[0]',
      'types',
    ],
    [
      'judgment',
      { judgments: [{ ...judgment, 'private-field synthetic-subscription': '/private/path' }] },
      'unknown',
      'judgments[0]',
    ],
    ['judgment', { judgments: [] }, 'unknown', null],
  ]) {
    const result = run(t, scenario ?? 'ok', {
      TEST_RESPONSE_STAGE: stage,
      TEST_RESPONSE_VALUE: JSON.stringify(value),
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(legacyFailure(result.stderr), {
      error: 'MODEL_OUTPUT',
      diagnostic: { stage, reason, location },
    });
    assert.doesNotMatch(result.stderr, /private-|synthetic-|test-key|test-secret/);
    const models = result.requests.filter((r) => r.url.endsWith('/responses'));
    assert.equal(models.length, stage === 'retrieval' ? 2 : 3);
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

test('CLI integrates response-location rejection and stage statistics for reordered evidence', (t) => {
  const record = {
    exchange: 'NAS',
    symbol: 'GOOG',
    source: 'kis:NAS:GOOG',
    excerpt: 'Common stock',
    identityLink: 'Individual security',
    asOf: '2026-10-18',
    effectiveDate: '2026-10-18',
    subsequentChanges: 'No change',
    currentness: 'Current',
  };
  const invalid = {
    ...record,
    symbol: 'AAPL',
    source: 'private-source synthetic-subscription',
    'private-field': '/private/path',
  };
  delete invalid.subsequentChanges;
  const result = run(t, 'types', {
    TEST_STATISTICS_CLOCK: '1',
    TEST_RESPONSE_STAGE: 'retrieval',
    TEST_RESPONSE_VALUE: JSON.stringify({ evidence: [record, invalid] }),
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), {
    error: 'MODEL_OUTPUT',
    diagnostic: {
      stage: 'retrieval',
      reason: 'missing_required_field',
      location: 'evidence[1].subsequentChanges',
      statistics: {
        retrieval: {
          status: 'failed',
          elapsedMs: 124,
          modelRequests: 2,
          infoToolCalls: 10,
          observedWebToolCalls: 0,
        },
        judgment: {
          status: 'not_started',
          elapsedMs: null,
          modelRequests: 0,
          infoToolCalls: 0,
          observedWebToolCalls: 0,
        },
      },
    },
  });
  assert.doesNotMatch(result.stderr, /private-|private.path|synthetic-|test-key|test-secret/);
  const models = result.requests.filter((request) => request.url.endsWith('/responses'));
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
