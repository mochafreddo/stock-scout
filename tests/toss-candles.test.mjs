import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, runCli } from './toss-cli-helper.mjs';

const candle = {
  timestamp: '2026-11-05T14:00:00+09:00',
  openPrice: '185.7000',
  highPrice: '190.1250',
  lowPrice: '180.0000',
  closePrice: '189.0000',
  volume: '0',
  currency: 'USD',
};
async function lookup(t, result, args = ['AAPL', '1d'], extra) {
  const f = fixture();
  t.after(f.close);
  const r = await runCli(
    f,
    [{ path: '/api/v1/candles', body: { result } }],
    ['candles', ...args],
    extra,
  );
  return { ...r, out: JSON.parse(r.stdout) };
}

test('daily candles request 100 adjusted bars and preserve values without claiming completion', async (t) => {
  const r = await lookup(t, {
    candles: [{ ...candle, privateExtra: 'synthetic-secret' }],
    nextBefore: null,
  });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stderr, '');
  assert.deepEqual(r.out.data, [{ ...candle, completion: 'unknown', inProgress: 'unknown' }]);
  assert.deepEqual(r.out.omissions, []);
  assert.deepEqual(r.out.page, { nextBefore: null });
  assert.equal(r.out.source.adjusted, true);
  assert.equal(r.out.source.count, 100);
  assert.equal(r.out.source.timestampMeaning, 'trade_date_local_midnight');
  assert.deepEqual(r.out.source.usSessionSemantics, {
    ohlc: 'regular',
    volume: 'consolidated_including_extended_hours',
  });
  assert.equal(r.requests.at(-1).query, '?symbol=AAPL&interval=1d&count=100&adjusted=true');
  assert.equal(r.requests.length, 2);
  assert.doesNotMatch(r.stdout + r.stderr, /synthetic-(secret|token|client)/);
});

test('minute candles preserve the inclusive provider boundary across an empty page', async (t) => {
  const nextBefore = '2026-11-06T09:31:00.123+09:00';
  const first = await lookup(t, { candles: [], nextBefore }, [
    'BRK.B',
    '1m',
    'count=1',
    'adjusted=false',
  ]);
  assert.equal(first.status, 2, first.stdout);
  assert.deepEqual(first.out.data, []);
  assert.deepEqual(first.out.page, { nextBefore });
  assert.deepEqual(first.out.omissions, [{ reason: 'next_page' }]);
  assert.equal(first.out.source.adjusted, false);
  const row = { ...candle, timestamp: nextBefore };
  const second = await lookup(t, { candles: [row], nextBefore: null }, [
    'BRK.B',
    '1m',
    'count=1',
    'adjusted=false',
    `before=${first.out.page.nextBefore}`,
  ]);
  assert.equal(second.status, 0, second.stdout);
  assert.equal(
    second.requests.at(-1).query,
    '?symbol=BRK.B&interval=1m&count=1&adjusted=false&before=2026-11-06T09%3A31%3A00.123%2B09%3A00',
  );
  assert.equal(second.out.source.before, nextBefore);
  assert.equal(second.out.source.timestampMeaning, 'minute_end_exclusive');
  assert.deepEqual(second.out.data, [{ ...row, completion: 'unknown', inProgress: 'unknown' }]);
  assert.deepEqual(second.out.source.usSessionSemantics, {
    ohlc: 'provider_trades_session_unknown',
    volume: 'selected_US_exchanges',
  });
  assert.equal(second.requests.length, 2);
});

test('candles expose adjustment limits and remain unconfirmed for past and current intervals', async (t) => {
  for (const interval of ['1d', '1m']) {
    for (const timestamp of [
      '2026-11-05T14:00:00+09:00',
      '2026-11-06T15:00:00Z',
      '2026-11-06T15:01:00Z',
    ]) {
      const r = await lookup(
        t,
        { candles: [{ ...candle, timestamp }], nextBefore: null },
        ['AAPL', interval],
        { TEST_CLOCK_START: String(Date.parse('2026-11-06T15:00:30Z')) },
      );
      assert.equal(r.status, 0, r.stdout);
      assert.equal(r.out.data[0].completion, 'unknown');
      assert.equal(r.out.data[0].inProgress, 'unknown');
      assert.equal(r.out.source.originalPricesGuaranteed, false);
      assert.equal(r.out.source.freshness, 'unknown');
    }
  }
});

test('help discovers candles and its supported intervals without authentication', async (t) => {
  const f = fixture();
  t.after(f.close);
  const r = await runCli(f, [], ['--help']);
  const command = JSON.parse(r.stdout).data.commands.find((x) => x.name === 'candles');
  assert.deepEqual(command.intervals, ['1d', '1m']);
  assert.equal(command.defaultCount, 100);
  assert.equal(command.maxCount, 200);
  assert.deepEqual(r.requests, []);
});

test('candles retain request semantics on upstream errors (characterization)', async (t) => {
  const f = fixture();
  t.after(f.close);
  const r = await runCli(
    f,
    [{ path: '/api/v1/candles', status: 403, body: {} }],
    ['candles', 'AAPL', '1m', 'count=1', 'adjusted=false'],
  );
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.stderr.trim(), 'PERMISSION_DENIED');
  assert.deepEqual(JSON.parse(r.stdout).source, {
    provider: 'tossinvest',
    endpoint: '/api/v1/candles',
    freshness: 'unknown',
    symbol: 'AAPL',
    interval: '1m',
    count: 1,
    adjusted: false,
    originalPricesGuaranteed: false,
    priceUnit: 'currency_per_security',
    volumeUnit: 'securities',
    timestampMeaning: 'minute_end_exclusive',
    usSessionSemantics: {
      ohlc: 'provider_trades_session_unknown',
      volume: 'selected_US_exchanges',
    },
  });
});

test('candles reject response order and upper-bound violations instead of silently reordering', async (t) => {
  const older = { ...candle, timestamp: '2026-11-04T14:00:00+09:00' };
  for (const [candles, args] of [
    [
      [older, candle],
      ['AAPL', '1d'],
    ],
    [[candle], ['AAPL', '1d', 'before=2026-11-04T14:00:00+09:00']],
  ]) {
    const r = await lookup(t, { candles, nextBefore: null }, args);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.out.error.code, 'RESPONSE_INVALID');
  }
});

test('candles enforce inclusive bounds beyond millisecond precision', async (t) => {
  for (const interval of ['1d', '1m']) {
    const r = await lookup(
      t,
      { candles: [{ ...candle, timestamp: '2026-11-06T15:00:00.1235Z' }], nextBefore: null },
      ['AAPL', interval, 'before=2026-11-06T15:00:00.1234Z'],
    );
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.out.error.code, 'RESPONSE_INVALID');
    assert.deepEqual(r.out.data, []);
    assert.equal(r.stderr.trim(), 'RESPONSE_INVALID');
  }
});

test('candles reject ascending submillisecond timestamps', async (t) => {
  for (const interval of ['1d', '1m']) {
    const r = await lookup(
      t,
      {
        candles: [
          { ...candle, timestamp: '2026-11-06T10:00:00.12340000000000000001-05:00' },
          { ...candle, timestamp: '2026-11-07T00:00:00.12340000000000000002+09:00' },
        ],
        nextBefore: null,
      },
      ['AAPL', interval],
    );
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.out.error.code, 'RESPONSE_INVALID');
    assert.deepEqual(r.out.data, []);
    assert.equal(r.stderr.trim(), 'RESPONSE_INVALID');
  }
});

test('candles preserve exact boundaries across offsets and fractional precision', async (t) => {
  for (const interval of ['1d', '1m']) {
    for (const [before, timestamps] of [
      [
        '2026-11-06T15:00:00.1234Z',
        [
          '2026-11-07T00:00:00.123400+09:00',
          '2026-11-06T10:00:00.12339999999999999999-05:00',
          '2026-11-06T15:00:00.1Z',
        ],
      ],
      [
        '2026-11-06T15:00:00Z',
        [
          '2026-11-06T15:00:00.0000Z',
          '2026-11-06T15:00:00Z',
          '2026-11-06T14:59:59.99999999999999999999Z',
        ],
      ],
      ['1969-12-31T23:59:59.1234Z', ['1969-12-31T23:59:59.1234Z', '1969-12-31T23:59:59.1233Z']],
    ]) {
      const r = await lookup(
        t,
        {
          candles: timestamps.map((timestamp) => ({ ...candle, timestamp })),
          nextBefore: before,
        },
        ['AAPL', interval, `before=${before}`],
      );
      assert.equal(r.status, 2, r.stdout);
      assert.equal(r.stderr, '');
      assert.deepEqual(
        r.out.data.map((row) => row.timestamp),
        timestamps,
      );
      assert.deepEqual(r.out.page, { nextBefore: before });
      assert.deepEqual(r.out.omissions, [{ reason: 'next_page' }]);
      assert.equal(new URLSearchParams(r.requests.at(-1).query).get('before'), before);
    }
  }
});

test('short and empty last pages succeed while missing pagination is partial', async (t) => {
  for (const candles of [[], [candle]]) {
    const r = await lookup(t, { candles, nextBefore: null });
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(r.out.page, { nextBefore: null });
    assert.deepEqual(r.out.omissions, []);
    const missing = await lookup(t, { candles });
    assert.equal(missing.status, 2, missing.stdout);
    assert.deepEqual(missing.out.page, {});
    assert.deepEqual(missing.out.omissions, [{ reason: 'pagination_unknown' }]);
  }
  for (const count of ['1', '200']) {
    const candles = Array.from({ length: Number(count) }, () => candle);
    const r = await lookup(t, { candles, nextBefore: null }, ['AAPL', '1d', `count=${count}`]);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.out.data.length, Number(count));
    assert.equal(r.requests.at(-1).query, `?symbol=AAPL&interval=1d&count=${count}&adjusted=true`);
  }
});

test('invalid candles are omitted and null or missing fields are never filled with estimates', async (t) => {
  const invalid = [
    null,
    [],
    {},
    ...[
      'timestamp',
      'openPrice',
      'highPrice',
      'lowPrice',
      'closePrice',
      'volume',
      'currency',
    ].flatMap((key) => [
      { ...candle, [key]: null },
      { ...candle, [key]: undefined },
      { ...candle, [key]: 0 },
    ]),
    { ...candle, volume: '1e3' },
    { ...candle, openPrice: '1'.repeat(31) },
    { ...candle, timestamp: '2026-02-30T10:00:00Z' },
    { ...candle, timestamp: '2026-11-06T10:00:00' },
    { ...candle, currency: '' },
  ];
  const r = await lookup(t, { candles: [candle, ...invalid], nextBefore: null });
  assert.equal(r.status, 2, r.stdout);
  assert.deepEqual(r.out.data, [{ ...candle, completion: 'unknown', inProgress: 'unknown' }]);
  assert.deepEqual(
    r.out.omissions,
    invalid.map((_, index) => ({ index: index + 1, reason: 'invalid_item' })),
  );
  for (const result of [
    null,
    [],
    {},
    { candles: null },
    { candles: [null], nextBefore: null },
    { candles: [], nextBefore: 'bad' },
    { candles: [], nextBefore: 0 },
    { candles: [candle, candle], nextBefore: null },
  ]) {
    const r = await lookup(t, result, ['AAPL', '1d', 'count=1']);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.out.error.code, 'RESPONSE_INVALID');
    assert.deepEqual(r.out.data, []);
  }
});

test('invalid candle arguments are rejected before authentication', async (t) => {
  for (const args of [
    [],
    ['AAPL'],
    ['AAPL,MSFT', '1d'],
    ['AAPL/', '1d'],
    ['AAPL', '1w'],
    ['AAPL', '1m', 'count=0'],
    ['AAPL', '1d', 'count=201'],
    ['AAPL', '1d', 'count=01'],
    ['AAPL', '1d', 'count=1.5'],
    ['AAPL', '1d', 'count=1e2'],
    ['AAPL', '1d', 'count='],
    ['AAPL', '1d', 'adjusted=1'],
    ['AAPL', '1d', 'before=2026-02-30T00:00:00Z'],
    ['AAPL', '1d', 'before=2026-11-06'],
    ['AAPL', '1d', 'count=1', 'count=2'],
    ['AAPL', '1d', 'before=2026-11-05T00:00:00Z', 'before=2026-11-04T00:00:00Z'],
    ['AAPL', '1d', 'from=2026-11-01'],
    ['AAPL', '1d', 'cursor=X'],
    ['AAPL', '1d', '100'],
    ['AAPL', '1d', 'adjusted=true=false'],
  ]) {
    const r = await lookup(t, { candles: [], nextBefore: null }, args);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.out.error.code, 'INPUT_INVALID');
    assert.deepEqual(r.requests, []);
  }
});

test('both candle intervals use common authentication recovery, limits and safe errors', async (t) => {
  const path = '/api/v1/candles';
  for (const interval of ['1d', '1m']) {
    for (const [step, code, requests] of [
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
      [{ status: 429, headers: { 'Retry-After': '60' }, body: {} }, 'TIMEOUT', 1],
      [{ status: 429, body: {} }, 'RATE_LIMIT', 2],
      [{ hang: true }, 'TIMEOUT', 1],
      [{ interrupt: true }, 'INTERRUPTED', 1],
      [{ body: { result: {}, error: 'private upstream message' } }, 'RESPONSE_INVALID', 1],
    ]) {
      const f = fixture();
      t.after(f.close);
      const r = await runCli(
        f,
        [
          { ...step, path },
          { ...step, path },
        ],
        ['candles', 'AAPL', interval],
      );
      const out = JSON.parse(r.stdout);
      assert.equal(r.status, 1, r.stdout);
      assert.equal(out.error.code, code, r.stdout);
      assert.deepEqual(out.data, []);
      assert.equal(r.requests.filter((row) => row.method === 'GET').length, requests);
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
    const r = await runCli(
      f,
      [
        { path, status: 401, body: { error: { code: 'expired-token' } } },
        { path, status: 503, body: {} },
        { path, body: { result: { candles: [candle], nextBefore: null } } },
      ],
      ['candles', 'AAPL', interval],
    );
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(
      r.requests.map(({ method, path }) => [method, path]),
      [
        ['POST', '/oauth2/token'],
        ['GET', path],
        ['POST', '/oauth2/token'],
        ['GET', path],
        ['GET', path],
      ],
    );
  }
});
