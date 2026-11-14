import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, runCli } from './toss-cli-helper.mjs';

function run(...args) {
  return spawnSync(process.execPath, ['tests/toss-agent-cli.mjs', ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: { PATH: process.env.PATH, TOSS_STATE_DIR: '/must-not-use-real-state' },
  });
}

function consume(result) {
  return spawnSync(process.execPath, ['examples/candle-consumer.mjs'], {
    input: result.stdout,
    encoding: 'utf8',
    timeout: 15000,
    env: { PATH: process.env.PATH },
  });
}

test('consumer preserves early daily input errors without candle source metadata', async (t) => {
  const f = fixture();
  t.after(f.close);
  for (const args of [
    ['candles', 'DEMO/', '1d'],
    ['candles-batch', 'DEMO/'],
  ]) {
    const result = await runCli(f, [], args);
    assert.equal(result.status, 1, result.stderr);
    const original = JSON.parse(result.stdout);
    assert.equal(original.source.interval, undefined);
    assert.deepEqual(original.error, { code: 'INPUT_INVALID' });
    assert.deepEqual(result.requests, []);
    const consumed = consume(result);
    assert.equal(consumed.status, 0, consumed.stderr);
    assert.deepEqual(JSON.parse(consumed.stdout), {
      status: 'error',
      data: [],
      error: { code: 'INPUT_INVALID' },
    });
  }
});

test('consumer preserves isolated daily authentication storage failures', async (t) => {
  const f = fixture();
  t.after(f.close);
  for (const args of [
    ['candles', 'DEMO', '1d'],
    ['candles-batch', 'DEMO,LATER'],
  ]) {
    const result = await runCli(f, [], args, { TOSS_STATE_DIR: join(f.directory, 'missing') });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).error, { code: 'AUTH_STORAGE' });
    assert.deepEqual(result.requests, []);
    const consumed = consume(result);
    assert.equal(consumed.status, 0, consumed.stderr);
    const output = JSON.parse(consumed.stdout);
    assert.equal(output.status, 'error');
    assert.deepEqual(output.error, { code: 'AUTH_STORAGE' });
    assert.ok(output.data.every((row) => row.analysis === null && row.bars.length === 0));
  }
});

test('consumer forwards only CLI-safe provider error details', async (t) => {
  const f = fixture();
  t.after(f.close);
  const result = await runCli(
    f,
    [
      {
        path: '/api/v1/candles',
        status: 403,
        body: {
          error: {
            code: 'ip-not-allowed',
            requestId: 'SAFE_REQUEST_312',
            message: 'private upstream message synthetic-secret synthetic-token',
          },
          privateBody: 'private upstream body',
        },
      },
    ],
    ['candles', 'DEMO', '1d'],
  );
  assert.equal(result.status, 1, result.stderr);
  const expected = {
    code: 'PERMISSION_DENIED',
    providerCode: 'ip-not-allowed',
    requestId: 'SAFE_REQUEST_312',
  };
  assert.deepEqual(JSON.parse(result.stdout).error, expected);
  const consumed = consume(result);
  assert.equal(consumed.status, 0, consumed.stderr);
  const output = JSON.parse(consumed.stdout);
  assert.equal(output.status, 'error');
  assert.deepEqual(output.error, expected);
  assert.deepEqual(output.data[0].error, expected);
  assert.doesNotMatch(
    result.stdout + result.stderr + consumed.stdout + consumed.stderr,
    /private upstream|synthetic-(secret|token|client)/,
  );
});

test('daily synthetic stdout runs through the executable analysis consumer', () => {
  const result = run('success', 'candles', 'DEMO', '1d', 'date=2026-11-05', 'count=3');
  assert.equal(result.status, 0, result.stderr);
  const consumed = consume(result);
  assert.equal(consumed.status, 0, consumed.stderr);
  const row = JSON.parse(consumed.stdout).data[0];
  assert.deepEqual(row.bars, [
    {
      timestamp: '2026-11-04T23:00:00-06:00',
      tradeDate: '2026-11-05',
      closePrice: '12.50',
      volume: '200',
    },
    {
      timestamp: '2026-11-03T23:00:00-06:00',
      tradeDate: '2026-11-04',
      closePrice: '10.00',
      volume: '100',
    },
  ]);
  assert.deepEqual(row.analysis, { closeChangePercent: 25, totalVolume: 300 });
});

test('batch consumer preserves usable partial coverage, empty pages, errors and unqueried rows', () => {
  const result = run(
    'partial',
    'candles-batch',
    'DEMO,PARTIAL,EMPTY,INVALID,DENIED,LATER',
    'date=2026-11-05',
    'count=3',
  );
  assert.equal(result.status, 2, result.stderr);
  const consumed = consume(result);
  assert.equal(consumed.status, 0, consumed.stderr);
  const output = JSON.parse(consumed.stdout);
  assert.equal(output.status, 'partial');
  const [complete, partial, empty, invalid, denied, later] = output.data;
  assert.deepEqual(
    output.data.map((row) => row.status),
    ['success', 'partial', 'partial', 'partial', 'error', 'not_queried'],
  );
  assert.deepEqual(complete.analysis, { closeChangePercent: 25, totalVolume: 300 });
  assert.deepEqual(partial.analysis, complete.analysis);
  assert.deepEqual(partial.summary, {
    returnedCount: 2,
    latestTimestamp: '2026-11-04T23:00:00-06:00',
    latestTradeDate: '2026-11-05',
    tradeDateUnavailableReason: null,
  });
  assert.deepEqual(partial.omissions, [{ reason: 'next_page' }]);
  assert.deepEqual(partial.page, { nextBefore: '2026-11-02T23:00:00-06:00' });
  assert.deepEqual(empty.summary, {
    returnedCount: 0,
    latestTimestamp: null,
    latestTradeDate: null,
    tradeDateUnavailableReason: null,
  });
  assert.equal(empty.analysis, null);
  assert.deepEqual(empty.omissions, [{ reason: 'next_page' }]);
  assert.equal(empty.page.nextBefore, partial.page.nextBefore);
  assert.deepEqual(invalid.analysis, { closeChangePercent: 25, totalVolume: 300 });
  assert.equal(invalid.summary.returnedCount, 2);
  assert.deepEqual(
    invalid.omissions.map((item) => item.reason),
    ['invalid_item', 'pagination_unknown'],
  );
  assert.deepEqual(invalid.page, {});
  assert.equal(denied.error.code, 'PERMISSION_DENIED');
  assert.equal(later.reason, 'PERMISSION_DENIED');
  for (const row of [denied, later]) {
    assert.deepEqual(row.summary, {
      returnedCount: null,
      latestTimestamp: null,
      latestTradeDate: null,
      tradeDateUnavailableReason: null,
    });
    assert.deepEqual(row.bars, []);
    assert.equal(row.analysis, null);
  }
});

test('consumer keeps unconfirmed trade dates null and distinguishes a successful empty batch row', () => {
  for (const args of [
    ['candles', 'DEMO', '1d'],
    ['candles-batch', 'DEMO,EMPTY'],
  ]) {
    const result = run('success', ...args);
    assert.equal(result.status, 0, result.stderr);
    const consumed = consume(result);
    assert.equal(consumed.status, 0, consumed.stderr);
    const [row, empty] = JSON.parse(consumed.stdout).data;
    assert.deepEqual(
      row.bars.map((bar) => bar.tradeDate),
      [null, null],
    );
    assert.equal(row.tradeDateUnavailableReason, 'market_timezone_unconfirmed');
    assert.equal(row.bars[0].timestamp, '2026-11-04T23:00:00-06:00');
    assert.deepEqual(row.analysis, { closeChangePercent: 25, totalVolume: 300 });
    if (empty) {
      assert.equal(row.summary.latestTradeDate, null);
      assert.equal(row.summary.tradeDateUnavailableReason, 'market_timezone_unconfirmed');
      assert.equal(empty.status, 'success');
      assert.equal(empty.summary.returnedCount, 0);
      assert.equal(empty.analysis, null);
    }
  }
});

test('same executable accepts zero closes without masking a missing closePrice field', () => {
  const result = run('success', 'candles', 'DEMO', '1d');
  assert.equal(result.status, 0, result.stderr);
  for (const [index, expected] of [
    [0, -100],
    [1, null],
  ]) {
    const output = JSON.parse(result.stdout);
    output.data[index].closePrice = '0';
    const consumed = consume({ stdout: JSON.stringify(output) });
    assert.equal(consumed.status, 0, consumed.stderr);
    assert.deepEqual(JSON.parse(consumed.stdout).data[0].analysis, {
      closeChangePercent: expected,
      totalVolume: 300,
    });
  }
  const output = JSON.parse(result.stdout);
  delete output.data[0].closePrice;
  const missing = consume({ stdout: JSON.stringify(output) });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /closePrice must be a decimal string/);
  const wrongCommand = consume({
    stdout: JSON.stringify({
      version: 1,
      status: 'success',
      source: { endpoint: '/api/v1/prices' },
      data: [],
    }),
  });
  assert.equal(wrongCommand.status, 1);
  assert.match(wrongCommand.stderr, /daily candle output required/);
});

test('consumer rejects nondecimal values and invalid source timestamps', async (t) => {
  const result = run('success', 'candles', 'DEMO', '1d');
  assert.equal(result.status, 0, result.stderr);
  for (const [field, value] of [
    ['closePrice', '0x10'],
    ['volume', '1e2'],
    ['timestamp', '2026-11-05'],
    ['timestamp', '2026-02-30T00:00:00Z'],
  ]) {
    await t.test(`${field}=${value}`, () => {
      const output = JSON.parse(result.stdout);
      output.data[0][field] = value;
      const consumed = consume({ stdout: JSON.stringify(output) });
      assert.equal(consumed.status, 1, consumed.stderr);
      assert.equal(consumed.stdout, '');
      assert.match(consumed.stderr, /AssertionError/);
    });
  }
});

test('daily error scenarios preserve original exit and diagnostic semantics', () => {
  for (const args of [
    ['candles', 'DEMO', '1d'],
    ['candles-batch', 'DEMO,LATER'],
  ]) {
    const result = run('error', ...args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'error');
    assert.match(result.stderr, /SYNTHETIC/);
    assert.match(result.stderr, /PERMISSION_DENIED/);
    const consumed = consume(result);
    assert.equal(consumed.status, 0, consumed.stderr);
    assert.equal(JSON.parse(consumed.stdout).data[0].analysis, null);
  }
});

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
