import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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

test('shutdown terminates an unresponsive query and tunnel at the absolute deadlines', async () => {
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
  const worker = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
      import { mock } from 'node:test';
      import { runScheduledDot } from './scripts/run-dot-mcp.ts';
      const options = JSON.parse(process.argv[1]);
      const run = await runScheduledDot({
        ...options,
        now: () => Date.parse('2026-11-24T12:00:00Z'),
        log: (entry) => {
          if (process.connected) process.send({ entry });
        },
      });
      process.send({ url: run.url });
      process.on('message', (stage) => {
        if (stage === 'stop') {
          mock.timers.enable({ apis: ['setTimeout'] });
          void run.stop();
          mock.timers.tick(74999);
          process.send({ draining: true });
        } else if (stage === 'grace') {
          mock.timers.tick(1);
        } else if (stage === 'force') {
          mock.timers.tick(5000);
          process.disconnect();
        }
      });
      `,
      JSON.stringify(options),
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  const exited = once(worker, 'close');
  let url;
  let draining = false;
  worker.on('message', (message) => {
    if (message.url) url = message.url;
    if (message.draining) draining = true;
    if (message.entry) logs.push(message.entry);
  });
  const processes = ['query', 'tunnel'];
  const marker = (name, suffix) => join(state, name + suffix);
  const pid = (name) => Number(readFileSync(marker(name, '.pid'), 'utf8'));
  try {
    await until(() => url, 'runner announces the server URL');
    const request = fetch(url, {
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
    await until(
      () => processes.every((name) => existsSync(marker(name, '.pid'))),
      'process startup',
    );
    await until(() => existsSync(marker('pipe', '.pid')), 'inherited pipe startup');
    worker.send('stop');
    await until(() => draining, '74.999s drain');
    assert.ok(processes.every((name) => !existsSync(marker(name, '.term'))));
    worker.send('grace');
    await until(() => processes.every((name) => existsSync(marker(name, '.term'))), '75s TERM');
    await until(
      () => logs.some((entry) => entry.code === 'RESPONSE_DELIVERY_UNCONFIRMED'),
      'delivery status',
    );
    assert.equal(await request, 'disconnected');
    assert.equal(worker.exitCode, null);
    worker.send('force');
    await until(() => worker.exitCode !== null, '80s runner exit despite inherited pipes');
    assert.deepEqual(await exited, [0, null]);
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
    worker.kill('SIGKILL');
    await exited;
    rmSync(state, { recursive: true, force: true });
  }
});
