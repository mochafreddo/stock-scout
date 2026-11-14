import assert from 'node:assert/strict';
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, runCli } from './toss-cli-helper.mjs';

function selection(f, accountSeq = 741, scopes = ['holdings', 'buying-power'], alias = 'primary') {
  const path = join(f.directory, 'selection-input.json');
  writeFileSync(path, JSON.stringify({ accountSeq, alias, scopes }), { mode: 0o600 });
  return runCli(f, [], ['account-select', path]);
}
const accounts = {
  path: '/api/v1/accounts',
  body: {
    result: [
      { accountSeq: 741, accountNo: '99887766554', accountType: 'BROKERAGE' },
      { accountSeq: 852, accountNo: '11223344556', accountType: 'BROKERAGE' },
    ],
  },
};
const buying = {
  path: '/api/v1/buying-power',
  body: { result: { currency: 'USD', cashBuyingPower: '3500.5000' } },
};

test('only financial requests receive the selected account header, including auth recovery', async () => {
  const expired = { status: 401, body: { error: { code: 'expired-token' } } };
  for (const [steps, expected] of [
    [
      [accounts, buying],
      [
        ['POST', '/oauth2/token', undefined],
        ['GET', '/api/v1/accounts', undefined],
        ['GET', '/api/v1/buying-power', '852'],
      ],
    ],
    [
      [{ ...accounts, ...expired }, accounts, buying],
      [
        ['POST', '/oauth2/token', undefined],
        ['GET', '/api/v1/accounts', undefined],
        ['POST', '/oauth2/token', undefined],
        ['GET', '/api/v1/accounts', undefined],
        ['GET', '/api/v1/buying-power', '852'],
      ],
    ],
    [
      [accounts, { ...buying, ...expired }, buying],
      [
        ['POST', '/oauth2/token', undefined],
        ['GET', '/api/v1/accounts', undefined],
        ['GET', '/api/v1/buying-power', '852'],
        ['POST', '/oauth2/token', undefined],
        ['GET', '/api/v1/buying-power', '852'],
      ],
    ],
  ]) {
    const f = fixture();
    try {
      const selected = await selection(f, 852, ['buying-power'], 'secondary');
      assert.equal(selected.status, 0, selected.stdout + selected.stderr);
      const result = await runCli(f, steps, ['buying-power', 'USD']);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout).data, [buying.body.result]);
      assert.equal(JSON.parse(result.stdout).source.accountAlias, 'secondary');
      assert.deepEqual(
        result.requests.map(({ method, path, account }) => [method, path, account]),
        expected,
      );
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /741|852|99887766554|11223344556|synthetic-secret|synthetic-token/,
      );
    } finally {
      f.close();
    }
  }
});

test('explicit account selection persists scopes and uses only selected account header', async () => {
  const f = fixture();
  try {
    const selected = await selection(f);
    assert.equal(selected.status, 0, selected.stdout);
    assert.deepEqual(JSON.parse(selected.stdout).data, [
      { alias: 'primary', scopes: ['holdings', 'buying-power'] },
    ]);
    assert.equal(selected.requests.length, 0);
    const result = await runCli(f, [accounts, buying], ['buying-power', 'USD']);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).data, [
      { currency: 'USD', cashBuyingPower: '3500.5000' },
    ]);
    assert.equal(JSON.parse(result.stdout).source.accountAlias, 'primary');
    assert.equal(result.requests.at(-1).account, '741');
    assert.equal(result.requests.at(-1).query, '?currency=USD');
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /741|852|99887766554|11223344556|synthetic-secret|synthetic-token/,
    );
  } finally {
    f.close();
  }
});

const holding = {
  symbol: 'AAPL',
  name: 'Apple',
  marketCountry: 'US',
  currency: 'USD',
  quantity: '0.1250',
  lastPrice: '200.00',
  averagePurchasePrice: '180.0000',
  marketValue: { purchaseAmount: '22.5000', amount: '25.00', amountAfterCost: '24.90' },
  profitLoss: { amount: '2.50', amountAfterCost: '2.40', rate: '0.1111', rateAfterCost: '0.1066' },
  dailyProfitLoss: { amount: '-0.25', rate: '-0.01' },
  cost: { commission: '0', tax: null },
};
const overview = {
  totalPurchaseAmount: { krw: '0', usd: '22.5000' },
  marketValue: { amount: { krw: '0', usd: '25.00' }, amountAfterCost: { krw: '0', usd: '24.90' } },
  profitLoss: {
    amount: { krw: '0', usd: '2.50' },
    amountAfterCost: { krw: '0', usd: '2.40' },
    rate: '0.1111',
    rateAfterCost: '0.1066',
  },
  dailyProfitLoss: { amount: { krw: '0', usd: '-0.25' }, rate: '-0.01' },
  items: [holding],
};
const holdings = (result) => ({ path: '/api/v1/holdings', body: { result } });

test('holdings preserves official monetary fields and filters unknown identifiers', async () => {
  const f = fixture();
  try {
    await selection(f);
    const result = await runCli(
      f,
      [
        accounts,
        holdings({
          ...overview,
          accountNo: '99887766554',
          items: [{ ...holding, accountSeq: 741 }],
        }),
      ],
      ['holdings', 'AAPL'],
    );
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).data, [overview]);
    assert.equal(result.requests.at(-1).account, '741');
    assert.equal(result.requests.at(-1).query, '?symbol=AAPL');
    assert.doesNotMatch(result.stdout, /accountNo|accountSeq|99887766554/);
  } finally {
    f.close();
  }
});

test('missing, invalid, changed and unpermitted account selections never use first account', async () => {
  const f = fixture();
  try {
    const missing = await runCli(f, [], ['holdings']);
    assert.equal(JSON.parse(missing.stdout).error.code, 'ACCOUNT_SELECTION_REQUIRED');
    assert.equal(missing.requests.length, 0);
    await selection(f, 741, ['holdings']);
    const denied = await runCli(f, [], ['buying-power', 'USD']);
    assert.equal(JSON.parse(denied.stdout).error.code, 'ACCOUNT_SCOPE_DENIED');
    assert.equal(denied.requests.length, 0);
    await selection(f, 963);
    const invalid = await runCli(f, [accounts], ['holdings']);
    assert.equal(JSON.parse(invalid.stdout).error.code, 'ACCOUNT_SELECTION_REQUIRED');
    assert.equal(invalid.requests.at(-1).path, '/api/v1/accounts');
    await selection(f, 852, ['buying-power'], 'secondary');
    const changed = await runCli(f, [accounts, buying], ['buying-power', 'USD']);
    assert.equal(changed.status, 0, changed.stdout);
    assert.equal(changed.requests.at(-1).account, '852');
    assert.equal(JSON.parse(changed.stdout).source.accountAlias, 'secondary');
    const again = await runCli(f, [accounts, buying], ['buying-power', 'USD']);
    assert.equal(again.status, 0);
    assert.equal(again.requests.at(-1).account, '852');
  } finally {
    f.close();
  }
});

test('normal empty holdings, nullable optional decimals, invalid rows and summaries are distinct', async () => {
  const f = fixture();
  try {
    await selection(f);
    const empty = {
      totalPurchaseAmount: { krw: '0', usd: null },
      marketValue: { amount: { krw: '0' }, amountAfterCost: { krw: '0', usd: null } },
      profitLoss: {
        amount: { krw: '0', usd: null },
        amountAfterCost: { krw: '0' },
        rate: '0',
        rateAfterCost: '0',
      },
      dailyProfitLoss: { amount: { krw: '0' }, rate: '0' },
      items: [],
    };
    const normal = await runCli(f, [accounts, holdings(empty)], ['holdings']);
    assert.equal(normal.status, 0, normal.stdout);
    assert.deepEqual(JSON.parse(normal.stdout).data, [empty]);
    const partial = await runCli(
      f,
      [
        accounts,
        holdings({
          ...overview,
          profitLoss: null,
          items: [holding, { ...holding, quantity: null }],
        }),
      ],
      ['holdings'],
    );
    assert.equal(partial.status, 2, partial.stdout);
    const output = JSON.parse(partial.stdout);
    assert.deepEqual(output.data[0].items, [holding]);
    assert.equal('profitLoss' in output.data[0], false);
    assert.deepEqual(output.omissions, [
      { index: 1, reason: 'invalid_item' },
      { field: 'profitLoss', reason: 'invalid_summary' },
    ]);
    const invalid = await runCli(
      f,
      [accounts, holdings({ ...overview, items: [{ ...holding, averagePurchasePrice: 180 }] })],
      ['holdings'],
    );
    assert.equal(invalid.status, 2);
    assert.deepEqual(JSON.parse(invalid.stdout).data[0].items, []);
    assert.equal(JSON.parse(invalid.stdout).data[0].totalPurchaseAmount.usd, '22.5000');
    const noTax = structuredClone(overview);
    delete noTax.items[0].cost.tax;
    const omitted = await runCli(f, [accounts, holdings(noTax)], ['holdings']);
    assert.equal(omitted.status, 0);
    assert.equal('tax' in JSON.parse(omitted.stdout).data[0].items[0].cost, false);
  } finally {
    f.close();
  }
});

test('account inputs reject cursor reuse, unsupported filters and malformed selection before HTTP', async () => {
  const f = fixture();
  try {
    for (const args of [
      ['holdings', 'AAPL', 'cursor=X'],
      ['holdings', 'cursor=X'],
      ['buying-power'],
      ['buying-power', 'usd'],
      ['buying-power', 'USD', 'cursor=X'],
      ['account-select'],
      ['account-select', '/unused', 'extra'],
    ]) {
      const result = await runCli(f, [], args);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(JSON.parse(result.stdout).error.code, 'INPUT_INVALID');
      assert.equal(result.requests.length, 0);
    }
    for (const seq of ['9223372036854775808', '-9223372036854775809', 'not-an-id', 1.5]) {
      const result = await selection(f, seq);
      assert.equal(JSON.parse(result.stdout).error.code, 'ACCOUNT_SELECTION_REQUIRED');
    }
    for (const scopes of [[], ['submit-order'], ['holdings', 'holdings']]) {
      const result = await selection(f, 741, scopes);
      assert.equal(JSON.parse(result.stdout).error.code, 'ACCOUNT_SELECTION_REQUIRED');
    }
  } finally {
    f.close();
  }
});

test('buying power preserves zero and rejects missing, null, numeric or mismatched currency', async () => {
  const f = fixture();
  try {
    await selection(f);
    for (const value of [
      { currency: 'KRW', cashBuyingPower: '0' },
      { currency: 'EUR', cashBuyingPower: '0.0001' },
    ]) {
      const result = await runCli(
        f,
        [accounts, { ...buying, body: { result: value } }],
        ['buying-power', value.currency],
      );
      assert.equal(result.status, 0, result.stdout);
      assert.deepEqual(JSON.parse(result.stdout).data, [value]);
    }
    for (const value of [
      { currency: 'USD' },
      { currency: 'USD', cashBuyingPower: null },
      { currency: 'USD', cashBuyingPower: 0 },
      { currency: 'KRW', cashBuyingPower: '1' },
    ]) {
      const result = await runCli(
        f,
        [accounts, { ...buying, body: { result: value } }],
        ['buying-power', 'USD'],
      );
      assert.equal(result.status, 1, result.stdout);
      assert.equal(JSON.parse(result.stdout).error.code, 'RESPONSE_INVALID');
    }
  } finally {
    f.close();
  }
});

test('account HTTP errors stay errors and recovery retains selected account header', async () => {
  const f = fixture();
  try {
    await selection(f);
    for (const [status, code, expected] of [
      [403, 'permission-denied', 'PERMISSION_DENIED'],
      [401, 'invalid-token', 'AUTH_FAILED'],
      [404, 'account-not-found', 'ACCOUNT_SELECTION_REQUIRED'],
      [400, 'unsupported-currency', 'UNSUPPORTED'],
    ]) {
      const result = await runCli(
        f,
        [
          accounts,
          {
            ...buying,
            status,
            body: { error: { code, message: '99887766554', data: { accountSeq: 741 } } },
          },
        ],
        ['buying-power', 'USD'],
      );
      assert.equal(result.status, 1, result.stdout);
      assert.equal(JSON.parse(result.stdout).error.code, expected);
      assert.equal(JSON.parse(result.stdout).source.accountAlias, 'primary');
      assert.equal(JSON.parse(result.stdout).source.currency, 'USD');
      assert.equal(JSON.parse(result.stdout).source.scope, 'cash_based_excluding_margin');
      assert.match(result.stderr, new RegExp(expected));
      assert.doesNotMatch(result.stdout + result.stderr, /99887766554|accountSeq/);
    }
    const unavailable = await runCli(
      f,
      [{ ...accounts, status: 403, body: { error: { code: 'ip-not-allowed' } } }],
      ['buying-power', 'USD'],
    );
    assert.equal(JSON.parse(unavailable.stdout).error.code, 'PERMISSION_DENIED');
    assert.equal(JSON.parse(unavailable.stdout).source.accountAlias, 'primary');
    assert.equal(JSON.parse(unavailable.stdout).source.currency, 'USD');
    assert.equal(JSON.parse(unavailable.stdout).source.scope, 'cash_based_excluding_margin');
    writeFileSync(f.trace, '');
    const result = await runCli(
      f,
      [accounts, { ...buying, status: 401, body: { error: { code: 'expired-token' } } }, buying],
      ['buying-power', 'USD'],
    );
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(
      result.requests.filter((r) => r.path === '/api/v1/buying-power').map((r) => r.account),
      ['741', '741'],
    );
    assert.ok(
      result.requests.every((r) => r.method === (r.path === '/oauth2/token' ? 'POST' : 'GET')),
    );
  } finally {
    f.close();
  }
});

test('financial responses are not saved and selection is bound to client credentials', async () => {
  const { readFileSync, readdirSync, statSync, chmodSync } = await import('node:fs');
  const f = fixture();
  try {
    await selection(f);
    const before = readdirSync(f.directory).sort();
    const result = await runCli(f, [accounts, holdings(overview)], ['holdings']);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(readdirSync(f.directory).sort(), [...before, 'state.json'].sort());
    assert.doesNotMatch(
      readFileSync(join(f.directory, 'state.json'), 'utf8'),
      /Apple|quantity|22\.5000|cashBuyingPower|99887766554/,
    );
    assert.equal(statSync(join(f.directory, 'account.json')).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(f.directory, 'account.json'), 'utf8')).scopes, [
      'holdings',
      'buying-power',
    ]);
    chmodSync(join(f.directory, 'account.json'), 0o644);
    const unprotected = await runCli(f, [], ['holdings']);
    assert.equal(JSON.parse(unprotected.stdout).error.code, 'ACCOUNT_SELECTION_REQUIRED');
    chmodSync(join(f.directory, 'account.json'), 0o600);
    writeFileSync(
      join(f.directory, 'credentials.json'),
      JSON.stringify({ clientId: 'synthetic-client', clientSecret: 'replacement-secret' }),
      { mode: 0o600 },
    );
    writeFileSync(f.trace, '');
    const changed = await runCli(f, [], ['holdings']);
    assert.equal(JSON.parse(changed.stdout).error.code, 'ACCOUNT_SELECTION_REQUIRED');
    assert.equal(changed.requests.length, 0);
  } finally {
    f.close();
  }
});

test('account identifiers in provider error metadata are redacted while financial values remain', async () => {
  const f = fixture();
  try {
    await selection(f);
    const result = await runCli(
      f,
      [accounts, { ...buying, status: 403, body: { error: { code: 'denied', requestId: '741' } } }],
      ['buying-power', 'USD'],
    );
    assert.deepEqual(JSON.parse(result.stdout).error, {
      code: 'PERMISSION_DENIED',
      providerCode: 'denied',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'PERMISSION_DENIED\n');
    assert.doesNotMatch(result.stdout + result.stderr, /741/);
    for (const [metadata, expected] of [
      [{ code: 'account-741', requestId: 'SAFE_REQUEST' }, { requestId: 'SAFE_REQUEST' }],
      [
        { code: 'denied', requestId: 'SAFE_REQUEST' },
        { providerCode: 'denied', requestId: 'SAFE_REQUEST' },
      ],
      [{ code: 'account-852', requestId: 'REQ-741' }, {}],
      [{ requestId: 'SAFE_REQUEST' }, { requestId: 'SAFE_REQUEST' }],
      [{ code: 'denied' }, { providerCode: 'denied' }],
      [{ requestId: 'REQ-741' }, {}],
      [{ code: 'account-852' }, {}],
      [{}, {}],
    ]) {
      const failed = await runCli(
        f,
        [
          accounts,
          {
            ...buying,
            status: 403,
            body: { error: { ...metadata, message: 'private-response-body' } },
          },
        ],
        ['buying-power', 'USD'],
      );
      assert.equal(failed.status, 1, failed.stdout + failed.stderr);
      assert.equal(failed.stderr, 'PERMISSION_DENIED\n');
      assert.deepEqual(JSON.parse(failed.stdout).error, { code: 'PERMISSION_DENIED', ...expected });
      assert.deepEqual(JSON.parse(failed.stdout).data, []);
      assert.equal(failed.requests.at(-1).account, '741');
      assert.equal(failed.requests.at(-1).path, '/api/v1/buying-power');
      assert.doesNotMatch(
        failed.stdout + failed.stderr,
        /741|852|99887766554|11223344556|synthetic-(client|secret|token)|private-response-body/,
      );
    }
    for (const secret of [
      'synthetic-client',
      'synthetic-secret',
      'synthetic-token',
      'account-99887766554',
      'account-11223344556',
    ]) {
      for (const metadata of [
        { code: secret, requestId: 'SAFE_REQUEST' },
        { code: 'denied', requestId: secret },
      ]) {
        const failed = await runCli(
          f,
          [
            accounts,
            {
              ...buying,
              status: 403,
              body: { error: { ...metadata, message: 'private-response-body' } },
            },
          ],
          ['buying-power', 'USD'],
        );
        assert.equal(failed.status, 1, failed.stdout + failed.stderr);
        assert.equal(failed.stderr, 'SENSITIVE_OUTPUT\n');
        assert.deepEqual(JSON.parse(failed.stdout).error, { code: 'SENSITIVE_OUTPUT' });
        assert.deepEqual(JSON.parse(failed.stdout).data, []);
        assert.doesNotMatch(
          failed.stdout + failed.stderr,
          /741|852|99887766554|11223344556|synthetic-(client|secret|token)|private-response-body/,
        );
      }
    }
    const financial = await runCli(
      f,
      [accounts, { ...buying, body: { result: { currency: 'USD', cashBuyingPower: '741' } } }],
      ['buying-power', 'USD'],
    );
    assert.equal(financial.status, 0);
    assert.equal(JSON.parse(financial.stdout).data[0].cashBuyingPower, '741');
  } finally {
    f.close();
  }
});

test('duplicate and malformed selected account responses stop before financial HTTP', async () => {
  const f = fixture();
  try {
    await selection(f);
    for (const rows of [
      [accounts.body.result[0], accounts.body.result[0]],
      [{ accountSeq: 741, accountType: 'BROKERAGE' }],
    ]) {
      const result = await runCli(f, [{ ...accounts, body: { result: rows } }], ['holdings']);
      assert.equal(JSON.parse(result.stdout).error.code, 'RESPONSE_INVALID');
      assert.equal(result.requests.at(-1).path, '/api/v1/accounts');
    }
  } finally {
    f.close();
  }
});

test('KRW buying power rejects fractional won and selection cannot expose cached tokens', async () => {
  const f = fixture();
  try {
    await selection(f);
    const result = await runCli(
      f,
      [accounts, { ...buying, body: { result: { currency: 'KRW', cashBuyingPower: '0.5' } } }],
      ['buying-power', 'KRW'],
    );
    assert.equal(result.status, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, 'RESPONSE_INVALID');
    const preserved = readFileSync(join(f.directory, 'account.json'));
    writeFileSync(f.trace, '');
    const alias = await selection(f, 741, ['holdings'], 'synthetic-token');
    assert.equal(alias.status, 1);
    assert.equal(alias.stderr, 'SENSITIVE_OUTPUT\n');
    assert.equal(JSON.parse(alias.stdout).error.code, 'SENSITIVE_OUTPUT');
    assert.equal(alias.requests.length, 0);
    assert.doesNotMatch(alias.stdout + alias.stderr, /synthetic-token/);
    assert.deepEqual(readFileSync(join(f.directory, 'account.json')), preserved);
    const again = await runCli(f, [accounts, holdings(overview)], ['holdings']);
    assert.equal(JSON.parse(again.stdout).source.accountAlias, 'primary');
  } finally {
    f.close();
  }
});

test('unsafe selection input files are rejected before HTTP and preserve the default account', async () => {
  for (const boundary of ['permissions', 'symlink']) {
    const f = fixture();
    try {
      const selected = await selection(f);
      assert.equal(selected.status, 0, selected.stdout + selected.stderr);
      const preserved = readFileSync(join(f.directory, 'account.json'));
      const input = join(f.directory, 'replacement.json');
      writeFileSync(
        input,
        JSON.stringify({ accountSeq: 852, alias: 'secondary', scopes: ['holdings'] }),
        { mode: 0o600 },
      );
      let unsafe = input;
      if (boundary === 'permissions') chmodSync(input, 0o644);
      else {
        unsafe = join(f.directory, 'selection-link.json');
        symlinkSync(input, unsafe);
      }
      const rejected = await runCli(f, [], ['account-select', unsafe]);
      assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
      assert.equal(rejected.stderr, 'ACCOUNT_SELECTION_REQUIRED\n');
      assert.equal(JSON.parse(rejected.stdout).error.code, 'ACCOUNT_SELECTION_REQUIRED');
      assert.equal(rejected.requests.length, 0);
      assert.doesNotMatch(
        rejected.stdout + rejected.stderr,
        /741|852|synthetic-secret|synthetic-token/,
      );
      assert.deepEqual(readFileSync(join(f.directory, 'account.json')), preserved);
      const retained = await runCli(f, [accounts, buying], ['buying-power', 'USD']);
      assert.equal(retained.status, 0, retained.stdout + retained.stderr);
      assert.equal(retained.stderr, '');
      assert.equal(retained.requests.at(-1).account, '741');
      assert.equal(JSON.parse(retained.stdout).source.accountAlias, 'primary');
    } finally {
      f.close();
    }
  }
});

test('official int64 account identifiers keep exact digits in selection and HTTP', async () => {
  const f = fixture();
  try {
    const selected = await selection(f, '9007199254740993');
    assert.equal(selected.status, 0, selected.stdout);
    const input = join(f.directory, 'selection-input.json');
    writeFileSync(
      input,
      '{"alias":"primary","accountSeq":9007199254740993,"scopes":["buying-power"]}',
    );
    const rawSelection = await runCli(f, [], ['account-select', input]);
    assert.equal(rawSelection.status, 0, rawSelection.stdout);
    const result = await runCli(
      f,
      [
        {
          path: '/api/v1/accounts',
          rawBody:
            '{"result":[{"accountSeq":9007199254740993,"accountNo":"99887766554","accountType":"BROKERAGE"}]}',
        },
        buying,
      ],
      ['buying-power', 'USD'],
    );
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.requests.at(-1).account, '9007199254740993');
    assert.doesNotMatch(result.stdout, /900719925474099[23]/);
  } finally {
    f.close();
  }
});

test('account selection and provider integer identifiers are validated from exact JSON tokens', async () => {
  const f = fixture();
  try {
    const input = join(f.directory, 'selection-input.json');
    writeFileSync(
      input,
      '{"alias":"primary","accountSeq":741.0000000000000000001,"scopes":["holdings"]}',
      { mode: 0o600 },
    );
    const invalid = await runCli(f, [], ['account-select', input]);
    assert.equal(invalid.status, 1, invalid.stdout);
    assert.equal(JSON.parse(invalid.stdout).error.code, 'ACCOUNT_SELECTION_REQUIRED');
    await selection(f);
    for (const id of ['"741"', '741.0000000000000000001']) {
      const result = await runCli(
        f,
        [
          {
            path: '/api/v1/accounts',
            rawBody: `{"result":[{"accountSeq":${id},"accountNo":"99887766554","accountType":"BROKERAGE"}]}`,
          },
        ],
        ['holdings'],
      );
      assert.equal(JSON.parse(result.stdout).error.code, 'RESPONSE_INVALID');
      assert.equal(result.requests.at(-1).path, '/api/v1/accounts');
    }
  } finally {
    f.close();
  }
});

test('invalid or missing holdings arrays preserve independent summaries without claiming empty holdings', async () => {
  const f = fixture();
  try {
    await selection(f);
    for (const items of [null, undefined]) {
      const value = { ...overview, items };
      const result = await runCli(f, [accounts, holdings(value)], ['holdings']);
      assert.equal(result.status, 2, result.stdout);
      const output = JSON.parse(result.stdout);
      assert.equal(output.data[0].totalPurchaseAmount.usd, '22.5000');
      assert.equal('items' in output.data[0], false);
      assert.deepEqual(output.omissions, [{ field: 'items', reason: 'invalid_items' }]);
    }
  } finally {
    f.close();
  }
});
