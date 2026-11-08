import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fixture } from './toss-cli-helper.mjs';

function run(...args) {
  return spawnSync(process.execPath, ['tests/toss-agent-cli.mjs', ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: { PATH: process.env.PATH, TOSS_STATE_DIR: '/must-not-use-real-state' },
  });
}

test('agent discovers the real CLI and reads explicitly synthetic prices', () => {
  const help = run('success', '--help');
  assert.equal(help.status, 0, help.stderr);
  assert.ok(JSON.parse(help.stdout).data.commands.some((x) => x.name === 'prices'));
  const price = run('success', 'prices', 'DEMO');
  assert.equal(price.status, 0, price.stderr);
  assert.deepEqual(JSON.parse(price.stdout).data, [
    { symbol: 'DEMO', lastPrice: '10.0100', currency: 'USD', timestamp: null },
  ]);
  assert.match(price.stderr, /SYNTHETIC/);
  assert.doesNotMatch(price.stdout + price.stderr, /synthetic-(secret|token|client)/);
});

test('agent can request synthetic rankings and a complete tradable list', () => {
  const rankings = run('success', 'rankings', 'TOP_GAINERS', '1d', '1');
  assert.equal(rankings.status, 0, rankings.stderr);
  const ranked = JSON.parse(rankings.stdout);
  assert.equal(ranked.data[0].rank, 1);
  assert.equal(ranked.data[0].symbol, 'DEMO');
  assert.equal(ranked.source.aggregation, 'US_market');
  const tradable = run('success', 'tradable', 'NASDAQ');
  assert.equal(tradable.status, 0, tradable.stderr);
  assert.equal(JSON.parse(tradable.stdout).data[0].name, 'Synthetic Demo');
});

test('agent follows an empty partial page using the exact returned boundary', () => {
  const first = run('partial', 'candles', 'DEMO', '1m', 'count=1');
  assert.equal(first.status, 2, first.stderr);
  const page = JSON.parse(first.stdout);
  assert.equal(page.status, 'partial');
  assert.deepEqual(page.data, []);
  assert.equal(page.page.nextBefore, '2026-11-06T09:31:00.123+09:00');
  const second = run(
    'partial',
    'candles',
    'DEMO',
    '1m',
    'count=1',
    `before=${page.page.nextBefore}`,
  );
  assert.equal(second.status, 0, second.stderr);
  const last = JSON.parse(second.stdout);
  assert.equal(last.data[0].closePrice, '10.0100');
  assert.equal(last.source.before, '2026-11-06T09:31:00.123+09:00');
  assert.deepEqual(last.page, { nextBefore: null });
});

test('agent distinguishes permission errors and invalid inputs from empty results', () => {
  const denied = run('error', 'prices', 'DEMO');
  assert.equal(denied.status, 1, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).error.code, 'PERMISSION_DENIED');
  assert.match(denied.stderr, /PERMISSION_DENIED/);
  const invalid = run('success', 'prices', 'DEMO/');
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'INPUT_INVALID');
});

test('synthetic notice survives fixture creation failure', (t) => {
  const f = fixture();
  t.after(f.close);
  const result = spawnSync(process.execPath, ['tests/toss-agent-cli.mjs', 'success', '--help'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, TMPDIR: `${f.directory}/missing` },
    timeout: 15000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT: no such file or directory, mkdtemp/);
  assert.match(result.stderr, /SYNTHETIC/);
});
