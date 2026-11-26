import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, runCli } from './toss-cli-helper.mjs';

function run(...args) {
  return spawnSync(process.execPath, ['tests/toss-agent-cli.mjs', ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: { PATH: process.env.PATH, TOSS_STATE_DIR: '/must-not-use-real-state' },
  });
}

test('readiness consumer checks locally before attempting its needed price query', () => {
  const result = run('readiness-success', 'prices', 'DEMO');
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout, '', result.stderr);
  assert.match(result.stderr, /SYNTHETIC readiness=ready exit=0/);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'success');
  assert.equal(output.data[0].lastPrice, '10.0100');
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /synthetic-(client|secret|token)|stock-scout-toss-/,
  );
});

test('readiness consumer stops before market or account followups when transition is required', () => {
  const result = run('readiness-transition', 'prices', 'DEMO');
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.notEqual(result.stdout, '', result.stderr);
  assert.match(result.stderr, /SYNTHETIC readiness=blocked exit=1/);
  const output = JSON.parse(result.stdout);
  assert.equal(output.source.endpoint, 'local:readiness');
  assert.deepEqual(output.data, [
    { readiness: 'blocked', token: 'unknown', reasons: ['AUTH_STATE_TRANSITION_REQUIRED'] },
  ]);
  assert.deepEqual(output.error, { code: 'AUTH_STATE_TRANSITION_REQUIRED' });
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /synthetic-(client|secret|token)|stock-scout-toss-/,
  );
});

test('ready consumer preserves a subsequent query failure, safe error details and original exit', () => {
  const result = run('readiness-error', 'prices', 'DEMO');
  const original = run('error', 'prices', 'DEMO');
  assert.ifError(result.error);
  assert.equal(result.status, original.status, result.stderr);
  assert.notEqual(result.stdout, '', result.stderr);
  assert.match(result.stderr, /SYNTHETIC readiness=ready exit=0/);
  const { retrievedAt, ...query } = JSON.parse(result.stdout);
  const { retrievedAt: originalRetrievedAt, ...originalQuery } = JSON.parse(original.stdout);
  assert.equal(typeof retrievedAt, 'string');
  assert.equal(typeof originalRetrievedAt, 'string');
  assert.deepEqual(query, originalQuery);
  assert.match(result.stderr, /PERMISSION_DENIED/);
  assert.deepEqual(JSON.parse(result.stdout).error, {
    code: 'PERMISSION_DENIED',
    providerCode: 'ip-not-allowed',
    requestId: 'SYNTHETIC_295',
  });
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /synthetic-(client|secret|token)|private upstream|stock-scout-toss-/,
  );
});

test('ready consumer still runs real query validation after synthetic state changes', () => {
  const result = run('readiness-changed', 'prices', 'DEMO');
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.notEqual(result.stdout, '', result.stderr);
  assert.match(result.stderr, /SYNTHETIC readiness=ready exit=0/);
  const output = JSON.parse(result.stdout);
  assert.equal(output.source.endpoint, '/api/v1/prices');
  assert.equal(output.status, 'error');
  assert.deepEqual(output.data, []);
  assert.deepEqual(output.error, { code: 'AUTH_STATE_TRANSITION_REQUIRED' });
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /synthetic-(client|secret|token)|stock-scout-toss-/,
  );
});

test('agent receives a local transition error without protected-state changes or HTTP', () => {
  const result = run('transition-required', 'prices', 'DEMO');
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.notEqual(result.stdout, '', result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.version, 1);
  assert.equal(output.status, 'error');
  assert.deepEqual(output.data, []);
  assert.equal(output.error.code, 'AUTH_STATE_TRANSITION_REQUIRED');
  assert.match(result.stderr, /SYNTHETIC/);
  assert.match(result.stderr, /AUTH_STATE_TRANSITION_REQUIRED/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /synthetic-(secret|token|client)|99887766554|stock-scout-toss-/,
  );
});

function copiedCheckout(t, name) {
  const directory = mkdtempSync(join(tmpdir(), 'stock-scout-checkout-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, name);
  mkdirSync(join(root, 'tests'), { recursive: true });
  cpSync(new URL('../scripts', import.meta.url), join(root, 'scripts'), { recursive: true });
  for (const path of [
    'package.json',
    'tests/toss-agent-cli.mjs',
    'tests/toss-cli-helper.mjs',
    'tests/toss-http-mock.mjs',
    'tests/pre-push.test.mjs',
  ])
    copyFileSync(new URL(`../${path}`, import.meta.url), join(root, path));
  return root;
}

for (const name of ['ordinary', 'with spaces', '한글']) {
  test(`documented synthetic commands preserve output in ${name} checkout paths`, (t) => {
    const cwd = copiedCheckout(t, name);
    for (const [scenario, status] of [
      ['success', 0],
      ['partial', 2],
      ['error', 1],
    ]) {
      const result = spawnSync(
        process.execPath,
        ['tests/toss-agent-cli.mjs', scenario, 'candles', 'DEMO', '1d'],
        {
          cwd,
          encoding: 'utf8',
          timeout: 15000,
          env: { PATH: process.env.PATH, TOSS_STATE_DIR: '/must-not-use-real-state' },
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, status, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.version, 1);
      assert.equal(output.status, scenario);
      assert.equal(output.source.endpoint, '/api/v1/candles');
      assert.match(result.stderr, /SYNTHETIC/);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-(secret|token|client)/);
      if (scenario === 'error') {
        assert.deepEqual(output.data, []);
        assert.equal(output.error.code, 'PERMISSION_DENIED');
        assert.match(result.stderr, /PERMISSION_DENIED/);
      } else {
        assert.ok(output.data.length > 0);
        assert.equal(output.source.symbol, 'DEMO');
        assert.equal(output.data[0].closePrice, '12.50');
        assert.doesNotMatch(result.stderr, /PERMISSION_DENIED/);
      }
    }
  });

  test(`related hook test resolves its entry in ${name} checkout paths`, (t) => {
    const result = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-reporter=tap',
        '--test-name-pattern=^docs CLI checks selected working documents and untracked targets without changing the index$',
        'tests/pre-push.test.mjs',
      ],
      {
        cwd: copiedCheckout(t, name),
        encoding: 'utf8',
        timeout: 15000,
        env: { PATH: process.env.PATH },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# pass 1/);
    assert.match(result.stdout, /# fail 0/);
  });
}

function consume(result) {
  return spawnSync(process.execPath, ['examples/candle-consumer.mjs'], {
    input: result.stdout,
    encoding: 'utf8',
    timeout: 15000,
    env: { PATH: process.env.PATH },
  });
}

test('consumer preserves safe empty CLI errors when sensitive source metadata is removed', async (t) => {
  const f = fixture('/api/v1/candles');
  t.after(f.close);
  const result = await runCli(
    f,
    [
      {
        path: '/api/v1/candles',
        status: 403,
        body: { error: { code: 'ip-not-allowed', requestId: 'SAFE_REQUEST_334' } },
      },
    ],
    ['candles', 'DEMO', '1d'],
    { TEST_CLIENT_SECRET: '/api/v1/candles' },
  );
  assert.equal(result.status, 1, result.stderr);
  const original = JSON.parse(result.stdout);
  assert.deepEqual(original.source, { provider: 'tossinvest' });
  assert.deepEqual(original.data, []);
  assert.deepEqual(original.error, {
    code: 'PERMISSION_DENIED',
    providerCode: 'ip-not-allowed',
    requestId: 'SAFE_REQUEST_334',
  });
  const consumed = consume(result);
  assert.equal(consumed.status, 0, consumed.stderr);
  assert.deepEqual(JSON.parse(consumed.stdout), {
    status: 'error',
    retrievedAt: original.retrievedAt,
    data: [],
    error: original.error,
  });
  assert.doesNotMatch(consumed.stdout, /endpoint|\/api\/v1\/candles/);
});

test('consumer rejects malformed error envelopes and requires candle sources for usable data', async (t) => {
  const error = {
    version: 1,
    status: 'error',
    source: { provider: 'tossinvest' },
    data: [],
    error: { code: 'SENSITIVE_OUTPUT' },
  };
  for (const [name, patch] of [
    ['wrong version', { version: 2 }],
    ['success with masked source', { status: 'success' }],
    ['partial with masked source', { status: 'partial' }],
    ['unknown status', { status: 'failed', source: { endpoint: '/api/v1/candles' } }],
    ['non-array data', { data: {} }],
    ['nonempty data with masked source', { data: [{}] }],
    ['missing error', { error: undefined }],
    ['null error', { error: null }],
    ['array error', { error: [] }],
    ['string error', { error: 'SENSITIVE_OUTPUT' }],
    ['missing error code', { error: {} }],
    ['empty error code', { error: { code: '' } }],
    ['non-string error code', { error: { code: 1 } }],
    ['non-string provider code', { error: { code: 'AUTH_FAILED', providerCode: {} } }],
    ['non-string request id', { error: { code: 'AUTH_FAILED', requestId: [] } }],
    ['non-array choices', { error: { code: 'IDENTITY_AMBIGUOUS', choices: {} } }],
  ]) {
    await t.test(name, () => {
      const consumed = consume({ stdout: JSON.stringify({ ...error, ...patch }) });
      assert.equal(consumed.status, 1, consumed.stderr);
      assert.equal(consumed.stdout, '');
    });
  }
});

test('consumer accepts only daily or exactly redacted sources for empty errors', async (t) => {
  const error = {
    version: 1,
    status: 'error',
    data: [],
    error: { code: 'INPUT_INVALID' },
  };
  for (const source of [
    undefined,
    null,
    [],
    'tossinvest',
    {},
    { provider: 'other' },
    { provider: 'tossinvest', endpoint: '/api/v1/prices' },
    { provider: 'tossinvest', endpoint: '/api/v1/candles', interval: '1m' },
    { provider: 'tossinvest', endpoint: null },
    { provider: 'tossinvest', interval: '1d' },
  ]) {
    await t.test(`rejects ${JSON.stringify(source)}`, () => {
      const consumed = consume({ stdout: JSON.stringify({ ...error, source }) });
      assert.equal(consumed.status, 1, consumed.stderr);
      assert.equal(consumed.stdout, '');
      assert.match(consumed.stderr, /daily candle output required/);
    });
  }
  for (const source of [
    { provider: 'tossinvest' },
    { provider: 'tossinvest', endpoint: '/api/v1/candles' },
    { provider: 'tossinvest', endpoint: '/api/v1/candles', interval: '1d', symbol: 'DEMO' },
  ]) {
    await t.test(`preserves ${JSON.stringify(source)}`, () => {
      const consumed = consume({ stdout: JSON.stringify({ ...error, source }) });
      assert.equal(consumed.status, 0, consumed.stderr);
      assert.deepEqual(JSON.parse(consumed.stdout).error, error.error);
    });
  }
});

test('consumer rejects unsafe error fields and malformed stock choices without rewriting safe details', async (t) => {
  const choice = {
    symbol: 'DEMO',
    name: 'Synthetic Demo',
    market: 'NASDAQ',
    isinCode: 'US0000000002',
  };
  const error = {
    version: 1,
    status: 'error',
    source: { provider: 'tossinvest' },
    data: [],
    error: { code: 'IDENTITY_AMBIGUOUS' },
  };
  const malformedChoices = [
    null,
    [],
    'DEMO',
    {},
    { ...choice, symbol: 1 },
    { ...choice, name: 1 },
    { ...choice, market: null },
    { ...choice, isinCode: {} },
    { symbol: 'DEMO', market: 'NASDAQ' },
    { ...choice, message: 'raw provider message' },
  ];
  for (const [name, detail] of [
    ['message', { ...error.error, message: 'raw provider message' }],
    ['body', { ...error.error, body: { secret: 'raw provider body' } }],
    ['unknown key', { ...error.error, extra: true }],
    ...malformedChoices.map((value) => [
      `choice=${JSON.stringify(value)}`,
      { ...error.error, choices: [value] },
    ]),
  ]) {
    await t.test(`rejects ${name}`, () => {
      const consumed = consume({ stdout: JSON.stringify({ ...error, error: detail }) });
      assert.equal(consumed.status, 1, consumed.stderr);
      assert.equal(consumed.stdout, '');
    });
  }
  for (const detail of [
    { code: 'IDENTITY_AMBIGUOUS', choices: [choice, { ...choice, name: null, isinCode: null }] },
    {
      code: 'AUTH_FAILED',
      providerCode: 'safe-provider-code',
      requestId: 'SAFE_REQUEST',
      choices: [],
    },
  ]) {
    await t.test(`preserves ${detail.code}`, () => {
      const consumed = consume({ stdout: JSON.stringify({ ...error, error: detail }) });
      assert.equal(consumed.status, 0, consumed.stderr);
      assert.deepEqual(JSON.parse(consumed.stdout), { status: 'error', data: [], error: detail });
    });
  }
});

test('consumer preserves currencies and declines mixed-currency close comparisons', () => {
  const output = {
    version: 1,
    status: 'partial',
    source: { endpoint: '/api/v1/candles', interval: '1d', symbol: 'DEMO' },
    data: [
      { timestamp: '2026-11-05T21:00:00Z', closePrice: '12500', volume: '200', currency: 'KRW' },
      { timestamp: '2026-11-04T21:00:00Z', closePrice: '10.00', volume: '100', currency: 'USD' },
    ],
    omissions: [{ reason: 'next_page' }],
    page: { nextBefore: '2026-11-03T21:00:00Z' },
  };
  const consumed = consume({ stdout: JSON.stringify(output) });
  assert.equal(consumed.status, 0, consumed.stderr);
  const result = JSON.parse(consumed.stdout);
  assert.equal(result.status, 'partial');
  const row = result.data[0];
  assert.deepEqual(row.analysis, {
    closeChangePercent: null,
    closeChangeUnavailableReason: 'currency_mismatch',
    totalVolume: 300,
  });
  assert.deepEqual(
    row.bars,
    output.data.map((bar) => ({ ...bar, tradeDate: null })),
  );
  assert.deepEqual(row.omissions, output.omissions);
  assert.deepEqual(row.page, output.page);
});

test('consumer rejects absent or invalid currency on every bar before calculating', async (t) => {
  for (const currency of [undefined, null, '', '   ', 1, {}, []]) {
    await t.test(`currency=${JSON.stringify(currency)}`, () => {
      const output = {
        version: 1,
        status: 'success',
        source: { endpoint: '/api/v1/candles', interval: '1d', symbol: 'DEMO' },
        data: [
          { timestamp: '2026-11-05T21:00:00Z', closePrice: '12.50', volume: '200', currency },
          { timestamp: '2026-11-04T21:00:00Z', closePrice: '10.00', volume: '100', currency },
        ],
      };
      const consumed = consume({ stdout: JSON.stringify(output) });
      assert.equal(consumed.status, 1, consumed.stderr);
      assert.equal(consumed.stdout, '');
      assert.match(consumed.stderr, /currency must be a nonempty string/);
    });
  }
});

test('actual CLI mixed-currency stdout retains bars and volume in the executable consumer', async (t) => {
  const f = fixture();
  t.after(f.close);
  const bars = [
    {
      timestamp: '2026-11-05T21:00:00Z',
      openPrice: '12000',
      highPrice: '13000',
      lowPrice: '11000',
      closePrice: '12500',
      volume: '200',
      currency: 'KRW',
    },
    {
      timestamp: '2026-11-04T21:00:00Z',
      openPrice: '9',
      highPrice: '11',
      lowPrice: '8',
      closePrice: '10.00',
      volume: '100',
      currency: 'USD',
    },
  ];
  for (const args of [
    ['candles', 'DEMO', '1d'],
    ['candles-batch', 'DEMO'],
  ]) {
    const result = await runCli(
      f,
      [{ path: '/api/v1/candles', body: { result: { candles: bars, nextBefore: null } } }],
      args,
    );
    assert.equal(result.status, 0, result.stderr);
    const consumed = consume(result);
    assert.equal(consumed.status, 0, consumed.stderr);
    const output = JSON.parse(consumed.stdout);
    assert.equal(output.status, 'success');
    const row = output.data[0];
    assert.deepEqual(row.analysis, {
      closeChangePercent: null,
      closeChangeUnavailableReason: 'currency_mismatch',
      totalVolume: 300,
    });
    assert.deepEqual(
      row.bars.map((bar) => bar.currency),
      ['KRW', 'USD'],
    );
    assert.deepEqual(
      row.bars.map((bar) => bar.closePrice),
      ['12500', '10.00'],
    );
    assert.deepEqual(row.page, { nextBefore: null });
  }
});

test('actual daily CLI bars require distinct instants and unambiguous endpoint closes', async (t) => {
  const f = fixture();
  t.after(f.close);
  const newest = '2026-11-05T21:00:00.0002Z';
  const equivalent = '2026-11-05T16:00:00.000200-05:00';
  const oldest = '2026-11-05T21:00:00.0001Z';
  const bar = (timestamp, closePrice, currency = 'USD') => ({
    timestamp,
    closePrice,
    currency,
    openPrice: '10',
    highPrice: '100',
    lowPrice: '0',
    volume: '3',
  });
  const latest = bar(newest, '15');
  const base = bar(oldest, '10');
  for (const [name, candles, percent, reason, volume] of [
    ['one bar', [latest], null, 'insufficient_distinct_timestamps', 3],
    ['one instant', [latest, bar(equivalent, '15')], null, 'insufficient_distinct_timestamps', 6],
    [
      'latest close conflict',
      [latest, bar(equivalent, '15.00000000000000001'), base],
      null,
      'ambiguous_endpoint',
      9,
    ],
    [
      'oldest currency conflict',
      [latest, bar(oldest, '10', 'KRW'), base],
      null,
      'ambiguous_endpoint',
      9,
    ],
    [
      'equivalent close values',
      [latest, bar(equivalent, '015.00'), base, bar(oldest, '10.00')],
      50,
      null,
      12,
    ],
  ]) {
    await t.test(name, async () => {
      const result = await runCli(
        f,
        [{ path: '/api/v1/candles', body: { result: { candles, nextBefore: null } } }],
        ['candles', 'DEMO', '1d'],
      );
      assert.equal(result.status, 0, result.stderr);
      const consumed = consume(result);
      assert.equal(consumed.status, 0, consumed.stderr);
      const output = JSON.parse(consumed.stdout);
      assert.equal(output.status, 'success');
      const [row] = output.data;
      assert.deepEqual(row.analysis, {
        closeChangePercent: percent,
        ...(reason && { closeChangeUnavailableReason: reason }),
        totalVolume: volume,
      });
      assert.deepEqual(
        row.bars,
        candles.map(({ timestamp, closePrice, volume, currency }) => ({
          timestamp,
          closePrice,
          volume,
          currency,
          tradeDate: null,
        })),
      );
    });
  }
});

test('actual CLI and candle consumer retain valid bars beside negative prices or volume', async (t) => {
  const f = fixture();
  t.after(f.close);
  const valid = {
    timestamp: '2026-11-05T05:00:00Z',
    openPrice: '10',
    highPrice: '11',
    lowPrice: '9',
    closePrice: '10.00',
    volume: '0',
    currency: 'USD',
  };
  const invalid = ['openPrice', 'highPrice', 'lowPrice', 'closePrice', 'volume'].map((field) => ({
    ...valid,
    timestamp: '2026-11-04T05:00:00Z',
    [field]: '-0.01',
  }));
  const page = (candles) => ({
    path: '/api/v1/candles',
    body: { result: { candles, nextBefore: null } },
  });
  for (const args of [
    ['candles', 'DEMO', '1d'],
    ['candles-batch', 'DEMO'],
  ]) {
    const result = await runCli(f, [page([valid, ...invalid])], args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    const consumed = consume(result);
    assert.equal(consumed.status, 0, consumed.stderr);
    const output = JSON.parse(consumed.stdout);
    assert.equal(output.status, 'partial');
    assert.deepEqual(output.data[0].bars, [
      {
        timestamp: valid.timestamp,
        tradeDate: null,
        closePrice: '10.00',
        volume: '0',
        currency: 'USD',
      },
    ]);
    assert.deepEqual(output.data[0].omissions, [
      { index: 1, reason: 'invalid_item' },
      { index: 2, reason: 'invalid_item' },
      { index: 3, reason: 'invalid_item' },
      { index: 4, reason: 'invalid_item' },
      { index: 5, reason: 'invalid_item' },
    ]);
  }
  const failed = await runCli(f, [page(invalid)], ['candles', 'DEMO', '1d']);
  assert.equal(failed.status, 1, failed.stdout);
  assert.equal(JSON.parse(failed.stdout).error.code, 'RESPONSE_INVALID');
});

test('consumer preserves early daily input errors without candle source metadata', async (t) => {
  const f = fixture();
  t.after(f.close);
  for (const args of [
    ['candles', 'DEMO/', '1d'],
    ['candles-batch', 'DEMO/'],
  ]) {
    const result = await runCli(f, [], args);
    assert.equal(result.status, 1, result.stderr);
    const original = JSON.parse(result.stdout);
    assert.equal(original.source.interval, undefined);
    assert.deepEqual(original.error, { code: 'INPUT_INVALID' });
    assert.deepEqual(result.requests, []);
    const consumed = consume(result);
    assert.equal(consumed.status, 0, consumed.stderr);
    assert.deepEqual(JSON.parse(consumed.stdout), {
      status: 'error',
      retrievedAt: original.retrievedAt,
      data: [],
      error: { code: 'INPUT_INVALID' },
    });
  }
});

test('consumer preserves isolated daily authentication storage failures', async (t) => {
  const f = fixture();
  t.after(f.close);
  for (const args of [
    ['candles', 'DEMO', '1d'],
    ['candles-batch', 'DEMO,LATER'],
  ]) {
    const result = await runCli(f, [], args, { TOSS_STATE_DIR: join(f.directory, 'missing') });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).error, { code: 'AUTH_STORAGE' });
    assert.deepEqual(result.requests, []);
    const consumed = consume(result);
    assert.equal(consumed.status, 0, consumed.stderr);
    const output = JSON.parse(consumed.stdout);
    assert.equal(output.status, 'error');
    assert.deepEqual(output.error, { code: 'AUTH_STORAGE' });
    assert.ok(output.data.every((row) => row.analysis === null && row.bars.length === 0));
  }
});

test('consumer forwards only CLI-safe provider error details', async (t) => {
  const f = fixture();
  t.after(f.close);
  const result = await runCli(
    f,
    [
      {
        path: '/api/v1/candles',
        status: 403,
        body: {
          error: {
            code: 'ip-not-allowed',
            requestId: 'SAFE_REQUEST_312',
            message: 'private upstream message synthetic-secret synthetic-token',
          },
          privateBody: 'private upstream body',
        },
      },
    ],
    ['candles', 'DEMO', '1d'],
  );
  assert.equal(result.status, 1, result.stderr);
  const expected = {
    code: 'PERMISSION_DENIED',
    providerCode: 'ip-not-allowed',
    requestId: 'SAFE_REQUEST_312',
  };
  assert.deepEqual(JSON.parse(result.stdout).error, expected);
  const consumed = consume(result);
  assert.equal(consumed.status, 0, consumed.stderr);
  const output = JSON.parse(consumed.stdout);
  assert.equal(output.status, 'error');
  assert.deepEqual(output.error, expected);
  assert.deepEqual(output.data[0].error, expected);
  assert.doesNotMatch(
    result.stdout + result.stderr + consumed.stdout + consumed.stderr,
    /private upstream|synthetic-(secret|token|client)/,
  );
});

test('daily synthetic stdout runs through the executable analysis consumer', () => {
  const result = run('success', 'candles', 'DEMO', '1d', 'date=2026-11-05', 'count=3');
  assert.equal(result.status, 0, result.stderr);
  const consumed = consume(result);
  assert.equal(consumed.status, 0, consumed.stderr);
  const row = JSON.parse(consumed.stdout).data[0];
  assert.deepEqual(row.bars, [
    {
      timestamp: '2026-11-04T23:00:00-06:00',
      tradeDate: '2026-11-05',
      closePrice: '12.50',
      volume: '200',
      currency: 'USD',
    },
    {
      timestamp: '2026-11-03T23:00:00-06:00',
      tradeDate: '2026-11-04',
      closePrice: '10.00',
      volume: '100',
      currency: 'USD',
    },
  ]);
  assert.deepEqual(row.analysis, { closeChangePercent: 25, totalVolume: 300 });
});

test('batch consumer preserves usable partial coverage, empty pages, errors and unqueried rows', () => {
  const result = run(
    'partial',
    'candles-batch',
    'DEMO,PARTIAL,EMPTY,INVALID,DENIED,LATER',
    'date=2026-11-05',
    'count=3',
  );
  assert.equal(result.status, 2, result.stderr);
  const consumed = consume(result);
  assert.equal(consumed.status, 0, consumed.stderr);
  const output = JSON.parse(consumed.stdout);
  assert.equal(output.status, 'partial');
  const [complete, partial, empty, invalid, denied, later] = output.data;
  const query = JSON.parse(result.stdout);
  assert.notEqual(query.data[0].retrievedAt, query.data[1].retrievedAt);
  assert.notEqual(query.data[0].retrievedAt, query.retrievedAt);
  assert.equal(output.retrievedAt, query.retrievedAt);
  assert.deepEqual(
    output.data.map((row) => row.retrievedAt),
    query.data.map((row) => row.retrievedAt),
  );
  delete query.retrievedAt;
  delete query.data[0].retrievedAt;
  const omitted = consume({ stdout: JSON.stringify(query) });
  assert.equal(omitted.status, 0, omitted.stderr);
  const withoutTimes = JSON.parse(omitted.stdout);
  assert.ok(!Object.hasOwn(withoutTimes, 'retrievedAt'));
  assert.ok(!Object.hasOwn(withoutTimes.data[0], 'retrievedAt'));
  assert.equal(withoutTimes.data[1].retrievedAt, query.data[1].retrievedAt);
  assert.deepEqual(
    output.data.map((row) => row.status),
    ['success', 'partial', 'partial', 'partial', 'error', 'not_queried'],
  );
  assert.deepEqual(complete.analysis, { closeChangePercent: 25, totalVolume: 300 });
  assert.deepEqual(partial.analysis, complete.analysis);
  assert.deepEqual(partial.summary, {
    returnedCount: 2,
    latestTimestamp: '2026-11-04T23:00:00-06:00',
    latestTradeDate: '2026-11-05',
    tradeDateUnavailableReason: null,
  });
  assert.deepEqual(partial.omissions, [{ reason: 'next_page' }]);
  assert.deepEqual(partial.page, { nextBefore: '2026-11-02T23:00:00-06:00' });
  assert.deepEqual(empty.summary, {
    returnedCount: 0,
    latestTimestamp: null,
    latestTradeDate: null,
    tradeDateUnavailableReason: null,
  });
  assert.equal(empty.analysis, null);
  assert.deepEqual(empty.omissions, [{ reason: 'next_page' }]);
  assert.equal(empty.page.nextBefore, partial.page.nextBefore);
  assert.deepEqual(invalid.analysis, { closeChangePercent: 25, totalVolume: 300 });
  assert.equal(invalid.summary.returnedCount, 2);
  assert.deepEqual(
    invalid.omissions.map((item) => item.reason),
    ['invalid_item', 'pagination_unknown'],
  );
  assert.deepEqual(invalid.page, {});
  assert.equal(denied.error.code, 'PERMISSION_DENIED');
  assert.equal(later.reason, 'PERMISSION_DENIED');
  for (const row of [denied, later]) {
    assert.deepEqual(row.summary, {
      returnedCount: null,
      latestTimestamp: null,
      latestTradeDate: null,
      tradeDateUnavailableReason: null,
    });
    assert.deepEqual(row.bars, []);
    assert.equal(row.analysis, null);
  }
});

test('consumer keeps unconfirmed trade dates null and distinguishes a successful empty batch row', () => {
  for (const args of [
    ['candles', 'DEMO', '1d'],
    ['candles-batch', 'DEMO,EMPTY'],
  ]) {
    const result = run('success', ...args);
    assert.equal(result.status, 0, result.stderr);
    const consumed = consume(result);
    assert.equal(consumed.status, 0, consumed.stderr);
    const [row, empty] = JSON.parse(consumed.stdout).data;
    assert.deepEqual(
      row.bars.map((bar) => bar.tradeDate),
      [null, null],
    );
    assert.equal(row.tradeDateUnavailableReason, 'market_timezone_unconfirmed');
    assert.equal(row.bars[0].timestamp, '2026-11-04T23:00:00-06:00');
    assert.deepEqual(row.analysis, { closeChangePercent: 25, totalVolume: 300 });
    if (empty) {
      assert.equal(row.summary.latestTradeDate, null);
      assert.equal(row.summary.tradeDateUnavailableReason, 'market_timezone_unconfirmed');
      assert.equal(empty.status, 'success');
      assert.equal(empty.summary.returnedCount, 0);
      assert.equal(empty.analysis, null);
    }
  }
});

test('same executable accepts zero closes without masking a missing closePrice field', () => {
  const result = run('success', 'candles', 'DEMO', '1d');
  assert.equal(result.status, 0, result.stderr);
  for (const [index, expected] of [
    [0, -100],
    [1, null],
  ]) {
    const output = JSON.parse(result.stdout);
    output.data[index].closePrice = '0';
    const consumed = consume({ stdout: JSON.stringify(output) });
    assert.equal(consumed.status, 0, consumed.stderr);
    assert.deepEqual(JSON.parse(consumed.stdout).data[0].analysis, {
      closeChangePercent: expected,
      totalVolume: 300,
    });
  }
  const output = JSON.parse(result.stdout);
  delete output.data[0].closePrice;
  const missing = consume({ stdout: JSON.stringify(output) });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /closePrice must be a decimal string/);
  const wrongCommand = consume({
    stdout: JSON.stringify({
      version: 1,
      status: 'success',
      source: { endpoint: '/api/v1/prices' },
      data: [],
    }),
  });
  assert.equal(wrongCommand.status, 1);
  assert.match(wrongCommand.stderr, /daily candle output required/);
});

test('consumer rejects nondecimal values and invalid source timestamps', async (t) => {
  const result = run('success', 'candles', 'DEMO', '1d');
  assert.equal(result.status, 0, result.stderr);
  for (const [field, value] of [
    ['closePrice', '0x10'],
    ['volume', '1e2'],
    ['timestamp', '2026-11-05'],
    ['timestamp', '2026-02-30T00:00:00Z'],
  ]) {
    await t.test(`${field}=${value}`, () => {
      const output = JSON.parse(result.stdout);
      output.data[0][field] = value;
      const consumed = consume({ stdout: JSON.stringify(output) });
      assert.equal(consumed.status, 1, consumed.stderr);
      assert.equal(consumed.stdout, '');
      assert.match(consumed.stderr, /AssertionError/);
    });
  }
});

test('daily error scenarios preserve original exit and diagnostic semantics', () => {
  for (const args of [
    ['candles', 'DEMO', '1d'],
    ['candles-batch', 'DEMO,LATER'],
  ]) {
    const result = run('error', ...args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'error');
    assert.match(result.stderr, /SYNTHETIC/);
    assert.match(result.stderr, /PERMISSION_DENIED/);
    const consumed = consume(result);
    assert.equal(consumed.status, 0, consumed.stderr);
    assert.equal(JSON.parse(consumed.stdout).data[0].analysis, null);
  }
});

test('agent discovers the real CLI and reads explicitly synthetic prices', () => {
  const help = run('success', '--help');
  assert.equal(help.status, 0, help.stderr);
  assert.ok(JSON.parse(help.stdout).data.commands.some((x) => x.name === 'prices'));
  const price = run('success', 'prices', 'DEMO');
  assert.equal(price.status, 0, price.stderr);
  assert.deepEqual(JSON.parse(price.stdout).data, [
    {
      symbol: 'DEMO',
      lastPrice: '10.0100',
      currency: 'USD',
      timestamp: null,
      priceAge: {
        seconds: null,
        thresholdSeconds: 900,
        exceedsThreshold: null,
        unavailableReason: 'timestamp_null',
      },
    },
  ]);
  assert.match(price.stderr, /SYNTHETIC/);
  assert.doesNotMatch(price.stdout + price.stderr, /synthetic-(secret|token|client)/);
});

test('agent can request synthetic rankings and a complete tradable list', () => {
  const rankings = run('success', 'rankings', 'TOP_GAINERS', '1d', '1');
  assert.equal(rankings.status, 0, rankings.stderr);
  const ranked = JSON.parse(rankings.stdout);
  assert.equal(ranked.data[0].rank, 1);
  assert.equal(ranked.data[0].symbol, 'DEMO');
  assert.equal(ranked.source.aggregation, 'US_market');
  const tradable = run('success', 'tradable', 'NASDAQ');
  assert.equal(tradable.status, 0, tradable.stderr);
  assert.equal(JSON.parse(tradable.stdout).data[0].name, 'Synthetic Demo');
});

test('agent follows an empty partial page using the exact returned boundary', () => {
  const first = run('partial', 'candles', 'DEMO', '1m', 'count=1');
  assert.equal(first.status, 2, first.stderr);
  const page = JSON.parse(first.stdout);
  assert.equal(page.status, 'partial');
  assert.deepEqual(page.data, []);
  assert.equal(page.page.nextBefore, '2026-11-06T09:31:00.123+09:00');
  const second = run(
    'partial',
    'candles',
    'DEMO',
    '1m',
    'count=1',
    `before=${page.page.nextBefore}`,
  );
  assert.equal(second.status, 0, second.stderr);
  const last = JSON.parse(second.stdout);
  assert.equal(last.data[0].closePrice, '10.0100');
  assert.equal(last.source.before, '2026-11-06T09:31:00.123+09:00');
  assert.deepEqual(last.page, { nextBefore: null });
});

test('agent distinguishes permission errors and invalid inputs from empty results', () => {
  const denied = run('error', 'prices', 'DEMO');
  assert.equal(denied.status, 1, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).error.code, 'PERMISSION_DENIED');
  assert.match(denied.stderr, /PERMISSION_DENIED/);
  const invalid = run('success', 'prices', 'DEMO/');
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'INPUT_INVALID');
});

test('agent reads synthetic account data and follows an empty transaction page', () => {
  const buying = run('success', 'buying-power', 'USD');
  assert.equal(buying.status, 0, buying.stderr);
  const output = JSON.parse(buying.stdout);
  assert.deepEqual(output.data, [{ currency: 'USD', cashBuyingPower: '3500.5000' }]);
  assert.equal(output.source.accountAlias, 'primary');
  assert.doesNotMatch(
    buying.stdout + buying.stderr,
    /accountSeq|accountNo|99887766554|synthetic-(secret|token|client)/,
  );
  const first = run('partial', 'transactions', '2026-10-11', '2026-11-10', 'limit=1');
  assert.equal(first.status, 2, first.stderr);
  const page = JSON.parse(first.stdout);
  assert.deepEqual(page.data, []);
  assert.equal(page.page.nextCursor, 'synthetic_next');
  const last = run(
    'partial',
    'transactions',
    '2026-10-11',
    '2026-11-10',
    'limit=1',
    `cursor=${page.page.nextCursor}`,
    `context=${page.page.context}`,
  );
  assert.equal(last.status, 0, last.stderr);
  const end = JSON.parse(last.stdout);
  assert.equal(end.data[0].netAmount, '23.469999');
  assert.equal(end.data[0].settled, false);
  assert.equal(end.data[0].transactionTime, null);
  assert.deepEqual(end.page, { hasNext: false, nextCursor: null });
  const denied = run('error', 'holdings');
  assert.equal(denied.status, 1, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).error.code, 'PERMISSION_DENIED');
});

test('agent reads synthetic KRW buying power as an integer amount', () => {
  const result = run('success', 'buying-power', 'KRW');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data, [{ currency: 'KRW', cashBuyingPower: '3500' }]);
});

test('agent discovers and uses later market queries without assuming eligibility', () => {
  for (const [args, status, check] of [
    [['stock', 'DEMO'], 0, (o) => assert.equal(o.data[0].securityType, 'STOCK')],
    [['orderbook', 'DEMO'], 0, (o) => assert.equal(o.data[0].asks[0].price, '10.0200')],
    [['trades', 'DEMO', '1'], 0, (o) => assert.equal(o.data[0].volume, '0.0125')],
    [['sessions', '2026-11-06'], 0, (o) => assert.equal(o.source.dateTimeZone, 'America/New_York')],
    [
      ['constraints', 'DEMO', '2026-11-06'],
      2,
      (o) => assert.equal(o.data[0].eligibility, 'unknown'),
    ],
  ]) {
    const result = run('success', ...args);
    assert.equal(result.status, status, result.stderr);
    check(JSON.parse(result.stdout));
  }
});

test('agent reads holdings and order groups and follows both order cursors', () => {
  const holdings = run('success', 'holdings');
  assert.equal(holdings.status, 0, holdings.stderr);
  assert.equal(JSON.parse(holdings.stdout).data[0].items[0].quantity, '0.1250');
  for (const command of ['orders', 'conditional-orders']) {
    for (const group of ['OPEN', 'CLOSED']) {
      const result = run('success', command, group);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).data[0].symbol, 'DEMO');
      if (command === 'orders') {
        assert.equal(
          JSON.parse(result.stdout).data[0].status,
          group === 'OPEN' ? 'PENDING' : 'CANCELED',
        );
        assert.equal(JSON.parse(result.stdout).data[0].execution.filledQuantity, '0');
      }
    }
    const first = run('partial', command, 'CLOSED', 'limit=1');
    assert.equal(first.status, 2, first.stderr);
    const page = JSON.parse(first.stdout);
    assert.deepEqual(page.data, []);
    assert.equal(page.page.nextCursor, 'synthetic_next');
    const last = run(
      'partial',
      command,
      'CLOSED',
      'limit=1',
      `cursor=${page.page.nextCursor}`,
      `context=${page.page.context}`,
    );
    assert.equal(last.status, 0, last.stderr);
    assert.deepEqual(JSON.parse(last.stdout).page, { hasNext: false, nextCursor: null });
    assert.doesNotMatch(
      last.stdout + last.stderr,
      /accountSeq|accountNo|99887766554|synthetic-(secret|token|client)/,
    );
  }
});

test('synthetic notice survives fixture creation failure', (t) => {
  const f = fixture();
  t.after(f.close);
  const result = spawnSync(process.execPath, ['tests/toss-agent-cli.mjs', 'success', '--help'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, TMPDIR: `${f.directory}/missing` },
    timeout: 15000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT: no such file or directory, mkdtemp/);
  assert.match(result.stderr, /SYNTHETIC/);
});

test('batch consumer requires each usable item to match its daily candle source', async (t) => {
  const result = run('success', 'candles-batch', 'DEMO,EMPTY');
  assert.equal(result.status, 0, result.stderr);
  for (const [field, value] of [
    ['symbol', 'OTHER'],
    ['interval', '1m'],
    ['endpoint', '/api/v1/prices'],
  ]) {
    await t.test(field, () => {
      const query = JSON.parse(result.stdout);
      query.data[0].source[field] = value;
      const consumed = consume({ stdout: JSON.stringify(query) });
      assert.equal(consumed.status, 1, consumed.stderr);
      assert.equal(consumed.stdout, '');
    });
  }
});

test('successful empty daily CLI pages require a valid source symbol in the consumer', async (t) => {
  const f = fixture();
  t.after(f.close);
  const result = await runCli(
    f,
    [{ path: '/api/v1/candles', body: { result: { candles: [], nextBefore: null } } }],
    ['candles', 'DEMO', '1d'],
  );
  assert.equal(result.status, 0, result.stderr);
  const consumed = consume(result);
  assert.equal(consumed.status, 0, consumed.stderr);
  const [empty] = JSON.parse(consumed.stdout).data;
  assert.equal(empty.symbol, 'DEMO');
  assert.equal(empty.status, 'success');
  assert.deepEqual(empty.bars, []);
  assert.equal(empty.analysis, null);
  for (const symbol of [undefined, 'DEMO/']) {
    await t.test(String(symbol), () => {
      const query = JSON.parse(result.stdout);
      query.source.symbol = symbol;
      const invalid = consume({ stdout: JSON.stringify(query) });
      assert.equal(invalid.status, 1, invalid.stderr);
      assert.equal(invalid.stdout, '');
    });
  }
});
