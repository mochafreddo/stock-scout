import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runScheduledDot } from '../scripts/run-dot-mcp.ts';

async function until(predicate, description) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, description);
    await delay(10);
  }
}

test('shutdown terminates an unresponsive query and tunnel at the absolute deadlines', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'dot-shutdown-'));
  const logs = [];
  const executable = (name, body) => {
    const path = join(state, name);
    writeFileSync(path, `#!${process.execPath}\n${body}`, { mode: 0o700 });
    return path;
  };
  const stubborn = (name) => `
    const { writeFileSync } = require('node:fs');
    process.on('SIGTERM', () => writeFileSync(${JSON.stringify(join(state, `${name}.term`))}, ''));
    writeFileSync(${JSON.stringify(join(state, `${name}.pid`))}, String(process.pid));
    setInterval(() => {}, 60000);
  `;
  const pipeHolder = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    writeFileSync(${JSON.stringify(join(state, 'pipe.pid'))}, String(child.pid));
  `;
  const options = {
    state,
    port: 0,
    now: () => Date.parse('2026-11-24T12:00:00Z'),
    tunnel: executable('tunnel', stubborn('tunnel')),
    launcher: executable(
      'launcher',
      `
      if (process.argv[2] === 'readiness') {
        console.log('{"version":1,"status":"success","data":[{"readiness":"ready"}]}');
      } else {
        ${stubborn('query')}
        ${pipeHolder}
      }
    `,
    ),
    log: (entry) => logs.push(entry),
  };
  const run = await runScheduledDot(options);
  const request = fetch(run.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'prices', arguments: { symbols: ['DEMO'] } },
    }),
  }).then(
    (response) => response.text(),
    () => 'disconnected',
  );
  const processes = ['query', 'tunnel'];
  const marker = (name, suffix) => join(state, name + suffix);
  const pid = (name) => Number(readFileSync(marker(name, '.pid'), 'utf8'));
  try {
    await until(
      () => processes.every((name) => existsSync(marker(name, '.pid'))),
      'process startup',
    );
    await until(() => existsSync(marker('pipe', '.pid')), 'inherited pipe startup');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let closed = false;
    void run.stop().then(() => {
      closed = true;
    });
    t.mock.timers.tick(74999);
    assert.ok(processes.every((name) => !existsSync(marker(name, '.term'))));
    t.mock.timers.tick(1);
    await until(() => processes.every((name) => existsSync(marker(name, '.term'))), '75s TERM');
    await until(
      () => logs.some((entry) => entry.code === 'RESPONSE_DELIVERY_UNCONFIRMED'),
      'delivery status',
    );
    assert.equal(await request, 'disconnected');
    assert.equal(closed, false);
    t.mock.timers.tick(5000);
    await until(() => closed, '80s runner exit despite inherited pipes');
    process.kill(pid('pipe'), 0);
    for (const name of processes) {
      await until(() => {
        try {
          process.kill(pid(name), 0);
          return false;
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
          return true;
        }
      }, '80s KILL');
    }
    assert.ok(logs.some((entry) => entry.status === 'result_unavailable'));
    assert.equal(await runScheduledDot(options), undefined);
    assert.equal(logs.at(-1).code, 'SESSION_CLAIMED');
  } finally {
    for (const name of [...processes, 'pipe']) {
      if (!existsSync(marker(name, '.pid'))) continue;
      try {
        process.kill(pid(name), 'SIGKILL');
      } catch (error) {
        assert.equal(error.code, 'ESRCH');
      }
    }
    await run.stop();
    rmSync(state, { recursive: true, force: true });
  }
});
