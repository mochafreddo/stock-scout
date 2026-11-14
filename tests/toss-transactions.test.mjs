import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accounts, fixture, runAccountCli as runCli, selectAccount } from './toss-cli-helper.mjs';

const period = ['2026-09-01', '2026-10-31'];

const row = {
  transactionType: 'BUY',
  marketCountry: 'US',
  currency: 'USD',
  symbol: 'AAPL',
  assetClass: 'STOCK',
  isinCode: 'US0378331005',
  quantity: '0.123456789012345678',
  filledPrice: null,
  amount: '23.450000',
  commission: '0.01',
  tax: '0',
  netAmount: '23.469999',
  exchangeRate: null,
  settlementDate: '2026-10-01',
  settled: false,
  transactionTime: null,
  isCancellation: false,
};
const page = (transactions = [row], hasNext = false, nextCursor = null) => ({
  path: '/api/v1/transactions',
  body: { result: { transactions, hasNext, nextCursor } },
});
function select(f, accountSeq = 741, scopes = ['transactions']) {
  return selectAccount(f, accountSeq, scopes);
}

test('transactions preserve settlement meaning, precision and duplicate rows on selected account', async () => {
  const f = fixture();
  try {
    const selected = await select(f);
    assert.equal(selected.status, 0, selected.stdout);
    const result = await runCli(
      f,
      [accounts, page([row, { ...row, accountSeq: 741 }])],
      ['transactions', ...period],
    );
    assert.equal(result.status, 0, result.stdout);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.data, [row, row]);
    assert.equal(output.source.accountAlias, 'primary');
    assert.equal(result.requests.at(-1).account, '741');
    assert.equal(result.requests.at(-1).query, '?from=2026-09-01&to=2026-10-31&limit=20');
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /accountSeq|99887766554|synthetic-token|synthetic-secret/,
    );
    assert.equal(result.stderr, '');
  } finally {
    f.close();
  }
});

test('transactions preserve supplied trade decimals and nullable securities transfer amounts', async (t) => {
  const f = fixture();
  t.after(f.close);
  await select(f);
  const buy = {
    ...row,
    quantity: '0.1250',
    filledPrice: '187.760000000000000001',
    exchangeRate: '1382.123456789012345678',
    amount: '23.470001',
    netAmount: '23.480009',
  };
  const sell = {
    ...row,
    transactionType: 'SELL',
    quantity: '2.5000',
    filledPrice: '190.123456789012345678',
    exchangeRate: '1391.987654321098765432',
    amount: '475.308640',
    netAmount: '475.288631',
    settled: true,
    transactionTime: '2026-10-01T06:30:00+09:00',
  };
  const transfer = {
    ...row,
    transactionType: 'SECURITIES_TRANSFER_IN',
    amount: null,
    netAmount: null,
  };
  const transferOut = { ...transfer, transactionType: 'SECURITIES_TRANSFER_OUT' };
  const result = await runCli(
    f,
    [accounts, page([buy, sell, transfer, transferOut, row])],
    ['transactions', ...period],
  );
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout).data, [buy, sell, transfer, transferOut, row]);
});

test('transactions attach settlement semantics only after account validation (characterization)', async (t) => {
  const f = fixture();
  t.after(f.close);
  const args = ['transactions', ...period, 'limit=7', 'transactionTypes=BUY'];
  const missing = await runCli(f, [], args);
  assert.equal(missing.status, 1, missing.stdout);
  const base = { provider: 'tossinvest', endpoint: '/api/v1/transactions', freshness: 'unknown' };
  assert.deepEqual(JSON.parse(missing.stdout).source, base);
  assert.deepEqual(missing.requests, []);
  await select(f);
  const denied = await runCli(
    f,
    [accounts, { path: '/api/v1/transactions', status: 403, body: {} }],
    args,
  );
  assert.equal(denied.status, 1, denied.stdout);
  assert.equal(denied.stderr.trim(), 'PERMISSION_DENIED');
  assert.deepEqual(JSON.parse(denied.stdout).source, {
    ...base,
    accountAlias: 'primary',
    snapshot: 'unknown',
    from: '2026-09-01',
    to: '2026-10-31',
    transactionTypes: 'BUY',
    limit: 7,
    dateTimeZone: 'Asia/Seoul',
    dateMeaning: 'settlementDate',
    scope: 'KR_US_transactions_including_options_bonds',
  });
});

test('empty transaction pages preserve provider cursors and bind continuation to account and filters', async () => {
  const f = fixture();
  try {
    await select(f);
    const first = await runCli(
      f,
      [accounts, page([], true, 'opaque_Next-1')],
      ['transactions', ...period, 'transactionTypes=BUY,SELL'],
    );
    assert.equal(first.status, 2, first.stdout);
    const output = JSON.parse(first.stdout);
    assert.deepEqual(output.data, []);
    assert.equal(output.page.hasNext, true);
    assert.equal(output.page.nextCursor, 'opaque_Next-1');
    assert.equal(output.omissions[0].reason, 'next_page');
    const continuation = ['cursor=opaque_Next-1', `context=${output.page.context}`];
    const next = await runCli(
      f,
      [accounts, page([])],
      ['transactions', ...period, 'transactionTypes=BUY,SELL', 'limit=100', ...continuation],
    );
    assert.equal(next.status, 0, next.stdout);
    assert.equal(
      next.requests.at(-1).query,
      '?from=2026-09-01&to=2026-10-31&limit=100&transactionTypes=BUY%2CSELL&cursor=opaque_Next-1',
    );
    assert.deepEqual(JSON.parse(next.stdout).page, { hasNext: false, nextCursor: null });
    for (const args of [
      ['2026-09-02', period[1], 'transactionTypes=BUY,SELL'],
      [...period, 'transactionTypes=BUY'],
    ]) {
      const changed = await runCli(f, [], ['transactions', ...args, ...continuation]);
      assert.equal(JSON.parse(changed.stdout).error.code, 'INPUT_INVALID');
      assert.equal(changed.requests.length, next.requests.length);
    }
    const tampered = await runCli(
      f,
      [],
      [
        'transactions',
        ...period,
        'transactionTypes=BUY,SELL',
        'cursor=different',
        `context=${output.page.context}`,
      ],
    );
    assert.equal(JSON.parse(tampered.stdout).error.code, 'INPUT_INVALID');
    assert.equal(tampered.requests.length, next.requests.length);
    await select(f, 852);
    const changed = await runCli(
      f,
      [],
      ['transactions', ...period, 'transactionTypes=BUY,SELL', ...continuation],
    );
    assert.equal(JSON.parse(changed.stdout).error.code, 'INPUT_INVALID');
    assert.equal(changed.requests.length, next.requests.length);
  } finally {
    f.close();
  }
});

test('transactions reject missing periods, invalid dates, filters, limits and cursor pairs before HTTP', async () => {
  const f = fixture();
  try {
    for (const args of [
      [],
      ['2026-09-01'],
      ['2026-02-30', period[1]],
      [period[1], period[0]],
      [...period, 'limit=0'],
      [...period, 'limit=101'],
      [...period, 'limit=1', 'limit=2'],
      [...period, 'transactionTypes=BUY,,SELL'],
      [...period, 'transactionTypes=UNKNOWN'],
      [...period, 'cursor=x'],
      [...period, `context=${'a'.repeat(64)}`],
      [...period, 'symbol=AAPL'],
    ]) {
      const result = await runCli(f, [], ['transactions', ...args]);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(JSON.parse(result.stdout).error.code, 'INPUT_INVALID');
      assert.equal(result.requests.length, 0);
    }
  } finally {
    f.close();
  }
});

test('transaction schema distinguishes required nulls, unknown enums, invalid rows and invalid pages', async () => {
  const f = fixture();
  try {
    await select(f);
    const cash = {
      ...row,
      transactionType: 'future-type',
      currency: 'EUR',
      marketCountry: 'EU',
      assetClass: null,
      symbol: null,
      isinCode: null,
      quantity: null,
      amount: '0',
      netAmount: '0',
      settled: true,
      transactionTime: '2026-10-01T06:30:00+09:00',
      isCancellation: true,
    };
    const empty = await runCli(f, [accounts, page([])], ['transactions', ...period]);
    assert.equal(empty.status, 0, empty.stdout);
    assert.deepEqual(JSON.parse(empty.stdout).data, []);
    for (const field of Object.keys(row)) {
      const invalid = { ...row };
      delete invalid[field];
      const result = await runCli(
        f,
        [accounts, page([cash, invalid])],
        ['transactions', ...period],
      );
      assert.equal(result.status, 2, `${field}: ${result.stdout}`);
      assert.deepEqual(JSON.parse(result.stdout).data, [cash]);
      assert.deepEqual(JSON.parse(result.stdout).omissions, [{ index: 1, reason: 'invalid_item' }]);
    }
    for (const bad of [
      { quantity: 0.1 },
      { netAmount: '-1' },
      { settlementDate: '2026-02-30' },
      { settlementDate: '2026-11-01' },
      { settled: null },
      { transactionTime: 'bad' },
      { transactionTime: '2026-10-01T06:30:00+09:00' },
      { commission: null },
    ]) {
      const result = await runCli(
        f,
        [accounts, page([{ ...row, ...bad }])],
        ['transactions', ...period],
      );
      assert.equal(result.status, 1, result.stdout);
      assert.equal(JSON.parse(result.stdout).error.code, 'RESPONSE_INVALID');
    }
    for (const value of [
      { transactions: [], hasNext: true, nextCursor: null },
      { transactions: [], hasNext: false, nextCursor: 'stale' },
      { transactions: [], hasNext: false },
      { transactions: [], nextCursor: null },
      { transactions: null, hasNext: false, nextCursor: null },
    ]) {
      const result = await runCli(
        f,
        [accounts, { path: '/api/v1/transactions', body: { result: value } }],
        ['transactions', ...period],
      );
      assert.equal(result.status, 1, result.stdout);
      assert.equal(JSON.parse(result.stdout).error.code, 'RESPONSE_INVALID');
    }
    const over = await runCli(
      f,
      [accounts, page([row, row])],
      ['transactions', ...period, 'limit=1'],
    );
    assert.equal(JSON.parse(over.stdout).error.code, 'RESPONSE_INVALID');
  } finally {
    f.close();
  }
});

test('transaction account selection, scope, masking and provider failures never become empty success', async () => {
  const f = fixture();
  try {
    const absent = await runCli(f, [], ['transactions', ...period]);
    assert.equal(JSON.parse(absent.stdout).error.code, 'ACCOUNT_SELECTION_REQUIRED');
    await select(f, 741, ['holdings']);
    const denied = await runCli(f, [], ['transactions', ...period]);
    assert.equal(JSON.parse(denied.stdout).error.code, 'ACCOUNT_SCOPE_DENIED');
    assert.equal(denied.requests.length, 0);
    await select(f);
    for (const [status, code] of [
      [403, 'PERMISSION_DENIED'],
      [401, 'AUTH_FAILED'],
      [400, 'INPUT_INVALID'],
    ]) {
      const result = await runCli(
        f,
        [
          accounts,
          {
            path: '/api/v1/transactions',
            status,
            body: {
              error: {
                code: 'invalid-request',
                message: '99887766554 synthetic-secret',
                requestId: 'safe-id',
              },
            },
          },
        ],
        ['transactions', ...period],
      );
      assert.equal(result.status, 1, result.stdout);
      assert.equal(JSON.parse(result.stdout).error.code, code);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /99887766554|synthetic-secret|synthetic-token/,
      );
      assert.equal(result.requests.at(-1).method, 'GET');
    }
  } finally {
    f.close();
  }
});

test('transaction cursors remain opaque and account identifiers never appear as cursors', async () => {
  const f = fixture();
  try {
    await select(f);
    const first = await runCli(
      f,
      [accounts, page([], true, 'a+/b==')],
      ['transactions', ...period],
    );
    assert.equal(first.status, 2, first.stdout);
    const output = JSON.parse(first.stdout);
    assert.equal(output.page.nextCursor, 'a+/b==');
    const next = await runCli(
      f,
      [accounts, page([])],
      ['transactions', ...period, 'cursor=a+/b==', `context=${output.page.context}`],
    );
    assert.equal(next.status, 0, next.stdout);
    assert.equal(new URLSearchParams(next.requests.at(-1).query).get('cursor'), 'a+/b==');
    const sensitive = await runCli(
      f,
      [accounts, page([], true, '741')],
      ['transactions', ...period],
    );
    assert.equal(sensitive.status, 1, sensitive.stdout);
    assert.equal(JSON.parse(sensitive.stdout).error.code, 'SENSITIVE_OUTPUT');
    assert.doesNotMatch(sensitive.stdout + sensitive.stderr, /741/);
  } finally {
    f.close();
  }
});

test('opaque cursors containing a short account identifier remain usable', async () => {
  const f = fixture();
  try {
    await select(f, 5);
    const result = await runCli(
      f,
      [
        {
          ...accounts,
          body: { result: [{ accountSeq: 5, accountNo: '99887766554', accountType: 'BROKERAGE' }] },
        },
        page([], true, 'abc56x'),
      ],
      ['transactions', ...period],
    );
    assert.equal(result.status, 2, result.stdout);
    assert.equal(JSON.parse(result.stdout).page.nextCursor, 'abc56x');
  } finally {
    f.close();
  }
});

test('transaction type filters and inclusive settlement boundaries preserve valid rows only', async () => {
  const f = fixture();
  try {
    await select(f);
    const firstDay = { ...row, settlementDate: '2026-09-01' };
    const lastDay = { ...row, settlementDate: '2026-10-31' };
    const sold = { ...row, transactionType: 'SELL' };
    const outside = { ...row, settlementDate: '2026-08-31' };
    const result = await runCli(
      f,
      [accounts, page([firstDay, lastDay, sold, outside])],
      ['transactions', ...period, 'transactionTypes=BUY'],
    );
    assert.equal(result.status, 2, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).data, [firstDay, lastDay]);
    assert.deepEqual(JSON.parse(result.stdout).omissions, [
      { index: 2, reason: 'invalid_item' },
      { index: 3, reason: 'invalid_item' },
    ]);
    for (const filter of [[], ['transactionTypes=']]) {
      const unfiltered = await runCli(
        f,
        [accounts, page([row, sold])],
        ['transactions', ...period, ...filter],
      );
      assert.equal(unfiltered.status, 0, unfiltered.stdout);
      assert.deepEqual(JSON.parse(unfiltered.stdout).data, [row, sold]);
    }
  } finally {
    f.close();
  }
});

test('transaction continuation retains the previous public context format and equivalent all-type filters', async () => {
  const f = fixture();
  try {
    await select(f);
    const context = '292cbb842507e8289c40ba6c6ca9ed7a6efb271a0266d22ccd923146430f2910';
    for (const filter of [[], ['transactionTypes=']]) {
      const r = await runCli(
        f,
        [accounts, page([])],
        ['transactions', ...period, ...filter, 'cursor=legacy-next', `context=${context}`],
      );
      assert.equal(r.status, 0, r.stdout);
    }
  } finally {
    f.close();
  }
});
