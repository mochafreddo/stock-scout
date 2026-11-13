import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture, readRequests, runCli } from './toss-cli-helper.mjs';

const candle = {
  timestamp: '2026-11-05T14:00:00+09:00',
  openPrice: '185.7000',
  highPrice: '190.1250',
  lowPrice: '180.0000',
  closePrice: '189.0000',
  volume: '0',
  currency: 'USD',
};
const page = (candles = [candle], nextBefore = null) => ({
  path: '/api/v1/candles',
  body: { result: { candles, nextBefore } },
});
const stock = (symbol, market = 'NASDAQ') => ({
  symbol,
  market,
  name: '합성 주식',
  englishName: 'Synthetic stock',
  isinCode: 'US0000000002',
  securityType: 'STOCK',
  isCommonShare: true,
  status: 'ACTIVE',
  currency: 'USD',
  sharesOutstanding: '100',
});
const identity = (symbol, market) => ({
  path: '/api/v1/stocks',
  body: { result: [stock(symbol, market)] },
});

test('batch summarizes only returned valid candles without adding market or page requests', async (t) => {
  const f = fixture();
  t.after(f.close);
  const older = { ...candle, timestamp: '2026-11-04T14:00:00+09:00' };
  const r = await runCli(
    f,
    [page([candle, null, older], older.timestamp)],
    ['candles-batch', 'AAPL', 'count=4'],
  );
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 2, r.stdout);
  assert.equal(out.status, 'partial');
  assert.equal(r.stderr, '');
  assert.deepEqual(out.data[0].summary, {
    returnedCount: 2,
    latestTimestamp: candle.timestamp,
    latestTradeDate: null,
    tradeDateUnavailableReason: 'market_timezone_unconfirmed',
  });
  assert.deepEqual(
    out.data[0].data,
    [candle, older].map((row) => ({
      ...row,
      completion: 'unknown',
      inProgress: 'unknown',
    })),
  );
  assert.deepEqual(out.data[0].omissions, [
    { index: 1, reason: 'invalid_item' },
    { reason: 'next_page' },
  ]);
  assert.deepEqual(out.data[0].page, { nextBefore: older.timestamp });
  assert.deepEqual(
    r.requests.map(({ path }) => path),
    ['/oauth2/token', '/api/v1/candles'],
  );
});

test('batch derives the latest returned trade date from confirmed New York evidence across DST', async (t) => {
  for (const [date, timestamp, tradeDate] of [
    ['2026-03-09', '2026-03-08T04:30:00Z', '2026-03-07'],
    ['2026-03-10', '2026-03-09T03:30:00Z', '2026-03-08'],
    ['2026-11-02', '2026-11-01T03:30:00Z', '2026-10-31'],
    ['2026-11-03', '2026-11-02T04:30:00Z', '2026-11-01'],
    ['2026-11-06', '2026-11-05T14:00:00+09:00', '2026-11-05'],
  ]) {
    const f = fixture();
    t.after(f.close);
    const r = await runCli(
      f,
      [identity('AAPL'), page([{ ...candle, timestamp }])],
      ['candles-batch', 'AAPL', `date=${date}`],
    );
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.stderr, '');
    assert.deepEqual(JSON.parse(r.stdout).data[0].summary, {
      returnedCount: 1,
      latestTimestamp: timestamp,
      latestTradeDate: tradeDate,
      tradeDateUnavailableReason: null,
    });
    assert.deepEqual(
      r.requests.map(({ path }) => path),
      ['/oauth2/token', '/api/v1/stocks', '/api/v1/candles'],
    );
  }
});

test('batch distinguishes empty pages from failed and unqueried summaries', async (t) => {
  const f = fixture();
  t.after(f.close);
  const r = await runCli(
    f,
    [
      page([]),
      page([], candle.timestamp),
      { path: '/api/v1/candles', body: { result: { candles: [] } } },
      { path: '/api/v1/candles', status: 403, body: {} },
    ],
    ['candles-batch', 'EMPTY,MORE,UNKNOWN,BLOCKED,LATER'],
  );
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 2, r.stdout);
  assert.equal(out.status, 'partial');
  assert.equal(r.stderr, 'PERMISSION_DENIED\n');
  assert.deepEqual(
    out.data.map(({ symbol }) => symbol),
    ['EMPTY', 'MORE', 'UNKNOWN', 'BLOCKED', 'LATER'],
  );
  assert.deepEqual(
    out.data.map(({ status }) => status),
    ['success', 'partial', 'partial', 'error', 'not_queried'],
  );
  assert.deepEqual(
    out.data.map(({ summary }) => summary),
    [
      ...Array.from({ length: 3 }, () => ({
        returnedCount: 0,
        latestTimestamp: null,
        latestTradeDate: null,
        tradeDateUnavailableReason: null,
      })),
      ...Array.from({ length: 2 }, () => ({
        returnedCount: null,
        latestTimestamp: null,
        latestTradeDate: null,
        tradeDateUnavailableReason: null,
      })),
    ],
  );
  assert.deepEqual(out.data[1].page, { nextBefore: candle.timestamp });
  assert.deepEqual(out.data[1].omissions, [{ reason: 'next_page' }]);
  assert.deepEqual(out.data[2].page, {});
  assert.deepEqual(out.data[2].omissions, [{ reason: 'pagination_unknown' }]);
  assert.equal(out.data[3].error.code, 'PERMISSION_DENIED');
  assert.equal(out.data[4].reason, 'PERMISSION_DENIED');
  assert.equal(r.requests.length, 5);
});

test('batch preserves timestamp and unknown trade date with an explicit time bound', async (t) => {
  const f = fixture();
  t.after(f.close);
  const r = await runCli(
    f,
    [{ path: '/api/v1/candles', body: { result: { candles: [candle, null] } } }],
    ['candles-batch', 'AAPL', `before=${candle.timestamp}`],
  );
  const row = JSON.parse(r.stdout).data[0];
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.stderr, '');
  assert.deepEqual(row.summary, {
    returnedCount: 1,
    latestTimestamp: candle.timestamp,
    latestTradeDate: null,
    tradeDateUnavailableReason: 'market_timezone_unconfirmed',
  });
  assert.deepEqual(row.omissions, [
    { index: 1, reason: 'invalid_item' },
    { reason: 'pagination_unknown' },
  ]);
  assert.equal(r.requests.length, 2);
});

test('batch records the current symbol when the forty-call limit is reached between market and candle requests', async (t) => {
  const f = fixture();
  t.after(f.close);
  const symbols = Array.from({ length: 20 }, (_, i) => `S${i}`);
  const r = await runCli(
    f,
    symbols.flatMap((symbol) => [identity(symbol), page([])]),
    ['candles-batch', symbols.join(','), 'date=2026-11-05'],
  );
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 2, r.stdout);
  assert.ok(out.data.slice(0, 19).every((row) => row.status === 'success'));
  assert.equal(out.data[19].status, 'error');
  assert.equal(out.data[19].error.code, 'REQUEST_LIMIT');
  assert.equal(r.requests.length, 40);
  assert.equal(r.requests.at(-1).path, '/api/v1/stocks');
  assert.equal(r.requests.at(-1).query, '?symbols=S19');
  assert.equal(r.stderr, 'REQUEST_LIMIT\n');
});

test('batch stops a permission failure even when sensitive provider error metadata must be masked', async (t) => {
  const f = fixture();
  t.after(f.close);
  const r = await runCli(
    f,
    [
      page([]),
      {
        path: '/api/v1/candles',
        status: 403,
        body: {
          error: {
            code: 'synthetic-secret',
            requestId: 'synthetic-token',
            message: 'private body',
          },
        },
      },
      page(),
    ],
    ['candles-batch', 'FIRST,BLOCKED,LATER'],
  );
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 2, r.stdout);
  assert.deepEqual(
    out.data.map(({ status }) => status),
    ['success', 'error', 'not_queried'],
  );
  assert.deepEqual(out.data[1].error, { code: 'SENSITIVE_OUTPUT' });
  assert.equal(out.data[2].reason, 'SENSITIVE_OUTPUT');
  assert.equal(r.requests.length, 3);
  assert.equal(r.stderr, 'SENSITIVE_OUTPUT\n');
  assert.doesNotMatch(r.stdout + r.stderr, /private body|synthetic-(secret|token|client)/);
});

test('batch uses both execution clocks and reports a safe diagnostic when no symbol can start', async (t) => {
  for (const TEST_CLOCK_JUMP of ['wall', 'monotonic']) {
    const f = fixture();
    t.after(f.close);
    const r = await runCli(f, [], ['candles-batch', 'FIRST,LATER'], {
      TEST_CLOCK_JUMP,
      TEST_CLOCK_JUMP_MS: '120001',
      TEST_CLOCK_JUMP_AT: '2',
    });
    const out = JSON.parse(r.stdout);
    assert.equal(r.status, 1, r.stdout);
    assert.ok(out.data.every((row) => row.status === 'not_queried' && row.reason === 'TIMEOUT'));
    assert.equal(out.data.length, 2);
    assert.equal(r.stderr, 'TIMEOUT\n');
    assert.deepEqual(r.requests, []);
  }
});

test('help discovers the explicit daily batch limits without authentication', async (t) => {
  const f = fixture();
  t.after(f.close);
  const r = await runCli(f, [], ['--help']);
  const command = JSON.parse(r.stdout).data.commands.find(({ name }) => name === 'candles-batch');
  assert.equal(command.maxSymbols, 20);
  assert.equal(command.interval, '1d');
  assert.equal(command.defaultCount, 100);
  assert.equal(command.maxCount, 200);
  assert.deepEqual(command.executionLimits, {
    maxSeconds: 120,
    maxHttpTransmissions: 40,
    maxHttpSeconds: 15,
  });
  assert.deepEqual(r.requests, []);
  assert.equal(r.status, 0, r.stdout);
});

test('batch waits for each page before querying the next symbol and preserves requested spelling', async (t) => {
  const f = fixture();
  t.after(f.close);
  const gate = join(f.directory, 'gate');
  const pending = runCli(
    f,
    [{ ...page([]), gate: true }, page([])],
    ['candles-batch', 'first,BRK.B'],
    { TEST_REAL_CLOCK: '1', TEST_GATE: gate },
  );
  const deadline = Date.now() + 4000;
  while (!existsSync(`${gate}.ready`) && Date.now() < deadline) await sleep(10);
  assert.ok(existsSync(`${gate}.ready`));
  await sleep(50);
  assert.equal(readRequests(f.trace).length, 2);
  writeFileSync(gate, '', { mode: 0o600 });
  const r = await pending;
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(
    JSON.parse(r.stdout).data.map(({ symbol }) => symbol),
    ['first', 'BRK.B'],
  );
  assert.deepEqual(
    r.requests.filter(({ method }) => method === 'GET').map(({ query }) => query),
    [
      '?symbol=first&interval=1d&count=100&adjusted=true',
      '?symbol=BRK.B&interval=1d&count=100&adjusted=true',
    ],
  );
  assert.ok(r.requests[2].at - r.requests[1].at >= 1000);
});

test('batch includes authentication lock waits in its deadline and handles a signal while waiting', async (t) => {
  for (const name of ['client.lock', 'issuance.lock']) {
    const f = fixture();
    t.after(f.close);
    mkdirSync(join(f.directory, name), { mode: 0o700 });
    const r = await runCli(f, [], ['candles-batch', 'FIRST,LATER']);
    const out = JSON.parse(r.stdout);
    assert.equal(r.status, 1, r.stdout);
    assert.deepEqual(
      out.data.map(({ status }) => status),
      ['error', 'not_queried'],
    );
    assert.equal(out.data[0].error.code, 'TIMEOUT');
    assert.equal(out.data[1].reason, 'TIMEOUT');
    assert.equal(out.retrievedAt, '2026-11-06T15:02:00.000Z');
    assert.deepEqual(r.requests, []);
    assert.equal(r.stderr, 'TIMEOUT\n');
  }
  const f = fixture();
  t.after(f.close);
  mkdirSync(join(f.directory, 'client.lock'), { mode: 0o700 });
  const pending = runCli(f, [], ['candles-batch', 'FIRST,LATER'], { TEST_REAL_CLOCK: '1' });
  const deadline = Date.now() + 4000;
  while (!existsSync(join(f.directory, 'issuance.lock')) && Date.now() < deadline) await sleep(10);
  assert.ok(existsSync(join(f.directory, 'issuance.lock')));
  pending.child.kill('SIGINT');
  const r = await pending;
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.signal, null);
  assert.deepEqual(
    out.data.map(({ status }) => status),
    ['error', 'not_queried'],
  );
  assert.equal(out.data[0].error.code, 'INTERRUPTED');
  assert.equal(out.data[1].reason, 'INTERRUPTED');
  assert.equal(existsSync(join(f.directory, 'issuance.lock')), false);
  assert.deepEqual(r.requests, []);
});

test('batch retains per-query retry limits and applies stricter provider waits to later symbols', async (t) => {
  for (const [failures, code, gap] of [
    [
      [
        { status: 429, headers: { 'Retry-After': '3', 'X-RateLimit-Reset': '4' }, body: {} },
        { status: 429, headers: { 'Retry-After': '5' }, body: {} },
      ],
      'RATE_LIMIT',
      5000,
    ],
    [[{ transport: true }, { transport: true }], 'NETWORK_ERROR', 1000],
    [
      [
        { status: 503, body: {} },
        { status: 503, body: {} },
      ],
      'UPSTREAM_ERROR',
      1000,
    ],
  ]) {
    const f = fixture();
    t.after(f.close);
    const r = await runCli(
      f,
      [...failures.map((step) => ({ ...step, path: '/api/v1/candles' })), page([])],
      ['candles-batch', 'FAILED,GOOD'],
    );
    const out = JSON.parse(r.stdout);
    assert.equal(r.status, 2, r.stdout);
    assert.deepEqual(
      out.data.map(({ status }) => status),
      ['error', 'success'],
    );
    assert.equal(out.data[0].error.code, code);
    assert.equal(r.requests.length, 4);
    assert.ok(r.requests[3].at - r.requests[2].at >= gap);
    if (code === 'RATE_LIMIT') assert.ok(r.requests[2].at - r.requests[1].at >= 4000);
    assert.equal(r.stderr, `${code}\n`);
  }
  const f = fixture();
  t.after(f.close);
  const r = await runCli(
    f,
    [
      { path: '/api/v1/stocks', status: 401, body: { error: { code: 'expired-token' } } },
      { path: '/api/v1/stocks', status: 503, body: {} },
      identity('AAPL'),
      { path: '/api/v1/candles', status: 429, headers: { 'Retry-After': '3' }, body: {} },
      page([]),
      identity('MSFT'),
      page([]),
    ],
    ['candles-batch', 'AAPL,MSFT', 'date=2026-11-05'],
  );
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.requests.length, 9);
  assert.equal(r.requests.filter(({ method }) => method === 'POST').length, 2);
  assert.ok(r.requests[6].at - r.requests[5].at >= 3000);
  for (let i = 1; i < r.requests.length; i++)
    assert.ok(r.requests[i].at - r.requests[i - 1].at >= 1000);
});

test('batch verifies every date-selected market, preserves page boundaries and continues after unconfirmed identities', async (t) => {
  const f = fixture();
  t.after(f.close);
  const nextBefore = '2026-11-04T14:00:00.123+09:00';
  const r = await runCli(
    f,
    [
      identity('AAPL'),
      page([], nextBefore),
      identity('KR', 'KRX'),
      identity('UNKNOWN', 'FUTURE'),
      {
        path: '/api/v1/stocks',
        body: { result: [stock('AMBIG'), { ...stock('AMBIG', 'NYSE'), isinCode: 'US0000000003' }] },
      },
      { path: '/api/v1/stocks', body: { result: [stock('BAD'), {}] } },
      { path: '/api/v1/stocks', body: { result: [] } },
      identity('MSFT'),
      { path: '/api/v1/candles', body: { result: { candles: [] } } },
    ],
    [
      'candles-batch',
      'AAPL,KR,UNKNOWN,AMBIG,BAD,EMPTY,MSFT',
      'date=2026-11-05',
      'count=1',
      'adjusted=false',
    ],
  );
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 2, r.stdout);
  assert.deepEqual(
    out.data.map(({ status }) => status),
    ['partial', 'error', 'error', 'error', 'error', 'error', 'partial'],
  );
  assert.deepEqual(
    out.data.slice(1, 6).map(({ error }) => error.code),
    ['UNSUPPORTED', 'UNSUPPORTED', 'IDENTITY_AMBIGUOUS', 'RESPONSE_INVALID', 'NOT_FOUND'],
  );
  assert.equal(out.data[3].error.choices.length, 2);
  assert.equal(out.data[0].source.market, 'NASDAQ');
  assert.equal(out.data[0].source.date, '2026-11-05');
  assert.equal(out.data[0].source.dateTimeZone, 'America/New_York');
  assert.deepEqual(out.data[0].page, { nextBefore });
  assert.deepEqual(out.data[6].page, {});
  assert.deepEqual(out.data[6].omissions, [{ reason: 'pagination_unknown' }]);
  assert.equal(r.requests.length, 10);
  assert.deepEqual(
    r.requests.filter(({ path }) => path === '/api/v1/candles').map(({ query }) => query),
    [
      '?symbol=AAPL&interval=1d&count=1&adjusted=false&before=2026-11-05T05%3A00%3A00.000Z',
      '?symbol=MSFT&interval=1d&count=1&adjusted=false&before=2026-11-05T05%3A00%3A00.000Z',
    ],
  );
  const follow = fixture();
  t.after(follow.close);
  const next = await runCli(
    follow,
    [page([])],
    ['candles', 'AAPL', '1d', 'count=1', 'adjusted=false', `before=${out.data[0].page.nextBefore}`],
  );
  assert.equal(next.status, 0, next.stdout);
  assert.equal(
    next.requests.at(-1).query,
    '?symbol=AAPL&interval=1d&count=1&adjusted=false&before=2026-11-04T14%3A00%3A00.123%2B09%3A00',
  );
  assert.equal(next.requests.length, 2);
});

test('batch shares a 120-second deadline across requests and truncates the last HTTP timeout to remaining time', async (t) => {
  const f = fixture();
  t.after(f.close);
  const symbols = Array.from({ length: 20 }, (_, i) => `S${i}`);
  const r = await runCli(
    f,
    [page([]), ...symbols.slice(1).map(() => ({ path: '/api/v1/candles', hang: true }))],
    ['candles-batch', symbols.join(',')],
  );
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 2, r.stdout);
  assert.equal(out.data[0].status, 'success');
  assert.ok(
    out.data.slice(1, 9).every((row) => row.status === 'error' && row.error.code === 'TIMEOUT'),
  );
  assert.ok(
    out.data.slice(9).every((row) => row.status === 'not_queried' && row.reason === 'TIMEOUT'),
  );
  assert.equal(r.requests.length, 10);
  assert.equal(Date.parse(out.retrievedAt) - r.requests[0].at, 120000);
  assert.equal(Date.parse(out.data[8].retrievedAt) - r.requests.at(-1).at, 13000);
});

test('batch stops after token issuance or recovery fails and retains nested errors when nothing is usable', async (t) => {
  for (const auth of [
    { transport: true },
    { status: 503, body: {} },
    { status: 400, body: {} },
    { status: 429, headers: { 'Retry-After': '3' }, body: {} },
    { body: { access_token: 'synthetic-token', token_type: 'Bearer', expires_in: 'bad' } },
  ]) {
    const f = fixture();
    t.after(f.close);
    const r = await runCli(f, [page()], ['candles-batch', 'FIRST,LATER'], {
      TEST_AUTH_STEPS: JSON.stringify([auth]),
    });
    const out = JSON.parse(r.stdout);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(out.status, 'error');
    assert.deepEqual(
      out.data.map(({ status }) => status),
      ['error', 'not_queried'],
    );
    assert.equal(out.data[1].reason, out.data[0].error.code);
    assert.equal(r.requests.length, 1);
    assert.equal(r.stderr, `${out.data[0].error.code}\n`);
    assert.doesNotMatch(r.stdout + r.stderr, /synthetic-(secret|token|client)/);
  }
  const f = fixture();
  t.after(f.close);
  const r = await runCli(
    f,
    [
      { path: '/api/v1/candles', status: 404, body: {} },
      { path: '/api/v1/candles', body: { result: { candles: [null], nextBefore: null } } },
    ],
    ['candles-batch', 'MISSING,BAD'],
  );
  assert.equal(r.status, 1, r.stdout);
  assert.equal(JSON.parse(r.stdout).status, 'error');
  assert.deepEqual(
    JSON.parse(r.stdout).data.map(({ summary }) => summary),
    [
      {
        returnedCount: null,
        latestTimestamp: null,
        latestTradeDate: null,
        tradeDateUnavailableReason: null,
      },
      {
        returnedCount: null,
        latestTimestamp: null,
        latestTradeDate: null,
        tradeDateUnavailableReason: null,
      },
    ],
  );
  assert.deepEqual(
    JSON.parse(r.stdout).data.map(({ error }) => error.code),
    ['NOT_FOUND', 'RESPONSE_INVALID'],
  );
  assert.equal(r.requests.length, 3);
});

test('batch continues after an individual fifteen-second timeout but stops when a required wait cannot fit', async (t) => {
  const f = fixture();
  t.after(f.close);
  const r = await runCli(
    f,
    [
      page([]),
      { path: '/api/v1/candles', hang: true },
      page([]),
      { path: '/api/v1/candles', status: 429, headers: { 'Retry-After': '120' }, body: {} },
      page(),
    ],
    ['candles-batch', 'FIRST,SLOW,GOOD,RATE,LATER'],
  );
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 2, r.stdout);
  assert.deepEqual(
    out.data.map(({ status }) => status),
    ['success', 'error', 'success', 'error', 'not_queried'],
  );
  assert.equal(out.data[1].error.code, 'TIMEOUT');
  assert.equal(Date.parse(out.data[1].retrievedAt) - r.requests[2].at, 15000);
  assert.equal(out.data[3].error.code, 'TIMEOUT');
  assert.equal(out.data[4].reason, 'TIMEOUT');
  assert.equal(r.requests.length, 5);
  assert.equal(r.stderr, 'TIMEOUT\nTIMEOUT\n');
});

test('batch forty-transmission budget includes market confirmation, authentication and retries without resetting per symbol', async (t) => {
  const f = fixture();
  t.after(f.close);
  const symbols = Array.from({ length: 20 }, (_, i) => `S${i}`);
  const steps = symbols.flatMap((symbol, i) => [
    identity(symbol),
    ...(i === 0 ? [{ path: '/api/v1/candles', status: 503, body: {} }] : []),
    page(),
  ]);
  const r = await runCli(f, steps, ['candles-batch', symbols.join(','), 'date=2026-11-05']);
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 2, r.stdout);
  assert.equal(out.status, 'partial');
  assert.equal(r.requests.length, 40);
  assert.ok(out.data.slice(0, 19).every((row) => row.status === 'success'));
  assert.equal(out.data[19].symbol, 'S19');
  assert.equal(out.data[19].status, 'not_queried');
  assert.equal(out.data[19].reason, 'REQUEST_LIMIT');
  assert.equal(
    r.requests.at(-1).query,
    '?symbol=S18&interval=1d&count=100&adjusted=true&before=2026-11-05T05%3A00%3A00.000Z',
  );
  assert.equal(r.stderr, '');
});

test('batch preserves completed pages when a handled signal interrupts the current request', async (t) => {
  const f = fixture();
  t.after(f.close);
  const r = await runCli(
    f,
    [page([], '2026-11-04T14:00:00+09:00'), { path: '/api/v1/candles', interrupt: true }, page()],
    ['candles-batch', 'FIRST,CURRENT,LATER'],
  );
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.signal, null);
  assert.equal(out.status, 'partial');
  assert.deepEqual(
    out.data.map(({ status }) => status),
    ['partial', 'error', 'not_queried'],
  );
  assert.deepEqual(out.data[0].page, { nextBefore: '2026-11-04T14:00:00+09:00' });
  assert.equal(out.data[1].error.code, 'INTERRUPTED');
  assert.equal(out.data[2].reason, 'INTERRUPTED');
  assert.equal(r.stderr, 'INTERRUPTED\n');
  assert.equal(r.requests.length, 3);
  assert.equal(r.stdout.trim().split('\n').length, 1);
});

test('batch stops shared access failures and distinguishes the failed symbol from unqueried symbols', async (t) => {
  for (const [failure, code, extraSteps = []] of [
    [
      { status: 403, body: { error: { code: 'ip-not-allowed', message: 'private body' } } },
      'PERMISSION_DENIED',
    ],
    [{ status: 401, body: { error: { code: 'invalid-token' } } }, 'AUTH_FAILED'],
    [
      { status: 401, body: { error: { code: 'expired-token' } } },
      'AUTH_FAILED',
      [{ path: '/api/v1/candles', status: 401, body: { error: { code: 'expired-token' } } }],
    ],
  ]) {
    const f = fixture();
    t.after(f.close);
    const r = await runCli(
      f,
      [page([]), { path: '/api/v1/candles', ...failure }, ...extraSteps, page()],
      ['candles-batch', 'EMPTY,BLOCKED,LATER'],
    );
    const out = JSON.parse(r.stdout);
    assert.equal(r.status, 2, r.stdout);
    assert.equal(out.status, 'partial');
    assert.deepEqual(
      out.data.map(({ status }) => status),
      ['success', 'error', 'not_queried'],
    );
    assert.equal(out.data[1].error.code, code);
    assert.equal(out.data[2].reason, code);
    assert.equal(r.requests.filter(({ method }) => method === 'GET').length, 2 + extraSteps.length);
    assert.equal(r.stderr, `${code}\n`);
    assert.doesNotMatch(r.stdout + r.stderr, /private body|synthetic-(secret|token|client)/);
  }
});

test('date-selected batch stops shared access failures at either request and preserves safe reasons', async (t) => {
  for (const path of ['/api/v1/stocks', '/api/v1/candles']) {
    for (const [status, providerCode, code] of [
      [401, 'invalid-token', 'AUTH_FAILED'],
      [403, 'ip-not-allowed', 'PERMISSION_DENIED'],
      [403, 'synthetic-secret', 'SENSITIVE_OUTPUT'],
    ]) {
      await t.test(`${path} ${code}`, async (t) => {
        const f = fixture();
        t.after(f.close);
        const steps = [identity('FIRST'), page([])];
        if (path === '/api/v1/candles') steps.push(identity('BLOCKED'));
        steps.push({ path, status, body: { error: { code: providerCode } } });
        const r = await runCli(f, steps, [
          'candles-batch',
          'FIRST,BLOCKED,LATER',
          'date=2026-11-05',
        ]);
        const out = JSON.parse(r.stdout);
        assert.equal(r.status, 2, r.stdout);
        assert.equal(out.status, 'partial');
        assert.deepEqual(
          out.data.map(({ status }) => status),
          ['success', 'error', 'not_queried'],
        );
        assert.deepEqual(out.data[0].data, []);
        assert.equal(out.data[1].error.code, code);
        assert.equal(out.data[2].reason, code);
        assert.deepEqual(
          r.requests.filter(({ method }) => method === 'GET').map(({ path }) => path),
          steps.map(({ path }) => path),
        );
        assert.equal(r.stderr, `${code}\n`);
        assert.doesNotMatch(r.stdout + r.stderr, /synthetic-(secret|token|client)/);
      });
    }
  }
});

test('batch preserves valid empty and partial pages, records individual failures and continues', async (t) => {
  const f = fixture();
  t.after(f.close);
  const nextBefore = '2026-11-04T14:00:00.123+09:00';
  const r = await runCli(
    f,
    [
      page([]),
      page([], nextBefore),
      page([candle, null]),
      { path: '/api/v1/candles', body: { result: { candles: [null], nextBefore: null } } },
      {
        path: '/api/v1/candles',
        status: 404,
        body: {
          error: { code: 'stock-not-found', requestId: 'SAFE_404', message: 'private body' },
        },
      },
      page(),
    ],
    ['candles-batch', 'EMPTY,MORE,MIXED,BAD,MISSING,GOOD'],
  );
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 2, r.stdout);
  assert.equal(out.status, 'partial');
  assert.deepEqual(
    out.data.map(({ status }) => status),
    ['success', 'partial', 'partial', 'error', 'error', 'success'],
  );
  assert.deepEqual(out.data[0].data, []);
  assert.deepEqual(out.data[1].data, []);
  assert.deepEqual(out.data[1].page, { nextBefore });
  assert.deepEqual(out.data[1].omissions, [{ reason: 'next_page' }]);
  assert.deepEqual(out.data[2].omissions, [{ index: 1, reason: 'invalid_item' }]);
  assert.equal(out.data[2].data.length, 1);
  assert.equal(out.data[3].error.code, 'RESPONSE_INVALID');
  assert.deepEqual(out.data[4].error, {
    code: 'NOT_FOUND',
    providerCode: 'stock-not-found',
    requestId: 'SAFE_404',
  });
  assert.equal(r.stderr, 'RESPONSE_INVALID\nNOT_FOUND\n');
  assert.equal(r.requests.length, 7);
  assert.doesNotMatch(r.stdout + r.stderr, /private body|synthetic-(secret|token|client)/);
});

test('batch validates all symbols and shared daily options before authentication and accepts twenty symbols', async (t) => {
  const symbols = Array.from({ length: 20 }, (_, i) => `S${i}`);
  for (const args of [
    [],
    ['', 'count=1'],
    ['AAPL,'],
    ['AAPL,,MSFT'],
    ['AAPL/MSFT'],
    ['AAPL,AAPL'],
    ['AAPL,aapl'],
    [[...symbols, 'EXTRA'].join(',')],
    ['AAPL', '1m'],
    ['AAPL', 'count=201'],
    ['AAPL', 'count=1', 'count=2'],
    ['AAPL', 'adjusted=1'],
    ['AAPL', 'date=2026-02-30'],
    ['AAPL', 'date=2026-11-05', 'before=2026-11-05T05:00:00Z'],
  ]) {
    const f = fixture();
    t.after(f.close);
    const r = await runCli(f, [], ['candles-batch', ...args]);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(JSON.parse(r.stdout).error.code, 'INPUT_INVALID');
    assert.equal(r.stderr.trim(), 'INPUT_INVALID');
    assert.deepEqual(r.requests, []);
  }
  const f = fixture();
  t.after(f.close);
  const r = await runCli(
    f,
    symbols.map(() => page([])),
    ['candles-batch', symbols.join(','), 'count=1', 'adjusted=false'],
  );
  assert.equal(r.status, 0, r.stdout);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(
    out.data.map(({ symbol }) => symbol),
    symbols,
  );
  assert.ok(out.data.every((row) => row.status === 'success' && row.data.length === 0));
  assert.equal(r.requests.length, 21);
  assert.equal(r.requests.at(-1).query, '?symbol=S19&interval=1d&count=1&adjusted=false');
});

test('batch validates every input before reading authentication storage (characterization)', async (t) => {
  const f = fixture();
  t.after(f.close);
  const env = { TOSS_STATE_DIR: join(f.directory, 'missing') };
  for (const args of [[], ['AAPL,aapl'], ['AAPL,INVALID/'], ['AAPL', 'count=201']]) {
    const r = await runCli(f, [], ['candles-batch', ...args], env);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(JSON.parse(r.stdout).error.code, 'INPUT_INVALID');
    assert.equal(r.stderr, 'INPUT_INVALID\n');
    assert.deepEqual(r.requests, []);
  }
  const valid = await runCli(f, [], ['candles-batch', 'AAPL'], env);
  assert.equal(valid.status, 1, valid.stdout);
  assert.equal(JSON.parse(valid.stdout).error.code, 'AUTH_STORAGE');
  assert.equal(valid.stderr, 'AUTH_STORAGE\n');
  assert.deepEqual(valid.requests, []);
});

test('daily batch returns twelve ordered single pages under one shared execution', async (t) => {
  const f = fixture();
  t.after(f.close);
  const symbols = [
    'AAPL',
    'MSFT',
    'GOOG',
    'AMZN',
    'META',
    'NVDA',
    'TSLA',
    'BRK.B',
    'JPM',
    'V',
    'MA',
    'XOM',
  ];
  const r = await runCli(
    f,
    symbols.map(() => page()),
    ['candles-batch', symbols.join(',')],
  );
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.equal(out.version, 1);
  assert.equal(out.status, 'success');
  assert.deepEqual(
    out.data.map(({ symbol }) => symbol),
    symbols,
  );
  assert.equal(out.data.length, 12);
  for (const row of out.data) {
    assert.equal(row.status, 'success');
    assert.deepEqual(row.data, [{ ...candle, completion: 'unknown', inProgress: 'unknown' }]);
    assert.deepEqual(row.page, { nextBefore: null });
    assert.deepEqual(row.omissions, []);
    assert.equal(row.source.symbol, row.symbol);
    assert.equal(row.source.provider, 'tossinvest');
    assert.equal(row.source.endpoint, '/api/v1/candles');
    assert.equal(row.source.interval, '1d');
    assert.equal(row.source.count, 100);
    assert.equal(row.source.adjusted, true);
    assert.ok(Number.isFinite(Date.parse(row.retrievedAt)));
  }
  assert.equal(r.requests.length, 13);
  assert.deepEqual(
    r.requests.filter(({ method }) => method === 'GET').map(({ path, query }) => [path, query]),
    symbols.map((symbol) => [
      '/api/v1/candles',
      `?symbol=${symbol}&interval=1d&count=100&adjusted=true`,
    ]),
  );
  for (let i = 1; i < r.requests.length; i++)
    assert.ok(r.requests[i].at - r.requests[i - 1].at >= 1000);
  assert.doesNotMatch(r.stdout + r.stderr, /synthetic-(secret|token|client)/);
});
