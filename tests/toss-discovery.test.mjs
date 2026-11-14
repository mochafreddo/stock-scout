import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, runCli } from './toss-cli-helper.mjs';

const row = {
  rank: 2,
  symbol: 'DEMO',
  currency: 'USD',
  price: { lastPrice: '10.0100', basePrice: '0', changeRate: null },
  tradingVolume: '0',
  tradingAmount: '100.0000',
};
const rankedAt = '2026-11-06T15:15:00Z';
async function query(t, args, path, result, extra = {}) {
  const f = fixture();
  t.after(f.close);
  const run = await runCli(f, [{ path, body: { result }, ...extra }], args);
  return { ...run, out: JSON.parse(run.stdout) };
}
test('US market rankings keep original ranks, decimal strings and aggregation time', async (t) => {
  for (const type of [
    'MARKET_TRADING_VOLUME',
    'MARKET_TRADING_AMOUNT',
    'TOP_GAINERS',
    'TOP_LOSERS',
  ]) {
    const r = await query(t, ['rankings', type, '1d'], '/api/v1/rankings', {
      rankedAt,
      rankings: [row],
    });
    assert.equal(r.status, 2);
    assert.deepEqual(r.out.data, [row]);
    assert.deepEqual(r.out.omissions, [{ reason: 'fewer_than_requested' }]);
    assert.equal(r.out.source.rankedAt, rankedAt);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(r.requests.at(-1).query)), {
      type,
      duration: '1d',
      count: '20',
      marketCountry: 'US',
    });
  }
});
const listed = {
  symbol: 'DEMO',
  name: '합성 종목',
  securityType: 'ETF',
  isCommonShare: false,
  isinCode: 'US0000000010',
};
test('tradable list returns every matching row from one filtered GET', async (t) => {
  const rows = Array.from({ length: 201 }, (_, i) => ({ ...listed, symbol: `DEMO${i}` }));
  const r = await query(
    t,
    ['tradable', 'NASDAQ', 'status=SCHEDULED', 'securityType=ETF', 'commonShare=false'],
    '/api/v1/stocks/all',
    rows,
  );
  assert.equal(r.status, 0);
  assert.deepEqual(r.out.data, rows);
  assert.equal(r.out.source.status, 'SCHEDULED');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(r.requests.at(-1).query)), {
    market: 'NASDAQ',
    status: 'SCHEDULED',
    securityType: 'ETF',
    commonShare: 'false',
  });
  assert.equal(r.requests.length, 2);
});
test('tradable lists default to ACTIVE in the request and source, including empty lists', async (t) => {
  for (const count of [201, 0]) {
    const rows = Array.from({ length: count }, (_, i) => ({ ...listed, symbol: `DEMO${i}` }));
    const r = await query(t, ['tradable', 'NYSE'], '/api/v1/stocks/all', rows);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    assert.deepEqual(r.out.data, rows);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(r.requests.at(-1).query)), {
      market: 'NYSE',
      status: 'ACTIVE',
    });
    assert.equal(r.out.source.status, 'ACTIVE');
    assert.equal(r.requests.length, 2);
  }
});
test('unsupported combinations, filters and cursors fail before HTTP', async (t) => {
  for (const args of [
    ['rankings', 'TOP_LOSERS', 'realtime'],
    ['rankings', 'TOP_GAINERS', 'realtime'],
    ['rankings', 'OTHER', '1d'],
    ['rankings', 'MARKET_TRADING_AMOUNT', '1m'],
    ['rankings', 'TOP_GAINERS', '1d', '101'],
    ['rankings', 'TOP_GAINERS', '1d', '0'],
    ['rankings', 'TOP_GAINERS', '1d', '20', 'cursor=X'],
    ['tradable', 'KOSPI'],
    ['tradable', 'AMEX', 'cursor=X'],
    ['tradable', 'NYSE', 'status=ACTIVE', 'status=SCHEDULED'],
    ['tradable', 'NASDAQ', 'commonShare=yes'],
    ['tradable', 'NYSE', 'securityType=OTHER'],
  ]) {
    const r = await query(t, args, '', null);
    assert.equal(r.status, 1);
    assert.equal(r.out.error.code, 'INPUT_INVALID');
    assert.deepEqual(r.requests, []);
    assert.equal(r.stderr.trim(), 'INPUT_INVALID');
  }
});
test('empty, incomplete, invalid and throttled responses are distinguishable', async (t) => {
  for (const [args, path, empty, bad] of [
    [
      ['rankings', 'MARKET_TRADING_VOLUME', 'realtime', '100'],
      '/api/v1/rankings',
      { rankedAt: null, rankings: [] },
      { rankings: [{ ...row, tradingVolume: 0 }] },
    ],
    [['tradable', 'US_ETC'], '/api/v1/stocks/all', [], [{ ...listed, isCommonShare: null }]],
  ]) {
    const r = await query(t, args, path, empty);
    assert.equal(r.status, 0);
    assert.deepEqual(r.out.data, []);
    assert.equal(r.requests.length, 2);
    if (args[0] === 'rankings') assert.equal(r.out.source.rankedAt, null);
    const invalid = await query(t, args, path, bad);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.out.error.code, 'RESPONSE_INVALID');
    const limited = await query(t, args, path, null, {
      status: 429,
      headers: { 'Retry-After': '90' },
      body: { error: { code: 'rate-limit' } },
    });
    assert.equal(limited.status, 1);
    assert.equal(limited.out.error.code, 'TIMEOUT');
    assert.equal(limited.requests.length, 2);
  }
  const mixed = await query(t, ['tradable', 'NYSE', 'securityType=ETF'], '/api/v1/stocks/all', [
    listed,
    { ...listed, securityType: 'ETN' },
  ]);
  assert.equal(mixed.status, 2);
  assert.deepEqual(mixed.out.data, [listed]);
  assert.deepEqual(mixed.out.omissions, [{ index: 1, reason: 'invalid_item' }]);
  const full = await query(t, ['rankings', 'TOP_GAINERS', '1w', '2'], '/api/v1/rankings', {
    rankings: [{ ...row, rank: 1 }, row],
    rankedAt,
  });
  assert.equal(full.status, 0);
  assert.deepEqual(
    full.out.data.map((x) => x.rank),
    [1, 2],
  );
});
test('contradictory ranking values cannot be reported as success', async (t) => {
  const args = ['rankings', 'TOP_GAINERS', '1d', '2'],
    path = '/api/v1/rankings';
  const reversed = await query(t, args, path, { rankings: [row, { ...row, rank: 1 }] });
  assert.equal(reversed.status, 1);
  assert.equal(reversed.out.error.code, 'RESPONSE_INVALID');
  const mixed = await query(t, args, path, {
    rankings: [
      { ...row, rank: 1, price: { lastPrice: '10', basePrice: '0.00', changeRate: '1' } },
      row,
    ],
  });
  assert.equal(mixed.status, 2);
  assert.deepEqual(mixed.out.data, [row]);
  assert.deepEqual(mixed.out.omissions, [{ index: 0, reason: 'invalid_item' }]);
});
