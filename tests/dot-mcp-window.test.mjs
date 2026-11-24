import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
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

function fixture(t) {
  const state = mkdtempSync(join(tmpdir(), 'dot-window-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const tunnel = join(state, 'tunnel');
  const launcher = join(state, 'launcher');
  const trace = join(state, 'trace');
  writeFileSync(
    tunnel,
    `#!/bin/sh
echo "$$ $1" > "${trace}-opening"
mv "${trace}-opening" "${trace}-tunnel"
read hold
`,
    { mode: 0o700 },
  );
  writeFileSync(
    launcher,
    `#!/bin/sh
echo "$*" >> "${trace}"
case "$1" in
readiness) echo '{"version":1,"data":[{"readiness":"ready"}],"status":"success"}';;
*) echo '{"version":1,"data":[{"symbol":"DEMO"}],"status":"success"}';;
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
  return { options, logs, trace };
}

async function price(url) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'prices', arguments: { symbols: ['DEMO'] } },
    }),
  });
  return (await res.json()).result.structuredContent;
}

async function openedTunnel(trace) {
  const file = `${trace}-tunnel`;
  const changed = Promise.withResolvers();
  const watcher = watch(dirname(file), () => {
    if (existsSync(file)) changed.resolve();
  });
  try {
    if (!existsSync(file)) await changed.promise;
    const [pid, url] = readFileSync(file, 'utf8').trim().split(' ');
    return { pid: Number(pid), url };
  } finally {
    watcher.close();
  }
}

test('the scheduled connection serves prices and a failed tunnel cannot restart the same session', async (t) => {
  const { options, logs, trace } = fixture(t);
  const run = await runScheduledDot(options);
  t.after(() => run.stop());
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
  const { options, logs, trace } = fixture(t);
  const run = await runScheduledDot(options);
  t.after(() => run.stop());
  const program = readFileSync(options.launcher, 'utf8');
  const response = (status, exit) =>
    `echo '{"version":1,"data":[],"status":"${status}"}'; exit ${exit}`;
  writeFileSync(options.launcher, `#!/bin/sh\n${response('error', 1)}\n`);
  assert.equal((await price(run.url)).stage, 'readiness');
  writeFileSync(
    options.launcher,
    program.replace('readiness) echo', 'readiness) mv "$0" "$0.saved"; echo'),
  );
  assert.equal((await price(run.url)).error.code, 'CLI_RESULT_UNAVAILABLE');
  renameSync(`${options.launcher}.saved`, options.launcher);
  for (const [status, exit] of [
    ['partial', 2],
    ['error', 1],
  ]) {
    writeFileSync(
      options.launcher,
      program.replace(/\*\) echo [^\n]+/, `*) ${response(status, exit)};;`),
    );
    assert.equal((await price(run.url)).exitCode, exit);
  }
  writeFileSync(options.launcher, program);
  for (let n = 2; n < 16; n++) assert.equal((await price(run.url)).exitCode, 0);
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

test('a readiness check crossing the deadline cannot start prices', async (t) => {
  const { options, trace } = fixture(t);
  options.now = () =>
    Date.parse(existsSync(trace) ? '2026-11-24T12:20:00Z' : '2026-11-24T12:19:59Z');
  const run = await runScheduledDot(options);
  t.after(() => run.stop());
  assert.equal((await price(run.url)).error?.code, 'WINDOW_CLOSED');
  assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['readiness']);
});

test('at close the tunnel drains a started price response and turns away the waiting request', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { options, trace } = fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const control = createServer(async (_req, res) => {
    entered.resolve();
    await release.promise;
    res.end();
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  t.after(() => control.close());
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
  const run = await runScheduledDot(options);
  t.after(() => run.stop());
  const tunnel = await openedTunnel(trace);
  assert.equal(tunnel.url, run.url);
  const active = price(tunnel.url);
  await entered.promise;
  const second = price(run.url);
  const doubleStart = new Promise((resolve) =>
    control.once('request', () => resolve('second started')),
  );
  try {
    assert.equal(await Promise.race([queued.promise, doubleStart]), 'queued');
    time += 1000;
    t.mock.timers.tick(1000);
    assert.equal(closed, false);
    process.kill(tunnel.pid, 0);
  } finally {
    release.resolve();
  }
  assert.equal((await active).response.data[0].symbol, 'DEMO');
  assert.equal((await second).error.code, 'WINDOW_CLOSED');
  await run.done;
  assert.equal(closed, true);
  assert.throws(() => process.kill(tunnel.pid, 0), { code: 'ESRCH' });
  assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['readiness', 'prices DEMO']);
});

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
  const { options, trace, logs } = fixture(t);
  let time = Date.parse('2026-11-24T12:00:00Z');
  options.now = () => time;
  const run = await runScheduledDot(options);
  t.after(() => run.stop());
  const tunnel = await openedTunnel(trace);
  assert.equal(tunnel.url, run.url);
  process.kill(tunnel.pid, 0);
  time = Date.parse('2026-11-25T12:00:00Z');
  t.mock.timers.tick(1000);
  await run.done;
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
  const [url] = await Promise.race([
    once(worker, 'message'),
    exited.then(() => {
      throw Error('worker exited before serving');
    }),
  ]);
  assert.equal((await price(url)).exitCode, 0);
  worker.kill('SIGKILL');
  assert.equal((await exited)[1], 'SIGKILL');
  assert.equal(await runScheduledDot(options), undefined);
  assert.equal(logs.at(-1).code, 'SESSION_CLAIMED');
  assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['readiness', 'prices DEMO']);
});
