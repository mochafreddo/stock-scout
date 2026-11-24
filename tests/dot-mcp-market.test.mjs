import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { authState, fixture, readRequests } from './toss-cli-helper.mjs';

async function marketServer(t) {
  const f = fixture();
  t.after(f.close);
  const dir = dirname(f.cliTrace);
  const launcher = join(dir, 'launcher');
  const steps = join(dir, 'steps.json');
  let now = Date.parse('2026-11-06T15:00:00Z');
  const clock = join(dir, 'clock');
  writeFileSync(
    launcher,
    '#!/bin/sh\nTEST_STEPS=$(cat "$TEST_STEP_FILE")\nTEST_CLOCK_START=$(cat "$TEST_CLOCK_FILE")\nexport TEST_STEPS TEST_CLOCK_START\nexec "$TEST_NODE" --import "$TEST_MOCK" "$TEST_CLI" "$@"\n',
    { mode: 0o700 },
  );
  writeFileSync(join(f.directory, 'state.json'), JSON.stringify(authState()), { mode: 0o600 });
  const child = spawn(process.execPath, ['scripts/dot-mcp.ts', launcher, '0'], {
    env: {
      PATH: process.env.PATH,
      TEST_NODE: process.execPath,
      TEST_MOCK: new URL('./toss-http-mock.mjs', import.meta.url).href,
      TEST_CLI: fileURLToPath(new URL('../scripts/toss.ts', import.meta.url)),
      TEST_PLATFORM: 'darwin',
      TOSS_STATE_DIR: f.directory,
      TEST_TRACE: f.trace,
      TEST_CLI_TRACE: f.cliTrace,
      TEST_STEP_FILE: steps,
      TEST_CLOCK_FILE: clock,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill();
    await closed;
  });
  const [url] = await Promise.race([
    once(createInterface({ input: child.stdout }), 'line'),
    closed.then(([code]) => {
      throw Error(`server exited ${code}`);
    }),
  ]);
  const call = async (name, args, mocks = []) => {
    now += 5000;
    writeFileSync(clock, String(now), { mode: 0o600 });
    writeFileSync(steps, JSON.stringify(mocks), { mode: 0o600 });
    const reply = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    return reply.json();
  };
  return { call, f };
}

test('a ranked symbol leads to a stock lookup and two daily candle pages', async (t) => {
  const { call, f } = await marketServer(t);
  const symbol = 'RANK.B';
  const ranked = await call('rankings', { type: 'TOP_GAINERS', duration: '1d', count: 1 }, [
    {
      path: '/api/v1/rankings',
      body: {
        result: {
          rankedAt: '2026-11-05T18:00:00Z',
          rankings: [
            {
              rank: 1,
              symbol,
              currency: 'USD',
              tradingVolume: '70',
              tradingAmount: '800',
              price: { lastPrice: '11', basePrice: '10', changeRate: '0.1' },
            },
          ],
        },
      },
    },
  ]);
  assert.equal(ranked.result?.structuredContent.exitCode, 0, JSON.stringify(ranked));
  const candidate = ranked.result.structuredContent.response.data[0];
  const identity = await call('stock', { symbol: candidate.symbol, market: 'NASDAQ', isin: '-' }, [
    {
      path: '/api/v1/stocks',
      body: {
        result: [
          {
            symbol,
            name: 'Example',
            englishName: 'Example',
            market: 'NASDAQ',
            isinCode: '',
            securityType: 'STOCK',
            isCommonShare: true,
            status: 'ACTIVE',
            currency: 'USD',
            sharesOutstanding: '80',
          },
        ],
      },
    },
  ]);
  assert.equal(identity.result.structuredContent.stage, 'query', JSON.stringify(identity));
  const selected = identity.result.structuredContent.response.data[0];
  assert.deepEqual([selected.symbol, selected.market, selected.isinCode], [symbol, 'NASDAQ', null]);
  const options = { symbol: selected.symbol, interval: '1d', count: 1, adjusted: false };
  const boundary = '2026-11-04T00:00:00.0001-05:00';
  const first = (
    await call('candles', options, [
      { path: '/api/v1/candles', body: { result: { candles: [], nextBefore: boundary } } },
    ])
  ).result.structuredContent;
  assert.deepEqual(
    [first.exitCode, first.response.status, first.response.omissions, first.response.page],
    [2, 'partial', [{ reason: 'next_page' }], { nextBefore: boundary }],
  );
  const bar = {
    timestamp: '2026-11-03T00:00:00-05:00',
    openPrice: '11.00',
    highPrice: '12.00',
    lowPrice: '10.30',
    closePrice: '11.50',
    volume: '90',
    currency: 'USD',
  };
  const next = (
    await call('candles', { ...options, before: first.response.page.nextBefore }, [
      { path: '/api/v1/candles', body: { result: { candles: [bar], nextBefore: null } } },
    ])
  ).result.structuredContent;
  assert.deepEqual(
    [next.exitCode, next.response.status, next.response.page],
    [0, 'success', { nextBefore: null }],
  );
  assert.deepEqual(next.response.data, [{ ...bar, completion: 'unknown', inProgress: 'unknown' }]);
  assert.deepEqual(
    readRequests(f.cliTrace).filter(([name]) => name !== 'readiness'),
    [
      ['rankings', 'TOP_GAINERS', '1d', '1'],
      ['stock', symbol, 'NASDAQ', '-'],
      ['candles', symbol, '1d', 'count=1', 'adjusted=false'],
      ['candles', symbol, '1d', 'count=1', 'adjusted=false', `before=${boundary}`],
    ],
  );
});

test('sessions preserves the regular opening time and missing sessions', async (t) => {
  const { call } = await marketServer(t);
  const date = '2026-11-05';
  const regularMarket = {
    startTime: '2026-11-05T23:30:00+09:00',
    endTime: '2026-11-06T06:00:00+09:00',
  };
  const reply = await call('sessions', { date }, [
    { path: '/api/v1/market-calendar/US', body: { result: { today: { date, regularMarket } } } },
  ]);
  const { stage, exitCode, response } = reply.result.structuredContent;
  assert.deepEqual(
    [stage, exitCode, response.status, response.data[0].today.regularMarket.startTime],
    ['query', 2, 'partial', regularMarket.startTime],
  );
  assert.deepEqual(response.data[0].today, { date, regularMarket });
  assert.ok(
    response.omissions.some(
      ({ field, reason }) => field === 'today.preMarket' && reason === 'session_unknown',
    ),
  );
});

test('market tools reject unknown commands, invalid options and selectors before starting the CLI', async (t) => {
  const { call, f } = await marketServer(t);
  for (const [name, args] of [
    ['candles-batch', { symbols: ['DEMO'] }],
    ['rankings', { type: 'TOP_GAINERS', duration: 'realtime' }],
    ['rankings', { type: 'TOP_LOSERS', duration: '1d', count: 101 }],
    ['rankings', { type: 'TOP_GAINERS', duration: '1d', count: '1' }],
    ['stock', { symbol: 'DEMO', isin: '-' }],
    ['stock', { symbol: 'DEMO', market: '--help' }],
    ['stock', { symbol: 'DEMO', market: 'NASDAQ', isin: 'bad' }],
    ['candles', { symbol: '-other' }],
    ['candles', { symbol: 'DEMO', interval: '1m' }],
    ['candles', { symbol: 'DEMO', count: 201 }],
    ['candles', { symbol: 'DEMO', adjusted: 'false' }],
    ['candles', { symbol: 'DEMO', before: '2026-02-29T00:00:00Z' }],
    ['candles', { symbol: 'DEMO', date: '2026-11-05', before: '2026-11-05T00:00:00Z' }],
    ['sessions', { date: '2026-02-29' }],
    ['prices', { symbols: ['DEMO'], market: 'NASDAQ' }],
  ])
    assert.equal((await call(name, args)).error?.code, -32602, JSON.stringify([name, args]));
  assert.deepEqual(readRequests(f.cliTrace), []);
});
