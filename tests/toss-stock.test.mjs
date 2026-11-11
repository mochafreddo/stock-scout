import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, runCli } from './toss-cli-helper.mjs';

const stock = {
  symbol: 'DEMO',
  name: '합성 ETF',
  englishName: 'Synthetic ETF',
  market: 'NASDAQ',
  isinCode: 'US0000000002',
  securityType: 'ETF',
  isCommonShare: false,
  status: 'ACTIVE',
  currency: 'USD',
  sharesOutstanding: '100',
};
const endpoint = '/api/v1/stocks';
async function lookup(t, rows, args = ['stock', 'DEMO']) {
  const f = fixture();
  t.after(f.close);
  const run = await runCli(f, [{ path: endpoint, body: { result: rows } }], args);
  return { ...run, out: JSON.parse(run.stdout) };
}
test('stock retrieves the specified symbol and projects its identity, type and listing state', async (t) => {
  const r = await lookup(t, [stock]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stderr, '');
  assert.deepEqual(
    r.requests.map(({ method, path, query }) => [method, path, query]),
    [
      ['POST', '/oauth2/token', ''],
      ['GET', endpoint, '?symbols=DEMO'],
    ],
  );
  assert.deepEqual(r.out.data, [
    {
      symbol: 'DEMO',
      name: '합성 ETF',
      market: 'NASDAQ',
      securityType: 'ETF',
      isinCode: 'US0000000002',
      status: 'ACTIVE',
    },
  ]);
  assert.equal(r.out.source.endpoint, endpoint);
  assert.equal(r.out.source.freshness, 'unknown');
  assert.ok(Number.isFinite(Date.parse(r.out.retrievedAt)));
});

test('stock asks for a market and ISIN selection, then applies it only to the fresh response', async (t) => {
  const other = {
    ...stock,
    name: '합성 ETN',
    market: 'NYSE',
    isinCode: 'US0000000010',
    securityType: 'ETN',
  };
  const r = await lookup(t, [other, stock]);
  assert.equal(r.status, 1);
  assert.equal(r.out.error.code, 'IDENTITY_AMBIGUOUS');
  assert.deepEqual(r.out.data, []);
  assert.deepEqual(r.out.error.choices, [
    { symbol: 'DEMO', name: '합성 ETN', market: 'NYSE', isinCode: 'US0000000010' },
    { symbol: 'DEMO', name: '합성 ETF', market: 'NASDAQ', isinCode: 'US0000000002' },
  ]);
  const args = ['stock', 'DEMO', 'NYSE', 'US0000000010'];
  const selected = await lookup(t, [stock, other], args);
  assert.equal(selected.status, 0, selected.stdout);
  assert.equal(selected.out.data[0].securityType, 'ETN');
  assert.equal(selected.requests.at(-1).query, '?symbols=DEMO');
  const stale = await lookup(t, [stock], args);
  assert.equal(stale.out.error.code, 'NOT_FOUND');
});

test('unrecognized types remain usable identities and never gate a prices call', async (t) => {
  const r = await lookup(t, [{ ...stock, securityType: 'NEW_TYPE', isinCode: '' }]);
  assert.equal(r.status, 2);
  assert.equal(r.out.data[0].securityType, null);
  assert.equal(r.out.data[0].isinCode, null);
  assert.deepEqual(r.out.omissions, [{ symbol: 'DEMO', reason: 'type_unknown' }]);
  const f = fixture();
  t.after(f.close);
  const prices = await runCli(
    f,
    [{ body: { result: [{ symbol: 'DEMO', currency: 'USD', lastPrice: '1.0' }] } }],
    ['prices', 'DEMO'],
  );
  assert.equal(prices.status, 0);
  assert.deepEqual(
    prices.requests.map((x) => x.path),
    ['/oauth2/token', '/api/v1/prices'],
  );
});

test('stock separates empty and failed lookups, malformed rows and partial responses', async (t) => {
  for (const [rows, code] of [
    [[], 'NOT_FOUND'],
    [[null], 'RESPONSE_INVALID'],
    [[[]], 'RESPONSE_INVALID'],
    [[{ ...stock, symbol: 'OTHER' }], 'RESPONSE_INVALID'],
    [[{ ...stock, status: null }], 'RESPONSE_INVALID'],
    [[{ ...stock, englishName: undefined }], 'RESPONSE_INVALID'],
    [[{ ...stock, securityType: null }], 'RESPONSE_INVALID'],
    [[{ ...stock, isinCode: null }], 'RESPONSE_INVALID'],
    [[stock, stock], 'RESPONSE_INVALID'],
  ]) {
    const r = await lookup(t, rows);
    assert.equal(r.status, 1);
    assert.equal(r.out.error.code, code);
  }
  const r = await lookup(t, [stock, { ...stock, symbol: 'OTHER' }]);
  assert.equal(r.status, 2);
  assert.deepEqual(r.out.omissions, [{ index: 1, reason: 'invalid_item' }]);
  const f = fixture();
  t.after(f.close);
  const denied = await runCli(
    f,
    [
      {
        path: endpoint,
        status: 403,
        body: { error: { code: 'forbidden', message: 'private upstream message' } },
      },
    ],
    ['stock', 'DEMO'],
  );
  assert.equal(JSON.parse(denied.stdout).error.code, 'PERMISSION_DENIED');
  assert.doesNotMatch(
    denied.stdout + denied.stderr,
    /private upstream message|synthetic-(client|secret|token)/,
  );
});

test('stock preserves the existing 30-character decimal limit for shares outstanding', async (t) => {
  const valid = await lookup(t, [
    { ...stock, sharesOutstanding: '1234567890123456789012345678.9' },
  ]);
  assert.equal(valid.status, 0, valid.stdout);
  assert.equal(valid.out.data[0].symbol, 'DEMO');

  const invalid = await lookup(t, [
    { ...stock, sharesOutstanding: '12345678901234567890123456789.9' },
  ]);
  assert.equal(invalid.status, 1, invalid.stdout);
  assert.equal(invalid.out.error.code, 'RESPONSE_INVALID');
});

test('stock rejects secrets in selected data or choices and invalid arguments before HTTP', async (t) => {
  for (const rows of [
    [{ ...stock, name: 'synthetic-token' }],
    [stock, { ...stock, name: 'synthetic-token', market: 'NYSE' }],
  ]) {
    const r = await lookup(t, rows);
    assert.equal(r.status, 1);
    assert.equal(r.out.error.code, 'SENSITIVE_OUTPUT');
    assert.doesNotMatch(r.stdout + r.stderr, /synthetic-token/);
  }
  for (const args of [
    ['stock', 'DEMO,OTHER'],
    ['stock', 'DEMO', 'NYSE', 'bad'],
    ['stock', 'DEMO/OTHER'],
  ]) {
    const r = await lookup(t, [], args);
    assert.equal(r.out.error.code, 'INPUT_INVALID');
    assert.equal(r.requests.length, 0);
  }
});

test('selection can distinguish a missing ISIN from a known ISIN in the same market', async (t) => {
  const rows = [stock, { ...stock, isinCode: '', name: '합성 별도 종목' }];
  const r = await lookup(t, rows, ['stock', 'DEMO', 'NASDAQ', '-']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.out.data[0].name, '합성 별도 종목');
  assert.equal(r.out.data[0].isinCode, null);
});

test('an identifiable but malformed listing still requires a choice; duplicate rows cannot hide a different listing', async (t) => {
  const other = { ...stock, name: '합성 별도 종목', market: 'NYSE', isinCode: 'US0000000010' };
  for (const rows of [
    [stock, { ...other, sharesOutstanding: null }],
    [stock, stock, other],
  ]) {
    const r = await lookup(t, rows);
    assert.equal(r.out.error?.code, 'IDENTITY_AMBIGUOUS', r.stdout);
    assert.deepEqual(
      r.out.error.choices.map(({ market }) => market),
      ['NASDAQ', 'NYSE'],
    );
  }
  const malformed = await lookup(
    t,
    [stock, { ...other, sharesOutstanding: null }],
    ['stock', 'DEMO', 'NYSE'],
  );
  assert.equal(malformed.out.error.code, 'RESPONSE_INVALID');
  const selected = await lookup(t, [stock, stock, other], ['stock', 'DEMO', 'NYSE']);
  assert.equal(selected.out.data[0].market, 'NYSE');
});

test('JSON escaping cannot expose a credential in a result or a selection request', async (t) => {
  const secret = 'synthetic-"quoted\\token';
  for (const rows of [
    [{ ...stock, name: secret }],
    [stock, { ...stock, name: secret, market: 'NYSE' }],
  ]) {
    const f = fixture(secret);
    t.after(f.close);
    const r = await runCli(f, [{ path: endpoint, body: { result: rows } }], ['stock', 'DEMO'], {
      TEST_CLIENT_SECRET: secret,
    });
    assert.equal(r.status, 1, r.stdout);
    assert.equal(JSON.parse(r.stdout).error.code, 'SENSITIVE_OUTPUT', r.stdout);
    assert.equal(r.stderr.trim(), 'SENSITIVE_OUTPUT');
  }
});
