import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('the default check rejects lint errors in shipped examples', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'stock-scout-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ['package.json', 'biome.json', 'tsconfig.json']) {
    copyFileSync(new URL(`../${file}`, import.meta.url), join(root, file));
  }
  for (const directory of ['scripts', 'tests', 'examples']) mkdirSync(join(root, directory));
  symlinkSync(new URL('../node_modules', import.meta.url), join(root, 'node_modules'));
  const example = join(root, 'examples/consumer.mjs');
  writeFileSync(example, 'debugger;\n');
  const check = () => spawnSync('npm', ['run', 'check'], { cwd: root, encoding: 'utf8' });
  const broken = check();
  assert.equal(broken.status, 1, broken.stdout + broken.stderr);
  assert.match(broken.stdout + broken.stderr, /examples\/consumer\.mjs/);
  assert.match(broken.stdout + broken.stderr, /noDebugger/);
  writeFileSync(example, 'console.log(42);\n');
  const valid = check();
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
});
