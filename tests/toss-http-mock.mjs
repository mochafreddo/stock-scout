import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs, { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { setInterval as realInterval } from 'node:timers';
import { setTimeout as realSleep } from 'node:timers/promises';

const nativeHrtime = process.hrtime.bigint.bind(process.hrtime);
if (process.env.TEST_PLATFORM)
  Object.defineProperty(process, 'platform', { value: process.env.TEST_PLATFORM });
const boot = process.env.TEST_BOOT_ID || '11111111-1111-4111-8111-111111111111';
const execFileSync = childProcess.execFileSync;
mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (file === '/usr/sbin/sysctl' && args.join(' ') === '-n kern.bootsessionuuid') {
    if (process.env.TEST_CLOCK_UNAVAILABLE) throw new Error('synthetic-secret');
    return `${boot}\n`;
  }
  return execFileSync(file, args, options);
});
const readFileSync = fs.readFileSync;
mock.method(fs, 'readFileSync', (file, ...args) => {
  if (file === '/proc/sys/kernel/random/boot_id') {
    if (process.env.TEST_CLOCK_UNAVAILABLE) throw new Error('synthetic-secret');
    return `${boot}\n`;
  }
  if (file === '/proc/self/timens_offsets') {
    if (process.env.TEST_TIME_OFFSET_UNAVAILABLE) throw new Error('synthetic-secret');
    return process.env.TEST_TIME_OFFSET || 'monotonic 0 0\nboottime 0 0\n';
  }
  return readFileSync(file, ...args);
});
const readlinkSync = fs.readlinkSync;
const renameSync = fs.renameSync;
let cooldownSaveFailed = false;
mock.method(fs, 'renameSync', (source, target) => {
  if (
    process.env.TEST_FAIL_COOLDOWN_SAVE_ONCE &&
    !cooldownSaveFailed &&
    /\/cooldown-[0-9a-f-]{36}\.json$/.test(target)
  ) {
    cooldownSaveFailed = true;
    throw Object.assign(new Error('synthetic-secret'), { code: 'EIO' });
  }
  if (process.env.TEST_FAIL_STATE_SAVE && target === `${process.env.TOSS_STATE_DIR}/state.json`)
    throw new Error('synthetic-secret');
  return renameSync(source, target);
});
mock.method(fs, 'readlinkSync', (file, ...args) => {
  if (file === '/proc/self/ns/time') return process.env.TEST_TIME_NAMESPACE || 'time:[123]';
  if (file === '/proc/self/ns/time_for_children')
    return process.env.TEST_CHILD_TIME_NAMESPACE || process.env.TEST_TIME_NAMESPACE || 'time:[123]';
  return readlinkSync(file, ...args);
});
syncBuiltinESMExports();
let clock;
if (!process.env.TEST_REAL_CLOCK) {
  mock.timers.enable({
    apis: ['Date', 'setTimeout'],
    now: Number(process.env.TEST_CLOCK_START || Date.parse('2026-11-06T15:00:00Z')),
  });
  const sharedNow = Date.now.bind(Date);
  const sharedStart = sharedNow();
  mock.method(process.hrtime, 'bigint', () =>
    process.env.TEST_SHARED_CLOCK_START_NS
      ? BigInt(process.env.TEST_SHARED_CLOCK_START_NS) +
        BigInt(sharedNow() - sharedStart) * 1000000n
      : BigInt(sharedNow()) * 1000000n,
  );
  clock = realInterval(() => mock.timers.tick(100), 1);
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (...args) => {
    clearInterval(clock);
    return write(...args);
  };
}
if (process.env.TEST_CLOCK_JUMP) {
  let calls = 0;
  const jump = Number(process.env.TEST_CLOCK_JUMP_MS || 60001);
  const at = Number(process.env.TEST_CLOCK_JUMP_AT || 3);
  if (process.env.TEST_CLOCK_JUMP === 'wall') {
    const original = Date.now.bind(Date);
    Date.now = () => original() + (++calls >= at ? jump : 0);
  } else mock.method(performance, 'now', () => (++calls >= at ? jump : 0));
}
const authSteps = JSON.parse(process.env.TEST_AUTH_STEPS || '[]');

const steps = JSON.parse(process.env.TEST_STEPS || '[]');
let started = false;
globalThis.fetch = async (url, init) => {
  if (!started && process.env.TEST_START_DELAY)
    mock.timers.tick(Number(process.env.TEST_START_DELAY));
  started = true;
  const address = new URL(url);
  assert.equal(address.origin, 'https://openapi.tossinvest.com');
  assert.equal(init.redirect, 'error');
  appendFileSync(
    process.env.TEST_TRACE,
    `${JSON.stringify({ path: address.pathname, query: address.search, method: init.method, at: Date.now(), nativeNs: nativeHrtime().toString(), sharedNs: process.hrtime.bigint().toString(), authorization: init.headers.authorization, account: init.headers['X-Tossinvest-Account'], body: init.body })}\n`,
  );
  if (address.pathname === '/oauth2/token') {
    assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), {
      grant_type: 'client_credentials',
      client_id: 'synthetic-client',
      client_secret: process.env.TEST_CLIENT_SECRET || 'synthetic-secret',
    });
    const step = authSteps.shift();
    if (step?.transport) throw new TypeError('synthetic-secret');
    if (step)
      return Response.json(step.body, { status: step.status || 200, headers: step.headers });
    return Response.json({
      access_token: 'synthetic-token',
      token_type: 'Bearer',
      expires_in: 86400,
    });
  }
  assert.equal(init.method, 'GET');
  const step = steps.shift() || {
    body: {
      result: [
        {
          symbol: 'AAPL',
          lastPrice: '185.7000',
          currency: 'USD',
          timestamp: '2026-11-06T10:30:00-05:00',
        },
      ],
    },
  };
  assert.equal(address.pathname, step.path || '/api/v1/prices');
  assert.equal(init.headers.authorization, `Bearer ${step.expectedToken || 'synthetic-token'}`);
  if (step.gate) {
    writeFileSync(`${process.env.TEST_GATE}.ready`, 'ready', { mode: 0o600 });
    while (!existsSync(process.env.TEST_GATE)) await realSleep(5);
  }
  if (step.oversizedCancel)
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1048577));
        },
        cancel() {
          throw new Error('synthetic-secret');
        },
      }),
    );
  if (step.bodyHang) return new Response(new ReadableStream({ start() {} }));
  if (step.interrupt) {
    process.kill(process.pid, 'SIGTERM');
    return new Promise(() => {});
  }
  if (step.advance) mock.timers.tick(step.advance);
  if (step.monotonicAdvance) {
    const advanced = performance.now() + step.monotonicAdvance;
    mock.method(performance, 'now', () => advanced);
  }
  if (step.transport) throw new TypeError('synthetic-secret');
  if (step.hang) return new Promise(() => {});
  if (step.rawBody) return new Response(step.rawBody, { status: step.status || 200 });
  if (step.freezeAt) {
    clearInterval(clock);
    mock.timers.setTime(Date.parse(step.freezeAt));
  }
  const response = Response.json(step.body, { status: step.status || 200, headers: step.headers });
  if (step.responseWallJump) {
    const original = Date.now.bind(Date);
    Date.now = () => original() + step.responseWallJump;
  }
  if (step.wallJump) {
    const getReader = response.body.getReader.bind(response.body);
    mock.method(response.body, 'getReader', () => {
      const reader = getReader();
      const read = reader.read.bind(reader);
      let changed = false;
      mock.method(reader, 'read', async () => {
        const result = await read();
        if (!changed) {
          changed = true;
          const original = Date.now.bind(Date);
          Date.now = () => original() + step.wallJump;
        }
        return result;
      });
      return reader;
    });
  }
  return response;
};
