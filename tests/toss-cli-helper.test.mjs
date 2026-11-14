import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeRuns, fixture, price, runCli, waitForFile } from './toss-cli-helper.mjs';

for (const failure of ['readiness timeout', 'assertion failure'])
  test(`gated child cleanup reaps its child before removing state after ${failure}`, async () => {
    const f = fixture();
    const gate = join(f.directory, 'gate');
    const pending = runCli(f, [{ gate: true }], undefined, {
      TEST_REAL_CLOCK: '1',
      TEST_GATE: gate,
    });
    let reaped = false;
    pending.child.once('close', () => {
      reaped = true;
    });
    const remove = f.close;
    f.close = () => {
      try {
        assert.equal(reaped, true, 'child close must precede fixture removal');
      } finally {
        remove();
      }
    };
    await assert.rejects(
      async () => {
        try {
          await waitForFile(`${gate}.ready`, pending);
          if (failure === 'readiness timeout')
            await waitForFile(join(f.directory, 'missing.ready'), pending, 20);
          else assert.fail('synthetic assertion failure');
        } finally {
          await closeRuns(f, [pending], [gate]);
        }
      },
      { code: 'ERR_ASSERTION' },
    );
    assert.equal(reaped, true);
    assert.throws(() => process.kill(pending.child.pid, 0), { code: 'ESRCH' });
    assert.equal(existsSync(f.directory), false);
  });

test('readiness waiting retains an early CLI error result while its peer remains gated', async () => {
  const f = fixture();
  const gate = join(f.directory, 'peer-gate');
  const peer = runCli(f, [{ gate: true }], undefined, {
    TEST_REAL_CLOCK: '1',
    TEST_GATE: gate,
  });
  const runs = [peer];
  try {
    await waitForFile(`${gate}.ready`, peer);
    const failed = runCli(f, [], ['unknown-command']);
    runs.push(failed);
    await assert.rejects(waitForFile(join(f.directory, 'missing.ready'), failed), (error) => {
      assert.equal(error.cause.status, 1);
      assert.equal(JSON.parse(error.cause.stdout).status, 'error');
      assert.notEqual(error.cause.stderr, '');
      assert.equal(peer.child.exitCode, null);
      assert.equal(peer.child.signalCode, null);
      return true;
    });
  } finally {
    writeFileSync(gate, '', { mode: 0o600 });
    await Promise.allSettled(runs);
    f.close();
  }
});

test('readiness waiting reports the original spawn failure and permits immediate fixture cleanup', async () => {
  const f = fixture();
  const executable = process.execPath;
  let pending;
  try {
    process.execPath = join(f.directory, 'missing-node');
    pending = runCli(f);
  } finally {
    process.execPath = executable;
  }
  try {
    let original;
    await assert.rejects(waitForFile(join(f.directory, 'gate.ready'), pending), (error) => {
      original = error;
      return error.code === 'ENOENT' && error.syscall.startsWith('spawn');
    });
    await assert.rejects(pending, (error) => error === original);
    assert.equal(pending.child.pid, undefined);
  } finally {
    await Promise.allSettled([pending]);
    f.close();
  }
});

test('normal helper runs preserve CLI output and keep concurrent and repeated fixtures separate', async () => {
  for (let round = 0; round < 2; round++) {
    await Promise.all(
      ['AAPL', 'MSFT'].map(async (symbol) => {
        const f = fixture();
        try {
          const result = await runCli(
            f,
            [{ body: { result: [{ ...price, symbol }] } }],
            ['prices', symbol],
          );
          assert.equal(result.status, 0);
          assert.equal(result.signal, null);
          assert.equal(result.stderr, '');
          const output = JSON.parse(result.stdout);
          assert.equal(output.status, 'success');
          assert.equal(output.data[0].symbol, symbol);
          assert.equal(output.data[0].lastPrice, '185.7000');
          assert.deepEqual(
            result.requests.map(({ method, path, query }) => ({ method, path, query })),
            [
              { method: 'POST', path: '/oauth2/token', query: '' },
              { method: 'GET', path: '/api/v1/prices', query: `?symbols=${symbol}` },
            ],
          );
        } finally {
          f.close();
        }
      }),
    );
  }
});

test('watchdog waits for child close before fixture cleanup and reports only the timeout', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { join } from 'node:path';
        import { fixture, readRequests, runCli } from ${JSON.stringify(new URL('./toss-cli-helper.mjs', import.meta.url).href)};
        const f = fixture();
        const pending = runCli(f, [{ gate: true }], undefined, {
          TEST_REAL_CLOCK: '1', TEST_GATE: join(f.directory, 'gate'),
        });
        try {
          await pending;
          throw new Error('Expected watchdog timeout');
        } catch (error) {
          console.log(JSON.stringify({
            error: error.message,
            signal: pending.child.signalCode,
            pid: pending.child.pid,
            requests: readRequests(f.trace).map(({ method }) => method),
          }));
        } finally {
          f.close();
        }
      `,
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.error, 'CLI test timed out');
  assert.equal(report.signal, 'SIGKILL');
  assert.deepEqual(report.requests, ['POST', 'GET']);
  assert.throws(() => process.kill(report.pid, 0), { code: 'ESRCH' });
});
