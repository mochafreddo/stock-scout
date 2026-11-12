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
    {
      symbol: 'DEMO',
      lastPrice: '10.0100',
      currency: 'USD',
      timestamp: null,
      priceAge: {
        seconds: null,
        thresholdSeconds: 900,
        exceedsThreshold: null,
        unavailableReason: 'timestamp_null',
      },
    },
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

test('agent reads synthetic account data and follows an empty transaction page', () => {
  const buying = run('success', 'buying-power', 'USD');
  assert.equal(buying.status, 0, buying.stderr);
  const output = JSON.parse(buying.stdout);
  assert.deepEqual(output.data, [{ currency: 'USD', cashBuyingPower: '3500.5000' }]);
  assert.equal(output.source.accountAlias, 'primary');
  assert.doesNotMatch(
    buying.stdout + buying.stderr,
    /accountSeq|accountNo|99887766554|synthetic-(secret|token|client)/,
  );
  const first = run('partial', 'transactions', '2026-10-11', '2026-11-10', 'limit=1');
  assert.equal(first.status, 2, first.stderr);
  const page = JSON.parse(first.stdout);
  assert.deepEqual(page.data, []);
  assert.equal(page.page.nextCursor, 'synthetic_next');
  const last = run(
    'partial',
    'transactions',
    '2026-10-11',
    '2026-11-10',
    'limit=1',
    `cursor=${page.page.nextCursor}`,
    `context=${page.page.context}`,
  );
  assert.equal(last.status, 0, last.stderr);
  const end = JSON.parse(last.stdout);
  assert.equal(end.data[0].netAmount, '23.469999');
  assert.equal(end.data[0].settled, false);
  assert.equal(end.data[0].transactionTime, null);
  assert.deepEqual(end.page, { hasNext: false, nextCursor: null });
  const denied = run('error', 'holdings');
  assert.equal(denied.status, 1, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).error.code, 'PERMISSION_DENIED');
});

test('agent reads synthetic KRW buying power as an integer amount', () => {
  const result = run('success', 'buying-power', 'KRW');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data, [{ currency: 'KRW', cashBuyingPower: '3500' }]);
});

test('agent discovers and uses later market queries without assuming eligibility', () => {
  for (const [args, status, check] of [
    [['stock', 'DEMO'], 0, (o) => assert.equal(o.data[0].securityType, 'STOCK')],
    [['orderbook', 'DEMO'], 0, (o) => assert.equal(o.data[0].asks[0].price, '10.0200')],
    [['trades', 'DEMO', '1'], 0, (o) => assert.equal(o.data[0].volume, '0.0125')],
    [['sessions', '2026-11-06'], 0, (o) => assert.equal(o.source.dateTimeZone, 'America/New_York')],
    [
      ['constraints', 'DEMO', '2026-11-06'],
      2,
      (o) => assert.equal(o.data[0].eligibility, 'unknown'),
    ],
  ]) {
    const result = run('success', ...args);
    assert.equal(result.status, status, result.stderr);
    check(JSON.parse(result.stdout));
  }
});

test('agent reads holdings and order groups and follows both order cursors', () => {
  const holdings = run('success', 'holdings');
  assert.equal(holdings.status, 0, holdings.stderr);
  assert.equal(JSON.parse(holdings.stdout).data[0].items[0].quantity, '0.1250');
  for (const command of ['orders', 'conditional-orders']) {
    for (const group of ['OPEN', 'CLOSED']) {
      const result = run('success', command, group);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).data[0].symbol, 'DEMO');
      if (command === 'orders') {
        assert.equal(
          JSON.parse(result.stdout).data[0].status,
          group === 'OPEN' ? 'PENDING' : 'CANCELED',
        );
        assert.equal(JSON.parse(result.stdout).data[0].execution.filledQuantity, '0');
      }
    }
    const first = run('partial', command, 'CLOSED', 'limit=1');
    assert.equal(first.status, 2, first.stderr);
    const page = JSON.parse(first.stdout);
    assert.deepEqual(page.data, []);
    assert.equal(page.page.nextCursor, 'synthetic_next');
    const last = run(
      'partial',
      command,
      'CLOSED',
      'limit=1',
      `cursor=${page.page.nextCursor}`,
      `context=${page.page.context}`,
    );
    assert.equal(last.status, 0, last.stderr);
    assert.deepEqual(JSON.parse(last.stdout).page, { hasNext: false, nextCursor: null });
    assert.doesNotMatch(
      last.stdout + last.stderr,
      /accountSeq|accountNo|99887766554|synthetic-(secret|token|client)/,
    );
  }
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
