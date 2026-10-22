import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, now, putToken } from './kis-cli-helper.mjs';

function session(t, changes = {}) {
  const f = fixture();
  t.after(f.close);
  putToken(f, 'test-token');
  const directory = join(f.home, 'siwc');
  mkdirSync(directory, { mode: 0o700 });
  const hostId = 'urn:uuid:859484d1-d773-489f-a0dd-a3021048bb7f';
  writeFileSync(join(directory, 'host.json'), JSON.stringify({ hostId }), { mode: 0o600 });
  const path = join(directory, 'credentials.json');
  writeFileSync(
    path,
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
      scopes: ['openid', 'resource.invoke', 'chatgpt.tokens.use.direct'],
      expiresAt: now + 300_000,
      ...changes,
    }),
    { mode: 0o600 },
  );
  return { ...f, directory, path };
}
function run(
  f,
  mode = 'ok',
  extraEnv = {},
  args = ['scripts/llm-security-probe.ts', f.directory, 'gpt-6.1-sol', '1'],
) {
  const trace = join(f.home, 'refresh-trace');
  writeFileSync(trace, '', { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    ['--import', new URL('./siwc-refresh-http-mock.mjs', import.meta.url).pathname, ...args],
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
        SCENARIO: 'ok',
        TEST_REFRESH_MODE: mode,
        TEST_MODEL_TOKEN: 'synthetic-refreshed',
        ...extraEnv,
      },
    },
  );
  return {
    ...result,
    requests: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
  };
}
function check(f, mode = 'ok', extraEnv = {}) {
  return run(f, mode, { TEST_CHECK_MODE: 'ok', ...extraEnv }, [
    'scripts/siwc-auth.ts',
    'check',
    f.directory,
  ]);
}

test('subscription check refreshes once and the next process lists models with the stored token', (t) => {
  const f = session(t);
  const first = check(f);
  assert.equal(first.status, 0, first.stderr);
  const output = JSON.parse(first.stdout);
  assert.equal(output.status, 'connected');
  assert.deepEqual(output.models, [{ slug: 'gpt-6.1-sol', displayName: 'GPT 6.1' }]);
  assert.deepEqual(output.auth, {
    status: 'refreshed',
    refreshRequests: 1,
    responseValidated: true,
    credentialsStored: true,
    storedCredentialsMatch: true,
    accessTokenChanged: true,
    refreshTokenChanged: true,
    expiresAt: '2026-10-18T01:00:00.000Z',
  });
  assert.equal(first.requests.length, 2);
  assert.equal(first.requests[1].url, 'https://api.openai.com/v1/models');
  assert.equal(first.requests[1].method, 'GET');
  assert.equal(first.requests[1].headers.Authorization, 'Bearer synthetic-refreshed');
  const stored = readFileSync(f.path, 'utf8');
  const second = check(f);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout).auth, {
    status: 'reused',
    refreshRequests: 0,
    expiresAt: '2026-10-18T01:00:00.000Z',
  });
  assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0].headers.Authorization, 'Bearer synthetic-refreshed');
  assert.equal(readFileSync(f.path, 'utf8'), stored);
  assert.doesNotMatch(
    first.stdout + first.stderr + second.stdout + second.stderr,
    /synthetic-|oaiapp_|credentials\.json/,
  );
});

test('subscription check accepts empty catalogs and preserves visible model ordering', (t) => {
  for (const models of [
    [],
    [{ slug: 'hidden', visibility: 'hide' }],
    [
      { slug: 'z-model', display_name: 'Z model', visibility: 'list' },
      { slug: 'a-model', display_name: 'A model', visibility: 'list' },
    ],
  ]) {
    const f = session(t, { expiresAt: now + 3600_000 });
    const result = check(f, 'ok', {
      TEST_MODEL_TOKEN: 'synthetic-subscription',
      TEST_CHECK_BODY: JSON.stringify({ models }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.deepEqual(
      JSON.parse(result.stdout).models,
      models.length === 2
        ? [
            { slug: 'z-model', displayName: 'Z model' },
            { slug: 'a-model', displayName: 'A model' },
          ]
        : [],
    );
  }
});

test('subscription check accepts a valid catalog larger than the token response limit', (t) => {
  const f = session(t);
  const result = check(f, 'ok', {
    TEST_CHECK_BODY: JSON.stringify({
      models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT 6.1', visibility: 'list' }],
      metadata: 'x'.repeat(600_000),
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).models, [
    { slug: 'gpt-6.1-sol', displayName: 'GPT 6.1' },
  ]);
  assert.equal(result.requests.length, 2);
});

test('subscription check bounds catalog size in UTF-8 bytes', (t) => {
  const f = session(t);
  const bodyPath = join(f.home, 'catalog.json');
  writeFileSync(bodyPath, JSON.stringify({ models: [], metadata: '가'.repeat(400_000) }), {
    mode: 0o600,
  });
  const result = check(f, 'ok', {
    TEST_CHECK_BODY_FILE: bodyPath,
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, 'siwc_invalid_response');
  assert.equal(JSON.parse(result.stderr).auth.status, 'refreshed');
  assert.equal(result.requests.length, 2);
});

for (const mode of ['http', 'network', 'timeout', 'body-timeout', 'json', 'large']) {
  test(`subscription check preserves a successful rotation when catalog requests fail without retry or inference: ${mode}`, (t) => {
    const f = session(t);
    const result = check(f, 'ok', { TEST_CHECK_MODE: mode });
    assert.equal(result.status, 1, mode);
    assert.equal(result.stdout, '', mode);
    const error = JSON.parse(result.stderr);
    assert.match(error.error, /^siwc_/, mode);
    assert.equal(error.auth.status, 'refreshed', mode);
    assert.equal(error.auth.credentialsStored, true, mode);
    assert.equal(error.auth.storedCredentialsMatch, true, mode);
    assert.equal(result.requests.length, 2, mode);
    assert.equal(result.requests[1].signalPresent, true, mode);
    assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).refreshToken, 'synthetic-rotated');
    assert.doesNotMatch(result.stderr, /RAW_PRIVATE|synthetic-|oaiapp_/);
  });
}

test('subscription check rejects malformed catalogs instead of reporting an empty connected result', (t) => {
  for (const body of [
    null,
    {},
    { models: {} },
    { models: [null] },
    { models: [{}] },
    { models: [{ visibility: 'list', slug: '', display_name: 'Model' }] },
    { models: [{ visibility: 'list', slug: 'test', display_name: ' ' }] },
    { models: [{ visibility: 'list', slug: 'test', display_name: 'bad\nname' }] },
    {
      models: [
        { visibility: 'list', slug: 'test', display_name: 'Model' },
        { visibility: 'list', slug: 'test', display_name: 'Duplicate' },
      ],
    },
  ]) {
    const f = session(t);
    const result = check(f, 'ok', { TEST_CHECK_BODY: JSON.stringify(body) });
    assert.equal(result.status, 1, JSON.stringify(body));
    assert.equal(JSON.parse(result.stderr).error, 'siwc_invalid_response');
    assert.equal(JSON.parse(result.stderr).auth.status, 'refreshed');
    assert.equal(result.stdout, '');
    assert.equal(result.requests.length, 2);
  }
});

test('subscription check reports refresh progress on failure and never lists models before authentication succeeds', (t) => {
  for (const [mode, changes, error, requests, validated] of [
    ['ok', { earliestRefreshAt: 1792281660 }, 'siwc_refresh_not_allowed', 0, false],
    ['network', {}, 'siwc_refresh_failed', 1, false],
    ['missing-refresh', {}, 'siwc_invalid_response', 1, false],
    ['save-failure', {}, 'siwc_refresh_failed', 1, true],
    ['error:400:invalid_grant', {}, 'siwc_relogin_required', 1, false],
  ]) {
    const f = session(t, changes);
    const result = check(f, mode);
    assert.equal(result.status, 1, mode);
    const output = JSON.parse(result.stderr);
    assert.equal(output.error, error, mode);
    assert.equal(output.auth.status, 'pending');
    assert.equal(output.auth.refreshRequests, requests);
    assert.equal(output.auth.responseValidated === true, validated);
    assert.equal(output.auth.credentialsStored, undefined);
    assert.equal(result.stdout, '');
    assert.equal(result.requests.length, requests);
    if (mode === 'ok') assert.equal(output.retryAt, '2026-10-18T00:01:00.000Z');
    if (mode.startsWith('error:')) assert.equal(output.action, 'login');
  }
  const f = session(t);
  const invalid = run(f, 'ok', { TEST_CHECK_MODE: 'ok' }, [
    'scripts/siwc-auth.ts',
    'check',
    f.directory,
    'extra',
  ]);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).error, 'siwc_usage');
  assert.equal(invalid.requests.length, 0);
});

test('subscription check records stored rotation before honoring cancellation without listing models', (t) => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const f = session(t);
    const result = check(f, `postvalidation-${signal}`);
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    const output = JSON.parse(result.stderr);
    assert.equal(output.error, 'siwc_refresh_cancelled');
    assert.equal(output.auth.status, 'refreshed');
    assert.equal(output.auth.credentialsStored, true);
    assert.equal(output.auth.storedCredentialsMatch, true);
    assert.equal(result.requests.length, 1);
    assert.equal(existsSync(join(f.directory, '.login.lock')), false);
  }
});

test('subscription check rejects persisted tokens or expiration that do not match the validated response', (t) => {
  for (const field of ['accessToken', 'refreshToken', 'expiresAt']) {
    const f = session(t);
    const result = check(f, `readback-${field}`);
    assert.equal(result.status, 1, field);
    assert.equal(result.stdout, '');
    const output = JSON.parse(result.stderr);
    assert.equal(output.error, 'siwc_invalid_credentials');
    assert.equal(output.auth.responseValidated, true);
    assert.equal(output.auth.credentialsStored, true);
    assert.equal(output.auth.storedCredentialsMatch, false);
    assert.equal(output.auth.status, 'pending');
    assert.equal(result.requests.length, 1);
    assert.doesNotMatch(result.stderr, /synthetic-|oaiapp_|credentials\.json/);
  }
});
function start(t, f, mode, name = mode, extraEnv = {}) {
  const trace = join(f.home, `${name}-trace`);
  writeFileSync(trace, '', { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      '--import',
      new URL('./siwc-refresh-http-mock.mjs', import.meta.url).pathname,
      'scripts/llm-security-probe.ts',
      f.directory,
      'gpt-6.1-sol',
      '1',
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: f.home,
        KIS_APP_KEY: 'test-key',
        KIS_APP_SECRET: 'test-secret',
        TEST_NOW: String(now),
        TEST_TRACE: trace,
        SCENARIO: 'ok',
        TEST_REFRESH_MODE: mode,
        TEST_MODEL_TOKEN: 'synthetic-refreshed',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  t.after(() => child.kill());
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const requests = () =>
    readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const done = once(child, 'close').then(([status, signal]) => ({
    status,
    signal,
    stdout,
    stderr,
    requests: requests(),
  }));
  return { child, done, requests };
}
async function waitFor(predicate) {
  for (let count = 0; count < 500; count++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('Synthetic process did not reach the expected boundary');
}

test('CLI refreshes at five minutes before any data request and reuses rotated credentials in a separate process', (t) => {
  const f = session(t);
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const token = result.requests[0];
  assert.equal(token.url, 'https://auth.openai.com/api/accounts/oauth/token');
  assert.equal(token.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(token.body)), {
    grant_type: 'refresh_token',
    client_id: 'oaiapp_synthetic',
    refresh_token: 'synthetic-refresh',
    resource: 'https://api.openai.com/v1',
  });
  assert.equal(token.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const saved = JSON.parse(readFileSync(f.path, 'utf8'));
  assert.equal(saved.accessToken, 'synthetic-refreshed');
  assert.equal(saved.refreshToken, 'synthetic-rotated');
  assert.equal(saved.expiresAt, 1792285200000);
  assert.equal(saved.idToken, 'synthetic-identity');
  assert.deepEqual(saved.scopes, ['openid', 'resource.invoke', 'chatgpt.tokens.use.direct']);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /synthetic-(subscription|refresh|rotated|identity|user)/,
  );
  const next = run(f);
  assert.equal(next.status, 0, next.stderr);
  assert.ok(next.requests.every((request) => !request.url.startsWith('https://auth.openai.com')));
});

test('CLI reuses tokens above the five-minute boundary, refreshes expired tokens and respects explicit refresh times', (t) => {
  const valid = session(t, { expiresAt: now + 300_001 });
  const reused = run(valid, 'ok', { TEST_MODEL_TOKEN: 'synthetic-subscription' });
  assert.equal(reused.status, 0, reused.stderr);
  assert.ok(reused.requests.every((request) => !request.url.startsWith('https://auth.openai.com')));
  const expired = session(t, { expiresAt: now - 1, earliestRefreshAt: 1792281600 });
  assert.equal(run(expired).status, 0);
  for (const earliestRefreshAt of [1792281660, '2026-10-18T09:01:00+09:00']) {
    const f = session(t, { earliestRefreshAt });
    const before = readFileSync(f.path, 'utf8');
    const result = run(f);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), {
      error: 'siwc_refresh_not_allowed',
      diagnostic: { stage: 'authentication', reason: 'siwc_refresh_not_allowed', location: null },
      retryAt: '2026-10-18T00:01:00.000Z',
    });
    assert.equal(result.stdout, '');
    assert.equal(result.requests.length, 0);
    assert.equal(readFileSync(f.path, 'utf8'), before);
  }
  for (const earliestRefreshAt of [
    '2026-10-18T00:01:00',
    '2026-02-30T00:01:00Z',
    'tomorrow',
    null,
    {},
    -1,
    1e30,
  ]) {
    const f = session(t, { earliestRefreshAt });
    const result = run(f);
    assert.equal(result.status, 1, String(earliestRefreshAt));
    assert.deepEqual(JSON.parse(result.stderr), {
      error: 'siwc_invalid_refresh_time',
      diagnostic: { stage: 'authentication', reason: 'unknown', location: null },
    });
    assert.equal(result.requests.length, 0);
  }
  const f = session(t);
  const result = run(f, 'ok', { TEST_REFRESH_EARLIEST: '1792285200' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).earliestRefreshAt, 1792285200);
});

test('CLI rejects invalid rotated responses and changed permissions or identities before storing or requesting data', (t) => {
  for (const mode of [
    'missing-access',
    'missing-refresh',
    'bad-expiry',
    'fraction-expiry',
    'bad-type',
    'bad-scope-type',
    'missing-permission',
    'duplicate-scope',
    'bad-id',
    'null-id',
    'identity-issuer',
    'identity-audience',
    'identity-account',
    'identity-expired',
    'identity-signature',
  ]) {
    const f = session(t);
    const before = readFileSync(f.path, 'utf8');
    const result = run(f, mode);
    assert.equal(result.status, 1, mode);
    assert.equal(result.stdout, '', mode);
    assert.match(JSON.parse(result.stderr).error, /^siwc_/, mode);
    assert.equal(readFileSync(f.path, 'utf8'), before, mode);
    assert.ok(
      result.requests.every((request) => request.url.startsWith('https://auth.openai.com')),
      mode,
    );
    assert.doesNotMatch(result.stderr, /synthetic-|other-user/);
  }
  for (const mode of ['new-scope', 'identity-valid']) {
    const f = session(t);
    const result = run(f, mode);
    assert.equal(result.status, 0, mode + result.stderr);
    const saved = JSON.parse(readFileSync(f.path, 'utf8'));
    if (mode === 'new-scope')
      assert.deepEqual(saved.scopes, [
        'openid',
        'resource.invoke',
        'chatgpt.tokens.use.direct',
        'email',
      ]);
    else assert.notEqual(saved.idToken, 'synthetic-identity');
  }
  const invalidTime = session(t);
  const beforeInvalidTime = readFileSync(invalidTime.path, 'utf8');
  const invalid = run(invalidTime, 'ok', { TEST_REFRESH_EARLIEST: '"2026-02-30T00:01:00Z"' });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).error, 'siwc_invalid_refresh_time');
  assert.equal(invalid.requests.length, 1);
  assert.equal(readFileSync(invalidTime.path, 'utf8'), beforeInvalidTime);
});

test('model authentication failure after a successful preflight refresh never replays refresh or model requests', (t) => {
  const f = session(t);
  const result = run(f, 'ok', { SCENARIO: 'auth-failure' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'AUTH_FAILED');
  assert.equal(result.requests.filter((request) => request.url.endsWith('/oauth/token')).length, 1);
  assert.equal(result.requests.filter((request) => request.url.endsWith('/responses')).length, 1);
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).refreshToken, 'synthetic-rotated');
});

test('CLI waits at most thirty seconds for a shared login lock and preserves an abandoned lock', (t) => {
  const f = session(t);
  const lock = join(f.directory, '.login.lock');
  writeFileSync(lock, 'abandoned', { mode: 0o600 });
  const before = readFileSync(f.path, 'utf8');
  const result = run(f, 'locked');
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    error: 'siwc_session_locked',
    diagnostic: { stage: 'authentication', reason: 'unknown', location: null },
  });
  assert.equal(result.stdout, '');
  assert.equal(result.requests.length, 0);
  assert.equal(readFileSync(f.path, 'utf8'), before);
  assert.equal(readFileSync(lock, 'utf8'), 'abandoned');
  assert.equal(existsSync(lock), true);
});

test('official refresh invalidation clears tokens but retains registration while transient and client errors preserve credentials', (t) => {
  for (const error of [
    'invalid_grant',
    'invalid_refresh_token',
    'token_expired',
    'refresh_token_expired',
    'refresh_token_invalidated',
    'refresh_token_reused',
  ]) {
    const f = session(t);
    const before = JSON.parse(readFileSync(f.path, 'utf8'));
    const result = run(f, `error:400:${error}`);
    assert.equal(result.status, 1, error);
    assert.deepEqual(JSON.parse(result.stderr), {
      error: 'siwc_relogin_required',
      diagnostic: { stage: 'authentication', reason: 'siwc_relogin_required', location: null },
      action: 'login',
    });
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), {
      schemaVersion: 1,
      issuer: before.issuer,
      subject: before.subject,
      clientId: before.clientId,
      hostId: before.hostId,
    });
    assert.equal(result.requests.length, 1);
    const again = run(f);
    assert.deepEqual(JSON.parse(again.stderr), {
      error: 'siwc_relogin_required',
      action: 'login',
      diagnostic: { stage: 'authentication', reason: 'siwc_relogin_required', location: null },
    });
    assert.equal(again.requests.length, 0);
  }
  for (const mode of [
    'network',
    'error:400:invalid_client',
    'error:503:invalid_grant',
    'error:400:unknown',
    'malformed-error',
    'bad-json',
    'large-response',
  ]) {
    const f = session(t);
    const before = readFileSync(f.path, 'utf8');
    const result = run(f, mode);
    assert.equal(result.status, 1, mode);
    assert.match(JSON.parse(result.stderr).error, /^siwc_/);
    assert.equal(readFileSync(f.path, 'utf8'), before, mode);
    assert.equal(result.requests.length, 1);
    assert.doesNotMatch(result.stderr, /RAW_PRIVATE|synthetic-/);
  }
});

test('unsafe credential files and directories prevent all HTTP requests and never replace the selected state', (t) => {
  for (const mode of [
    'directory-mode',
    'file-mode',
    'file-symlink',
    'directory-symlink',
    'hard-link',
    'host-mismatch',
    'partial-tokens',
  ]) {
    const f = session(t);
    const before = readFileSync(f.path, 'utf8');
    if (mode === 'directory-mode') chmodSync(f.directory, 0o755);
    if (mode === 'file-mode') chmodSync(f.path, 0o644);
    if (mode === 'file-symlink') {
      const target = join(f.home, 'actual-credentials');
      writeFileSync(target, before, { mode: 0o600 });
      rmSync(f.path);
      symlinkSync(target, f.path);
    }
    if (mode === 'directory-symlink') {
      const alias = join(f.home, 'alias');
      symlinkSync(f.directory, alias);
      f.directory = alias;
    }
    if (mode === 'hard-link') linkSync(f.path, join(f.home, 'other-link'));
    if (mode === 'host-mismatch' || mode === 'partial-tokens') {
      const data = JSON.parse(before);
      if (mode === 'host-mismatch') data.hostId = 'urn:uuid:00000000-0000-4000-8000-000000000000';
      else delete data.refreshToken;
      writeFileSync(f.path, JSON.stringify(data));
    }
    const unchanged = readFileSync(f.path, 'utf8');
    const result = run(f);
    assert.equal(result.status, 1, mode);
    assert.equal(result.stdout, '');
    assert.equal(result.requests.length, 0, mode);
    assert.equal(readFileSync(f.path, 'utf8'), unchanged);
  }
});

test('cancellation while waiting for another session preserves its lock and starts no requests', async (t) => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const f = session(t);
    const lock = join(f.directory, '.login.lock');
    writeFileSync(lock, 'other-session', { mode: 0o600 });
    const before = readFileSync(f.path, 'utf8');
    const running = start(t, f, 'ok');
    await delay(300);
    running.child.kill(signal);
    const result = await running.done;
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.deepEqual(JSON.parse(result.stderr), {
      error: 'siwc_refresh_cancelled',
      diagnostic: { stage: 'authentication', reason: 'unknown', location: null },
    });
    assert.equal(result.requests.length, 0);
    assert.equal(readFileSync(lock, 'utf8'), 'other-session');
    assert.equal(readFileSync(f.path, 'utf8'), before);
  }
});

test('concurrent CLI processes rotate once and the waiting process reloads the stored tokens', async (t) => {
  const f = session(t);
  const gate = join(f.home, 'release-refresh');
  const first = start(t, f, 'hold', 'first', { TEST_REFRESH_GATE: gate });
  await waitFor(() => first.requests().length === 1);
  const otherHome = fixture();
  t.after(otherHome.close);
  putToken(otherHome, 'test-token');
  const second = start(t, f, 'ok', 'second', { HOME: otherHome.home });
  await delay(150);
  assert.equal(second.requests().length, 0);
  writeFileSync(gate, '', { mode: 0o600 });
  const results = await Promise.all([first.done, second.done]);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(
    results
      .flatMap((result) => result.requests)
      .filter((request) => request.url.startsWith('https://auth.openai.com')).length,
    1,
  );
  assert.equal(existsSync(join(f.directory, '.login.lock')), false);
});

test('SIGINT and SIGTERM cancel refresh and identity phases while preserving credentials and releasing locks', async (t) => {
  for (const phase of ['token', 'discovery', 'jwks']) {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const f = session(t);
      const before = readFileSync(f.path, 'utf8');
      const running = start(t, f, `cancel-${phase}`);
      const suffix = { token: '/oauth/token', discovery: '/openid-configuration', jwks: '/jwks' }[
        phase
      ];
      await waitFor(() => running.requests().some((request) => request.url.endsWith(suffix)));
      running.child.kill(signal);
      const result = await running.done;
      assert.equal(result.status, 1, phase + signal);
      assert.equal(result.signal, null);
      assert.deepEqual(JSON.parse(result.stderr), {
        error: 'siwc_refresh_cancelled',
        diagnostic: { stage: 'authentication', reason: 'unknown', location: null },
      });
      assert.equal(result.stdout, '');
      assert.equal(readFileSync(f.path, 'utf8'), before);
      assert.equal(existsSync(join(f.directory, '.login.lock')), false);
      assert.ok(
        result.requests.every((request) => request.url.startsWith('https://auth.openai.com')),
      );
    }
  }
});

test('validated rotation is stored before cancellation is honored and no data request starts', (t) => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const f = session(t);
    const result = run(f, `postvalidation-${signal}`);
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.deepEqual(JSON.parse(result.stderr), {
      error: 'siwc_refresh_cancelled',
      diagnostic: { stage: 'authentication', reason: 'unknown', location: null },
    });
    assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).refreshToken, 'synthetic-rotated');
    assert.equal(existsSync(join(f.directory, '.login.lock')), false);
    assert.equal(result.requests.length, 1);
  }
});

test('refresh and remote identity validation share a thirty-second deadline and failed persistence blocks data requests', (t) => {
  for (const mode of ['deadline', 'save-failure']) {
    const f = session(t);
    const before = readFileSync(f.path, 'utf8');
    const result = run(f, mode);
    assert.equal(result.status, 1, mode);
    assert.equal(result.stdout, '');
    assert.match(JSON.parse(result.stderr).error, /^siwc_/);
    assert.equal(readFileSync(f.path, 'utf8'), before);
    assert.equal(existsSync(join(f.directory, '.login.lock')), false);
    assert.ok(
      result.requests.every((request) => request.url.startsWith('https://auth.openai.com')),
    );
    if (mode === 'deadline') assert.equal(result.requests.length, 2);
  }
});
