import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, runCli } from './toss-cli-helper.mjs';

const stock = {
  symbol: 'AAPL',
  name: '합성 주식',
  englishName: 'Synthetic stock',
  market: 'NASDAQ',
  isinCode: 'US0000000002',
  securityType: 'STOCK',
  isCommonShare: true,
  status: 'ACTIVE',
  currency: 'USD',
  sharesOutstanding: '100',
};
const candle = {
  timestamp: '2026-11-06T14:00:00+09:00',
  openPrice: '185.7000',
  highPrice: '190.1250',
  lowPrice: '180.0000',
  closePrice: '189.0000',
  volume: '100',
  currency: 'USD',
};
async function lookup(t, steps, args = ['AAPL', '1d', 'date=2026-11-06'], extra) {
  const f = fixture();
  t.after(f.close);
  const result = await runCli(f, steps, ['candles', ...args], extra);
  return { ...result, out: JSON.parse(result.stdout) };
}

test('daily date includes the selected New York trade date after confirming the provider market', async (t) => {
  const r = await lookup(
    t,
    [
      { path: '/api/v1/stocks', body: { result: [stock] } },
      { path: '/api/v1/candles', body: { result: { candles: [candle], nextBefore: null } } },
    ],
    undefined,
    { TEST_CLOCK_START: String(Date.parse('2026-11-06T16:00:00Z')) },
  );
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stderr, '');
  assert.deepEqual(
    r.requests.map(({ path }) => path),
    ['/oauth2/token', '/api/v1/stocks', '/api/v1/candles'],
  );
  assert.equal(r.requests[1].query, '?symbols=AAPL');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(r.requests[2].query)), {
    symbol: 'AAPL',
    interval: '1d',
    count: '100',
    adjusted: 'true',
    before: '2026-11-06T05:00:00.000Z',
  });
  assert.equal(r.out.source.date, '2026-11-06');
  assert.equal(r.out.source.dateTimeZone, 'America/New_York');
  assert.equal(r.out.source.market, 'NASDAQ');
  assert.deepEqual(r.out.data, [{ ...candle, completion: 'unknown', inProgress: 'unknown' }]);
  assert.deepEqual(r.out.page, { nextBefore: null });
  assert.doesNotMatch(r.stdout + r.stderr, /synthetic-(secret|token|client)/);
});

test('date selection uses New York midnight on both DST transition dates and preserves timestamp spelling', async (t) => {
  for (const [date, before, timestamp] of [
    ['2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-07T21:00:00-08:00'],
    ['2026-03-09', '2026-03-09T04:00:00.000Z', '2026-03-09T13:00:00+09:00'],
    ['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-01T13:00:00+09:00'],
    ['2026-11-02', '2026-11-02T05:00:00.000Z', '2026-11-01T21:00:00-08:00'],
    ['2024-02-29', '2024-02-29T05:00:00.000Z', '2024-02-29T05:00:00Z'],
  ]) {
    const row = { ...candle, timestamp };
    const r = await lookup(
      t,
      [
        { path: '/api/v1/stocks', body: { result: [stock] } },
        { path: '/api/v1/candles', body: { result: { candles: [row], nextBefore: null } } },
      ],
      ['AAPL', '1d', `date=${date}`],
    );
    assert.equal(r.status, 0, r.stdout);
    assert.equal(new URLSearchParams(r.requests.at(-1).query).get('before'), before);
    assert.equal(r.out.data[0].timestamp, timestamp);
    assert.equal(r.out.data[0].completion, 'unknown');
    assert.equal(r.out.data[0].inProgress, 'unknown');
  }
});

test('invalid dates, minute dates and conflicting bounds are rejected before any HTTP', async (t) => {
  for (const args of [
    ['AAPL', '1d', 'date=2026-02-29'],
    ['AAPL', '1d', 'date=2026-04-31'],
    ['AAPL', '1d', 'date=2026-3-09'],
    ['AAPL', '1d', 'date=2026-03-09T00:00:00Z'],
    ['AAPL', '1d', 'date='],
    ['AAPL', '1m', 'date=2026-11-06'],
    ['AAPL', '1d', 'date=2026-11-06', 'date=2026-11-05'],
    ['AAPL', '1d', 'date=2026-11-06', 'before=2026-11-06T05:00:00Z'],
    ['AAPL', '1d', 'before=2026-11-06T05:00:00Z', 'date=2026-11-06'],
  ]) {
    const r = await lookup(t, [], args);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.out.error.code, 'INPUT_INVALID');
    assert.equal(r.stderr.trim(), 'INPUT_INVALID');
    assert.deepEqual(r.requests, []);
  }
});

test('date selection accepts all provider US markets and does not require a known security type', async (t) => {
  for (const market of ['NYSE', 'NASDAQ', 'AMEX', 'US_ETC']) {
    const r = await lookup(t, [
      {
        path: '/api/v1/stocks',
        body: { result: [{ ...stock, market, securityType: 'FUTURE_TYPE' }] },
      },
      { path: '/api/v1/candles', body: { result: { candles: [], nextBefore: null } } },
    ]);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.stderr, '');
    assert.equal(r.out.source.market, market);
    assert.deepEqual(r.out.omissions, []);
    assert.deepEqual(r.out.data, []);
  }
});

test('date selection rejects unconfirmed markets and malformed or ambiguous identity without requesting candles', async (t) => {
  for (const [rows, code] of [
    ...['KOSPI', 'KOSDAQ', 'KR_ETC', 'FUTURE_MARKET'].map((market) => [
      [{ ...stock, market }],
      'UNSUPPORTED',
    ]),
    [[], 'NOT_FOUND'],
    [[stock, { ...stock, market: 'NYSE' }], 'IDENTITY_AMBIGUOUS'],
    [[stock, stock], 'RESPONSE_INVALID'],
    [[stock, null], 'RESPONSE_INVALID'],
    [[stock, { ...stock, market: null }], 'RESPONSE_INVALID'],
    [[{ ...stock, symbol: 'OTHER' }], 'RESPONSE_INVALID'],
    [[{ ...stock, currency: undefined }], 'RESPONSE_INVALID'],
    [null, 'RESPONSE_INVALID'],
  ]) {
    const r = await lookup(t, [{ path: '/api/v1/stocks', body: { result: rows } }]);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.out.error.code, code);
    assert.equal(r.stderr.trim(), code);
    assert.deepEqual(r.out.data, []);
    assert.deepEqual(
      r.requests.map(({ path }) => path),
      ['/oauth2/token', '/api/v1/stocks'],
    );
    if (code === 'IDENTITY_AMBIGUOUS') assert.equal(r.out.error.choices.length, 2);
  }
});

test('a holiday date requests one page with unchanged count and adjustment and reuses the provider boundary without date', async (t) => {
  const nextBefore = '2026-11-25T14:00:00.123400+09:00';
  const first = await lookup(
    t,
    [
      { path: '/api/v1/stocks', body: { result: [stock] } },
      { path: '/api/v1/candles', body: { result: { candles: [], nextBefore } } },
    ],
    ['AAPL', '1d', 'adjusted=false', 'date=2026-11-26', 'count=1'],
  );
  assert.equal(first.status, 2, first.stdout);
  assert.equal(first.stderr, '');
  assert.deepEqual(first.out.data, []);
  assert.deepEqual(first.out.omissions, [{ reason: 'next_page' }]);
  assert.deepEqual(first.out.page, { nextBefore });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(first.requests.at(-1).query)), {
    symbol: 'AAPL',
    interval: '1d',
    count: '1',
    adjusted: 'false',
    before: '2026-11-26T05:00:00.000Z',
  });
  assert.equal(first.requests.length, 3);
  const second = await lookup(
    t,
    [{ path: '/api/v1/candles', body: { result: { candles: [], nextBefore: null } } }],
    ['AAPL', '1d', 'count=1', 'adjusted=false', `before=${first.out.page.nextBefore}`],
  );
  assert.equal(second.status, 0, second.stdout);
  assert.deepEqual(second.out.page, { nextBefore: null });
  assert.equal(new URLSearchParams(second.requests.at(-1).query).get('before'), nextBefore);
  assert.deepEqual(
    second.requests.map(({ path }) => path),
    ['/oauth2/token', '/api/v1/candles'],
  );
  assert.equal(Object.hasOwn(second.out.source, 'date'), false);
  assert.equal(Object.hasOwn(second.out.source, 'market'), false);
});

test('date-selected pages retain unknown boundaries, valid partial rows and the inclusive upper-bound check', async (t) => {
  for (const [result, status, reason] of [
    [{ candles: [] }, 2, 'pagination_unknown'],
    [{ candles: [candle, { ...candle, volume: null }], nextBefore: null }, 2, 'invalid_item'],
    [{ candles: [{ ...candle, timestamp: '2026-11-07T14:00:00+09:00' }], nextBefore: null }, 1],
  ]) {
    const r = await lookup(t, [
      { path: '/api/v1/stocks', body: { result: [stock] } },
      { path: '/api/v1/candles', body: { result } },
    ]);
    assert.equal(r.status, status, r.stdout);
    if (status === 1) assert.equal(r.out.error.code, 'RESPONSE_INVALID');
    else assert.equal(r.out.omissions[0].reason, reason);
    for (const row of r.out.data) {
      assert.equal(row.completion, 'unknown');
      assert.equal(row.inProgress, 'unknown');
    }
    assert.equal(r.requests.length, 3);
  }
});

test('market failures remain safe errors and never fall through to a candle request', async (t) => {
  for (const [step, code] of [
    [
      { status: 403, body: { error: { code: 'ip-not-allowed', message: 'synthetic-secret' } } },
      'PERMISSION_DENIED',
    ],
    [{ status: 401, body: { error: { code: 'invalid-token' } } }, 'AUTH_FAILED'],
    [{ status: 429, headers: { 'Retry-After': '60' }, body: {} }, 'TIMEOUT'],
    [{ hang: true }, 'TIMEOUT'],
  ]) {
    const r = await lookup(t, [{ path: '/api/v1/stocks', ...step }]);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.out.error.code, code);
    assert.equal(r.stderr.trim(), code);
    assert.deepEqual(
      r.requests.map(({ path }) => path),
      ['/oauth2/token', '/api/v1/stocks'],
    );
    assert.doesNotMatch(r.stdout + r.stderr, /synthetic-(secret|token|client)/);
  }
});

test('market checks and candle retries share the original sixty-second deadline', async (t) => {
  const r = await lookup(t, [
    { path: '/api/v1/stocks', status: 429, headers: { 'Retry-After': '35' }, body: {} },
    { path: '/api/v1/stocks', body: { result: [stock] } },
    { path: '/api/v1/candles', status: 429, headers: { 'Retry-After': '30' }, body: {} },
    { path: '/api/v1/candles', body: { result: { candles: [candle], nextBefore: null } } },
  ]);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.out.error.code, 'TIMEOUT');
  assert.equal(r.stderr.trim(), 'TIMEOUT');
  assert.deepEqual(
    r.requests.map(({ path }) => path),
    ['/oauth2/token', '/api/v1/stocks', '/api/v1/stocks', '/api/v1/candles'],
  );
  assert.ok(r.requests.at(-1).at - r.requests[0].at >= 35000);
  assert.ok(r.requests.at(-1).at - r.requests[0].at < 60000);
});

test('market and candle authentication recovery and retries retain common HTTP spacing', async (t) => {
  const r = await lookup(t, [
    { path: '/api/v1/stocks', status: 401, body: { error: { code: 'expired-token' } } },
    { path: '/api/v1/stocks', status: 503, body: {} },
    { path: '/api/v1/stocks', body: { result: [stock] } },
    { path: '/api/v1/candles', status: 401, body: { error: { code: 'expired-token' } } },
    { path: '/api/v1/candles', status: 503, body: {} },
    { path: '/api/v1/candles', body: { result: { candles: [candle], nextBefore: null } } },
  ]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stderr, '');
  assert.deepEqual(
    r.requests.map(({ path }) => path),
    [
      '/oauth2/token',
      '/api/v1/stocks',
      '/oauth2/token',
      '/api/v1/stocks',
      '/api/v1/stocks',
      '/api/v1/candles',
      '/oauth2/token',
      '/api/v1/candles',
      '/api/v1/candles',
    ],
  );
  for (let index = 1; index < r.requests.length; index++)
    assert.ok(r.requests[index].at - r.requests[index - 1].at >= 1000);
});

test('help exposes the daily US date boundary and continuation without HTTP', async (t) => {
  const f = fixture();
  t.after(f.close);
  const r = await runCli(f, [], ['--help']);
  const command = JSON.parse(r.stdout).data.commands.find(({ name }) => name === 'candles');
  assert.deepEqual(command.dateSelection, {
    interval: '1d',
    market: 'provider_verified_US',
    timeZone: 'America/New_York',
    boundary: 'inclusive_trade_date',
    conflictsWith: 'before',
    continuation: 'copy_page_nextBefore_to_before_without_date',
    completion: 'unknown',
    inProgress: 'unknown',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.deepEqual(r.requests, []);
});
