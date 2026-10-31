import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fixture, now, putToken, runCli } from './kis-cli-helper.mjs';

const query = '/uapi/overseas-stock/v1/ranking/trade-vol';
const expired = { rt_cd: '1', msg_cd: 'EGW00123', msg1: 'test-key test-secret rejected-token' };
const transient = { rt_cd: '1', msg_cd: 'EGW00316', msg1: 'test-secret rejected-token' };
const stepsEnv = (steps, env = {}) => ({ TEST_QUERY_STEPS: JSON.stringify(steps), ...env });
function failure(result, code, requests) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /test-key|test-secret|test-token|rejected-token|peer-token/);
  assert.equal(JSON.parse(result.stderr).error, code);
  assert.deepEqual(result.requests, requests);
}

test('EGW00316 retries each GET once with the same inputs and no token issuance', () => {
  for (const kind of ['volume', 'amount', 'daily', 'info']) {
    const f = fixture();
    try {
      const before = putToken(f);
      const detail = join(f.home, 'query-details');
      const result = runCli(
        f,
        'ok',
        [kind, 'NAS', ...(['daily', 'info'].includes(kind) ? ['AAPL'] : [])],
        stepsEnv(
          [{ token: 'rejected-token', body: transient, status: 500 }, { token: 'rejected-token' }],
          { TEST_QUERY_DETAILS: detail },
        ),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.requests.length, 2);
      assert.equal(result.requests[0], result.requests[1]);
      const requests = readFileSync(detail, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(requests[0].url, requests[1].url);
      assert.equal(requests[0].trId, requests[1].trId);
      assert.ok(requests.every((r) => r.tokenMatches));
      assert.ok(
        requests[1].at - requests[0].at >= 950,
        'the bounded retry waits approximately one second',
      );
      assert.deepEqual(JSON.parse(readFileSync(join(f.cache, 'token.json'))), before);
      assert.doesNotMatch(result.stdout + result.stderr, /test-key|test-secret|rejected-token/);
    } finally {
      f.close();
    }
  }
});

test('EGW00316 repeated failures stop at two requests and preserve the public error', () => {
  for (const status of [200, 500]) {
    const f = fixture();
    try {
      putToken(f);
      failure(
        runCli(
          f,
          'ok',
          undefined,
          stepsEnv([
            { token: 'rejected-token', body: transient, status },
            { token: 'rejected-token', body: transient, status },
          ]),
        ),
        status === 500 ? 'HTTP_FAILURE' : 'KIS_FAILURE',
        [query, query],
      );
    } finally {
      f.close();
    }
  }
});

test('EGW00316 retry requires the exact structured failure and never retries other errors', () => {
  for (const step of [
    { raw: 'EGW00316', status: 500 },
    { body: { rt_cd: '1', msg1: 'EGW00316' }, status: 500 },
    { body: { rt_cd: '1', msg_cd: ['EGW00316'] }, status: 500 },
    { body: { rt_cd: '1', msg_cd: 'EGW00316 ' }, status: 500 },
    { body: { rt_cd: '1', msg_cd: 'EGW00201' }, status: 500 },
    { body: { rt_cd: '0', msg_cd: 'EGW00316', output1: {}, output2: [] } },
    {
      body: { rt_cd: '0', msg_cd: 'EGW00316', output1: {}, output2: [] },
      status: 500,
      code: 'HTTP_FAILURE',
    },
  ]) {
    const f = fixture();
    try {
      putToken(f);
      const result = runCli(f, 'ok', undefined, stepsEnv([{ token: 'rejected-token', ...step }]));
      assert.equal(result.status, 1, result.stdout);
      assert.equal(result.stdout, '');
      assert.deepEqual(result.requests, [query]);
      if (step.code) assert.equal(JSON.parse(result.stderr).error, step.code);
    } finally {
      f.close();
    }
  }
});

test('EGW00316 and explicit expiry each keep a single independent recovery budget', () => {
  for (const sequence of ['TE', 'ET', 'TET', 'ETE']) {
    const f = fixture();
    try {
      putToken(f);
      let token = 'rejected-token';
      const steps = [...sequence].map((code) => {
        const step = { token, body: code === 'T' ? transient : expired, status: 500 };
        if (code === 'E') token = 'test-token';
        return step;
      });
      steps.push({ token: 'test-token' });
      const result = runCli(f, 'ok', undefined, stepsEnv(steps));
      assert.equal(result.status, sequence.length === 2 ? 0 : 1, result.stderr);
      assert.equal(result.requests.filter((r) => r === query).length, 3);
      assert.equal(result.requests.filter((r) => r === '/oauth2/tokenP').length, 1);
      assert.equal(existsSync(join(f.cache, 'token.json')), sequence !== 'ETE');
      if (sequence.length === 3) assert.equal(result.stdout, '');
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /test-key|test-secret|rejected-token|test-token/,
      );
    } finally {
      f.close();
    }
  }
});

test('explicit structured expiry recovers once through the shared auth policy', () => {
  const f = fixture();
  try {
    putToken(f);
    const result = runCli(f, 'ok', undefined, {
      TEST_QUERY_STEPS: JSON.stringify([{ token: 'rejected-token', body: expired }]),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.requests, [query, '/oauth2/tokenP', query]);
    assert.equal(JSON.parse(result.stdout).rows[0].symb, 'AAPL');
    assert.equal(JSON.parse(readFileSync(join(f.cache, 'token.json'))).access_token, 'test-token');
    assert.equal(JSON.parse(readFileSync(join(f.cache, 'issuance.json'))).at, now);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /test-key|test-secret|test-token|rejected-token/,
    );
  } finally {
    f.close();
  }
});

test('all observation modes recover structured non-2xx expiry despite success-shaped rows', () => {
  for (const kind of ['volume', 'amount', 'daily', 'info']) {
    const f = fixture();
    try {
      putToken(f);
      const result = runCli(
        f,
        'ok',
        [kind, 'NAS', ...(['daily', 'info'].includes(kind) ? ['AAPL'] : [])],
        stepsEnv([
          {
            token: 'rejected-token',
            body: {
              ...expired,
              output1: {},
              output2: [{ symb: 'WRONG' }],
              output: { std_pdno: 'WRONG' },
            },
            status: 401,
          },
        ]),
      );
      assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
      assert.equal(result.requests.length, 3);
      assert.equal(result.requests[1], '/oauth2/tokenP');
      assert.equal(result.requests[0], result.requests[2]);
      assert.doesNotMatch(result.stdout, /WRONG|test-key|test-secret|test-token|rejected-token/);
    } finally {
      f.close();
    }
  }
});

test('only exact structured query expiry permits recovery; other errors retain cache', () => {
  const cases = [
    ...[
      'EGW00121',
      'EGW00122',
      'EGW00102',
      'EGW00103',
      'EGW00104',
      'EGW00105',
      'EGW00304',
      'EGW00205',
      'EGW00120',
      'EGW00126',
      'EGW00202',
      'EGW00203',
      'EGW00300',
      'EGW00301',
      'EGW00302',
      'EGW00111',
      'EGW00133',
      'EGW00124',
      'EGW00128',
      'EGW00123 ',
      'egw00123',
      'UNKNOWN',
    ].map((msg_cd) => ({ body: { ...expired, msg_cd } })),
    { body: { rt_cd: '1', msg1: 'EGW00123 expired token' } },
    { body: { rt_cd: '1', error_code: 'EGW00123' } },
    { body: { rt_cd: '1', msg_cd: ['EGW00123'] } },
    { body: { rt_cd: '1', msg_cd: { code: 'EGW00123' } } },
    { body: { rt_cd: '0', msg_cd: 'EGW00123', output1: {}, output2: [] } },
    { raw: 'EGW00123 test-secret' },
    { raw: 'EGW00123 test-secret', status: 401 },
    { raw: '', status: 403 },
    { transport: true },
  ];
  for (const item of cases) {
    const f = fixture();
    try {
      const before = putToken(f);
      const result = runCli(f, 'ok', undefined, stepsEnv([{ token: 'rejected-token', ...item }]));
      assert.equal(result.status, 1, JSON.stringify(item));
      assert.equal(result.stdout, '');
      assert.deepEqual(result.requests, [query]);
      assert.doesNotMatch(result.stderr, /test-key|test-secret|test-token|rejected-token/);
      assert.deepEqual(JSON.parse(readFileSync(join(f.cache, 'token.json'))), before);
    } finally {
      f.close();
    }
  }
});

test('cooldown keeps rejected tokens invalidated and permits exactly the 300-second boundary', () => {
  for (const elapsed of [0, 299_999, 300_000]) {
    const f = fixture();
    try {
      putToken(f);
      writeFileSync(
        join(f.cache, 'issuance.json'),
        JSON.stringify({ kind: 'attempt', at: now - elapsed }),
        { mode: 0o600 },
      );
      const result = runCli(
        f,
        'ok',
        undefined,
        stepsEnv([{ token: 'rejected-token', body: expired }]),
      );
      if (elapsed === 300_000) {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(result.requests, [query, '/oauth2/tokenP', query]);
      } else {
        failure(result, 'AUTH_COOLDOWN', [query]);
        assert.equal(
          JSON.parse(result.stderr).retryAfterSeconds,
          Math.ceil((300_000 - elapsed) / 1000),
        );
        assert.equal(existsSync(join(f.cache, 'token.json')), false);
        assert.equal(JSON.parse(readFileSync(join(f.cache, 'issuance.json'))).at, now - elapsed);
        failure(runCli(f), 'AUTH_COOLDOWN', []);
      }
    } finally {
      f.close();
    }
  }
});

test('invalidation compares token identity even after local expiry has advanced', () => {
  const f = fixture();
  try {
    putToken(f);
    writeFileSync(join(f.cache, 'issuance.json'), JSON.stringify({ kind: 'attempt', at: now }), {
      mode: 0o600,
    });
    const result = runCli(
      f,
      'issue-transport',
      undefined,
      stepsEnv([{ token: 'rejected-token', body: expired, advance: 3_600_000 }]),
    );
    failure(result, 'AUTH_FAILED', [query, '/oauth2/tokenP']);
    assert.equal(existsSync(join(f.cache, 'token.json')), false);
  } finally {
    f.close();
  }
});

test('second expiry invalidates the retry token without a third query or issuance', () => {
  const f = fixture();
  try {
    putToken(f);
    failure(
      runCli(
        f,
        'ok',
        undefined,
        stepsEnv([
          { token: 'rejected-token', body: expired },
          { token: 'test-token', body: expired, status: 500 },
        ]),
      ),
      'KIS_FAILURE',
      [query, '/oauth2/tokenP', query],
    );
    assert.equal(existsSync(join(f.cache, 'token.json')), false);
    assert.equal(JSON.parse(readFileSync(join(f.cache, 'issuance.json'))).at, now);
    failure(runCli(f), 'AUTH_COOLDOWN', []);
  } finally {
    f.close();
  }
});

test('retry failures stop without invalidating a token absent explicit expiry', () => {
  for (const step of [
    { body: { ...expired, msg_cd: 'EGW00121' } },
    { transport: true },
    { raw: 'test-secret', status: 500 },
  ]) {
    const f = fixture();
    try {
      putToken(f);
      const result = runCli(
        f,
        'ok',
        undefined,
        stepsEnv([{ token: 'rejected-token', body: expired }, step]),
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.deepEqual(result.requests, [query, '/oauth2/tokenP', query]);
      assert.equal(
        JSON.parse(readFileSync(join(f.cache, 'token.json'))).access_token,
        'test-token',
      );
      assert.doesNotMatch(result.stderr, /test-secret|test-token|rejected-token/);
    } finally {
      f.close();
    }
  }
});

test('recovery issuance never accepts a rejected token or recurses on issuance errors', () => {
  for (const env of [
    { TEST_TOKEN_BODY: JSON.stringify({ access_token: 'rejected-token' }) },
    {
      TEST_TOKEN_BODY: JSON.stringify({ error_code: 'EGW00123', error_description: 'test-secret' }),
    },
  ]) {
    const f = fixture();
    try {
      putToken(f);
      failure(
        runCli(f, 'ok', undefined, stepsEnv([{ token: 'rejected-token', body: expired }], env)),
        'AUTH_FAILED',
        [query, '/oauth2/tokenP'],
      );
      assert.equal(existsSync(join(f.cache, 'token.json')), false);
      assert.equal(JSON.parse(readFileSync(join(f.cache, 'issuance.json'))).at, now);
      failure(runCli(f), 'AUTH_COOLDOWN', []);
    } finally {
      f.close();
    }
  }
});

test('recovery fails safely on lock, invalidation permissions and save failures', () => {
  for (const fault of ['lock', 'unsafe', 'blockSave']) {
    const f = fixture();
    try {
      putToken(f);
      failure(
        runCli(
          f,
          'ok',
          undefined,
          stepsEnv([{ token: 'rejected-token', body: expired, [fault]: true }]),
        ),
        fault === 'lock' ? 'AUTH_LOCKED' : 'AUTH_STORAGE',
        fault === 'blockSave' ? [query, '/oauth2/tokenP'] : [query],
      );
      assert.equal(existsSync(join(f.cache, 'token.json')), fault !== 'blockSave');
      assert.equal(
        JSON.parse(readFileSync(join(f.cache, 'issuance.json'))).at,
        fault === 'blockSave' ? now : now - 300_000,
      );
    } finally {
      f.close();
    }
  }
});

test('conditional invalidation preserves a changed-credential peer token', () => {
  const f = fixture();
  try {
    const peer = putToken(f, 'rejected-token', 'changed-key', 'changed-secret');
    putToken(f);
    writeFileSync(join(f.cache, 'issuance.json'), JSON.stringify({ kind: 'attempt', at: now }), {
      mode: 0o600,
    });
    failure(
      runCli(f, 'ok', undefined, stepsEnv([{ token: 'rejected-token', body: expired, peer }])),
      'AUTH_COOLDOWN',
      [query],
    );
    assert.ok(existsSync(join(f.cache, 'token.json')));
    assert.deepEqual(JSON.parse(readFileSync(join(f.cache, 'token.json'))), peer);
  } finally {
    f.close();
  }
});

test('second expiry preserves a newer peer token and does not query it', () => {
  const f = fixture();
  try {
    const peer = putToken(f, 'peer-token');
    putToken(f);
    failure(
      runCli(
        f,
        'ok',
        undefined,
        stepsEnv([
          { token: 'rejected-token', body: expired },
          { token: 'test-token', body: expired, peer },
        ]),
      ),
      'KIS_FAILURE',
      [query, '/oauth2/tokenP', query],
    );
    assert.deepEqual(JSON.parse(readFileSync(join(f.cache, 'token.json'))), peer);
  } finally {
    f.close();
  }
});

test('a concurrent CLI peer refresh survives rejection of the original token and is reused once', async () => {
  const f = fixture();
  const gate = join(f.home, 'query-release');
  const trace = join(f.home, 'primary-requests');
  let child;
  try {
    putToken(f);
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
          TEST_QUERY_GATE: gate,
          TEST_TRACE: trace,
          ...stepsEnv([
            { token: 'rejected-token', body: expired, gate: true },
            { token: 'peer-token' },
          ]),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (bytes) => {
      stdout += bytes;
    });
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    const completed = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    const deadline = Date.now() + 5000;
    while (!existsSync(`${gate}.ready`) && Date.now() < deadline) await setTimeout(10);
    assert.ok(existsSync(`${gate}.ready`), stderr);
    const peer = runCli(
      f,
      'ok',
      undefined,
      stepsEnv([{ token: 'peer-token' }], {
        TEST_NOW: String(now + 3_540_000),
        TEST_TOKEN_BODY: JSON.stringify({
          access_token: 'peer-token',
          access_token_token_expired: '2026-10-18 12:00:00',
        }),
      }),
    );
    assert.equal(peer.status, 0, peer.stderr);
    assert.deepEqual(peer.requests, ['/oauth2/tokenP', query]);
    writeFileSync(gate, 'release', { mode: 0o600 });
    assert.equal(await completed, 0, stderr);
    assert.equal(JSON.parse(stdout).rows[0].symb, 'AAPL');
    assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), [query, query]);
    assert.equal(JSON.parse(readFileSync(join(f.cache, 'token.json'))).access_token, 'peer-token');
    assert.doesNotMatch(stdout + stderr, /test-key|test-secret|rejected-token|peer-token/);
  } finally {
    child?.kill();
    f.close();
  }
});
