import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCli, runFreshCli } from './toss-cli-helper.mjs';

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
async function draft(value, now = '2026-11-06T14:00:00Z', args, extra = {}) {
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
      ...extra,
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

function assertInvalidDraft(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), 'INPUT_INVALID');
  assert.equal(result.out.error.code, 'INPUT_INVALID');
  assert.deepEqual(result.out.data, []);
}

test('selected listings with the same symbol retain their market and known ISIN offline', async () => {
  for (const [listingMarket, isinCode] of [
    ['NASDAQ', 'US0000000002'],
    ['NYSE', 'US0000000010'],
  ]) {
    const result = await draft({ ...input(), listingMarket, isinCode });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.out.data[0].symbol, 'DEMO');
    assert.equal(result.out.data[0].market, 'US');
    assert.equal(result.out.data[0].listingMarket, listingMarket);
    assert.equal(result.out.data[0].isinCode, isinCode);
    assert.equal(result.out.data[0].draftVersion, 1);
    assert.deepEqual(result.out.omissions, [{ field: 'appConditions', reason: 'not_verified' }]);
  }
});

test('unknown ISIN remains usable with a selected market and legacy identity stays unverified', async () => {
  for (const side of ['BUY', 'SELL']) {
    for (const isinCode of [null, undefined]) {
      const selected = await draft({ ...input(side), listingMarket: 'NASDAQ', isinCode });
      assert.equal(selected.status, 2, selected.stdout);
      assert.equal(selected.out.data[0].listingMarket, 'NASDAQ');
      assert.equal(selected.out.data[0].isinCode, null);
      assert.deepEqual(selected.out.omissions, [
        { field: 'appConditions', reason: 'not_verified' },
      ]);
    }
    const legacy = await draft(input(side));
    assert.equal(legacy.status, 2, legacy.stdout);
    assert.equal(legacy.stderr, '');
    assert.equal(legacy.out.data[0].listingMarket, null);
    assert.equal(legacy.out.data[0].isinCode, null);
    assert.deepEqual(legacy.out.omissions, [
      { field: 'listingMarket', reason: 'not_verified' },
      { field: 'appConditions', reason: 'not_verified' },
    ]);
  }
});

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
      listingMarket: null,
      isinCode: null,
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
  assert.deepEqual(result.out.omissions, [
    { field: 'listingMarket', reason: 'not_verified' },
    { field: 'appConditions', reason: 'not_verified' },
  ]);
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
      listingMarket: null,
      isinCode: null,
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
  assert.deepEqual(result.out.omissions, [
    { field: 'listingMarket', reason: 'not_verified' },
    { field: 'appConditions', reason: 'not_verified' },
  ]);
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
    ...['KOSPI', 'KOSDAQ', 'KONEX', 'US', 'nasdaq', '', 1].map((listingMarket) => [
      { listingMarket },
      'INPUT_INVALID',
    ]),
    ...['', '-', 'bad', 'US0000000002\n', 2].map((isinCode) => [{ isinCode }, 'INPUT_INVALID']),
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
        v.sessions.data[0].today.regularMarket.endTime = '2026-11-06T16:00:00';
      },
    ],
    [
      'DRAFT_SESSION_MISMATCH',
      (v) => {
        v.sessions.data[0].today.regularMarket.endTime = '2026-11-06T14:30:00Z';
      },
    ],
    [
      'DRAFT_SESSION_MISMATCH',
      (v) => {
        v.sessions.data[0].today.regularMarket.endTime = '2026-11-06T14:29:59.9999Z';
      },
    ],
    [
      'DRAFT_SESSION_MISMATCH',
      (v) => {
        v.sessions.data[0].today.regularMarket.startTime = '2026-11-06T04:59:59.9999Z';
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
  for (const price of ['12.7500', '0.0000', '-0.0000']) {
    const referencePrice = { price, currency: 'USD', timestamp: '2026-11-06T08:00:00-05:00' };
    const result = await draft({ ...value, referencePrice });
    assert.equal(result.status, 2, price);
    assert.deepEqual(result.out.data[0].referencePrice, {
      ...referencePrice,
      meaning: 'observed_not_execution',
    });
  }
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

test('an offline draft preserves the regular interval from a partial sessions result', async () => {
  const interval = {
    startTime: '2026-11-06T23:30:00.1234+09:00',
    endTime: '2026-11-06T14:30:00.1235Z',
  };
  const sessions = await runFreshCli(
    [
      {
        path: '/api/v1/market-calendar/US',
        body: { result: { today: { date: '2026-11-06', regularMarket: interval } } },
      },
    ],
    ['sessions', '2026-11-06'],
  );
  assert.equal(sessions.status, 2, sessions.stdout + sessions.stderr);
  assert.equal(sessions.out.status, 'partial');
  assert.equal(sessions.stderr, '');
  assert.deepEqual(sessions.out.data[0].today.regularMarket, interval);
  assert.deepEqual(
    sessions.requests.map(({ method, path, query }) => [method, path, query]),
    [
      ['POST', '/oauth2/token', ''],
      ['GET', '/api/v1/market-calendar/US', '?date=2026-11-06'],
    ],
  );
  const result = await draft({ ...input(), sessions: sessions.out });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(result.out.status, 'partial');
  assert.equal(result.stderr, '');
  assert.deepEqual(result.out.data[0].regularMarket, interval);
});

// Regression: ISSUE-001 order draft blocks on a FIFO input
// Found by qa-loop on 2026-11-20
test('order draft rejects a FIFO without waiting for a writer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stock-scout-draft-fifo-'));
  try {
    const fifo = join(directory, 'input.json');
    assert.equal(spawnSync('mkfifo', ['-m', '600', fifo]).status, 0);
    const result = await draft(input(), undefined, ['order-draft', fifo]);
    assertInvalidDraft(result);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const oneMiB = 1_048_576;

function draftAtSizeLimit() {
  const value = input();
  value.sessions.data[0].label = '정규장';
  const json = JSON.stringify(value);
  return json + ' '.repeat(oneMiB - Buffer.byteLength(json));
}

test('order draft accepts exactly 1 MiB and rejects one additional byte', async () => {
  const json = draftAtSizeLimit();
  const atLimit = await draft(json);
  assert.equal(atLimit.status, 2);
  assert.equal(atLimit.stderr, '');
  assert.equal(atLimit.out.status, 'partial');
  assert.equal(atLimit.out.data[0].symbol, 'DEMO');

  const oversized = await draft(json + ' ');
  assertInvalidDraft(oversized);
});

test('order draft rejects a file that grows past 1 MiB after its metadata is read', async () => {
  const preload = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';

    const statFile = fs.fstatSync;
    fs.fstatSync = (...args) => {
      const stat = statFile(...args);
      if (stat.isFile() && stat.size === ${oneMiB}) fs.appendFileSync(process.argv[3], ' ');
      return stat;
    };
    syncBuiltinESMExports();
  `;
  const result = await draft(draftAtSizeLimit(), undefined, undefined, {
    NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}`,
  });
  assertInvalidDraft(result);
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
    const cardValues = [
      value.symbol,
      value.market,
      value.listingMarket,
      ...(value.isinCode === null ? [] : [value.isinCode]),
      value.expiresAt,
      ...orderValues,
    ];
    assert.ok(value.listingMarket, 'documented cards require a selected listing');
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
