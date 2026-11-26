import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runScheduledDot } from '../scripts/run-dot-mcp.ts';

test('a Mac waking after the KST close skips the tunnel and records only safe metadata', async (t) => {
  const now = () => Date.parse('2026-11-24T12:20:00Z');
  const state = mkdtempSync(join(tmpdir(), 'dot-window-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const logs = [];
  await runScheduledDot({
    launcher: '/unused',
    port: 0,
    state,
    tunnel: '/unused',
    now,
    log: (entry) => logs.push(entry),
  });
  assert.deepEqual(logs, [
    {
      session: '2026-11-24',
      time: '2026-11-24T12:20:00.000Z',
      status: 'skipped',
      code: 'WINDOW_CLOSED',
    },
  ]);
});

test('a shared claim directory cannot start the scheduled tunnel', async (t) => {
  const { options, logs } = fixture(t);
  chmodSync(options.state, 0o770);
  assert.equal(await runScheduledDot({ ...options, tunnel: '/missing' }), undefined);
  assert.equal(existsSync(join(options.state, '2026-11-24')), false);
  assert.equal(logs.at(-1).code, 'SESSION_STORAGE_UNSAFE');
});

test('the adapter module does not open an unscheduled server when run directly', () => {
  const output = execFileSync(process.execPath, ['scripts/dot-mcp.ts', '/unused', '0'], {
    encoding: 'utf8',
    timeout: 1500,
  });
  assert.equal(output, '');
});

const readyRow = { readiness: 'ready', token: 'valid', reasons: [] };
function envelope(endpoint, data, fields = {}) {
  return {
    version: 1,
    status: 'success',
    source: { provider: 'tossinvest', endpoint, freshness: 'unknown' },
    retrievedAt: '2026-11-24T11:55:00.000Z',
    data,
    omissions: [],
    ...fields,
  };
}
const readyResponse = envelope('local:readiness', [readyRow]);
const pricesResponse = envelope('/api/v1/prices', [{ symbol: 'DEMO' }]);
const redactedError = {
  version: 1,
  retrievedAt: '2026-11-24T11:55:00.000Z',
  status: 'error',
  data: [],
  source: { provider: 'tossinvest' },
  error: { code: 'SENSITIVE_OUTPUT' },
};

function fixture(t) {
  const state = mkdtempSync(join(tmpdir(), 'dot-window-'));
  let stop;
  t.after(async () => {
    try {
      await stop?.();
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
  const tunnel = join(state, 'tunnel');
  const launcher = join(state, 'launcher');
  const trace = join(state, 'trace');
  writeFileSync(
    tunnel,
    `#!/bin/sh
exec "${process.execPath}" --input-type=module -e '
  import { renameSync, writeFileSync } from "node:fs";
  const [trace, url] = process.argv.slice(1);
  writeFileSync(trace + "-opening", process.pid + " " + url);
  renameSync(trace + "-opening", trace + "-tunnel");
  process.stdin.resume();
' "${trace}" "$1"
`,
    { mode: 0o700 },
  );
  writeFileSync(
    launcher,
    `#!/bin/sh
echo "$*" >> "${trace}"
case "$1" in
readiness) echo '${JSON.stringify(readyResponse)}';;
*) echo '${JSON.stringify(pricesResponse)}';;
esac
`,
    { mode: 0o700 },
  );
  const logs = [];
  const options = {
    state,
    launcher,
    tunnel,
    now: () => Date.parse('2026-11-24T11:55:00Z'),
    port: 0,
    log: (e) => logs.push(e),
  };
  const start = async () => {
    const run = await runScheduledDot(options);
    stop = run?.stop;
    return run;
  };
  return { options, logs, trace, start };
}

function price(url, signal) {
  return query(url, { name: 'prices', arguments: { symbols: ['DEMO'] } }, signal);
}

async function query(url, params, signal) {
  const res = await fetch(url, {
    signal,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params,
    }),
  });
  return (await res.json()).result.structuredContent;
}

const realTimeout = setTimeout;
const clearRealTimeout = clearTimeout;

async function observe(label, ...events) {
  let timer;
  try {
    return await Promise.race([
      ...events,
      new Promise((_, reject) => {
        timer = realTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5000);
      }),
    ]);
  } finally {
    clearRealTimeout(timer);
  }
}

async function openedTunnel(trace, exited) {
  const file = `${trace}-tunnel`;
  const changed = Promise.withResolvers();
  const watcher = watch(dirname(file), () => {
    if (existsSync(file)) changed.resolve();
  });
  try {
    if (!existsSync(file))
      await observe(
        'tunnel marker',
        changed.promise,
        exited.then(() => {
          throw new Error('Tunnel exited before publishing its marker');
        }),
      );
    const [pid, url] = readFileSync(file, 'utf8').trim().split(' ');
    return { pid: Number(pid), url };
  } finally {
    watcher.close();
  }
}

test('the scheduled connection serves prices and a failed tunnel cannot restart the same session', async (t) => {
  const { options, logs, trace, start } = fixture(t);
  const run = await start();
  assert.equal((await price(run.url)).response.data[0].symbol, 'DEMO');
  assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['readiness', 'prices DEMO']);
  await run.stop();
  assert.equal(await runScheduledDot(options), undefined);
  assert.equal(logs.at(-1).code, 'SESSION_CLAIMED');
  const tomorrow = {
    ...options,
    tunnel: '/usr/bin/false',
    now: () => Date.parse('2026-11-25T12:00:00Z'),
  };
  const crash = await runScheduledDot(tomorrow);
  await crash.done;
  assert.equal(logs.at(-1).code, 'TUNNEL_EXIT');
  assert.equal(await runScheduledDot(tomorrow), undefined);
  assert.equal(logs.at(-1).code, 'SESSION_CLAIMED');
});

test('the session charges every started lookup including partial and failed results, and excludes blocked readiness', async (t) => {
  const { options, logs, trace, start } = fixture(t);
  const run = await start();
  const program = readFileSync(options.launcher, 'utf8');
  const blocked = envelope(
    'local:readiness',
    [{ readiness: 'blocked', token: 'valid', reasons: ['WAIT_REQUIRED'] }],
    { status: 'error', error: { code: 'WAIT_REQUIRED' } },
  );
  writeFileSync(options.launcher, `#!/bin/sh\necho '${JSON.stringify(blocked)}'; exit 1\n`);
  assert.deepEqual((await price(run.url)).response, blocked);
  writeFileSync(
    options.launcher,
    program.replace('readiness) echo', 'readiness) mv "$0" "$0.saved"; echo'),
  );
  assert.equal((await price(run.url)).error.code, 'CLI_RESULT_UNAVAILABLE');
  renameSync(`${options.launcher}.saved`, options.launcher);
  for (const [response, exit] of [
    [{ ...pricesResponse, status: 'partial', omissions: [{ reason: 'invalid_item' }] }, 2],
    [redactedError, 1],
  ]) {
    writeFileSync(
      options.launcher,
      program.replace(/\*\) echo [^\n]+/, `*) echo '${JSON.stringify(response)}'; exit ${exit};;`),
    );
    assert.deepEqual(await price(run.url), { stage: 'query', exitCode: exit, response });
  }
  writeFileSync(
    options.launcher,
    program.replace(/\*\) echo [^\n]+/, '*) echo non-json-private-output;;'),
  );
  assert.deepEqual(await price(run.url), {
    stage: 'query',
    error: { code: 'CLI_RESULT_UNAVAILABLE' },
  });
  writeFileSync(options.launcher, program);
  for (let n = 3; n < 16; n++) assert.equal((await price(run.url)).exitCode, 0);
  assert.equal((await price(run.url)).error?.code, 'SESSION_BUDGET');
  assert.equal(
    readFileSync(trace, 'utf8')
      .split('\n')
      .filter((l) => l === 'prices DEMO').length,
    16,
  );
  assert.deepEqual(
    [...new Set(logs.map((e) => e.status))].sort(),
    [
      'partial',
      'query_error',
      'ready_blocked',
      'result_unavailable',
      'rejected',
      'started',
      'success',
    ].sort(),
  );
  for (const entry of logs)
    assert.ok(Object.keys(entry).every((k) => ['session', 'time', 'status', 'code'].includes(k)));
});

test('incomplete or inconsistent readiness never admits or classifies a market query as blocked', async (t) => {
  const { options, trace, start } = fixture(t);
  const run = await start();
  for (const [data, status, exit, error] of [
    [[{ readiness: 'ready' }], 'success', 0],
    [[{ ...readyRow, reasons: ['WAIT_REQUIRED'] }], 'success', 0],
    [[], 'error', 1, { code: 'WAIT_REQUIRED' }],
    [
      [{ ...readyRow, readiness: 'blocked', reasons: ['WAIT_REQUIRED'] }],
      'error',
      1,
      { code: 'AUTH_STORAGE' },
    ],
    [[{ ...readyRow, readiness: 'unavailable' }], 'partial', 2],
  ]) {
    const response = envelope('local:readiness', data, { status, error });
    writeFileSync(
      options.launcher,
      `#!/bin/sh\necho "$1" >> "${trace}"\necho '${JSON.stringify(response)}'\nexit ${exit}\n`,
    );
    assert.deepEqual(await price(run.url), {
      stage: 'readiness',
      error: { code: 'CLI_RESULT_UNAVAILABLE' },
    });
  }
  assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), Array(5).fill('readiness'));
});

test('a market query rejects a mismatched CLI envelope or command source', async (t) => {
  const { options, start } = fixture(t);
  const run = await start();
  const program = readFileSync(options.launcher, 'utf8');
  const candles = { name: 'candles', arguments: { symbol: 'DEMO' } };
  const prices = { name: 'prices', arguments: { symbols: ['DEMO'] } };
  const candlePage = (symbol, interval) => ({
    ...envelope('/api/v1/candles', []),
    source: { provider: 'tossinvest', endpoint: '/api/v1/candles', symbol, interval },
  });
  const calendar = { name: 'sessions', arguments: { date: '2026-11-24' } };
  for (const [label, params, response, exit] of [
    ['different command', prices, envelope('/api/v1/stocks', []), 0],
    ['provider only success', prices, { ...pricesResponse, source: { provider: 'tossinvest' } }, 0],
    ['invalid retrieval time', prices, { ...pricesResponse, retrievedAt: 'yesterday' }, 0],
    ['missing omissions', prices, { ...pricesResponse, omissions: undefined }, 0],
    ['batch candles', candles, envelope('/api/v1/candles', []), 0],
    ['minute candles', candles, candlePage('DEMO', '1m'), 0],
    ['another candle symbol', candles, candlePage('OTHER', '1d'), 0],
    [
      'calendar constraints',
      calendar,
      envelope('/api/v1/market-calendar/US', [], {
        source: {
          provider: 'tossinvest',
          endpoint: '/api/v1/market-calendar/US',
          date: '2026-11-24',
          symbol: 'DEMO',
        },
      }),
      0,
    ],
    ['unexpected error rows', prices, { ...redactedError, data: [readyRow] }, 1],
  ]) {
    await t.test(label, async () => {
      writeFileSync(
        options.launcher,
        program.replace(
          /\*\) echo [^\n]+/,
          `*) echo '${JSON.stringify(response)}'; exit ${exit};;`,
        ),
      );
      assert.deepEqual(await query(run.url, params), {
        stage: 'query',
        error: { code: 'CLI_RESULT_UNAVAILABLE' },
      });
    });
  }
});

test('market errors expose only CLI error fields and candle results identify the requested page', async (t) => {
  const { options, start } = fixture(t);
  const run = await start();
  const program = readFileSync(options.launcher, 'utf8');
  const stock = { name: 'stock', arguments: { symbol: 'DEMO' } };
  const choices = ['NYSE', 'NASDAQ'].map((market) => ({
    symbol: 'DEMO',
    market,
    name: null,
    isinCode: null,
  }));
  const date = '2026-11-24';
  const before = '2026-11-24T05:00:00.000Z';
  const candles = {
    name: 'candles',
    arguments: { symbol: 'DEMO', count: 2, adjusted: false, date },
  };
  const page = {
    provider: 'tossinvest',
    endpoint: '/api/v1/candles',
    symbol: 'DEMO',
    interval: '1d',
    count: 2,
    adjusted: false,
    date,
    dateTimeZone: 'America/New_York',
    before,
  };
  for (const [label, params, response, valid] of [
    ...[
      [{ code: 'IDENTITY_AMBIGUOUS', choices }, true],
      [{ code: 'UPSTREAM_ERROR', providerCode: 'provider-error', requestId: 'Demo_1' }, true],
      [{ code: 'UPSTREAM_ERROR', message: 'private fixture' }, false],
      [{ code: 'UPSTREAM_ERROR', details: { value: 'private fixture' } }, false],
      [{ code: 'UPSTREAM_ERROR', requestId: {} }, false],
      [
        {
          code: 'IDENTITY_AMBIGUOUS',
          choices: [{ ...choices[0], details: 'private fixture' }, choices[1]],
        },
        false,
      ],
    ].map(([error, valid]) => [JSON.stringify(error), stock, { ...redactedError, error }, valid]),
    ...[
      ['matching dated page', {}, true],
      ['wrong count', { count: 1 }, false],
      ['wrong adjustment', { adjusted: true }, false],
      ['wrong date', { date: '2026-11-23' }, false],
      ['wrong cursor', { before: '2026-11-23T05:00:00.000Z' }, false],
    ].map(([label, fields, valid]) => [
      label,
      candles,
      envelope(page.endpoint, [], { source: { ...page, ...fields } }),
      valid,
    ]),
    [
      'unexpected dated page on cursor request',
      { name: 'candles', arguments: { symbol: 'DEMO', count: 2, adjusted: false, before } },
      envelope(page.endpoint, [], { source: page }),
      false,
    ],
  ]) {
    await t.test(label, async () => {
      const exit = response.status === 'error' ? 1 : 0;
      writeFileSync(
        options.launcher,
        program.replace(
          /\*\) echo [^\n]+/,
          `*) echo '${JSON.stringify(response)}'; exit ${exit};;`,
        ),
      );
      assert.deepEqual(
        await query(run.url, params),
        valid
          ? { stage: 'query', response, exitCode: exit }
          : { stage: 'query', error: { code: 'CLI_RESULT_UNAVAILABLE' } },
      );
    });
  }
});

test('a readiness check crossing the deadline cannot start prices', async (t) => {
  const { options, trace, start } = fixture(t);
  options.now = () =>
    Date.parse(existsSync(trace) ? '2026-11-24T12:20:00Z' : '2026-11-24T12:19:59Z');
  const run = await start();
  assert.equal((await price(run.url)).error?.code, 'WINDOW_CLOSED');
  assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['readiness']);
});

test('at close the tunnel drains a started price response and turns away the waiting request', async (t) => {
  await checkClose(t, fixture(t));
});

test('the close regression reports an early lookup error and shuts down its tunnel', async (t) => {
  const setup = fixture(t);
  writeFileSync(setup.options.launcher, '#!/bin/sh\nexit 1\n');
  await assert.rejects(checkClose(t, setup), /First price ended early: CLI_RESULT_UNAVAILABLE/);
  const [pid] = readFileSync(`${setup.trace}-tunnel`, 'utf8').split(' ');
  assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' });
});

async function checkClose(t, { options, trace, start }) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  await using control = createServer(async (_req, res) => {
    entered.resolve();
    await release.promise;
    res.end();
  });
  control.listen(0, '127.0.0.1');
  await observe('control server', once(control, 'listening'));
  const program = readFileSync(options.launcher, 'utf8');
  writeFileSync(
    options.launcher,
    program.replace(
      '*) echo',
      `*) "${process.execPath}" --input-type=module -e 'await fetch("http://127.0.0.1:${control.address().port}")'; echo`,
    ),
  );
  const queued = Promise.withResolvers();
  let closed = false;
  options.log = ({ status }) => {
    if (status === 'queued') queued.resolve('queued');
    if (status === 'closed') closed = true;
  };
  let time = Date.parse('2026-11-24T12:19:59Z');
  options.now = () => time;
  const run = await start();
  try {
    const tunnel = await openedTunnel(trace, run.done);
    assert.equal(tunnel.url, run.url);
    const active = price(tunnel.url);
    const firstEnded = active.then((result) => {
      throw new Error(`First price ended early: ${result.error?.code ?? result.stage}`);
    });
    await observe('first control request', entered.promise, firstEnded);
    const doubleStart = once(control, 'request').then(() => 'second started');
    const second = price(run.url);
    assert.equal(
      await observe(
        'queued price',
        queued.promise,
        doubleStart,
        firstEnded,
        second.then(() => 'second ended'),
      ),
      'queued',
    );
    time += 1000;
    t.mock.timers.tick(1000);
    assert.equal(closed, false);
    process.kill(tunnel.pid, 0);
    release.resolve();
    assert.equal((await observe('first price response', active)).response.data[0].symbol, 'DEMO');
    assert.equal((await observe('queued price response', second)).error.code, 'WINDOW_CLOSED');
    await observe('scheduled shutdown', run.done);
    assert.equal(closed, true);
    assert.throws(() => process.kill(tunnel.pid, 0), { code: 'ESRCH' });
    assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['readiness', 'prices DEMO']);
  } finally {
    release.resolve();
    await run.stop();
  }
}

test('failure to spawn the tunnel keeps the claim and records only a startup failure', async (t) => {
  const { options, logs } = fixture(t);
  options.tunnel = join(options.state, 'missing');
  const run = await runScheduledDot(options);
  if (run) await run.done;
  assert.deepEqual(
    logs.map((e) => [e.status, e.code]),
    [['error', 'TUNNEL_START_FAILED']],
  );
  assert.equal(await runScheduledDot(options), undefined);
  assert.equal(logs.at(-1).code, 'SESSION_CLAIMED');
});

test('a silent connection closes the foreground tunnel at the deadline after sleep', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { options, trace, logs, start } = fixture(t);
  let time = Date.parse('2026-11-24T12:00:00Z');
  options.now = () => time;
  const run = await start();
  const tunnel = await openedTunnel(trace, run.done);
  assert.equal(tunnel.url, run.url);
  process.kill(tunnel.pid, 0);
  time = Date.parse('2026-11-25T12:00:00Z');
  t.mock.timers.tick(1000);
  await observe('wake cutoff', run.done);
  assert.throws(() => process.kill(tunnel.pid, 0), { code: 'ESRCH' });
  assert.equal(logs.at(-1).code, 'WINDOW_CLOSED');
  assert.equal(existsSync(trace), false);
});

test('killing the serving process leaves the session claimed before any replacement can query', async (t) => {
  const { options, trace, logs } = fixture(t);
  const worker = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {runScheduledDot} from './scripts/run-dot-mcp.ts';
    const run=await runScheduledDot({...JSON.parse(process.argv[1]),now:()=>Date.parse('2026-11-24T12:00:00Z')});
    process.send(run.url);
    await run.done;
  `,
      JSON.stringify(options),
    ],
    { env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  const exited = once(worker, 'close');
  t.after(async () => {
    worker.kill('SIGKILL');
    await exited;
  });
  const [url] = await observe(
    'serving worker',
    once(worker, 'message'),
    exited.then(() => {
      throw Error('worker exited before serving');
    }),
  );
  assert.equal((await openedTunnel(trace, exited)).url, url);
  assert.equal((await price(url)).exitCode, 0);
  worker.kill('SIGKILL');
  assert.equal((await exited)[1], 'SIGKILL');
  assert.equal(await runScheduledDot(options), undefined);
  assert.equal(logs.at(-1).code, 'SESSION_CLAIMED');
  assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['readiness', 'prices DEMO']);
});

async function waitFor(check, label) {
  const deadline = performance.now() + 3000;
  while (!check()) {
    assert.ok(performance.now() < deadline, label);
    await new Promise((resolve) => realTimeout(resolve, 10));
  }
}

for (const [command, cleanup, title] of [
  ['readiness', 'release', '70s timeout waits for readiness pipes before the queued lookup'],
  ['prices', 'release', '70s timeout waits for prices pipes before admitting the queued lookup'],
  ['prices', 'stubborn', '75s deadline kills a stubborn lookup and closes the claimed session'],
  ['readiness', 'pipe', '75s deadline closes the claimed session when only a pipe remains'],
]) {
  test(title, async (t) => {
    const { options, trace, logs, start } = fixture(t);
    const pid = (suffix) => {
      const value = Number(readFileSync(trace + suffix, 'utf8'));
      assert.ok(Number.isSafeInteger(value) && value > 0);
      return value;
    };
    const normal = readFileSync(options.launcher, 'utf8');
    const held = join(options.state, 'held.cjs');
    const holder = join(options.state, 'holder.cjs');
    writeFileSync(
      holder,
      `
      const fs = require('node:fs');
      process.on('SIGUSR2', () => process.exit());
      fs.writeFileSync(process.argv[2], String(process.pid));
      setTimeout(() => process.exit(0), 60000);
    `,
    );
    writeFileSync(
      held,
      `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {
        fs.writeFileSync(process.argv[2] + '.term', '');
        if (${JSON.stringify(cleanup)} === 'stubborn') return;
        console.log('${JSON.stringify(command === 'prices' ? pricesResponse : readyResponse)}');
        process.exit(0);
      });
      fs.writeFileSync(process.argv[2] + '.pid', String(process.pid));
      spawn(process.execPath, [process.argv[3], process.argv[2] + '.pipe'], { stdio: 'inherit' });
    `,
    );
    writeFileSync(
      options.launcher,
      normal.replace(
        'case "$1"',
        `
if [ "$1" = "${command}" ] && [ ! -f "${trace}.pid" ]; then
  exec "${process.execPath}" "${held}" "${trace}" "${holder}"
fi
case "$1"`,
      ),
    );
    const run = await start();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    const active = price(run.url, controller.signal);
    let queued;
    try {
      await waitFor(() => existsSync(`${trace}.pipe`), 'inherited pipe opened');
      queued = price(run.url, controller.signal);
      await waitFor(() => logs.some((e) => e.status === 'queued'), 'queued request');
      t.mock.timers.tick(69999);
      assert.equal(existsSync(`${trace}.term`), false);
      t.mock.timers.tick(1);
      await waitFor(() => existsSync(`${trace}.term`), '70s SIGTERM');
      if (cleanup === 'pipe') {
        await waitFor(() => {
          try {
            process.kill(pid('.pid'), 0);
            return false;
          } catch (error) {
            assert.equal(error.code, 'ESRCH');
            return true;
          }
        }, 'launcher exited while its pipe is held');
      }
      t.mock.timers.tick(4999);
      const started = command === 'prices' ? ['readiness', 'prices DEMO'] : ['readiness'];
      assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), started);
      if (cleanup === 'release') {
        process.kill(pid('.pipe'), 'SIGUSR2');
      } else {
        assert.ok(!logs.some((entry) => entry.status === 'closed'));
        t.mock.timers.tick(1);
        await waitFor(() => logs.some((entry) => entry.status === 'closed'), '75s session close');
        assert.throws(() => process.kill(pid('.pid'), 0), {
          code: 'ESRCH',
        });
        process.kill(pid('.pipe'), 0);
        assert.deepEqual(await observe('queued rejection', queued), {
          stage: 'admission',
          error: { code: 'WINDOW_CLOSED' },
        });
        assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), started);
        assert.equal(await runScheduledDot(options), undefined);
        assert.equal(logs.at(-1).code, 'SESSION_CLAIMED');
      }
      assert.deepEqual(await observe('timed out request', active), {
        stage: command === 'prices' ? 'query' : 'readiness',
        error: { code: 'CLI_RESULT_UNAVAILABLE' },
      });
      if (cleanup !== 'release') return;
      assert.equal((await observe('queued lookup', queued)).exitCode, 0);
      assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), [
        ...started,
        'readiness',
        'prices DEMO',
      ]);
      const spentSlots = command === 'prices' ? 2 : 1;
      for (let n = spentSlots; n < 16; n++) {
        const result = await observe('remaining lookup', price(run.url, controller.signal));
        assert.equal(result.exitCode, 0);
      }
      assert.deepEqual(await observe('exhausted budget', price(run.url, controller.signal)), {
        stage: 'admission',
        error: { code: 'SESSION_BUDGET' },
      });
    } finally {
      const responses = Promise.allSettled([active, queued]);
      controller.abort();
      const stopped = run.stop();
      t.mock.timers.tick(80000);
      for (const suffix of ['.pid', '.pipe']) {
        if (!existsSync(trace + suffix)) continue;
        try {
          process.kill(pid(suffix), 'SIGKILL');
        } catch (error) {
          assert.equal(error.code, 'ESRCH');
        }
      }
      await Promise.all([stopped, responses]);
    }
  });
}
