import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs, {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  closeRuns,
  fixture,
  price,
  readRequests,
  runCli,
  runFreshCli,
  snapshot,
  waitForFile,
} from './toss-cli-helper.mjs';

for (const file of ['credentials.json', 'trace.jsonl', 'argv.jsonl'])
  test(`fixture creation removes allocated resources when ${file} initialization fails`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'fixture-failure-test-'));
    const previousTmpdir = process.env.TMPDIR;
    const write = fs.writeFileSync;
    const failure = new Error('synthetic initialization failure');
    process.env.TMPDIR = directory;
    t.mock.method(fs, 'writeFileSync', (path, ...args) => {
      if (basename(path) === file) throw failure;
      return write(path, ...args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => fixture(),
        (error) => error === failure,
      );
      assert.deepEqual(readdirSync(directory), []);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      rmSync(directory, { recursive: true, force: true });
    }
  });

test('fixture owns CLI invocation tracing outside protected snapshots and removes both resources', async () => {
  const f = fixture();
  try {
    assert.equal(typeof f.cliTrace, 'string');
    const before = snapshot(f.directory);
    for (let invocation = 0; invocation < 2; invocation++) {
      const result = await runCli(f, [], ['--help']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, 'success');
      assert.deepEqual(result.requests, []);
    }
    assert.deepEqual(readRequests(f.cliTrace), [['--help'], ['--help']]);
    assert.deepEqual(snapshot(f.directory), before);
  } finally {
    f.close();
  }
  assert.equal(existsSync(f.directory), false);
  assert.equal(existsSync(f.cliTrace), false);
  assert.equal(existsSync(dirname(f.cliTrace)), false);
  f.close();
});

test('fixture cleanup still removes CLI tracing when protected state removal fails', (t) => {
  const f = fixture();
  const remove = fs.rmSync;
  const failure = new Error('synthetic cleanup failure');
  t.mock.method(fs, 'rmSync', (path, options) => {
    if (realpathSync(path) === f.directory) throw failure;
    return remove(path, options);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => f.close(),
      (error) => error === failure,
    );
    assert.equal(existsSync(f.directory), true);
    assert.equal(existsSync(dirname(f.cliTrace)), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.close();
  }
});

test('fresh CLI runs remove their fixture after success and spawn failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fresh-cli-test-'));
  const previousTmpdir = process.env.TMPDIR;
  const executable = process.execPath;
  process.env.TMPDIR = directory;
  try {
    const result = await runFreshCli([], ['--help']);
    assert.equal(result.status, 0);
    assert.ok(result.out.data.commands.length > 0);
    assert.deepEqual(readdirSync(directory), []);
    process.execPath = join(directory, 'missing-node');
    await assert.rejects(runFreshCli(), { code: 'ENOENT' });
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    process.execPath = executable;
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    rmSync(directory, { recursive: true, force: true });
  }
});

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
    try {
      await waitForFile(`${gate}.ready`, pending);
      await assert.rejects(
        async () => {
          if (failure === 'readiness timeout')
            await waitForFile(join(f.directory, 'missing.ready'), pending, 20);
          else assert.fail('synthetic assertion failure');
        },
        {
          code: 'ERR_ASSERTION',
          message:
            failure === 'readiness timeout'
              ? `CLI did not create ${join(f.directory, 'missing.ready')}`
              : 'synthetic assertion failure',
        },
      );
    } finally {
      await closeRuns(f, [pending], [gate]);
    }
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

test('helper preserves split UTF-8 characters in stdout and stderr', async () => {
  const f = fixture();
  const gate = join(f.directory, 'output.gate');
  const writer = `
    import { existsSync, writeSync } from 'node:fs';
    import { setTimeout } from 'node:timers/promises';
    writeSync(1, Buffer.from([0x3e, 0xed]));
    writeSync(2, Buffer.from([0x3e, 0xea]));
    while (!existsSync(process.env.OUTPUT_GATE)) await setTimeout(5);
    writeSync(1, Buffer.from([0x95, 0x9c, 0x0a]));
    writeSync(2, Buffer.from([0xb8, 0x80, 0x0a]));
    process.exit(1);
  `;
  const run = runCli(f, [], [], {
    NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(writer)}`,
    OUTPUT_GATE: gate,
  });
  try {
    // Release the remaining bytes only after the parent reads the prefix from both pipes.
    await Promise.race([
      Promise.all([once(run.child.stdout, 'data'), once(run.child.stderr, 'data')]),
      run.then(({ stderr }) => assert.fail(`Child closed before writing prefixes: ${stderr}`)),
    ]);
    writeFileSync(gate, '', { mode: 0o600 });
    assert.deepEqual(await run, {
      status: 1,
      signal: null,
      stdout: '>한\n',
      stderr: '>글\n',
      requests: [],
    });
  } finally {
    await closeRuns(f, [run], []);
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
          assert.deepEqual(readRequests(f.cliTrace), [['prices', symbol]]);
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
