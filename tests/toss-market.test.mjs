import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, runCli } from './toss-cli-helper.mjs';

async function lookup(t, command, result, args = ['AAPL']) {
  const f = fixture();
  t.after(f.close);
  const r = await runCli(f, [{ path: `/api/v1/${command}`, body: { result } }], [command, ...args]);
  return { ...r, out: JSON.parse(r.stdout) };
}
const book = {
  currency: 'USD',
  timestamp: '2026-11-06T10:30:00.456-05:00',
  asks: [
    { price: '185.7500', volume: '0.1250' },
    { price: '185.7000', volume: '0' },
  ],
  bids: [
    { price: '185.6500', volume: '180.0000' },
    { price: '185.5500', volume: '0.2500' },
    { price: '185.6000', volume: '12.5000' },
  ],
};
const trade = {
  price: '185.7000',
  volume: '0.0125',
  timestamp: '2026-11-06T10:30:42.100-05:00',
  currency: 'USD',
};

test('orderbook preserves both sides, provider order, decimals and source timing', async (t) => {
  const r = await lookup(t, 'orderbook', {
    ...book,
    privateExtra: 'private upstream message',
    asks: book.asks.map((row) => ({ ...row, extra: 'synthetic-secret' })),
  });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stderr, '');
  assert.deepEqual(r.out.data, [book]);
  assert.deepEqual(r.out.omissions, []);
  assert.deepEqual(r.out.source, {
    provider: 'tossinvest',
    endpoint: '/api/v1/orderbook',
    freshness: 'unknown',
    session: 'unknown',
    snapshot: 'unknown',
    priceUnit: 'currency_per_security',
    volumeUnit: 'securities',
    symbol: 'AAPL',
  });
  assert.ok(Number.isFinite(Date.parse(r.out.retrievedAt)));
  assert.deepEqual(
    r.requests.map(({ method, path, query }) => [method, path, query]),
    [
      ['POST', '/oauth2/token', ''],
      ['GET', '/api/v1/orderbook', '?symbol=AAPL'],
    ],
  );
  assert.doesNotMatch(r.stdout + r.stderr, /private upstream message|synthetic-secret/);
});

test('trades sends the requested count and preserves identical executions and provider order', async (t) => {
  const rows = [
    trade,
    trade,
    {
      ...trade,
      price: '0',
      volume: '0',
      currency: 'EUR',
      timestamp: '2026-11-06T10:30:41.250-05:00',
    },
  ];
  const r = await lookup(t, 'trades', rows, ['BRK.B', '3']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stderr, '');
  assert.deepEqual(r.out.data, rows);
  assert.deepEqual(r.out.omissions, []);
  assert.deepEqual(r.out.source, {
    provider: 'tossinvest',
    endpoint: '/api/v1/trades',
    freshness: 'unknown',
    session: 'unknown',
    snapshot: 'unknown',
    priceUnit: 'currency_per_security',
    volumeUnit: 'securities',
    symbol: 'BRK.B',
    count: 3,
    scope: 'provider_current_day_recent_trades',
  });
  assert.deepEqual(
    r.requests.map(({ method, path, query }) => [method, path, query]),
    [
      ['POST', '/oauth2/token', ''],
      ['GET', '/api/v1/trades', '?symbol=BRK.B&count=3'],
    ],
  );
});

test('empty books, missing or null book times, and short or empty recent trades are successful', async (t) => {
  for (const timestamp of [undefined, null]) {
    const r = await lookup(t, 'orderbook', { ...book, asks: [], bids: [], timestamp });
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(r.out.data, [
      { currency: 'USD', asks: [], bids: [], ...(timestamp === null ? { timestamp: null } : {}) },
    ]);
    assert.equal(r.out.source.freshness, 'unknown');
  }
  for (const rows of [[], [trade]]) {
    const r = await lookup(t, 'trades', rows);
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(r.out.data, rows);
    assert.deepEqual(r.out.omissions, []);
    assert.equal(r.requests.at(-1).query, '?symbol=AAPL&count=50');
  }
});

test('book depth is not truncated and trade count boundaries are sent without extra requests', async (t) => {
  const asks = Array.from({ length: 60 }, () => ({ price: '1.0000', volume: '0.1250' }));
  const r = await lookup(t, 'orderbook', { ...book, asks });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.out.data[0].asks, asks);
  for (const count of ['1', '50']) {
    const rows = Array.from({ length: Number(count) }, () => trade);
    const r = await lookup(t, 'trades', rows, ['AAPL', count]);
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(r.out.data, rows);
    assert.equal(r.requests.at(-1).query, `?symbol=AAPL&count=${count}`);
    assert.equal(r.requests.length, 2);
  }
});

test('malformed book levels are omitted by side and index; no usable levels is an error', async (t) => {
  const r = await lookup(t, 'orderbook', {
    ...book,
    asks: [{ price: null, volume: '1' }, book.asks[0]],
    bids: [{ price: '1', volume: 0 }],
  });
  assert.equal(r.status, 2, r.stdout);
  assert.deepEqual(r.out.data, [{ ...book, asks: [book.asks[0]], bids: [] }]);
  assert.deepEqual(r.out.omissions, [
    { side: 'asks', index: 0, reason: 'invalid_item' },
    { side: 'bids', index: 0, reason: 'invalid_item' },
  ]);
  for (const value of [
    null,
    [],
    {},
    { ...book, currency: null },
    { ...book, currency: '' },
    { ...book, asks: null },
    { ...book, bids: undefined },
    { ...book, asks: [{ price: '1' }], bids: [] },
    { ...book, asks: [], bids: [{ price: '1'.repeat(31), volume: '1' }] },
  ]) {
    const r = await lookup(t, 'orderbook', value);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.out.error.code, 'RESPONSE_INVALID');
    assert.deepEqual(r.out.data, []);
    assert.equal(r.stderr.trim(), 'RESPONSE_INVALID');
  }
});

test('trades excludes invalid required fields without reconstructing unknown times or values', async (t) => {
  const invalid = [
    { ...trade, price: null },
    { ...trade, price: 0 },
    { ...trade, price: '1'.repeat(31) },
    { ...trade, volume: null },
    { ...trade, volume: undefined },
    { ...trade, volume: '1e3' },
    { ...trade, timestamp: null },
    { ...trade, timestamp: undefined },
    { ...trade, timestamp: '2026-11-06T10:00:00' },
    { ...trade, timestamp: '2026-02-30T10:00:00Z' },
    { ...trade, currency: null },
    { ...trade, currency: undefined },
  ];
  const r = await lookup(t, 'trades', [trade, ...invalid]);
  assert.equal(r.status, 2, r.stdout);
  assert.deepEqual(r.out.data, [trade]);
  assert.deepEqual(
    r.out.omissions,
    invalid.map((_, index) => ({ index: index + 1, reason: 'invalid_item' })),
  );
  for (const rows of [invalid, null, {}, [trade, trade]]) {
    const r = await lookup(t, 'trades', rows, ['AAPL', '1']);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.out.error.code, 'RESPONSE_INVALID');
  }
  const allInvalid = await lookup(t, 'trades', [{ ...trade, timestamp: null }]);
  assert.equal(allInvalid.out.error.code, 'RESPONSE_INVALID');
});

test('market commands reject multi-symbol, page, period and depth requests before authentication', async (t) => {
  for (const command of ['orderbook', 'trades']) {
    for (const args of [
      [],
      ['AAPL,MSFT'],
      ['AAPL/OTHER'],
      ['AAPL', 'cursor=X'],
      ['AAPL', '1d'],
      ['AAPL', '1', 'extra'],
    ]) {
      const r = await lookup(t, command, [], args);
      assert.equal(r.status, 1, r.stdout);
      assert.equal(r.out.error.code, 'INPUT_INVALID');
      assert.deepEqual(r.requests, []);
    }
  }
  for (const count of ['0', '51', '-1', '1.5', '01', '1e1', '']) {
    const r = await lookup(t, 'trades', [], ['AAPL', count]);
    assert.equal(r.out.error.code, 'INPUT_INVALID');
    assert.deepEqual(r.requests, []);
  }
  const r = await lookup(t, 'orderbook', book, ['AAPL', '10']);
  assert.equal(r.out.error.code, 'INPUT_INVALID');
  assert.deepEqual(r.requests, []);
});

test('both commands share authentication, bounded retries, timeout and safe provider diagnostics', async (t) => {
  for (const command of ['orderbook', 'trades']) {
    const path = `/api/v1/${command}`;
    for (const [step, code, count] of [
      [
        {
          status: 403,
          body: {
            error: {
              code: 'ip-not-allowed',
              requestId: 'SAFE_REQUEST_1',
              message: 'private upstream message',
            },
          },
        },
        'PERMISSION_DENIED',
        1,
      ],
      [{ status: 401, body: { error: { code: 'invalid-token' } } }, 'AUTH_FAILED', 1],
      [{ status: 400, body: { error: { code: 'unsupported-market' } } }, 'UNSUPPORTED', 1],
      [{ status: 404, body: { error: { code: 'stock-not-found' } } }, 'NOT_FOUND', 1],
      [
        {
          status: 429,
          headers: { 'Retry-After': '60' },
          body: { error: { code: 'rate-limit-exceeded' } },
        },
        'TIMEOUT',
        1,
      ],
      [{ status: 429, body: { error: { code: 'rate-limit-exceeded' } } }, 'RATE_LIMIT', 2],
      [{ hang: true }, 'TIMEOUT', 1],
      [{ interrupt: true }, 'INTERRUPTED', 1],
      [{ body: { result: [], error: 'private upstream message' } }, 'RESPONSE_INVALID', 1],
    ]) {
      const f = fixture();
      t.after(f.close);
      const r = await runCli(
        f,
        [
          { ...step, path },
          { ...step, path },
        ],
        [command, 'AAPL'],
      );
      const out = JSON.parse(r.stdout);
      assert.equal(r.status, 1, r.stdout);
      assert.equal(out.error.code, code, r.stdout);
      assert.deepEqual(out.data, []);
      assert.equal(r.requests.filter((row) => row.method === 'GET').length, count);
      assert.equal(r.stderr.trim(), code);
      assert.doesNotMatch(
        r.stdout + r.stderr,
        /private upstream message|synthetic-(secret|token|client)/,
      );
      if (code === 'PERMISSION_DENIED') {
        assert.equal(out.error.providerCode, 'ip-not-allowed');
        assert.equal(out.error.requestId, 'SAFE_REQUEST_1');
      }
    }
    const f = fixture();
    t.after(f.close);
    const result = command === 'orderbook' ? book : [trade];
    const r = await runCli(
      f,
      [
        { path, status: 401, body: { error: { code: 'expired-token' } } },
        { path, status: 503, body: {} },
        { path, body: { result } },
      ],
      [command, 'AAPL'],
    );
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(
      r.requests.map(({ method, path: p }) => [method, p]),
      [
        ['POST', '/oauth2/token'],
        ['GET', path],
        ['POST', '/oauth2/token'],
        ['GET', path],
        ['GET', path],
      ],
    );
    assert.deepEqual(JSON.parse(r.stdout).data, command === 'orderbook' ? [book] : [trade]);
  }
});

test('help discovers both market commands without authentication', async (t) => {
  const f = fixture();
  t.after(f.close);
  const r = await runCli(f, [], ['--help']);
  assert.equal(r.status, 0);
  const commands = JSON.parse(r.stdout).data.commands;
  assert.equal(
    commands.find((x) => x.name === 'orderbook').usage,
    'node scripts/toss.ts orderbook SYMBOL',
  );
  assert.equal(commands.find((x) => x.name === 'trades').maxCount, 50);
  assert.deepEqual(r.requests, []);
});

test('invalid optional book time preserves valid levels as partial; new currency codes remain usable', async (t) => {
  for (const timestamp of ['2026-02-30T10:00:00Z', '2026-11-06T10:00:00']) {
    const r = await lookup(t, 'orderbook', { ...book, timestamp });
    assert.equal(r.status, 2, r.stdout);
    assert.deepEqual(r.out.data, [{ currency: 'USD', asks: book.asks, bids: book.bids }]);
    assert.deepEqual(r.out.omissions, [{ field: 'timestamp', reason: 'invalid_timestamp' }]);
  }
  const r = await lookup(t, 'orderbook', { ...book, currency: 'USDT' });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.out.data[0].currency, 'USDT');
  const trades = await lookup(t, 'trades', [{ ...trade, currency: 'USDT' }]);
  assert.equal(trades.status, 0, trades.stdout);
  assert.equal(trades.out.data[0].currency, 'USDT');
});
