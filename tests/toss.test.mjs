import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  authState,
  closeRuns,
  fixture,
  price,
  readRequests,
  runCli,
  waitForFile,
} from './toss-cli-helper.mjs';

test('Toss CLI preserves decimal prices and data time through real arguments and HTTP', async () => {
  const f = fixture();
  try {
    const r = await runCli(f);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.version, 1);
    assert.equal(out.status, 'success');
    assert.deepEqual(
      out.data.map(({ priceAge, ...row }) => row),
      [price],
    );
    assert.equal(out.source.provider, 'tossinvest');
    assert.equal(out.source.endpoint, '/api/v1/prices');
    assert.equal(out.source.freshness, 'unknown');
    assert.equal(r.requests.length, 2);
    assert.equal(r.requests[1].query, '?symbols=AAPL');
    assert.doesNotMatch(r.stdout + r.stderr, /synthetic-(secret|token|client)/);
  } finally {
    f.close();
  }
});

test('Toss CLI reports per-price age at the output time and warns only above 900 seconds', async () => {
  const f = fixture();
  try {
    const rows = [
      { ...price, symbol: 'BEFORE', timestamp: '2026-11-06T10:30:01-05:00' },
      { ...price, symbol: 'EQUAL', timestamp: '2026-11-06T15:30:00Z' },
      { ...price, symbol: 'AFTER', timestamp: '2026-11-07T00:29:59+09:00' },
      { ...price, symbol: 'FRACTION', timestamp: '2026-11-06T15:29:59.9999999999999999Z' },
    ];
    const r = await runCli(
      f,
      [{ body: { result: rows }, freezeAt: '2026-11-06T15:45:00Z' }],
      ['prices', 'BEFORE,EQUAL,AFTER,FRACTION'],
      { TEST_CLOCK_START: '1793979898000' },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.retrievedAt, '2026-11-06T15:45:00.000Z');
    assert.equal(out.status, 'success');
    assert.deepEqual(out.omissions, []);
    assert.deepEqual(out.data, [
      { ...rows[0], priceAge: { seconds: 899, thresholdSeconds: 900, exceedsThreshold: false } },
      { ...rows[1], priceAge: { seconds: 900, thresholdSeconds: 900, exceedsThreshold: false } },
      { ...rows[2], priceAge: { seconds: 901, thresholdSeconds: 900, exceedsThreshold: true } },
      { ...rows[3], priceAge: { seconds: 900, thresholdSeconds: 900, exceedsThreshold: true } },
    ]);
    assert.equal(out.source.freshness, 'unknown');
    assert.equal(out.source.snapshot, 'unknown');
    assert.equal(r.requests.at(-1).query, '?symbols=BEFORE%2CEQUAL%2CAFTER%2CFRACTION');
  } finally {
    f.close();
  }
});

test('Toss CLI applies an explicit age threshold locally and rejects invalid thresholds before HTTP', async () => {
  for (const [option, threshold, expected] of [
    ['staleAfterSeconds=899', 899, true],
    ['staleAfterSeconds=900', 900, false],
    ['staleAfterSeconds=901', 901, false],
    ['staleAfterSeconds=0', 0, true],
    ['staleAfterSeconds=9007199254740991', 9007199254740991, false],
  ]) {
    const f = fixture();
    try {
      const row = { ...price, timestamp: '2026-11-06T15:30:00Z' };
      const r = await runCli(
        f,
        [{ body: { result: [row] }, freezeAt: '2026-11-06T15:45:00Z' }],
        ['prices', 'AAPL', option],
        { TEST_CLOCK_START: '1793979898000' },
      );
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(out.data, [
        {
          ...row,
          priceAge: {
            seconds: 900,
            thresholdSeconds: threshold,
            exceedsThreshold: expected,
          },
        },
      ]);
      assert.equal(r.requests.at(-1).query, '?symbols=AAPL');
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    for (const options of [
      ['staleAfterSeconds='],
      ['staleAfterSeconds=-1'],
      ['staleAfterSeconds=1.5'],
      ['staleAfterSeconds=NaN'],
      ['staleAfterSeconds=Infinity'],
      ['staleAfterSeconds=1e3'],
      ['staleAfterSeconds=9007199254740992'],
      ['staleAfterSeconds=0900'],
      ['staleAfterSeconds=900', 'staleAfterSeconds=901'],
      ['unknown=900'],
    ]) {
      const r = await runCli(f, [], ['prices', 'AAPL', ...options]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.equal(JSON.parse(r.stdout).error.code, 'INPUT_INVALID');
      assert.equal(r.requests.length, 0);
      assert.match(r.stderr, /INPUT_INVALID/);
    }
  } finally {
    f.close();
  }
});

test('Toss CLI retains prices with missing, null and future time while distinguishing unavailable age', async () => {
  for (const partial of [false, true]) {
    const f = fixture();
    try {
      const rows = [
        { symbol: 'MISSING', lastPrice: '0', currency: 'USD' },
        { symbol: 'NULL', lastPrice: '1.00', currency: 'EUR', timestamp: null },
        { ...price, symbol: 'FUTURE', timestamp: '2026-11-06T15:45:01Z' },
        { ...price, symbol: 'FUTURE-FRACTION', timestamp: '2026-11-06T15:45:00.0001Z' },
      ];
      const r = await runCli(
        f,
        [
          {
            body: {
              result: partial ? [...rows, { ...price, symbol: 'INVALID', lastPrice: null }] : rows,
            },
            freezeAt: '2026-11-06T15:45:00Z',
          },
        ],
        [
          'prices',
          partial
            ? 'MISSING,NULL,FUTURE,FUTURE-FRACTION,INVALID'
            : 'MISSING,NULL,FUTURE,FUTURE-FRACTION',
        ],
        { TEST_CLOCK_START: '1793979898000' },
      );
      assert.equal(r.status, partial ? 2 : 0, r.stdout + r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.status, partial ? 'partial' : 'success');
      assert.deepEqual(out.data, [
        {
          ...rows[0],
          priceAge: {
            seconds: null,
            thresholdSeconds: 900,
            exceedsThreshold: null,
            unavailableReason: 'timestamp_missing',
          },
        },
        {
          ...rows[1],
          priceAge: {
            seconds: null,
            thresholdSeconds: 900,
            exceedsThreshold: null,
            unavailableReason: 'timestamp_null',
          },
        },
        {
          ...rows[2],
          priceAge: {
            seconds: null,
            thresholdSeconds: 900,
            exceedsThreshold: null,
            unavailableReason: 'timestamp_future',
          },
        },
        {
          ...rows[3],
          priceAge: {
            seconds: null,
            thresholdSeconds: 900,
            exceedsThreshold: null,
            unavailableReason: 'timestamp_future',
          },
        },
      ]);
      assert.deepEqual(
        out.omissions,
        partial
          ? [
              { index: 4, reason: 'invalid_item' },
              { symbol: 'INVALID', reason: 'missing_item' },
            ]
          : [],
      );
      assert.equal(out.source.freshness, 'unknown');
      assert.equal(out.source.snapshot, 'unknown');
      assert.doesNotMatch(r.stdout + r.stderr, /synthetic-(secret|token|client)/);
    } finally {
      f.close();
    }
  }
});

test('Toss CLI excludes every duplicate price and preserves omission order (characterization)', async (t) => {
  const f = fixture();
  t.after(f.close);
  const rows = [
    price,
    { symbol: 'MSFT', lastPrice: '0.0000', currency: 'USD', timestamp: null },
    price,
    { symbol: 'INVALID', lastPrice: null, currency: 'USD' },
    { ...price, symbol: 'UNREQUESTED' },
  ];
  const r = await runCli(
    f,
    [{ body: { result: rows } }],
    ['prices', 'MISSING-Z,AAPL,MSFT,MISSING-A,INVALID,AAPL'],
  );
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'partial');
  assert.deepEqual(
    out.data.map(({ priceAge, ...row }) => row),
    [{ symbol: 'MSFT', lastPrice: '0.0000', currency: 'USD', timestamp: null }],
  );
  assert.deepEqual(out.omissions, [
    { index: 0, reason: 'invalid_item' },
    { index: 2, reason: 'invalid_item' },
    { index: 3, reason: 'invalid_item' },
    { index: 4, reason: 'invalid_item' },
    { symbol: 'MISSING-Z', reason: 'missing_item' },
    { symbol: 'AAPL', reason: 'missing_item' },
    { symbol: 'MISSING-A', reason: 'missing_item' },
    { symbol: 'INVALID', reason: 'missing_item' },
  ]);
  assert.equal(
    r.requests.at(-1).query,
    '?symbols=MISSING-Z%2CAAPL%2CMSFT%2CMISSING-A%2CINVALID%2CAAPL',
  );
});

test('missing and unknown commands report input errors without a provider endpoint', async (t) => {
  const f = fixture();
  t.after(f.close);
  for (const args of [[], ['prcies', 'AAPL']]) {
    const r = await runCli(f, [], args);
    assert.equal(r.status, 1, r.stdout);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error.code, 'INPUT_INVALID');
    assert.equal(Object.hasOwn(out.source, 'endpoint'), false);
    assert.equal(r.stderr, 'INPUT_INVALID\n');
    assert.equal(r.requests.length, 0);
  }
});

test('Toss CLI rejects invalid arguments before authentication and advertises commands as JSON', async () => {
  const f = fixture();
  try {
    for (const args of [
      ['prices'],
      ['prices', 'AAPL,,MSFT'],
      ['prices', 'AAPL/A'],
      ['prices', 'AAPL', 'extra'],
      ['prices', Array.from({ length: 201 }, (_, i) => `A${i}`).join(',')],
      ['orders', 'AAPL'],
    ]) {
      const r = await runCli(f, [], args);
      assert.equal(r.status, 1);
      assert.equal(JSON.parse(r.stdout).error.code, 'INPUT_INVALID');
      assert.equal(r.requests.length, 0);
    }
    const help = await runCli(f, [], ['--help']);
    assert.equal(help.status, 0);
    assert.equal(JSON.parse(help.stdout).data.commands[0].name, 'prices');
    assert.equal(help.requests.length, 0);
  } finally {
    f.close();
  }
});

test('prices exclude negative prices and preserve signed zero', async () => {
  const f = fixture();
  try {
    const zero = { ...price, lastPrice: '-0.0000' };
    const negative = { ...price, symbol: 'MSFT', lastPrice: '-0.000000000000000000000000001' };
    const mixed = await runCli(
      f,
      [{ body: { result: [zero, negative] } }],
      ['prices', 'AAPL,MSFT'],
    );
    assert.equal(mixed.status, 2, mixed.stdout);
    const partial = JSON.parse(mixed.stdout);
    assert.equal(partial.status, 'partial');
    assert.deepEqual(
      partial.data.map(({ priceAge, ...row }) => row),
      [zero],
    );
    assert.deepEqual(partial.omissions, [
      { index: 1, reason: 'invalid_item' },
      { symbol: 'MSFT', reason: 'missing_item' },
    ]);
    const invalid = await runCli(f, [{ body: { result: [negative] } }], ['prices', 'MSFT']);
    assert.equal(invalid.status, 1, invalid.stdout);
    assert.equal(JSON.parse(invalid.stdout).error.code, 'RESPONSE_INVALID');
  } finally {
    f.close();
  }
});

test('Toss CLI distinguishes empty, partial and malformed prices without losing null, zero or missing time', async () => {
  const f = fixture();
  try {
    for (const [rows, expectedStatus, expectedCode, args] of [
      [[], 0, 'success'],
      [[{ ...price, lastPrice: '0', timestamp: null }], 0, 'success'],
      [[{ symbol: 'AAPL', lastPrice: '1.00', currency: 'EUR' }], 0, 'success'],
      [
        [price, { symbol: 'MSFT', lastPrice: 4, currency: 'USD' }],
        2,
        'partial',
        ['prices', 'AAPL,MSFT'],
      ],
      [[price], 2, 'partial', ['prices', 'AAPL,MSFT']],
      [[{ ...price, lastPrice: null }], 1, 'error'],
      [[{ ...price, timestamp: '2026-02-30T10:00:00Z' }], 1, 'error'],
      [[{ ...price, timestamp: '2026-11-06' }], 1, 'error'],
      [[{ ...price, timestamp: '2026-11-06T24:00:00Z' }], 1, 'error'],
      [[{ ...price, symbol: 'MSFT' }], 1, 'error'],
      [[price, price], 1, 'error'],
    ]) {
      const r = await runCli(f, [{ body: { result: rows } }], args);
      assert.equal(r.status, expectedStatus, r.stdout);
      const out = JSON.parse(r.stdout);
      assert.equal(out.status, expectedCode);
      if (expectedCode === 'error') assert.equal(out.error.code, 'RESPONSE_INVALID');
      if (expectedCode === 'partial') {
        assert.deepEqual(
          out.data.map(({ priceAge, ...row }) => row),
          [price],
        );
        assert.ok(out.omissions.length);
      }
      if (expectedCode === 'success')
        assert.deepEqual(
          out.data.map(({ priceAge, ...row }) => row),
          rows,
        );
    }
    for (const body of [{}, { result: null }, { result: [], error: {} }]) {
      const r = await runCli(f, [{ body }]);
      assert.equal(r.status, 1, r.stdout);
      assert.equal(JSON.parse(r.stdout).error.code, 'RESPONSE_INVALID');
    }
    const leak = await runCli(
      f,
      [{ body: { result: [{ ...price, symbol: 'synthetic-secret' }] } }],
      ['prices', 'synthetic-secret'],
    );
    assert.doesNotMatch(leak.stdout + leak.stderr, /synthetic-secret/);
  } finally {
    f.close();
  }
});

test('Toss CLI classifies HTTP failures and only retries transient reads once', async () => {
  for (const [status, code, expected] of [
    [400, 'invalid-request', 'INPUT_INVALID'],
    [401, 'invalid-token', 'AUTH_FAILED'],
    [403, 'ip-not-allowed', 'PERMISSION_DENIED'],
    [404, 'stock-not-found', 'NOT_FOUND'],
    [404, 'edge-blocked', 'UNSUPPORTED'],
    [422, 'unsupported-market', 'UNSUPPORTED'],
    [429, 'rate-limit-exceeded', 'RATE_LIMIT'],
    [503, 'internal-error', 'UPSTREAM_ERROR'],
  ]) {
    const f = fixture();
    try {
      const body = {
        error: {
          code,
          requestId: 'SAFE_REQUEST_1',
          message: 'synthetic-secret synthetic-token',
          data: { secret: 'synthetic-secret' },
        },
      };
      const r = await runCli(f, [
        { status, body },
        { status, body },
      ]);
      assert.equal(r.status, 1, r.stdout);
      const out = JSON.parse(r.stdout);
      assert.equal(out.error.code, expected);
      assert.equal(out.error.providerCode, code);
      assert.equal(out.error.requestId, 'SAFE_REQUEST_1');
      assert.equal(
        r.requests.filter((x) => x.method === 'GET').length,
        [429, 503].includes(status) ? 2 : 1,
      );
      assert.doesNotMatch(r.stdout + r.stderr, /synthetic-(secret|token)/);
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    const r = await runCli(f, [{ transport: true }, { body: { result: [price] } }]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.requests.filter((x) => x.method === 'GET').length, 2);
  } finally {
    f.close();
  }
});

test('Toss CLI shares token issuance and one-second HTTP spacing across independent processes', async () => {
  const f = fixture();
  const runs = [];
  try {
    runs.push(
      runCli(f, [], undefined, { TEST_REAL_CLOCK: '1' }),
      runCli(f, [], undefined, { TEST_REAL_CLOCK: '1' }),
    );
    const results = await Promise.all(runs);
    for (const r of results) assert.equal(r.status, 0, r.stdout + r.stderr);
    const requests = readRequests(f.trace);
    assert.equal(requests.filter((x) => x.method === 'POST').length, 1);
    assert.equal(requests.filter((x) => x.method === 'GET').length, 2);
    for (let i = 1; i < requests.length; i++)
      assert.ok(requests[i].at - requests[i - 1].at >= 1000, JSON.stringify(requests));
    const again = await runCli(f, [], undefined, { TEST_REAL_CLOCK: '1' });
    assert.equal(again.status, 0, again.stdout);
    assert.equal(again.requests.filter((x) => x.method === 'POST').length, 1);
  } finally {
    await Promise.allSettled(runs);
    f.close();
  }
});

test('Toss CLI reuses unexpired tokens and refreshes locally expired tokens across executions', async (t) => {
  const f = fixture();
  t.after(f.close);
  for (const [wallTime, expectedToken, expiresIn, expectedIssuances] of [
    ['2026-11-06T15:00:00Z', 'synthetic-token-A', 60, 1],
    ['2026-11-06T15:00:30Z', 'synthetic-token-A', undefined, 1],
    ['2026-11-06T15:01:01Z', 'synthetic-token-B', 60, 2],
    ['2026-11-06T15:01:02Z', 'synthetic-token-B', undefined, 2],
  ]) {
    const r = await runCli(f, [{ expectedToken, body: { result: [price] } }], undefined, {
      TEST_CLOCK_START: String(Date.parse(wallTime)),
      TEST_CLOCK_WALL_FIXED: String(Date.parse(wallTime)),
      TEST_AUTH_STEPS: JSON.stringify(
        expiresIn === undefined
          ? []
          : [
              {
                body: { access_token: expectedToken, token_type: 'Bearer', expires_in: expiresIn },
              },
            ],
      ),
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).status, 'success');
    assert.equal(r.requests.filter(({ method }) => method === 'POST').length, expectedIssuances);
    assert.equal(r.requests.at(-1).authorization, `Bearer ${expectedToken}`);
    assert.equal(r.requests.at(-1).query, '?symbols=AAPL');
    assert.doesNotMatch(r.stdout + r.stderr, /synthetic-(secret|token|client)/);
  }
});

test('Toss CLI reuses a sixty-second token issued after a shared forty-five-second cooldown', async (t) => {
  const f = fixture();
  t.after(f.close);
  const limited = await runCli(f, [], undefined, {
    TEST_AUTH_STEPS: JSON.stringify([{ status: 429, headers: { 'Retry-After': '45' }, body: {} }]),
  });
  assert.equal(JSON.parse(limited.stdout).error.code, 'RATE_LIMIT');
  const issued = await runCli(f, [], undefined, {
    TEST_AUTH_STEPS: JSON.stringify([
      { body: { access_token: 'synthetic-token', token_type: 'Bearer', expires_in: 60 } },
    ]),
  });
  assert.equal(issued.status, 0, issued.stdout);
  assert.ok(issued.requests[1].at - limited.requests[0].at >= 45000);
  const again = await runCli(f, [], undefined, {
    TEST_CLOCK_START: String(issued.requests.at(-1).at),
  });
  assert.equal(again.status, 0, again.stdout);
  assert.deepEqual(
    again.requests.map(({ method }) => method),
    ['POST', 'POST', 'GET', 'GET'],
  );
});

test('Toss CLI refreshes at the strict fifteen-second cached-token safety boundary', async () => {
  for (const [wallTime, expectedToken, expectedIssuances] of [
    ['2026-11-06T15:00:44.999Z', 'synthetic-token-A', 1],
    ['2026-11-06T15:00:45.000Z', 'synthetic-token-B', 2],
    ['2026-11-06T15:00:45.001Z', 'synthetic-token-B', 2],
  ]) {
    const f = fixture();
    try {
      const first = await runCli(
        f,
        [{ expectedToken: 'synthetic-token-A', body: { result: [price] } }],
        undefined,
        {
          TEST_CLOCK_START: '1793977200000',
          TEST_CLOCK_WALL_FIXED: '1793977200000',
          TEST_AUTH_STEPS: JSON.stringify([
            { body: { access_token: 'synthetic-token-A', token_type: 'Bearer', expires_in: 60 } },
          ]),
        },
      );
      assert.equal(first.status, 0, first.stdout + first.stderr);
      const r = await runCli(f, [{ expectedToken, body: { result: [price] } }], undefined, {
        TEST_CLOCK_START: String(Date.parse(wallTime)),
        TEST_CLOCK_WALL_FIXED: String(Date.parse(wallTime)),
        TEST_AUTH_STEPS: JSON.stringify([
          { body: { access_token: 'synthetic-token-B', token_type: 'Bearer', expires_in: 60 } },
        ]),
      });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(JSON.parse(r.stdout).status, 'success');
      assert.equal(r.requests.filter(({ method }) => method === 'POST').length, expectedIssuances);
      assert.equal(r.requests.at(-1).authorization, `Bearer ${expectedToken}`);
      assert.doesNotMatch(r.stdout + r.stderr, /synthetic-(secret|token|client)/);
    } finally {
      f.close();
    }
  }
});

test('Toss CLI bounds expiry recovery and transient retries together, and retains ambiguous issuance', async () => {
  const expired = { status: 401, body: { error: { code: 'expired-token' } } };
  for (const steps of [
    [expired, { status: 503, body: {} }, { body: { result: [price] } }],
    [{ status: 503, body: {} }, expired, { body: { result: [price] } }],
  ]) {
    const f = fixture();
    try {
      const r = await runCli(f, steps);
      assert.equal(r.status, 0, r.stdout);
      assert.equal(r.requests.filter((x) => x.method === 'GET').length, 3);
      assert.equal(r.requests.filter((x) => x.method === 'POST').length, 2);
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    const r = await runCli(f, [expired, expired]);
    assert.equal(r.status, 1);
    assert.equal(r.requests.filter((x) => x.method === 'POST').length, 2);
    assert.equal(r.requests.filter((x) => x.method === 'GET').length, 2);
  } finally {
    f.close();
  }
  for (const auth of [
    { transport: true },
    { status: 503, body: {} },
    { body: { access_token: 'synthetic-token', token_type: 'Bearer', expires_in: '86400' } },
  ]) {
    const f = fixture();
    try {
      const first = await runCli(f, [], undefined, { TEST_AUTH_STEPS: JSON.stringify([auth]) });
      assert.equal(first.status, 1);
      assert.equal(first.requests.length, 1);
      const second = await runCli(f);
      assert.equal(second.status, 1, second.stdout);
      assert.equal(JSON.parse(second.stdout).error.code, 'AUTH_ISSUANCE_UNKNOWN');
      assert.equal(second.requests.length, 1);
    } finally {
      f.close();
    }
  }
});

test('Toss CLI includes Retry-After, body reads and lock waits in its time budget', async () => {
  for (const [steps, expectedRequests] of [
    [[{ status: 429, body: {}, headers: { 'Retry-After': '61' } }], 2],
    [[{ hang: true }], 2],
    [[{ bodyHang: true }], 2],
    [[{ advance: 60000, body: { result: [price] } }], 2],
    [[{ monotonicAdvance: 60000, body: { result: [price] } }], 2],
  ]) {
    const f = fixture();
    try {
      const r = await runCli(f, steps);
      assert.equal(r.status, 1, r.stdout);
      assert.equal(JSON.parse(r.stdout).error.code, 'TIMEOUT');
      assert.equal(r.requests.length, expectedRequests);
    } finally {
      f.close();
    }
  }
});

test('Toss CLI reuses a token replaced by a peer before expired-token recovery', async () => {
  const f = fixture();
  const gate = join(f.directory, 'gate');
  const runs = [];
  try {
    const first = runCli(
      f,
      [
        { gate: true, status: 401, body: { error: { code: 'expired-token' } } },
        { expectedToken: 'synthetic-peer-token', body: { result: [price] } },
      ],
      undefined,
      { TEST_REAL_CLOCK: '1', TEST_GATE: gate },
    );
    runs.push(first);
    await waitForFile(`${gate}.ready`, first);
    const peer = await runCli(
      f,
      [
        { status: 401, body: { error: { code: 'expired-token' } } },
        { expectedToken: 'synthetic-peer-token', body: { result: [price] } },
      ],
      undefined,
      {
        TEST_REAL_CLOCK: '1',
        TEST_AUTH_STEPS: JSON.stringify([
          {
            body: { access_token: 'synthetic-peer-token', token_type: 'Bearer', expires_in: 86400 },
          },
        ]),
      },
    );
    assert.equal(peer.status, 0, peer.stdout + peer.stderr);
    writeFileSync(gate, '', { mode: 0o600 });
    const result = await first;
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.requests.filter((x) => x.method === 'POST').length, 2);
    assert.equal(result.requests.filter((x) => x.method === 'GET').length, 4);
  } finally {
    writeFileSync(gate, '', { mode: 0o600 });
    await Promise.allSettled(runs);
    f.close();
  }
});

test('Toss CLI reports invalid locks as storage errors before readiness or price requests', async () => {
  for (const kind of ['file', 'symlink', 'permissions']) {
    const f = fixture();
    try {
      const lock = join(f.directory, 'client.lock');
      if (kind === 'file') writeFileSync(lock, '', { mode: 0o700 });
      if (kind === 'symlink') symlinkSync(f.directory, lock);
      if (kind === 'permissions') {
        mkdirSync(lock, { mode: 0o700 });
        chmodSync(lock, 0o755);
      }
      for (const args of [['readiness'], ['prices', 'AAPL']]) {
        const result = await runCli(f, [], args);
        assert.equal(result.status, 1);
        assert.equal(JSON.parse(result.stdout).error.code, 'AUTH_STORAGE', kind);
        assert.deepEqual(result.requests, []);
      }
    } finally {
      f.close();
    }
  }
});

test('Toss CLI reacquires a lock released during inspection and completes the price query', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.directory, 'client.lock'), { mode: 0o700 });
    const result = await runCli(f, [], ['prices', 'AAPL'], { TEST_RELEASE_CLIENT_LOCK: '1' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'success');
    assert.deepEqual(
      result.requests.map((r) => r.path),
      ['/oauth2/token', '/api/v1/prices'],
    );
  } finally {
    f.close();
  }
});

test('Toss CLI rejects unsafe storage, bounds abandoned locks and releases locks on interruption', async () => {
  for (const kind of ['permissions', 'symlink', 'lock', 'interrupt']) {
    const f = fixture();
    try {
      if (kind === 'permissions') chmodSync(join(f.directory, 'credentials.json'), 0o644);
      if (kind === 'symlink')
        symlinkSync(join(f.directory, 'missing'), join(f.directory, 'state.json'));
      if (kind === 'lock') mkdirSync(join(f.directory, 'client.lock'), { mode: 0o700 });
      const result = await runCli(f, kind === 'interrupt' ? [{ interrupt: true }] : []);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(
        JSON.parse(result.stdout).error.code,
        kind === 'lock' ? 'TIMEOUT' : kind === 'interrupt' ? 'INTERRUPTED' : 'AUTH_STORAGE',
      );
      if (kind === 'interrupt') assert.equal(existsSync(join(f.directory, 'client.lock')), false);
      else assert.equal(result.requests.length, 0);
    } finally {
      f.close();
    }
  }
});

test('Toss CLI respects stricter provider spacing and HTTP timeout without exposing arbitrary messages', async () => {
  const f = fixture();
  try {
    const result = await runCli(f, [
      {
        status: 429,
        headers: { 'Retry-After': '3', 'X-RateLimit-Reset': '4' },
        body: { error: { code: 'rate-limit-exceeded', message: 'synthetic-secret' } },
      },
      { body: { result: [price] } },
    ]);
    assert.equal(result.status, 0, result.stdout);
    assert.ok(result.requests[2].at - result.requests[1].at >= 4000);
    const timeout = await runCli(f, [{ hang: true }]);
    assert.equal(JSON.parse(timeout.stdout).error.code, 'TIMEOUT');
    const lastAt = timeout.requests.at(-1).at;
    assert.equal(Date.parse(JSON.parse(timeout.stdout).retrievedAt) - lastAt, 15000);
    assert.doesNotMatch(
      result.stdout + result.stderr + timeout.stdout + timeout.stderr,
      /synthetic-(secret|token)/,
    );
  } finally {
    f.close();
  }
});

test('Toss CLI does not mark issuance unknown when no token request fits the cooldown', async () => {
  const f = fixture();
  try {
    const first = await runCli(f, [], undefined, {
      TEST_AUTH_STEPS: JSON.stringify([
        {
          status: 429,
          headers: { 'Retry-After': '120' },
          body: { error: { code: 'rate-limit-exceeded' } },
        },
      ]),
    });
    assert.equal(JSON.parse(first.stdout).error.code, 'RATE_LIMIT');
    const second = await runCli(f);
    assert.equal(JSON.parse(second.stdout).error.code, 'TIMEOUT');
    assert.equal(second.requests.length, 1);
    const third = await runCli(f, [], undefined, {
      TEST_CLOCK_START: String(Date.parse('2026-11-06T15:03:00Z')),
    });
    assert.equal(third.status, 0, third.stdout);
    assert.equal(third.requests.filter((x) => x.method === 'POST').length, 2);
  } finally {
    f.close();
  }
});

test('Toss CLI anchors shared spacing to actual fetch start after scheduling delay', async () => {
  const f = fixture();
  try {
    const r = await runCli(f, [], undefined, { TEST_START_DELAY: '5000' });
    assert.equal(r.status, 0, r.stdout);
    assert.ok(r.requests[1].at - r.requests[0].at >= 1000, JSON.stringify(r.requests));
  } finally {
    f.close();
  }
});

test('Toss CLI rejects FIFO credentials without blocking', async () => {
  const f = fixture();
  try {
    const fifo = join(f.directory, 'fifo');
    const made = spawnSync('mkfifo', ['-m', '600', fifo]);
    assert.equal(made.status, 0);
    const fs = await import('node:fs');
    fs.renameSync(fifo, join(f.directory, 'credentials.json'));
    const r = await runCli(f);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).error.code, 'AUTH_STORAGE');
    assert.equal(r.requests.length, 0);
  } finally {
    f.close();
  }
});

test('Toss CLI rejects oversized rate headers without poisoning shared state', async () => {
  const f = fixture();
  try {
    const r = await runCli(f, [
      { status: 429, headers: { 'Retry-After': '9'.repeat(400) }, body: {} },
    ]);
    assert.equal(JSON.parse(r.stdout).error.code, 'RESPONSE_INVALID');
    const second = await runCli(f);
    assert.equal(second.status, 0, second.stdout);
  } finally {
    f.close();
  }
});

for (const [valid, oversized] of [
  ['Retry-After', 'X-RateLimit-Reset'],
  ['X-RateLimit-Reset', 'Retry-After'],
]) {
  test(`Toss CLI shares ${valid} despite oversized ${oversized}`, async (t) => {
    const f = fixture();
    t.after(f.close);
    const r = await runCli(f, [
      { status: 429, headers: { [valid]: '4.25', [oversized]: '9'.repeat(400) }, body: {} },
    ]);
    assert.equal(JSON.parse(r.stdout).error.code, 'RESPONSE_INVALID');
    const next = await runCli(f);
    assert.equal(next.status, 0, next.stdout);
    assert.deepEqual(
      next.requests.map(({ method }) => method),
      ['POST', 'GET', 'GET'],
    );
    assert.ok(next.requests[2].at - next.requests[1].at >= 4250);
  });
}

test('Toss CLI preserves access and storage errors on mixed rate headers', async (t) => {
  for (const [status, code] of [
    [401, 'AUTH_FAILED'],
    [403, 'PERMISSION_DENIED'],
  ]) {
    for (const failSave of [false, true]) {
      const f = fixture();
      t.after(f.close);
      const headers = { 'Retry-After': '4', 'X-RateLimit-Reset': '9'.repeat(400) };
      const r = await runCli(f, [], undefined, {
        TEST_AUTH_STEPS: JSON.stringify([{ status, headers, body: {} }]),
        ...(failSave ? { TEST_FAIL_COOLDOWN_SAVE_ONCE: '1' } : {}),
      });
      assert.equal(JSON.parse(r.stdout).error.code, failSave ? 'AUTH_STORAGE' : code);
      assert.deepEqual(
        r.requests.map(({ method }) => method),
        ['POST'],
      );
    }
  }
});

test('Toss CLI applies a peer Retry-After while another process is waiting to send', async () => {
  const f = fixture();
  const gate = join(f.directory, 'cooldown-gate');
  const waitGate = join(f.directory, 'peer-wait');
  const published = join(f.directory, 'cooldown-published');
  const sharedClock = join(f.directory, 'shared-clock');
  const runs = [];
  try {
    const first = runCli(
      f,
      [
        {
          gate: true,
          status: 429,
          headers: { 'Retry-After': '3' },
          body: { error: { code: 'rate-limit-exceeded' } },
        },
        { body: { result: [price] } },
      ],
      undefined,
      {
        TEST_REAL_CLOCK: '1',
        TEST_GATE: gate,
        TEST_COOLDOWN_SAVED: published,
        TEST_SHARED_CLOCK_FILE: sharedClock,
      },
    );
    runs.push(first);
    await waitForFile(`${gate}.ready`, first);
    const peer = runCli(f, [], undefined, {
      TEST_REAL_CLOCK: '1',
      TEST_WAIT_GATE: waitGate,
      TEST_SHARED_CLOCK_FILE: sharedClock,
    });
    runs.push(peer);
    peer.catch(() => {});
    await waitForFile(`${waitGate}.ready`, peer);
    const waiting = JSON.parse(readFileSync(`${waitGate}.ready`, 'utf8'));
    assert.ok(BigInt(waiting.nextNs) > BigInt(waiting.readNs));
    assert.ok(waiting.milliseconds > 0);
    assert.equal(readRequests(f.trace).length, 2);
    writeFileSync(gate, '', { mode: 0o600 });
    await waitForFile(published, first);
    const cooldown = JSON.parse(readFileSync(published, 'utf8'));
    assert.ok(BigInt(cooldown.clock.nextNs) > BigInt(waiting.nextNs));
    const frozenClock = JSON.parse(readFileSync(sharedClock, 'utf8'));
    const minimumSendNs = BigInt(frozenClock.nowNs) + 3_000_000_000n;
    assert.equal(BigInt(cooldown.clock.nextNs), minimumSendNs);
    const runningClock = `${sharedClock}.running`;
    writeFileSync(
      runningClock,
      JSON.stringify({ ...frozenClock, startedNs: process.hrtime.bigint().toString() }),
      { mode: 0o600 },
    );
    renameSync(runningClock, sharedClock);
    writeFileSync(waitGate, '', { mode: 0o600 });
    const results = await Promise.all([first, peer]);
    for (const r of results) assert.equal(r.status, 0, r.stdout + r.stderr);
    const requests = readRequests(f.trace);
    for (const r of requests.slice(2))
      assert.ok(BigInt(r.sharedNs) >= minimumSendNs, JSON.stringify(requests));
  } finally {
    await closeRuns(f, runs, [gate, waitGate]);
  }
});

for (const [bytes, expectedStatus] of [
  [1048576, 0],
  [1048577, 1],
])
  test(`Toss CLI enforces the total response byte limit across chunks at ${bytes} bytes`, async () => {
    const f = fixture();
    try {
      const json = JSON.stringify({ result: [price], privateNote: 'synthetic-response-body' });
      const responseChunks = [json, 524288, bytes - Buffer.byteLength(json) - 524288];
      const r = await runCli(f, [{ responseChunks }]);
      assert.equal(r.status, expectedStatus, r.stdout + r.stderr);
      const out = JSON.parse(r.stdout);
      if (expectedStatus === 0) {
        assert.equal(out.status, 'success');
        assert.deepEqual(
          out.data.map(({ priceAge, ...row }) => row),
          [price],
        );
      } else {
        assert.equal(out.status, 'error');
        assert.equal(out.error.code, 'RESPONSE_INVALID');
      }
      assert.equal(r.requests.filter((request) => request.method === 'GET').length, 1);
      assert.doesNotMatch(r.stdout + r.stderr, /synthetic-(response-body|secret|token|client)/);
    } finally {
      f.close();
    }
  });

for (const [status, errorCode] of [
  [429, 'RATE_LIMIT'],
  [503, 'UPSTREAM_ERROR'],
])
  test(`Toss CLI retries an oversized HTTP ${status} read once`, async () => {
    const error = { status, responseChunks: ['synthetic-response-body', 1048576] };
    for (const repeated of [false, true]) {
      const f = fixture();
      try {
        const r = await runCli(f, [error, repeated ? error : { body: { result: [price] } }]);
        assert.equal(r.requests.filter((request) => request.method === 'GET').length, 2);
        assert.equal(r.status, repeated ? 1 : 0, r.stdout + r.stderr);
        const out = JSON.parse(r.stdout);
        if (repeated) assert.equal(out.error.code, errorCode);
        else assert.equal(out.status, 'success');
        assert.doesNotMatch(r.stdout + r.stderr, /synthetic-response-body/);
      } finally {
        f.close();
      }
    }
  });

test('Toss CLI rejects late or oversized responses without exposing response content', async () => {
  for (const [step, expected] of [
    [{ monotonicAdvance: 16000, body: { result: [price] } }, 'TIMEOUT'],
    [{ oversizedCancel: true }, 'RESPONSE_INVALID'],
  ]) {
    const f = fixture();
    try {
      const r = await runCli(f, [step]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.equal(JSON.parse(r.stdout).error.code, expected);
      assert.doesNotMatch(r.stdout + r.stderr, /synthetic-secret/);
    } finally {
      f.close();
    }
  }
});

test('Toss CLI treats late transport rejection as timeout without another GET', async () => {
  const f = fixture();
  try {
    const r = await runCli(f, [{ monotonicAdvance: 16000, transport: true }]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).error.code, 'TIMEOUT', r.stdout + r.stderr);
    assert.equal(r.requests.filter((request) => request.method === 'GET').length, 1);
  } finally {
    f.close();
  }
});

test('Toss CLI checks each execution clock before sending HTTP', async () => {
  for (const clock of ['wall', 'monotonic']) {
    const f = fixture();
    try {
      const r = await runCli(f, [], undefined, { TEST_CLOCK_JUMP: clock });
      assert.equal(r.status, 1, r.stdout);
      assert.equal(JSON.parse(r.stdout).error.code, 'TIMEOUT');
      assert.equal(r.requests.length, 0);
    } finally {
      f.close();
    }
  }
});

function issuedToken(value, seconds) {
  return { body: { access_token: value, token_type: 'Bearer', expires_in: seconds } };
}

test('prices uses the shared clock for expiration after a backward wall clock correction', async (t) => {
  for (const jump of [0, -30000]) {
    const f = fixture();
    t.after(f.close);
    const r = await runCli(
      f,
      [{ expectedToken: 'synthetic-next', body: { result: [price] } }],
      undefined,
      {
        TEST_AUTH_STEPS: JSON.stringify([
          { ...issuedToken('synthetic-short', 1), responseWallJump: jump },
          issuedToken('synthetic-next', 60),
        ]),
      },
    );
    assert.deepEqual(
      r.requests.map(({ method, authorization }) => authorization ?? method),
      ['POST', 'POST', 'Bearer synthetic-next'],
    );
    assert.equal(r.status, 0, r.stderr);
  }
});

test('prices combines expiry during the shared wait with provider recovery and transient retry', async (t) => {
  const f = fixture();
  t.after(f.close);
  const r = await runCli(
    f,
    [
      { expectedToken: 'synthetic-next', status: 401, body: { error: { code: 'expired-token' } } },
      { expectedToken: 'synthetic-last', status: 503, body: {} },
      { expectedToken: 'synthetic-last', body: { result: [price] } },
    ],
    undefined,
    {
      TEST_AUTH_STEPS: JSON.stringify([
        issuedToken('synthetic-short', 1),
        issuedToken('synthetic-next', 10),
        issuedToken('synthetic-last', 10),
      ]),
    },
  );
  assert.deepEqual(
    r.requests.map(({ method, authorization }) => authorization ?? method),
    [
      'POST',
      'POST',
      'Bearer synthetic-next',
      'POST',
      'Bearer synthetic-last',
      'Bearer synthetic-last',
    ],
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

for (const method of ['GET', 'POST']) {
  for (const phase of ['before', 'after']) {
    test(`reservation sync failure ${phase} ${method} start controls subsequent CLI sends`, async (t) => {
      const f = fixture();
      t.after(f.close);
      if (method === 'GET')
        writeFileSync(join(f.directory, 'state.json'), JSON.stringify(authState()), {
          mode: 0o600,
        });
      const first = await runCli(f, [], undefined, { TEST_FAIL_RESERVATION_SYNC: phase });
      const methods = phase === 'after' ? [method] : [];
      assert.deepEqual(
        first.requests.map((request) => request.method),
        methods,
      );
      assert.equal(first.status, 1);
      assert.equal(JSON.parse(first.stdout).error.code, 'AUTH_STORAGE');

      const readiness = await runCli(f, [], ['readiness']);
      const { reasons } = JSON.parse(readiness.stdout).data[0];
      assert.equal(reasons.includes('LOCK_PRESENT'), phase === 'after');
      assert.deepEqual(
        readiness.requests.map((request) => request.method),
        methods,
      );
      if (phase === 'after') {
        const next = await runCli(f);
        assert.equal(next.status, 1);
        assert.equal(JSON.parse(next.stdout).error.code, 'TIMEOUT');
        assert.deepEqual(
          next.requests.map((request) => request.method),
          methods,
        );
      }
    });
  }
}

test('prices checks expiry and the execution deadline after reservation directory sync', async (t) => {
  for (const delay of [16000, 60000]) {
    const f = fixture();
    t.after(f.close);
    const start = Date.parse('2026-11-06T15:00:00Z');
    writeFileSync(
      join(f.directory, 'state.json'),
      JSON.stringify(
        authState({
          token: {
            value: 'synthetic-cached',
            expiresAt: start + 16000,
            expiresNs: (BigInt(start + 16000) * 1000000n).toString().padStart(30, '0'),
          },
        }),
      ),
      { mode: 0o600 },
    );
    const r = await runCli(f, [], undefined, { TEST_FIRST_DIRECTORY_SYNC_MS: String(delay) });
    assert.deepEqual(
      r.requests.map(({ method }) => method),
      delay === 16000 ? ['POST', 'GET'] : [],
    );
    assert.equal(r.status, delay === 16000 ? 0 : 1, r.stdout + r.stderr);
    if (delay === 60000) assert.equal(JSON.parse(r.stdout).error.code, 'TIMEOUT');
  }
});

test('prices uses the still-live replacement issued by a peer during its shared wait', async () => {
  const f = fixture();
  const gate = join(f.directory, 'wait');
  const runs = [];
  try {
    const state = authState();
    state.token.expiresAt = Date.now() + 120000;
    state.clock.nextNs = (process.hrtime.bigint() + 3000000000n).toString().padStart(30, '0');
    writeFileSync(join(f.directory, 'state.json'), JSON.stringify(state), { mode: 0o600 });
    const success = { expectedToken: 'synthetic-peer', body: { result: [price] } };
    const first = runCli(f, [success], undefined, { TEST_REAL_CLOCK: '1', TEST_WAIT_GATE: gate });
    runs.push(first);
    await waitForFile(`${gate}.ready`, first);
    const peer = await runCli(
      f,
      [{ status: 401, body: { error: { code: 'expired-token' } } }, success],
      undefined,
      {
        TEST_REAL_CLOCK: '1',
        TEST_AUTH_STEPS: JSON.stringify([issuedToken('synthetic-peer', 15)]),
      },
    );
    assert.equal(peer.status, 0, peer.stdout + peer.stderr);
    writeFileSync(gate, '', { mode: 0o600 });
    const r = await first;
    assert.deepEqual(
      r.requests.map(({ authorization, method }) => authorization ?? method),
      ['Bearer synthetic-token', 'POST', 'Bearer synthetic-peer', 'Bearer synthetic-peer'],
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    await closeRuns(f, runs, [gate]);
  }
});

test('candles-batch preserves the first page and stops when token reselection fails', async (t) => {
  for (const [issuance, code] of [
    [issuedToken('synthetic-short', 1), 'AUTH_TOKEN_UNAVAILABLE'],
    [{ status: 403, body: {} }, 'PERMISSION_DENIED'],
  ]) {
    const f = fixture();
    t.after(f.close);
    const r = await runCli(
      f,
      [
        {
          path: '/api/v1/candles',
          headers: { 'Retry-After': '40' },
          body: { result: { candles: [], nextBefore: null } },
        },
      ],
      ['candles-batch', 'AAPL,MSFT,AMD'],
      {
        TEST_AUTH_STEPS: JSON.stringify([issuedToken('synthetic-token', 30), issuance]),
      },
    );
    const rows = JSON.parse(r.stdout).data;
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.deepEqual(
      rows.map(({ status }) => status),
      ['success', 'error', 'not_queried'],
    );
    assert.equal(rows[1].error.code, code);
    assert.equal(rows[2].reason, code);
    assert.deepEqual(
      r.requests.map(({ method }) => method),
      ['POST', 'GET', 'POST'],
    );
  }
});

test('prices returns a local auth error after two tokens expire without a GET', async (t) => {
  const f = fixture();
  t.after(f.close);
  const r = await runCli(f, [], undefined, {
    TEST_AUTH_STEPS: JSON.stringify([
      issuedToken('synthetic-one', 1),
      issuedToken('synthetic-two', 1),
    ]),
  });
  assert.deepEqual(
    r.requests.map(({ method }) => method),
    ['POST', 'POST'],
  );
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(JSON.parse(r.stdout).error, { code: 'AUTH_TOKEN_UNAVAILABLE' });
  assert.equal(r.stderr, 'AUTH_TOKEN_UNAVAILABLE\n');
});
