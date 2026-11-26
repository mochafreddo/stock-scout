import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

function runHelper(t, server, check, timeout, timeoutExpected = false) {
  const dir = mkdtempSync(join(tmpdir(), 'dot-helper-'));
  t.after(async () => {
    writeFileSync(join(dir, 'cleanup'), '');
    const deadline = performance.now() + 3000;
    for (const name of ['server.pid', 'holder.pid']) {
      const marker = join(dir, name);
      if (!existsSync(marker)) continue;
      const pid = Number(readFileSync(marker, 'utf8'));
      assert.ok(Number.isSafeInteger(pid) && pid > 0, name);
      while (true) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          assert.equal(error.code, 'ESRCH');
          break;
        }
        assert.ok(performance.now() < deadline, `${name} still alive`);
        await delay(10);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(
    join(dir, 'scripts/run-dot-mcp.ts'),
    `import * as fixtureFs from 'node:fs';
    fixtureFs.writeFileSync('server.pid', String(process.pid));
    setInterval(() => { if (fixtureFs.existsSync('cleanup')) process.exit(); }, 20).unref();
    ${server}`,
  );
  const helper = new URL('./dot-mcp-helper.mjs', import.meta.url).href;
  writeFileSync(
    join(dir, 'fixture.test.mjs'),
    `
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startScheduledTestServer } from ${JSON.stringify(helper)};
test('synthetic server', async (t) => {
  const start = () => startScheduledTestServer(t, '.', 'unused', {});
  ${check}
});
`,
  );
  const result = spawnSync(process.execPath, ['fixture.test.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
  });
  if (timeoutExpected) {
    assert.equal(result.error?.code, 'ETIMEDOUT');
    return dir;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return dir;
}

test('a server that stays silent fails startup after five seconds', (t) => {
  runHelper(
    t,
    `export async function runScheduledDot() {
    await new Promise(resolve => setTimeout(resolve, 8000));
    process.exit(42);
  }`,
    `
    const before = performance.now();
    await assert.rejects(start, /timed out/i);
    assert.ok(performance.now() - before >= 4900);
  `,
    7000,
  );
});

const inheritedPipe = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const holder = spawn(process.execPath, ['-e', \`
  const fs = require('node:fs');
  setInterval(() => { if (fs.existsSync('cleanup')) process.exit(); }, 20).unref();
  setTimeout(() => {}, 8000);
\`], {
  stdio: ['ignore', 'inherit', 'ignore'],
});
writeFileSync('holder.pid', String(holder.pid));
holder.unref();
`;

test('startup reports an early exit even when a descendant holds stdout', (t) => {
  runHelper(
    t,
    `${inheritedPipe}
    export function runScheduledDot() { process.exit(23); }
  `,
    `await assert.rejects(start, /server exited 23/);`,
    3000,
  );
});

test('startup reports a spawn error without a second failure in teardown', (t) => {
  runHelper(
    t,
    '',
    `
    process.execPath = '/nonexistent-dot-test-node';
    await assert.rejects(start, { code: 'ENOENT' });
  `,
    3000,
  );
});

test('teardown kills a server that ignores SIGTERM and releases inherited stdout', (t) => {
  const dir = runHelper(
    t,
    `${inheritedPipe}
    export function runScheduledDot() {
      return {
        url: 'http://synthetic',
        done: new Promise(resolve => setTimeout(resolve, 8000)),
        stop() { writeFileSync('term', 'received'); },
      };
    }
  `,
    `assert.equal(await start(), 'http://synthetic');`,
    4000,
  );
  assert.equal(readFileSync(join(dir, 'term'), 'utf8'), 'received');
  const pid = Number(readFileSync(join(dir, 'server.pid'), 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('outer teardown reaps the fixtures after a wrapper timeout', (t) => {
  const dir = runHelper(
    t,
    `${inheritedPipe}
    export function runScheduledDot() {
      return { url: 'http://synthetic', done: new Promise(resolve => setTimeout(resolve, 8000)) };
    }`,
    `await start(); await new Promise(resolve => setTimeout(resolve, 8000));`,
    2000,
    true,
  );
  for (const name of ['server.pid', 'holder.pid']) assert.ok(existsSync(join(dir, name)));
});
