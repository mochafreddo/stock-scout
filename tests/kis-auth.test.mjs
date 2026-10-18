import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fixture, now, runCli } from './kis-cli-helper.mjs';

test('first execution records initial wait without issuing or querying', () => {
  const f = fixture(false);
  try {
    const result = runCli(f, 'no-network');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(result.requests, []);
    const error = JSON.parse(result.stderr);
    assert.equal(error.error, 'AUTH_COOLDOWN');
    assert.equal(error.retryAfterSeconds, 300);
    assert.equal(JSON.parse(readFileSync(join(f.cache, 'issuance.json'))).kind, 'initial');
    assert.equal(statSync(join(f.cache, 'issuance.json')).mode & 0o777, 0o600);
    assert.equal(statSync(f.cache).mode & 0o777, 0o700);
  } finally {
    f.close();
  }
});

test('after 300 seconds CLI issues, saves and queries, then reuses across executions', () => {
  const f = fixture();
  try {
    const issued = runCli(f);
    assert.equal(issued.status, 0, issued.stderr);
    assert.deepEqual(issued.requests, [
      '/oauth2/tokenP',
      '/uapi/overseas-stock/v1/ranking/trade-vol',
    ]);
    const saved = readFileSync(join(f.cache, 'token.json'), 'utf8');
    assert.doesNotMatch(saved, /test-key|test-secret/);
    assert.equal(statSync(join(f.cache, 'token.json')).mode & 0o777, 0o600);
    const reused = runCli(f);
    assert.equal(reused.status, 0, reused.stderr);
    assert.deepEqual(reused.requests, ['/uapi/overseas-stock/v1/ranking/trade-vol']);
  } finally {
    f.close();
  }
});

function failure(result, code, requests = []) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /test-key|test-secret|test-token/);
  assert.equal(JSON.parse(result.stderr).error, code);
  assert.deepEqual(result.requests, requests);
}
function put(f, name, value) {
  writeFileSync(join(f.cache, name), typeof value === 'string' ? value : JSON.stringify(value), {
    mode: 0o600,
  });
}

test('300-second interval survives failures, returned tokens, credential changes and clock rollback', () => {
  for (const scenario of ['ok', 'issue-transport', 'issue-http', 'issue-malformed']) {
    const f = fixture();
    try {
      const issued = runCli(f, scenario);
      assert.equal(issued.requests[0], '/oauth2/tokenP');
      if (scenario !== 'ok') failure(issued, 'AUTH_FAILED', ['/oauth2/tokenP']);
      for (const credentials of [
        { KIS_APP_KEY: 'changed-key' },
        { KIS_APP_SECRET: 'changed-secret' },
      ]) {
        const early = runCli(f, 'ok', undefined, {
          TEST_NOW: String(now + 299_999),
          ...credentials,
        });
        failure(early, 'AUTH_COOLDOWN');
        assert.equal(JSON.parse(early.stderr).retryAfterSeconds, 1);
      }
      const backwards = runCli(f, 'ok', undefined, {
        TEST_NOW: String(now - 1000),
        KIS_APP_KEY: 'changed-key',
      });
      failure(backwards, 'AUTH_COOLDOWN');
      assert.equal(JSON.parse(backwards.stderr).retryAfterSeconds, 301);
      assert.match(JSON.parse(backwards.stderr).guidance, /clock/);
      assert.equal(JSON.parse(readFileSync(join(f.cache, 'issuance.json'))).at, now);
      const allowed = runCli(f, 'ok', undefined, {
        TEST_NOW: String(now + 300_000),
        KIS_APP_SECRET: 'changed-secret',
      });
      assert.equal(allowed.status, 0, allowed.stderr);
    } finally {
      f.close();
    }
  }
});

test('KST expiry is independent of local timezone and ignores expires_in', () => {
  for (const TZ of ['UTC', 'America/New_York', 'Asia/Seoul']) {
    for (const expires_in of [undefined, 0, 86400, 'bad']) {
      const f = fixture();
      try {
        const body = { access_token_token_expired: '2026-10-18 09:01:01', expires_in };
        const env = { TZ, TEST_TOKEN_BODY: JSON.stringify(body) };
        assert.equal(runCli(f, 'ok', undefined, env).status, 0);
        assert.equal(runCli(f, 'ok', undefined, env).requests.length, 1);
        failure(
          runCli(f, 'ok', undefined, { ...env, TEST_NOW: String(now + 1000) }),
          'AUTH_COOLDOWN',
        );
      } finally {
        f.close();
      }
    }
  }
});

test('invalid or near-expiry issuance fails without querying or retrying', () => {
  for (const body of [
    { access_token: null },
    { access_token: '' },
    { access_token: 'bad\ntoken' },
    { access_token_token_expired: null },
    { access_token_token_expired: 'bad' },
    { access_token_token_expired: '2026-02-30 09:00:00' },
    { access_token_token_expired: '2026-10-18 09:01:00' },
    { access_token_token_expired: '2026-10-18 09:00:00' },
    ...['EGW00102', 'EGW00103', 'EGW00104', 'EGW00105', 'EGW00304', 'EGW00123'].map(
      (error_code) => ({ error_code, error_description: 'test-secret' }),
    ),
  ]) {
    const f = fixture();
    try {
      failure(
        runCli(f, 'ok', undefined, { TEST_TOKEN_BODY: JSON.stringify(body) }),
        'AUTH_FAILED',
        ['/oauth2/tokenP'],
      );
      failure(runCli(f), 'AUTH_COOLDOWN');
    } finally {
      f.close();
    }
  }
});

test('damaged tokens renew under the common interval; damaged issuance records require manual recovery', () => {
  for (const token of [
    '{',
    '{}',
    { access_token: 'test-token', access_token_token_expired: 'bad' },
  ]) {
    const f = fixture();
    try {
      put(f, 'token.json', token);
      assert.equal(runCli(f).status, 0);
    } finally {
      f.close();
    }
  }
  for (const record of ['{', '{}', 'null', { kind: 'attempt', at: 'yesterday' }]) {
    const f = fixture();
    try {
      put(f, 'issuance.json', record);
      failure(runCli(f), 'AUTH_RECORD');
      assert.equal(
        readFileSync(join(f.cache, 'issuance.json'), 'utf8'),
        typeof record === 'string' ? record : JSON.stringify(record),
      );
      unlinkSync(join(f.cache, 'issuance.json'));
      failure(runCli(f), 'AUTH_COOLDOWN');
      assert.equal(JSON.parse(readFileSync(join(f.cache, 'issuance.json'))).kind, 'initial');
    } finally {
      f.close();
    }
  }
});

test('unsafe cache permissions, links and read failures stop authentication', () => {
  for (const target of ['', 'issuance.json', 'token.json']) {
    const f = fixture();
    try {
      if (target === 'token.json') put(f, target, '{}');
      chmodSync(target ? join(f.cache, target) : f.cache, target ? 0o644 : 0o755);
      failure(runCli(f), 'AUTH_STORAGE');
    } finally {
      f.close();
    }
  }
  for (const target of ['token.json', 'issuance.json']) {
    const f = fixture();
    try {
      if (target === 'issuance.json') unlinkSync(join(f.cache, target));
      symlinkSync(join(f.home, 'missing'), join(f.cache, target));
      failure(runCli(f), 'AUTH_STORAGE');
    } finally {
      f.close();
    }
  }
});

test('storage failure prevents issuance or memory-only querying and preserves the interval', () => {
  for (const target of ['issuance.json.tmp', 'token.json.tmp']) {
    const f = fixture();
    try {
      mkdirSync(join(f.cache, target), { mode: 0o700 });
      failure(runCli(f), 'AUTH_STORAGE', target.startsWith('token') ? ['/oauth2/tokenP'] : []);
      if (target.startsWith('token')) failure(runCli(f), 'AUTH_COOLDOWN');
    } finally {
      f.close();
    }
  }
});

test('leftover lock fails promptly and is never removed; lock recovery preserves issuance state', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.cache, 'issuance.lock'), { mode: 0o700 });
    const result = runCli(f);
    failure(result, 'AUTH_LOCKED');
    assert.match(JSON.parse(result.stderr).guidance, /Stop all/);
    assert.ok(statSync(join(f.cache, 'issuance.lock')).isDirectory());
    put(f, 'issuance.json', { kind: 'attempt', at: now });
    rmdirSync(join(f.cache, 'issuance.lock'));
    failure(runCli(f), 'AUTH_COOLDOWN');
  } finally {
    f.close();
  }
});

test('retained tokens cannot bypass the initial wait after issuance-record recovery', () => {
  const f = fixture();
  try {
    assert.equal(runCli(f).status, 0);
    unlinkSync(join(f.cache, 'issuance.json'));
    failure(runCli(f), 'AUTH_COOLDOWN');
    failure(runCli(f), 'AUTH_COOLDOWN');
    failure(runCli(f, 'ok', undefined, { TEST_NOW: String(now + 299_999) }), 'AUTH_COOLDOWN');
    const result = runCli(f, 'ok', undefined, { TEST_NOW: String(now + 300_000) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.requests, ['/uapi/overseas-stock/v1/ranking/trade-vol']);
  } finally {
    f.close();
  }
});

test('concurrent execution cannot issue twice and a successful peer token is reusable', async () => {
  const f = fixture();
  const gate = join(f.home, 'release');
  let child;
  try {
    child = spawn(
      process.execPath,
      [
        '--import',
        new URL('./kis-http-mock.mjs', import.meta.url).pathname,
        new URL('../scripts/kis-probe.ts', import.meta.url).pathname,
        'volume',
        'NAS',
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: f.home,
          KIS_APP_KEY: 'test-key',
          KIS_APP_SECRET: 'test-secret',
          TEST_NOW: String(now),
          TEST_GATE: gate,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    const completed = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    const deadline = Date.now() + 5000;
    while (!existsSync(`${gate}.ready`) && Date.now() < deadline) await setTimeout(10);
    assert.ok(existsSync(`${gate}.ready`), stderr);
    failure(runCli(f), 'AUTH_LOCKED');
    writeFileSync(gate, 'release');
    assert.equal(await completed, 0, stderr);
    assert.equal(runCli(f).requests.length, 1);
  } finally {
    child?.kill();
    f.close();
  }
});

test('expired cached tokens require issuance and pre-issued environment tokens are ignored', () => {
  const f = fixture();
  try {
    assert.equal(runCli(f).status, 0);
    const old = JSON.parse(readFileSync(join(f.cache, 'token.json')));
    put(f, 'token.json', { ...old, access_token_token_expired: '2026-10-18 08:59:59' });
    failure(runCli(f, 'ok', undefined, { KIS_ACCESS_TOKEN: 'test-token' }), 'AUTH_COOLDOWN');
    assert.equal(
      runCli(f, 'ok', undefined, { TEST_NOW: String(now + 300_000) }).requests.length,
      2,
    );
  } finally {
    f.close();
  }
});
