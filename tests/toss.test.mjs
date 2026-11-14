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

test('Toss CLI rejects invalid arguments before authentication and advertises commands as JSON', async () => {
  const f = fixture();
  try {
    for (const args of [
      [],
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
