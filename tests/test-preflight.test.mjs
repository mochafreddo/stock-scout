import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const preflight = new URL('../scripts/test-preflight.ts', import.meta.url);

function fixture(t, mode) {
  const root = mkdtempSync(join(tmpdir(), 'stock-scout-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  if (existsSync(preflight)) copyFileSync(preflight, join(root, 'scripts/test-preflight.ts'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      scripts: { ...manifest.scripts, test: 'node suite.mjs' },
    }),
  );
  writeFileSync(join(root, 'suite.mjs'), "console.log('SUITE_STARTED');\n");
  const trace = join(root, 'trace');
  writeFileSync(
    join(root, 'network.cjs'),
    `
const net = require('node:net');
const fs = require('node:fs');
const listen = net.Server.prototype.listen;
const close = net.Server.prototype.close;
net.Server.prototype.listen = function (...args) {
  fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args.slice(0, 2)) + '\\n');
  if (${JSON.stringify(mode)} === 'interrupt') {
    return listen.call(this, args[0], args[1], () => {
      fs.appendFileSync(${JSON.stringify(trace)}, String(this.address().port) + '\\n');
      process.kill(process.pid, 'SIGTERM');
    });
  }
  if (${JSON.stringify(mode)} !== 'success') {
    process.nextTick(() => this.emit('error', Object.assign(new Error(${JSON.stringify(mode)} + ': denied'), { code: ${JSON.stringify(mode)} })));
    return this;
  }
  return listen.apply(this, args);
};
net.Server.prototype.close = function (...args) {
  fs.appendFileSync(${JSON.stringify(trace)}, 'closed\\n');
  return close.apply(this, args);
};
`,
  );
  return { root, trace };
}

for (const code of ['EPERM', 'EACCES']) {
  test(`npm test reports ${code} as an environment failure before starting the suite`, (t) => {
    const { root, trace } = fixture(t, code);
    const result = spawnSync('npm', ['test'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `--require=${join(root, 'network.cjs')}` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /environment/i);
    assert.match(result.stderr, /test.*not run/i);
    assert.match(result.stderr, new RegExp(code));
    assert.doesNotMatch(result.stdout, /SUITE_STARTED/);
    assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8').split('\n')[0]), [0, '127.0.0.1']);
  });
}

test('npm test closes its loopback listener before starting the suite', (t) => {
  const { root, trace } = fixture(t, 'success');
  const result = spawnSync('npm', ['test'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: `--require=${join(root, 'network.cjs')}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SUITE_STARTED/);
  assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['[0,"127.0.0.1"]', 'closed']);
});

test('npm test releases its listener and does not start the suite when interrupted', async (t) => {
  const { root, trace } = fixture(t, 'interrupt');
  const result = spawnSync('npm', ['test'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: `--require=${join(root, 'network.cjs')}` },
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /SUITE_STARTED/);
  const port = Number(readFileSync(trace, 'utf8').trim().split('\n')[1]);
  assert.ok(port > 0);
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
