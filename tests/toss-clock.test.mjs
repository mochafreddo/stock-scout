import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, price, runCli } from './toss-cli-helper.mjs';

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
        clock: { id: 'darwin-mach-continuous:11111111-1111-4111-8111-111111111111', nextNs: '0' },
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
      const requests = results.find((result) => result.requests.length === 3).requests;
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
