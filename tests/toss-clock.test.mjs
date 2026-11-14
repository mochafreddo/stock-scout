import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture, price, readRequests, runCli } from './toss-cli-helper.mjs';

test('v2 reservation with incompatible legacy sentinel remains queryable by the current CLI', async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.directory, 'state.json'),
      JSON.stringify({
        fingerprint: createHash('sha256')
          .update(JSON.stringify(['synthetic-client', 'synthetic-secret']))
          .digest('hex'),
        version: 2,
        nextAt: null,
        clock: {
          id: 'darwin-mach-continuous:11111111-1111-4111-8111-111111111111',
          nextNs: '000000000000000000000000000000',
        },
        pending: false,
        token: { value: 'synthetic-token', expiresAt: Date.parse('2026-11-07T15:00:00Z') },
      }),
      { mode: 0o600 },
    );
    const result = await runCli(f, [], undefined, { TEST_PLATFORM: 'darwin' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].method, 'GET');
  } finally {
    f.close();
  }
});

for (const wallJump of [0, 2000, -2000])
  test(`wall correction ${wallJump} preserves actual spacing between consecutive CLI sends`, async () => {
    const f = fixture();
    try {
      const result = await runCli(
        f,
        [{ status: 500, body: {}, wallJump }, { body: { result: [price] } }],
        undefined,
        { TEST_REAL_CLOCK: '1' },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.requests.length, 3);
      for (let index = 1; index < result.requests.length; index++)
        assert.ok(
          BigInt(result.requests[index].nativeNs) - BigInt(result.requests[index - 1].nativeNs) >=
            1000000000n,
          JSON.stringify(result.requests),
        );
    } finally {
      f.close();
    }
  });

test('legacy state and changed boot identity block without changing state or issuing HTTP', async () => {
  for (const kind of ['legacy', 'boot']) {
    const f = fixture();
    try {
      const first = await runCli(f);
      assert.equal(first.status, 0, first.stdout + first.stderr);
      const path = join(f.directory, 'state.json');
      const state = JSON.parse(readFileSync(path, 'utf8'));
      if (kind === 'legacy') {
        delete state.version;
        delete state.clock;
        state.nextAt = 0;
      }
      writeFileSync(path, JSON.stringify(state));
      const before = readFileSync(path);
      const result = await runCli(
        f,
        [],
        undefined,
        kind === 'boot' ? { TEST_BOOT_ID: '22222222-2222-4222-8222-222222222222' } : {},
      );
      assert.equal(result.status, 1);
      assert.equal(
        JSON.parse(result.stdout).error.code,
        kind === 'legacy' ? 'AUTH_STATE_TRANSITION_REQUIRED' : 'CLOCK_UNCERTAIN',
      );
      assert.equal(result.requests.length, 2);
      assert.deepEqual(readFileSync(path), before);
    } finally {
      f.close();
    }
  }
});

test('malformed legacy state is storage failure rather than an approved-transition candidate', async () => {
  for (const invalid of [
    { fingerprint: 'wrong-client' },
    { pending: 'false' },
    { pending: undefined },
    { token: { value: 'invalid token', expiresAt: 1794063600000 } },
    { token: { value: 'synthetic-token', expiresAt: 'invalid' } },
    { nextAt: -1 },
  ]) {
    const f = fixture();
    try {
      const initial = await runCli(f);
      assert.equal(initial.status, 0, initial.stdout + initial.stderr);
      const path = join(f.directory, 'state.json');
      const state = JSON.parse(readFileSync(path, 'utf8'));
      delete state.version;
      delete state.clock;
      const before = JSON.stringify({ ...state, nextAt: 0, ...invalid });
      writeFileSync(path, before);
      const result = await runCli(f);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).error.code, 'AUTH_STORAGE');
      assert.equal(result.requests.length, initial.requests.length);
      assert.equal(readFileSync(path, 'utf8'), before);
    } finally {
      f.close();
    }
  }
});

test('unavailable clock and unsupported platforms block before authentication HTTP', async () => {
  for (const extra of [
    { TEST_CLOCK_UNAVAILABLE: '1' },
    { TEST_PLATFORM: 'win32' },
    { TEST_BOOT_ID: 'invalid' },
  ]) {
    const f = fixture();
    try {
      const result = await runCli(f, [], undefined, extra);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).error.code, 'CLOCK_UNCERTAIN');
      assert.equal(result.requests.length, 0);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret/);
    } finally {
      f.close();
    }
  }
});

test('Linux clock state rejects a different time namespace before HTTP', async () => {
  const f = fixture();
  try {
    const first = await runCli(f, [], undefined, { TEST_PLATFORM: 'linux' });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const second = await runCli(f, [], undefined, {
      TEST_PLATFORM: 'linux',
      TEST_TIME_NAMESPACE: 'time:[456]',
    });
    assert.equal(second.status, 1);
    assert.equal(JSON.parse(second.stdout).error.code, 'CLOCK_UNCERTAIN');
    assert.equal(second.requests.length, 2);
  } finally {
    f.close();
  }
});

test('Linux clock rejects offsets belonging to a different child time namespace before HTTP', async () => {
  const f = fixture();
  try {
    const result = await runCli(f, [], undefined, {
      TEST_PLATFORM: 'linux',
      TEST_CHILD_TIME_NAMESPACE: 'time:[456]',
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, 'CLOCK_UNCERTAIN');
    assert.equal(result.requests.length, 0);
  } finally {
    f.close();
  }
});

test('Linux clock state rejects changed, malformed and unavailable monotonic namespace offsets', async () => {
  for (const extra of [
    { TEST_TIME_OFFSET: 'monotonic 3600 0\nboottime 0 0\n' },
    { TEST_TIME_OFFSET: 'monotonic invalid 0\n' },
    { TEST_TIME_OFFSET: 'monotonic 0 1000000000\n' },
    { TEST_TIME_OFFSET_UNAVAILABLE: '1' },
  ]) {
    const f = fixture();
    try {
      const first = await runCli(f, [], undefined, { TEST_PLATFORM: 'linux' });
      assert.equal(first.status, 0, first.stdout + first.stderr);
      const path = join(f.directory, 'state.json');
      const before = readFileSync(path);
      const second = await runCli(f, [], undefined, { TEST_PLATFORM: 'linux', ...extra });
      assert.equal(second.status, 1);
      assert.equal(JSON.parse(second.stdout).error.code, 'CLOCK_UNCERTAIN');
      assert.equal(second.requests.length, 2);
      assert.deepEqual(readFileSync(path), before);
    } finally {
      f.close();
    }
  }
});

test('provider cooldown persists across wall corrections and expires on the shared clock', async () => {
  const f = fixture();
  try {
    const first = await runCli(f, [
      { status: 429, headers: { 'Retry-After': '70', 'X-RateLimit-Reset': '80' }, body: {} },
    ]);
    assert.equal(JSON.parse(first.stdout).error.code, 'TIMEOUT');
    assert.equal(first.requests.length, 2);
    const early = await runCli(f, [], undefined, {
      TEST_CLOCK_JUMP: 'wall',
      TEST_CLOCK_JUMP_MS: '2000',
      TEST_CLOCK_JUMP_AT: '2',
    });
    assert.equal(JSON.parse(early.stdout).error.code, 'TIMEOUT');
    assert.equal(early.requests.length, 2);
    const late = await runCli(f, [], undefined, {
      TEST_CLOCK_START: String(Date.parse('2026-11-06T15:01:30Z')),
    });
    assert.equal(late.status, 0, late.stdout + late.stderr);
    assert.equal(late.requests.length, 3);
    assert.equal(late.requests.filter((request) => request.method === 'POST').length, 1);
  } finally {
    f.close();
  }
});

for (const wallJump of [16000, 60001])
  test(`provider cooldown survives a ${wallJump}ms wall jump at response-header handoff`, async () => {
    const f = fixture();
    try {
      const first = await runCli(f, [
        {
          status: 429,
          headers: { 'Retry-After': '80' },
          body: {},
          responseWallJump: wallJump,
        },
      ]);
      assert.equal(first.status, 1);
      assert.equal(JSON.parse(first.stdout).error.code, 'TIMEOUT');
      assert.equal(first.requests.length, 2);
      const early = await runCli(f);
      assert.equal(early.status, 1, early.stdout + early.stderr);
      assert.equal(JSON.parse(early.stdout).error.code, 'TIMEOUT');
      assert.equal(early.requests.length, 2);
      const late = await runCli(f, [], undefined, {
        TEST_CLOCK_START: String(Date.parse('2026-11-06T15:01:30Z')),
      });
      assert.equal(late.status, 0, late.stdout + late.stderr);
      assert.equal(late.requests.length, 3);
      assert.equal(late.requests.filter((request) => request.method === 'POST').length, 1);
      assert.equal(
        readdirSync(f.directory).filter((name) => name.startsWith('cooldown-')).length,
        0,
      );
    } finally {
      f.close();
    }
  });

test('concurrent response cooldowns preserve the longer wait without serializing in-flight requests', async () => {
  const f = fixture();
  const gates = [join(f.directory, 'first'), join(f.directory, 'second')];
  let pending = [];
  try {
    const initial = await runCli(f, [], undefined, { TEST_REAL_CLOCK: '1' });
    assert.equal(initial.status, 0, initial.stdout + initial.stderr);
    pending = gates.map((gate, index) =>
      runCli(
        f,
        [
          {
            gate: true,
            status: 429,
            headers: { 'Retry-After': index === 0 ? '80' : '70' },
            body: {},
            responseWallJump: 16000,
          },
        ],
        undefined,
        { TEST_REAL_CLOCK: '1', TEST_GATE: gate },
      ),
    );
    for (let attempt = 0; !gates.every((gate) => existsSync(`${gate}.ready`)); attempt++) {
      assert.ok(attempt < 500, 'both HTTP requests must start before either response is released');
      await sleep(10);
    }
    for (const gate of gates) writeFileSync(gate, '', { mode: 0o600 });
    const results = await Promise.all(pending);
    for (const result of results) {
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).error.code, 'TIMEOUT');
    }
    const sends = readRequests(f.trace);
    assert.equal(sends.length, 4);
    const firstResponseSend = sends[2];
    const afterShortWait = BigInt(firstResponseSend.sharedNs) + 75000000000n;
    const resumed = await runCli(f, [], undefined, {
      TEST_SHARED_CLOCK_START_NS: afterShortWait.toString(),
    });
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.equal(resumed.requests.length, 5);
    assert.ok(
      BigInt(resumed.requests[4].sharedNs) - BigInt(firstResponseSend.sharedNs) >= 80000000000n,
      JSON.stringify(resumed.requests),
    );
    assert.equal(readdirSync(f.directory).filter((name) => name.startsWith('cooldown-')).length, 0);
  } finally {
    for (const gate of gates) writeFileSync(gate, '', { mode: 0o600 });
    await Promise.allSettled(pending);
    f.close();
  }
});

test('unsafe cooldown observations block before HTTP and remain available for approved recovery', async () => {
  for (const kind of ['json', 'permissions', 'fingerprint', 'deadline', 'clock']) {
    const f = fixture();
    try {
      const initial = await runCli(f);
      assert.equal(initial.status, 0, initial.stdout + initial.stderr);
      const state = JSON.parse(readFileSync(join(f.directory, 'state.json'), 'utf8'));
      const record = { fingerprint: state.fingerprint, clock: { ...state.clock } };
      if (kind === 'fingerprint') record.fingerprint = 'wrong-client';
      if (kind === 'deadline') record.clock.nextNs = 'invalid';
      if (kind === 'clock') record.clock.id = 'different-clock';
      const path = join(f.directory, 'cooldown-11111111-1111-4111-8111-111111111111.json');
      const before = kind === 'json' ? '{' : JSON.stringify(record);
      writeFileSync(path, before, { mode: 0o600 });
      if (kind === 'permissions') chmodSync(path, 0o644);
      const result = await runCli(f);
      assert.equal(result.status, 1);
      assert.equal(
        JSON.parse(result.stdout).error.code,
        kind === 'clock' ? 'CLOCK_UNCERTAIN' : 'AUTH_STORAGE',
      );
      assert.equal(result.requests.length, initial.requests.length);
      assert.equal(readFileSync(path, 'utf8'), before);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret/);
    } finally {
      f.close();
    }
  }
});

test('failed cooldown merge preserves the observation for a later execution without restarting its wait', async () => {
  const f = fixture();
  try {
    const received = await runCli(f, [
      {
        status: 429,
        headers: { 'Retry-After': '80' },
        body: {},
        responseWallJump: 16000,
      },
    ]);
    assert.equal(JSON.parse(received.stdout).error.code, 'TIMEOUT');
    const records = readdirSync(f.directory).filter((name) => name.startsWith('cooldown-'));
    assert.equal(records.length, 1);
    const before = readFileSync(join(f.directory, records[0]));
    const failed = await runCli(f, [], undefined, { TEST_FAIL_STATE_SAVE: '1' });
    assert.equal(failed.status, 1);
    assert.equal(JSON.parse(failed.stdout).error.code, 'AUTH_STORAGE');
    assert.equal(failed.requests.length, 2);
    assert.deepEqual(readFileSync(join(f.directory, records[0])), before);
    const early = await runCli(f);
    assert.equal(JSON.parse(early.stdout).error.code, 'TIMEOUT');
    assert.equal(early.requests.length, 2);
    const late = await runCli(f, [], undefined, {
      TEST_CLOCK_START: String(Date.parse('2026-11-06T15:01:30Z')),
    });
    assert.equal(late.status, 0, late.stdout + late.stderr);
    assert.equal(late.requests.length, 3);
  } finally {
    f.close();
  }
});

for (const wallJump of [0, 16000]) {
  test(`cooldown publication storage failure with ${wallJump}ms wall jump stops a single query without another GET`, async () => {
    const f = fixture();
    try {
      const result = await runCli(
        f,
        [{ status: 429, headers: { 'Retry-After': '80' }, body: {}, responseWallJump: wallJump }],
        undefined,
        { TEST_FAIL_COOLDOWN_SAVE_ONCE: '1' },
      );
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).error.code, 'AUTH_STORAGE');
      assert.equal(result.stderr, 'AUTH_STORAGE\n');
      assert.equal(result.requests.length, 2);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret/);
    } finally {
      f.close();
    }
  });

  test(`cooldown publication storage failure with ${wallJump}ms wall jump retains completed batch data and stops later symbols`, async () => {
    const f = fixture();
    const page = {
      path: '/api/v1/candles',
      body: {
        result: {
          candles: [
            {
              timestamp: '2026-11-05T14:00:00+09:00',
              openPrice: '185.7000',
              highPrice: '190.1250',
              lowPrice: '180.0000',
              closePrice: '189.0000',
              volume: '0',
              currency: 'USD',
            },
          ],
          nextBefore: null,
        },
      },
    };
    try {
      const result = await runCli(
        f,
        [
          page,
          {
            path: '/api/v1/candles',
            status: 429,
            headers: { 'Retry-After': '80' },
            body: {},
            responseWallJump: wallJump,
          },
          page,
          page,
        ],
        ['candles-batch', 'AAPL,MSFT,GOOG', 'count=1'],
        { TEST_FAIL_COOLDOWN_SAVE_ONCE: '1' },
      );
      const out = JSON.parse(result.stdout);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.equal(out.status, 'partial');
      assert.equal(out.data[0].status, 'success');
      assert.equal(out.data[0].data[0].closePrice, '189.0000');
      assert.equal(out.data[1].status, 'error');
      assert.equal(out.data[1].error.code, 'AUTH_STORAGE');
      assert.equal(out.data[2].status, 'not_queried');
      assert.equal(out.data[2].reason, 'AUTH_STORAGE');
      assert.equal(result.stderr, 'AUTH_STORAGE\n');
      assert.equal(result.requests.length, 3);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret/);
    } finally {
      f.close();
    }
  });
}

test('independent CLI executions retain actual spacing across a wall-clock correction', async () => {
  for (const jump of [0, 2000, -2000]) {
    const f = fixture();
    try {
      const first = await runCli(f, [], undefined, { TEST_REAL_CLOCK: '1' });
      assert.equal(first.status, 0, first.stdout + first.stderr);
      const second = await runCli(f, [], undefined, {
        TEST_REAL_CLOCK: '1',
        TEST_CLOCK_JUMP: 'wall',
        TEST_CLOCK_JUMP_MS: String(jump),
        TEST_CLOCK_JUMP_AT: '1',
      });
      assert.equal(second.status, 0, second.stdout + second.stderr);
      assert.equal(second.requests.length, 3);
      assert.ok(
        BigInt(second.requests[2].nativeNs) - BigInt(second.requests[1].nativeNs) >= 1000000000n,
      );
    } finally {
      f.close();
    }
  }
});

test('independent CLI processes share actual send spacing during clock corrections', async () => {
  for (const jump of [0, 2000, -2000]) {
    const f = fixture();
    try {
      const results = await Promise.all([
        runCli(f, [], undefined, { TEST_REAL_CLOCK: '1' }),
        runCli(f, [], undefined, {
          TEST_REAL_CLOCK: '1',
          TEST_CLOCK_JUMP: 'wall',
          TEST_CLOCK_JUMP_MS: String(jump),
          TEST_CLOCK_JUMP_AT: '1',
        }),
      ]);
      for (const result of results) assert.equal(result.status, 0, result.stdout + result.stderr);
      const requests = readRequests(f.trace);
      assert.equal(requests.length, 3);
      assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
      for (let index = 1; index < requests.length; index++)
        assert.ok(
          BigInt(requests[index].nativeNs) - BigInt(requests[index - 1].nativeNs) >= 1000000000n,
        );
    } finally {
      f.close();
    }
  }
});
