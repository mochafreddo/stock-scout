import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli } from './toss-cli-helper.mjs';

const regularMarket = {
  startTime: '2026-11-06T23:30:00+09:00',
  endTime: '2026-11-07T06:00:00+09:00',
};
function input(side = 'BUY') {
  return {
    symbol: 'DEMO',
    market: 'US',
    side,
    orderType: 'MARKET',
    ...(side === 'BUY' ? { amount: '25.50' } : { quantity: '0.1250' }),
    currency: 'USD',
    tradeDate: '2026-11-06',
    session: 'regularMarket',
    expiresAt: '2026-11-06T09:30:00-05:00',
    sessions: {
      version: 1,
      status: 'success',
      data: [{ today: { date: '2026-11-06', regularMarket: { ...regularMarket } } }],
      source: {
        provider: 'tossinvest',
        endpoint: '/api/v1/market-calendar/US',
        date: '2026-11-06',
        dateTimeZone: 'America/New_York',
      },
    },
  };
}
async function draft(value, now = '2026-11-06T14:00:00Z', args) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'stock-scout-draft-')));
  const f = {
    directory,
    trace: join(directory, 'trace.jsonl'),
    cliTrace: join(directory, 'argv.jsonl'),
  };
  const path = join(directory, 'input.json');
  for (const file of [f.trace, f.cliTrace]) writeFileSync(file, '', { mode: 0o600 });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  try {
    const result = await runCli(f, [], args ?? ['order-draft', path], {
      TEST_CLOCK_START: String(Date.parse(now)),
      TOSS_STATE_DIR: undefined,
    });
    assert.deepEqual(result.requests, [], 'draft must never transmit HTTP');
    assert.ok(!(result.stdout + result.stderr).includes(directory));
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /accountSeq|accountNo|clientSecret|accessToken/,
    );
    return { ...result, out: JSON.parse(result.stdout) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('USD MARKET BUY returns an offline partial draft for manual app submission', async () => {
  const result = await draft(input());
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.out.version, 1);
  assert.equal(result.out.status, 'partial');
  assert.equal(result.out.source.endpoint, 'local:order-draft');
  assert.deepEqual(result.out.data, [
    {
      draftVersion: 1,
      symbol: 'DEMO',
      market: 'US',
      side: 'BUY',
      orderType: 'MARKET',
      amount: '25.50',
      currency: 'USD',
      tradeDate: '2026-11-06',
      session: 'regularMarket',
      regularMarket,
      expiresAt: '2026-11-06T09:30:00-05:00',
      submission: {
        route: 'toss_app',
        method: 'manual',
        workflow: 'fractional_pre_market_reservation',
      },
      appConditions: 'unknown',
    },
  ]);
  assert.deepEqual(result.out.omissions, [{ field: 'appConditions', reason: 'not_verified' }]);
});

test('US MARKET share quantity SELL returns an offline partial draft for manual app submission', async () => {
  const result = await draft(input('SELL'));
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.out.version, 1);
  assert.equal(result.out.status, 'partial');
  assert.equal(result.out.source.endpoint, 'local:order-draft');
  assert.deepEqual(result.out.data, [
    {
      draftVersion: 1,
      symbol: 'DEMO',
      market: 'US',
      side: 'SELL',
      orderType: 'MARKET',
      quantity: '0.1250',
      currency: 'USD',
      tradeDate: '2026-11-06',
      session: 'regularMarket',
      regularMarket,
      expiresAt: '2026-11-06T09:30:00-05:00',
      submission: {
        route: 'toss_app',
        method: 'manual',
        workflow: 'fractional_pre_market_reservation',
      },
      appConditions: 'unknown',
    },
  ]);
  assert.deepEqual(result.out.omissions, [{ field: 'appConditions', reason: 'not_verified' }]);
});

test('invalid order combinations never return a draft', async () => {
  for (const [changes, code] of [
    [{ amount: undefined }, 'DRAFT_AMOUNT_REQUIRED'],
    [{ quantity: '1' }, 'DRAFT_AMOUNT_QUANTITY_CONFLICT'],
    [{ amount: undefined, quantity: '1' }, 'ORDER_UNSUPPORTED'],
    [{ orderType: 'LIMIT' }, 'ORDER_UNSUPPORTED'],
    [{ side: 'SELL' }, 'ORDER_UNSUPPORTED'],
    ...['0', '-1', 'NaN', '1e3', '', null, 25].map((amount) => [{ amount }, 'INPUT_INVALID']),
    [{ currency: 'KRW' }, 'ORDER_UNSUPPORTED'],
    [{ market: 'KR' }, 'ORDER_UNSUPPORTED'],
    [{ symbol: 'DEMO\nextra' }, 'INPUT_INVALID'],
    [{ expiresAt: '2026-11-06T14:30:00' }, 'INPUT_INVALID'],
    [{ tradeDate: '2026-02-30' }, 'INPUT_INVALID'],
    [{ unexpected: 'discard-me' }, 'INPUT_INVALID'],
  ]) {
    const result = await draft({ ...input(), ...changes });
    assert.equal(result.status, 1, JSON.stringify(changes));
    assert.equal(result.out.status, 'error');
    assert.deepEqual(result.out.data, []);
    assert.equal(result.out.error.code, code, JSON.stringify(changes));
    assert.equal(result.stderr.trim(), code);
    assert.ok(!result.stdout.includes('discard-me'));
  }
});

test('SELL rejects missing, conflicting, unsupported and invalid share quantities', async () => {
  for (const [changes, code] of [
    [{ quantity: undefined }, 'DRAFT_AMOUNT_REQUIRED'],
    [{ amount: '25.50' }, 'DRAFT_AMOUNT_QUANTITY_CONFLICT'],
    [{ quantity: undefined, amount: '25.50' }, 'ORDER_UNSUPPORTED'],
    [{ orderType: 'LIMIT' }, 'ORDER_UNSUPPORTED'],
    [{ side: 'BUY' }, 'ORDER_UNSUPPORTED'],
    [{ side: 'OTHER' }, 'ORDER_UNSUPPORTED'],
    [{ currency: 'KRW' }, 'ORDER_UNSUPPORTED'],
    [{ market: 'KR' }, 'ORDER_UNSUPPORTED'],
    ...['0', '-1', 'NaN', '1e3', '', null, 0.125, '1'.repeat(31)].map((quantity) => [
      { quantity },
      'INPUT_INVALID',
    ]),
  ]) {
    const result = await draft({ ...input('SELL'), ...changes });
    assert.equal(result.status, 1, JSON.stringify(changes));
    assert.equal(result.out.status, 'error');
    assert.deepEqual(result.out.data, []);
    assert.equal(result.out.error.code, code, JSON.stringify(changes));
    assert.equal(result.stderr.trim(), code);
  }
});

test('schedule evidence and expiry boundaries distinguish safe failure reasons', async () => {
  const cases = [
    [
      'DRAFT_SESSION_MISMATCH',
      (v) => {
        v.session = 'preMarket';
      },
    ],
    [
      'DRAFT_DATE_MISMATCH',
      (v) => {
        v.sessions.source.date = '2026-11-05';
      },
    ],
    [
      'DRAFT_DATE_MISMATCH',
      (v) => {
        v.sessions.data[0].today.date = '2026-11-05';
      },
    ],
    [
      'DRAFT_SESSION_MISMATCH',
      (v) => {
        v.sessions.data[0].today.regularMarket = {
          startTime: '2026-11-07T00:30:00Z',
          endTime: '2026-11-07T05:00:00Z',
        };
      },
    ],
    [
      'DRAFT_SCHEDULE_MISSING',
      (v) => {
        delete v.sessions.data[0].today.regularMarket;
      },
    ],
    [
      'DRAFT_SCHEDULE_MISSING',
      (v) => {
        v.sessions.data = [];
      },
    ],
    [
      'DRAFT_SCHEDULE_MISSING',
      (v) => {
        v.sessions.status = 'error';
      },
    ],
    [
      'DRAFT_SCHEDULE_MISSING',
      (v) => {
        v.sessions.source.endpoint = '/api/v1/prices';
      },
    ],
    [
      'DRAFT_MARKET_CLOSED',
      (v) => {
        v.sessions.data[0].today.regularMarket = null;
      },
    ],
    [
      'DRAFT_EXPIRY_AFTER_OPEN',
      (v) => {
        v.expiresAt = '2026-11-06T09:30:00.0001-05:00';
      },
    ],
    [
      'DRAFT_EXPIRED',
      (v) => {
        v.expiresAt = '2026-11-06T09:00:00-05:00';
      },
    ],
    [
      'DRAFT_EXPIRED',
      (v) => {
        v.expiresAt = '2026-11-06T13:59:59.9999Z';
      },
    ],
  ];
  for (const side of ['BUY', 'SELL']) {
    for (const [code, change] of cases) {
      const value = input(side);
      change(value);
      const result = await draft(value);
      assert.equal(result.status, 1, `${side}: ${code}`);
      assert.deepEqual(result.out.data, []);
      assert.equal(result.out.error.code, code);
      assert.equal(result.stderr.trim(), code);
    }
  }
});

test('observed reference price is retained separately from execution and rejects incomplete pairs', async () => {
  const value = input();
  value.referencePrice = {
    price: '12.7500',
    currency: 'USD',
    timestamp: '2026-11-06T08:00:00-05:00',
  };
  const result = await draft(value);
  assert.equal(result.status, 2);
  assert.deepEqual(result.out.data[0].referencePrice, {
    ...value.referencePrice,
    meaning: 'observed_not_execution',
  });
  for (const referencePrice of [
    { price: '12.75', currency: 'USD' },
    { price: '-1', currency: 'USD', timestamp: '2026-11-06T13:00:00Z' },
    { price: '1', currency: 'USD', timestamp: '2026-11-06T15:00:00Z' },
    { price: '1', currency: 'KRW', timestamp: '2026-11-06T13:00:00Z' },
  ]) {
    const invalid = await draft({ ...value, referencePrice });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.out.error.code, 'INPUT_INVALID');
    assert.deepEqual(invalid.out.data, []);
  }
});

test('partial calendar evidence and submillisecond expiry remain usable before expiry', async () => {
  for (const side of ['BUY', 'SELL']) {
    const value = input(side);
    value.sessions.status = 'partial';
    value.expiresAt = '2026-11-06T14:00:00.0001Z';
    const result = await draft(value);
    assert.equal(result.status, 2);
    assert.equal(result.out.data[0].expiresAt, value.expiresAt);
  }
});

test('help discovers the offline command and malformed input stays a safe JSON error', async () => {
  const help = await draft(input(), undefined, ['--help']);
  assert.equal(help.status, 0);
  assert.equal(
    help.out.data.commands.find((entry) => entry.name === 'order-draft').usage,
    'node scripts/toss.ts order-draft INPUT_JSON_FILE',
  );
  for (const [value, args] of [
    ['not JSON'],
    [null],
    [input(), ['order-draft']],
    [input(), ['order-draft', '/absent/synthetic-draft.json']],
    [input(), ['order-draft', 'unused', 'extra']],
  ]) {
    const invalid = await draft(value, undefined, args);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stderr.trim(), 'INPUT_INVALID');
    assert.deepEqual(invalid.out.data, []);
  }
});

test('documented synthetic input and JSON examples agree with the actual CLI', async () => {
  const reference = readFileSync(new URL('../docs/toss-cli.md', import.meta.url), 'utf8')
    .split('## 오프라인 주문 초안\n')[1]
    .split('\n## ')[0];
  const examples = [...reference.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
    JSON.parse(match[1]),
  );
  const agentGuide = readFileSync(new URL('../docs/toss-agent-usage.md', import.meta.url), 'utf8')
    .split('## Prepare a manual Toss app BUY or SELL draft\n')[1]
    .split('\n## ')[0];
  const agentDrafts = [...agentGuide.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
    JSON.parse(match[1]),
  );
  assert.equal(examples.length, 4);
  assert.equal(agentDrafts.length, 2);
  for (const [index, side] of ['BUY', 'SELL'].entries()) {
    const result = await draft(examples[index * 2]);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, '');
    assert.equal(result.out.data[0].side, side);
    assert.deepEqual(result.out, examples[index * 2 + 1]);
    assert.deepEqual(agentDrafts[index], result.out.data[0]);
    const value = result.out.data[0];
    const orderValues = side === 'BUY' ? [value.currency, value.amount] : [value.quantity];
    const cardValues = [value.symbol, value.market, value.expiresAt, ...orderValues];
    for (const document of [reference, agentGuide]) {
      assert.ok(
        document
          .split('\n')
          .some(
            (line) =>
              line.startsWith('> ') &&
              cardValues.every((part) => line.includes(part)) &&
              line.replace(value.expiresAt, '').includes(value.tradeDate),
          ),
        `The ${side} card must show the draft values`,
      );
    }
  }
});
