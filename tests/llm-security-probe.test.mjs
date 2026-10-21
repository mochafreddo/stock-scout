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
  assert.deepEqual(JSON.parse(result.stderr), {
    error: 'USAGE',
    diagnostic: { stage: 'input', reason: 'unknown', location: null },
  });
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
      JSON.parse(result.stderr),
      {
        error: code,
        diagnostic: {
          stage: 'unknown',
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
    assert.equal(JSON.parse(result.stderr).error, 'MODEL_INCOMPLETE', scenario);
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
  assert.equal(JSON.parse(result.stderr).error, 'MODEL_OUTPUT');
});

test('CLI shares the model request ceiling between retrieval and judgment', (t) => {
  const result = run(t, 'model-limit');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'MODEL_LIMIT');
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
  assert.deepEqual(JSON.parse(result.stderr), {
    error: 'USAGE',
    diagnostic: { stage: 'unknown', reason: 'unknown', location: null },
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
});

test('CLI rejects empty, excessive, duplicate, malformed or answer-bearing evaluation inputs', (t) => {
  for (const input of [
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
    assert.deepEqual(JSON.parse(result.stderr), {
      error: 'USAGE',
      diagnostic: { stage: 'unknown', reason: 'unknown', location: null },
    });
    assert.deepEqual(result.requests, []);
  }
});

test('CLI binds final IDs to the observed context of the same individual security', (t) => {
  for (const scenario of [
    'invented-id',
    'url-instead-of-id',
    'types-cross-id',
    'missing-context',
    'malformed-context-identity',
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '', scenario);
    assert.deepEqual(
      JSON.parse(result.stderr),
      {
        error: 'MODEL_OUTPUT',
        diagnostic: { stage: 'unknown', reason: 'unknown', location: null },
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
    assert.deepEqual(JSON.parse(result.stderr), {
      error: 'MODEL_INCOMPLETE',
      diagnostic: { stage: 'unknown', reason: 'unknown', location: null },
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
  assert.equal(JSON.parse(result.stderr).error, 'AUTH_FAILED');
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 1);
  assert.doesNotMatch(result.stderr, /synthetic-subscription/);
});

test('CLI distinguishes explicit subscription exhaustion without sending an unbudgeted paid request', (t) => {
  const result = run(t, 'quota-http');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'SUBSCRIPTION_LIMIT');
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
    assert.equal(JSON.parse(result.stderr).error, code, scenario);
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
      ['MODEL_FAILED', 'MODEL_INCOMPLETE'].includes(JSON.parse(result.stderr).error),
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
      JSON.parse(result.stderr).error,
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
    assert.equal(JSON.parse(result.stderr).error, 'SEARCH_FAILED');
  }
});

test('CLI enforces information and hosted web-call ceilings without a successful partial result', (t) => {
  for (const scenario of ['info-limit', 'web-limit']) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, scenario + result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'MODEL_LIMIT');
    assert.ok(result.requests.filter((r) => r.url.includes('/search-info?')).length <= 32);
  }
});

test('CLI refuses unbounded paid search even when an API key exists after subscription exhaustion', (t) => {
  const result = run(t, 'quota-http', { OPENAI_API_KEY: 'synthetic-paid' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'PAID_BUDGET_UNPROVABLE');
  assert.equal(result.requests.filter((r) => r.url.endsWith('/responses')).length, 1);
  assert.doesNotMatch(result.stderr, /synthetic-paid/);
});

test('CLI reports a confirmed ranking incompleteness reason independently of its unknown stage', (t) => {
  const result = run(t, 'ranking-incomplete');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), {
    error: 'RANKING_INCOMPLETE',
    diagnostic: { stage: 'unknown', reason: 'RANKING_INCOMPLETE', location: null },
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
    assert.deepEqual(JSON.parse(result.stderr), {
      error: reason,
      diagnostic: { stage: 'unknown', reason, location: null },
    });
    assert.doesNotMatch(result.stderr, /synthetic-subscription/);
  }
});

test('CLI preserves retry time and login guidance with confirmed authentication reasons and an unknown stage', (t) => {
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
    diagnostic: { stage: 'unknown', reason: 'siwc_refresh_not_allowed', location: null },
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
    diagnostic: { stage: 'unknown', reason: 'siwc_relogin_required', location: null },
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
    assert.deepEqual(JSON.parse(result.stderr), {
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
    assert.deepEqual(JSON.parse(result.stderr), {
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
    assert.deepEqual(JSON.parse(result.stderr), {
      error,
      diagnostic: { stage: 'unknown', reason: 'unknown', location: null },
      ...(error === 'siwc_relogin_required' ? { action: 'login' } : {}),
      ...(error === 'siwc_refresh_not_allowed' ? { retryAt: '2026-10-18T00:10:00.000Z' } : {}),
    });
    assert.deepEqual(result.requests, []);
  }
});

test('CLI keeps aggregated ranking, lookup and model errors at an unknown reason', (t) => {
  for (const [scenario, error] of [
    ['rank-failure', 'RANKING_FAILED'],
    ['global-lookup', 'QUERY_FAILED'],
    ['malformed-judgment', 'MODEL_OUTPUT'],
    ['auth-failure', 'AUTH_FAILED'],
  ]) {
    const result = run(t, scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), {
      error,
      diagnostic: { stage: 'unknown', reason: 'unknown', location: null },
    });
  }
});

test('CLI preserves a confirmed sensitive lookup reason while keeping its legacy query error', (t) => {
  const result = run(t, 'sensitive-lookup');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), {
    error: 'QUERY_FAILED',
    diagnostic: { stage: 'unknown', reason: 'SENSITIVE_OUTPUT', location: null },
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
