import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture as kisFixture, now, putToken } from './kis-cli-helper.mjs';

const script = new URL('../scripts/siwc-auth.ts', import.meta.url).pathname;
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'siwc-test-'));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    directory: join(root, 'credentials'),
    trace: join(root, 'trace'),
    auth: join(root, 'authorization'),
  };
}
async function login(t, f, mode = '', callback = {}, beforeCallback) {
  writeFileSync(f.trace, '', { mode: 0o600 });
  const child = spawn(process.execPath, [script, 'login', f.directory], {
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: `--import=${new URL('./siwc-auth-http-mock.mjs', import.meta.url).pathname}`,
      TEST_TRACE: f.trace,
      TEST_AUTH_URL: f.auth,
      TEST_MODE: mode,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const done = once(child, 'close');
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Authorization URL timeout'));
    }, 5000);
    child.stdout.on('data', () => {
      if (stdout.includes('\n')) {
        clearTimeout(timer);
        resolve(stdout.split('\n')[0]);
      }
    });
    child.once('close', () => {
      clearTimeout(timer);
      reject(new Error(`Login exited before authorization: ${stderr}`));
    });
  });
  const authorization = new URL(JSON.parse(line).authorizationUrl);
  writeFileSync(f.auth, authorization.href, { mode: 0o600 });
  await beforeCallback?.(authorization);
  const redirect = new URL(authorization.searchParams.get('redirect_uri'));
  if (mode === 'malformed-callback') {
    await new Promise((resolve, reject) => {
      const incoming = request(
        { hostname: '127.0.0.1', port: redirect.port, path: 'http://[', method: 'GET' },
        (response) => {
          response.resume();
          resolve();
        },
      );
      incoming.on('error', reject);
      incoming.end();
    });
  }
  redirect.search = new URLSearchParams({
    code: 'fixture-code',
    state: authorization.searchParams.get('state'),
    client_id: 'oaiapp_fixture',
    ...callback,
  }).toString();
  await fetch(redirect);
  if (mode.startsWith('cancel:')) {
    const [, phase, signal] = mode.split(':');
    const suffix = {
      token: '/oauth/token',
      discovery: '/openid-configuration',
      jwks: '/jwks.json',
    }[phase];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error('Network fixture did not pause'));
      }, 5000);
      const poll = setInterval(() => {
        if (
          readFileSync(f.trace, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(JSON.parse)
            .some((item) => item.url?.endsWith(suffix))
        ) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 5);
    });
    child.kill(signal);
  }
  const [status, signal] = await done;
  return {
    status,
    signal,
    stdout,
    stderr,
    authorization,
    requests: readFileSync(f.trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
  };
}
function reader(directory, expiry = false) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { readSiwcCredentials } from ${JSON.stringify(new URL('../scripts/siwc-auth.ts', import.meta.url).href)}; try { const c = await readSiwcCredentials(process.argv[1]); console.log(JSON.stringify(process.argv[2] === 'expiry' ? {expiresAt:c.expiresAt} : {clientId:c.clientId, subject:c.subject, valid:c.expiresAt > Date.now(), tokenPresent:!!c.accessToken})); } catch(e) { console.error(JSON.stringify({error:e.message})); process.exitCode=1; }`,
      directory,
      expiry ? 'expiry' : 'summary',
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: `--import=${new URL('./siwc-auth-http-mock.mjs', import.meta.url).pathname}`,
        TEST_MODE: 'reader-block-network',
      },
    },
  );
}

test('new registration exchanges PKCE with issued client and stores private credentials for the public reader', async (t) => {
  const f = fixture(t);
  const result = await login(t, f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const params = result.authorization.searchParams;
  assert.equal(
    result.authorization.origin + result.authorization.pathname,
    'https://auth.openai.com/api/accounts/authorize',
  );
  assert.equal(params.get('client_id'), 'dynamic_agent_client');
  assert.equal(params.get('agent_name_hint'), 'Stock Scout');
  assert.match(params.get('ext_agent_host_id'), /^urn:uuid:/);
  assert.equal(
    params.get('scope'),
    'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  );
  assert.equal(params.get('resource'), 'https://api.openai.com/v1');
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('code_challenge_method'), 'S256');
  const token = result.requests.find((request) => request.url.endsWith('/oauth/token'));
  assert.equal(token.method, 'POST');
  const form = new URLSearchParams(token.body);
  assert.equal(form.get('client_id'), 'oaiapp_fixture');
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'fixture-code');
  assert.equal(form.get('redirect_uri'), params.get('redirect_uri'));
  assert.equal(form.get('resource'), 'https://api.openai.com/v1');
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  for (const name of ['host.json', 'credentials.json'])
    assert.equal(statSync(join(f.directory, name)).mode & 0o777, 0o600);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_|fixture-account/);
  const read = reader(f.directory);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), {
    clientId: 'oaiapp_fixture',
    subject: 'fixture-account',
    valid: true,
    tokenPresent: true,
  });
  assert.ok(existsSync(join(f.directory, 'host.json')));
});

test('returning sign-in keeps the issued registration and host, without printing retained identity hints', async (t) => {
  const f = fixture(t);
  const initial = await login(t, f);
  assert.equal(initial.status, 0, initial.stderr);
  const credentials = JSON.parse(readFileSync(join(f.directory, 'credentials.json')));
  credentials.expiresAt = 1;
  writeFileSync(join(f.directory, 'credentials.json'), JSON.stringify(credentials));
  assert.equal(reader(f.directory).status, 1);
  const result = await login(t, f, '', { client_id: '' });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), { error: 'siwc_invalid_callback' });
  const retry = await login(t, f);
  assert.equal(retry.status, 0, retry.stderr);
  const params = retry.authorization.searchParams;
  assert.equal(params.get('client_id'), 'oaiapp_fixture');
  assert.equal(
    params.get('ext_agent_host_id'),
    initial.authorization.searchParams.get('ext_agent_host_id'),
  );
  assert.equal(params.has('agent_name_hint'), false);
  assert.equal(params.has('id_token_hint'), false);
  assert.equal(params.has('login_hint'), false);
  assert.equal(reader(f.directory).status, 0);
});

test('untrusted callback results never exchange a code or replace credentials', async (t) => {
  const f = fixture(t);
  assert.equal((await login(t, f)).status, 0);
  const before = readFileSync(join(f.directory, 'credentials.json'), 'utf8');
  for (const callback of [
    { state: 'incorrect' },
    { state: 'x'.repeat(43) },
    { client_id: 'other-client' },
    { error: 'RAW_PRIVATE_ERROR' },
  ]) {
    const result = await login(t, f, '', callback);
    assert.equal(result.status, 1);
    assert.equal(result.requests.length, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /RAW_PRIVATE_ERROR|PRIVATE_/);
    assert.equal(readFileSync(join(f.directory, 'credentials.json'), 'utf8'), before);
  }
});

test('token, identity, account and permission failures preserve the previously selected account', async (t) => {
  const f = fixture(t);
  assert.equal((await login(t, f)).status, 0);
  const before = readFileSync(join(f.directory, 'credentials.json'), 'utf8');
  for (const mode of [
    'token-error',
    'signature',
    'audience',
    'nonce',
    'expired-id',
    'account',
    'scope',
  ]) {
    const result = await login(t, f, mode);
    assert.equal(result.status, 1, mode);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /RAW_PRIVATE_ERROR|PRIVATE_|fixture-account/,
    );
    assert.equal(readFileSync(join(f.directory, 'credentials.json'), 'utf8'), before, mode);
    assert.equal(existsSync(join(f.directory, '.login.lock')), false);
  }
});

test('public credential reader fails closed for unsafe or mismatched records and unavailable refresh', async (t) => {
  const f = fixture(t);
  assert.equal((await login(t, f)).status, 0);
  const path = join(f.directory, 'credentials.json');
  const before = readFileSync(path, 'utf8');
  const credentials = JSON.parse(before);
  for (const change of [
    { expiresAt: 1 },
    { clientId: 'dynamic_agent_client' },
    { hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000' },
    { scopes: ['openid', 'resource.invoke'] },
    { scopes: ['openid', 'resource.invoke', 'chatgpt.tokens.use.direct', 'invalid scope'] },
  ]) {
    writeFileSync(path, JSON.stringify({ ...credentials, ...change }));
    const result = reader(f.directory);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /PRIVATE_/);
  }
  writeFileSync(path, before);
  chmodSync(path, 0o644);
  assert.equal(reader(f.directory).status, 1);
  chmodSync(path, 0o600);
  chmodSync(f.directory, 0o755);
  assert.equal(reader(f.directory).status, 1);
  chmodSync(f.directory, 0o700);
  const alias = join(f.root, 'alias');
  symlinkSync(f.directory, alias);
  assert.equal(reader(alias).status, 1);
  rmSync(path);
  const target = join(f.root, 'target');
  writeFileSync(target, before, { mode: 0o600 });
  symlinkSync(target, path);
  assert.equal(reader(f.directory).status, 1);
});

test('registration without an issued client ID fails before token exchange', async (t) => {
  const f = fixture(t);
  const result = await login(t, f, '', { client_id: 'dynamic_agent_client' });
  assert.equal(result.status, 1);
  assert.equal(result.requests.length, 0);
  assert.equal(existsSync(join(f.directory, 'credentials.json')), false);
});

test('malformed loopback request cannot crash a pending login or expose callback text', async (t) => {
  const f = fixture(t);
  const result = await login(t, f, 'malformed-callback');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /ERR_INVALID_URL|http:\/\/\[/);
});

test('SIGINT and SIGTERM during token and identity requests abort network and remove the login lock', async (t) => {
  const f = fixture(t);
  assert.equal((await login(t, f)).status, 0);
  const before = readFileSync(join(f.directory, 'credentials.json'), 'utf8');
  for (const phase of ['token', 'discovery', 'jwks']) {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const result = await login(t, f, `cancel:${phase}:${signal}`);
      assert.equal(result.status, 1, `${phase} ${signal}`);
      assert.equal(result.signal, null);
      assert.deepEqual(JSON.parse(result.stderr), { error: 'siwc_login_cancelled' });
      assert.equal(result.requests.filter((item) => item.event === 'aborted').length, 1);
      assert.equal(existsSync(join(f.directory, '.login.lock')), false);
      assert.equal(readFileSync(join(f.directory, 'credentials.json'), 'utf8'), before);
    }
  }
});

test('access-token expiry starts when tokens arrive and excludes identity validation delay', async (t) => {
  const f = fixture(t);
  const result = await login(t, f, 'validation-delay');
  assert.equal(result.status, 0, result.stderr);
  const read = reader(f.directory, true);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), { expiresAt: 2_000_000_120_000 });
});

test('tokens that expire during identity validation are never installed', async (t) => {
  for (const returning of [false, true]) {
    const f = fixture(t);
    if (returning) assert.equal((await login(t, f)).status, 0);
    const path = join(f.directory, 'credentials.json');
    const before = returning ? readFileSync(path, 'utf8') : null;
    const result = await login(t, f, 'validation-stale');
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), { error: 'siwc_credentials_expired' });
    assert.equal(existsSync(join(f.directory, '.login.lock')), false);
    if (returning) assert.equal(readFileSync(path, 'utf8'), before);
    else assert.equal(existsSync(path), false);
  }
});

test('explicit login reuses the account, issued client and host after unusable tokens were cleared', async (t) => {
  const f = fixture(t);
  assert.equal((await login(t, f)).status, 0);
  const { schemaVersion, issuer, subject, clientId, hostId } = JSON.parse(
    readFileSync(join(f.directory, 'credentials.json')),
  );
  writeFileSync(
    join(f.directory, 'credentials.json'),
    JSON.stringify({ schemaVersion, issuer, subject, clientId, hostId }),
  );
  const result = await login(t, f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.authorization.searchParams.get('client_id'), clientId);
  assert.equal(result.authorization.searchParams.get('ext_agent_host_id'), hostId);
  assert.equal(result.authorization.searchParams.has('agent_name_hint'), false);
  assert.equal(reader(f.directory).status, 0);
});

test('login persists the server refresh time for the next CLI process', async (t) => {
  const f = fixture(t);
  const result = await login(t, f, 'earliest');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(readFileSync(join(f.directory, 'credentials.json'))).earliestRefreshAt,
    1792285200,
  );
});

function probe(t, f, mode, extraEnv = {}) {
  const home = kisFixture();
  t.after(home.close);
  putToken(home, 'test-token');
  const trace = join(f.root, 'probe-trace');
  writeFileSync(trace, '', { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      '--import',
      new URL('./siwc-refresh-http-mock.mjs', import.meta.url).pathname,
      new URL('../scripts/llm-security-probe.ts', import.meta.url).pathname,
      f.directory,
      'gpt-6-luna',
      '1',
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home.home,
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

test('a CLI with a valid old token waits for login and reloads its completed state', async (t) => {
  const f = fixture(t);
  assert.equal((await login(t, f)).status, 0);
  let running;
  const signedIn = await login(t, f, '', {}, async () => {
    running = probe(t, f, 'ok', { TEST_MODEL_TOKEN: 'PRIVATE_ACCESS_TOKEN' });
    await delay(250);
    assert.equal(running.requests().length, 0);
  });
  assert.equal(signedIn.status, 0, signedIn.stderr);
  const result = await running.done;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.requests.every((request) => !request.url.startsWith('https://auth.openai.com')));
  assert.equal(existsSync(join(f.directory, '.login.lock')), false);
});

test('login waits for an in-flight refresh and then reuses its account and registration', async (t) => {
  const f = fixture(t);
  assert.equal((await login(t, f)).status, 0);
  const credentials = JSON.parse(readFileSync(join(f.directory, 'credentials.json')));
  credentials.expiresAt = 1;
  writeFileSync(join(f.directory, 'credentials.json'), JSON.stringify(credentials));
  const gate = join(f.root, 'refresh-gate');
  const running = probe(t, f, 'hold', { TEST_REFRESH_GATE: gate });
  for (let count = 0; count < 500 && running.requests().length === 0; count++) await delay(10);
  assert.equal(running.requests().length, 1);
  const signingIn = login(t, f);
  await delay(250);
  assert.equal(readFileSync(f.trace, 'utf8'), '');
  writeFileSync(gate, '', { mode: 0o600 });
  const [refreshed, signedIn] = await Promise.all([running.done, signingIn]);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.equal(signedIn.status, 0, signedIn.stderr);
  assert.equal(signedIn.authorization.searchParams.get('client_id'), credentials.clientId);
  assert.equal(signedIn.authorization.searchParams.get('ext_agent_host_id'), credentials.hostId);
  assert.equal(existsSync(join(f.directory, '.login.lock')), false);
});
