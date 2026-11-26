import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const open = '2026-11-24T12:00:00.000Z';
const closed = '2026-11-24T12:20:00.000Z';

function stateDirectory(t) {
  const state = mkdtempSync(join(tmpdir(), 'dot-startup-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  return state;
}

function args(state, time, tunnel, launcher = '/unused', port = '0') {
  return [
    '--import',
    `data:text/javascript,Date.now=()=>${Date.parse(time)}`,
    'scripts/run-dot-mcp.ts',
    launcher,
    tunnel,
    state,
    port,
  ];
}

function run(state, time, tunnel = join(state, 'missing-tunnel'), launcher) {
  const result = spawnSync(process.execPath, args(state, time, tunnel, launcher), {
    encoding: 'utf8',
    timeout: 10000,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  assert.equal(result.stderr, '');
  return {
    entries: result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    status: result.status,
  };
}

function invoke(state, time, status, code, exitCode) {
  const result = run(state, time);
  assert.deepEqual(result.entries, [{ session: '2026-11-24', time, status, code }]);
  assert.equal(result.status, exitCode);
}

for (const [label, launcher, port] of [
  ['relative path', 'private-launcher', '0'],
  ['out-of-range port', '/unused', '65536'],
]) {
  test(`direct startup rejects invalid arguments without echoing them (${label})`, (t) => {
    const argv = args(stateDirectory(t), closed, '/unused', launcher, port);
    const result = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    const [line, ...rest] = result.stderr.split('\n');
    assert.deepEqual(rest, ['']);
    const entry = JSON.parse(line);
    assert.equal(new Date(entry.time).toISOString(), entry.time);
    assert.deepEqual(entry, { time: entry.time, status: 'error', code: 'INVALID_START_ARGUMENTS' });
  });
}

for (const [exitCode, tunnel] of [
  [0, '/usr/bin/true'],
  [1, '/usr/bin/false'],
]) {
  test(`direct launcher fails when the tunnel exits with ${exitCode} and retains the claim`, (t) => {
    const state = stateDirectory(t);
    const result = run(state, open, tunnel);
    assert.equal(result.entries.at(-1).code, 'TUNNEL_EXIT');
    assert.equal(result.status, 1);
    invoke(state, open, 'skipped', 'SESSION_CLAIMED', 0);
  });
}

test('direct launcher succeeds when asked to stop with a running tunnel', async (t) => {
  const state = stateDirectory(t);
  const tunnel = join(state, 'tunnel');
  const marker = join(state, 'url');
  writeFileSync(
    tunnel,
    `#!/bin/sh
printf '%s' "$1" > "${marker}.tmp" && mv "${marker}.tmp" "${marker}"
exec cat
`,
    { mode: 0o700 },
  );
  const run = promisify(execFile)(process.execPath, args(state, open, tunnel), {
    timeout: 10000,
    killSignal: 'SIGKILL',
  });
  const completed = Promise.allSettled([run]);
  try {
    const signal = AbortSignal.timeout(5000);
    while (!existsSync(marker)) await delay(10, undefined, { signal });
    const response = await fetch(readFileSync(marker, 'utf8'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      signal,
    });
    assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 1, result: {} });
    run.child.kill('SIGTERM');
    const { stdout, stderr } = await run;
    assert.equal(stderr, '');
    const statuses = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).status);
    assert.deepEqual(statuses, ['started', 'closed']);
  } finally {
    run.child.kill('SIGKILL');
    await completed;
  }
});

test('direct launcher fails when the tunnel exits while a response is draining', (t) => {
  const state = stateDirectory(t);
  const tunnel = join(state, 'tunnel.mjs');
  const launcher = join(state, 'launcher.mjs');
  const pid = JSON.stringify(join(state, 'tunnel.pid'));
  const draining = join(state, 'draining');
  writeFileSync(
    tunnel,
    `#!${process.execPath}
    import { writeFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    const url = process.argv[2];
    writeFileSync(${pid}, String(process.pid));
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'prices', arguments: { symbols: ['DEMO'] } } }),
    });
    while (true) {
      try {
        await fetch(url, { headers: { connection: 'close' } });
      } catch (error) {
        if (error.cause?.code !== 'ECONNREFUSED') throw error;
        writeFileSync(${JSON.stringify(draining)}, '');
        process.exit(0);
      }
      await delay(10);
    }
  `,
    { mode: 0o700 },
  );
  writeFileSync(
    launcher,
    `#!${process.execPath}
    import { readFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    const tunnel = Number(readFileSync(${pid}, 'utf8'));
    process.kill(process.ppid, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { process.kill(tunnel, 0); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        break;
      }
      await delay(10);
    }
  `,
    { mode: 0o700 },
  );
  const result = run(state, open, tunnel, launcher);
  assert.ok(existsSync(draining), 'listener closed while the request was pending');
  assert.ok(result.entries.some(({ code }) => code === 'TUNNEL_EXIT'));
  assert.equal(result.status, 1);
});

test('direct startup fails when the state directory is shared', (t) => {
  const state = stateDirectory(t);
  chmodSync(state, 0o770);
  invoke(state, open, 'error', 'SESSION_STORAGE_UNSAFE', 1);
});

test('direct startup retains the claim after tunnel failure and skips the next attempt', (t) => {
  const state = stateDirectory(t);
  invoke(state, open, 'error', 'TUNNEL_START_FAILED', 1);
  invoke(state, open, 'skipped', 'SESSION_CLAIMED', 0);
});

test('direct startup skips a closed window without claiming the session', (t) => {
  const state = stateDirectory(t);
  invoke(state, closed, 'skipped', 'WINDOW_CLOSED', 0);
  invoke(state, open, 'error', 'TUNNEL_START_FAILED', 1);
});

test('direct startup identifies a state path occupied by a file as unsafe', (t) => {
  const state = join(stateDirectory(t), 'state');
  writeFileSync(state, '');
  invoke(state, open, 'error', 'SESSION_STORAGE_UNSAFE', 1);
});

test('direct startup reports only diagnostic metadata on stderr for a storage exception', (t) => {
  const file = join(stateDirectory(t), 'parent');
  writeFileSync(file, '');
  const result = spawnSync(process.execPath, args(join(file, 'state'), open, '/unused'), {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const entry = JSON.parse(result.stderr);
  assert.equal(new Date(entry.time).toISOString(), entry.time);
  assert.deepEqual(entry, { time: entry.time, status: 'error', code: 'START_FAILED' });
});
