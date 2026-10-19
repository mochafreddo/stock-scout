import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function observation(symbol = 'AAPL', exchange = 'NAS') {
  return {
    requestedAt: '2026-10-18T00:00:00.000Z',
    receivedAt: '2026-10-18T00:00:01.000Z',
    request: {
      path: '/uapi/overseas-price/v1/quotations/search-info',
      params: { PDNO: symbol, PRDT_TYPE_CD: { NAS: '512', NYS: '513', AMS: '529' }[exchange] },
      secret: 'input-secret',
    },
    rows: [{ ovrs_stck_dvsn_cd: '01', account: 'input-secret' }],
  };
}

function run(records = [observation()], scenario = 'ok', options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'stock-scout-types-'));
  try {
    const trace = join(home, 'trace');
    writeFileSync(trace, '', { mode: 0o600 });
    const files = records.map((record, index) => {
      const path = join(home, `${index}.json`);
      writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
      return path;
    });
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        new URL('./security-type-http-mock.mjs', import.meta.url).pathname,
        new URL('../scripts/security-type-probe.ts', import.meta.url).pathname,
        ...(options.args ?? files),
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: { PATH: process.env.PATH, HOME: home, TEST_TRACE: trace, SCENARIO: scenario },
      },
    );
    return {
      ...result,
      requests: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function diagnostic(result, code) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /input-secret|remote-secret|test-private-value/);
  const report = JSON.parse(result.stderr);
  assert.equal(report.error, code);
  return report;
}

test('CLI rejects missing input and invalid saved KIS metadata before any request', () => {
  diagnostic(run([], 'ok', { args: [] }), 'USAGE');
  for (const change of [
    { receivedAt: 'yesterday' },
    { receivedAt: '2026-02-30T00:00:00.000Z' },
    { receivedAt: '2026-10-17T00:00:00.000Z' },
    { rows: [] },
    { request: { path: 'https://example.com', params: {} } },
    {
      request: {
        path: '/uapi/overseas-price/v1/quotations/search-info',
        params: { PDNO: 'bad?', PRDT_TYPE_CD: '512' },
      },
    },
  ]) {
    const result = run([{ ...observation(), ...change }]);
    diagnostic(result, 'INPUT_INVALID');
    assert.deepEqual(result.requests, []);
  }
});

test('CLI discovers fresh SEC sources and reports only an unverified historical diagnostic', () => {
  const result = run();
  const report = diagnostic(result, 'CURRENTNESS_UNVERIFIED');
  assert.equal(report.validation, 'unverified');
  assert.equal(report.runtimeEligible, false);
  assert.equal(report.observations[0].symbol, 'AAPL');
  assert.equal(report.observations[0].kisObservedAt, '2026-10-18T00:00:01.000Z');
  assert.equal(report.observations[0].filing.accessionNumber, '0000001000-26-000001');
  assert.equal(report.observations[0].instrumentType, 'unverified');
  assert.deepEqual(result.requests, [
    'https://www.sec.gov/files/company_tickers_exchange.json',
    'https://data.sec.gov/submissions/CIK0000001000.json',
    'https://www.sec.gov/Archives/edgar/data/1000/000000100026000001/index.json',
    'https://www.sec.gov/Archives/edgar/data/1000/000000100026000001/example_htm.xml',
  ]);
  assert.equal(report.sources.length, 4);
  for (const source of report.sources) {
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(source.bytes > 0);
    assert.ok(Number.isFinite(Date.parse(source.receivedAt)));
  }
});

test('CLI observes common stock and distinct ADS rights through expanded per-security contexts', () => {
  const report = diagnostic(
    run([
      observation(),
      observation('BBD', 'NYS'),
      observation('BBDO', 'NYS'),
      observation('TSM', 'NYS'),
    ]),
    'CURRENTNESS_UNVERIFIED',
  );
  assert.deepEqual(
    report.observations.map((row) => row.reportedType),
    ['common', 'adr_preferred', 'adr_common', 'common'],
  );
  const preferred = report.observations[1];
  const ordinary = report.observations[2];
  assert.equal(preferred.evidence[0].contextRef, 'security0');
  assert.equal(ordinary.evidence[0].contextRef, 'security1');
  assert.equal(preferred.evidence[0].title, ordinary.evidence[0].title);
  assert.equal(
    preferred.evidence[0].dimensions[0].member,
    '{https://xbrl.ifrs.org/taxonomy/2025-03-27/ifrs-full}PreferenceSharesMember',
  );
  assert.equal(
    ordinary.evidence[0].dimensions[0].member,
    '{https://xbrl.ifrs.org/taxonomy/2025-03-27/ifrs-full}OrdinarySharesMember',
  );
  for (const row of report.observations) {
    assert.equal(row.instrumentType, 'unverified');
    assert.equal(row.currentness, 'unverified');
  }
  assert.equal(report.observations[3].reason, 'DIRECT_OR_UNDERLYING_RIGHT_UNRESOLVED');
});

test('CLI accepts saved master microseconds and keeps depositary and optional identifiers explicit', () => {
  const master = {
    receivedAt: '2026-10-19T04:20:39.916441+00:00',
    columns: 24,
    encoding: 'cp949',
    rows: [
      {
        exchangeCode: 'NYS',
        symbol: 'TSM',
        securityType: '2',
        dr: 'Y',
        etpType: '   ',
        englishName: 'input-secret',
      },
    ],
  };
  const row = diagnostic(run([master]), 'CURRENTNESS_UNVERIFIED').observations[0];
  assert.equal(row.kisObservedAt, '2026-10-19T04:20:39.916441+00:00');
  assert.equal(row.kisFields.dr, 'Y');
  assert.equal(row.reportedType, 'common');
  assert.equal(row.reason, 'DEPOSITARY_LINK_UNRESOLVED');
  assert.equal(row.instrumentType, 'unverified');
  assert.deepEqual(row.identifiers, {});
  const bad = structuredClone(master);
  bad.receivedAt = '2026-02-30T04:20:39.916441+00:00';
  diagnostic(run([bad]), 'INPUT_INVALID');
});

test('CLI fails contradictory saved security identifiers before making a request', () => {
  const a = observation();
  a.rows[0].std_pdno = 'US0378331005';
  const b = observation();
  b.rows[0].std_pdno = 'US02079K3059';
  const result = run([a, b]);
  diagnostic(result, 'IDENTITY_AMBIGUOUS');
  assert.deepEqual(result.requests, []);
});

test('CLI detects cross-field ISIN conflicts across saved observations before fetching', () => {
  const standard = observation();
  standard.rows[0].std_pdno = 'US0378331005';
  const explicit = observation();
  explicit.rows[0].istt_usge_isin_cd = 'US02079K3059';
  for (const records of [
    [standard, explicit],
    [explicit, standard],
  ]) {
    const result = run(records);
    diagnostic(result, 'IDENTITY_AMBIGUOUS');
    assert.deepEqual(result.requests, []);
  }
  explicit.rows[0].istt_usge_isin_cd = 'US0378331005';
  const report = diagnostic(run([standard, explicit]), 'CURRENTNESS_UNVERIFIED');
  assert.deepEqual(
    report.observations.map((row) => row.identifiers),
    [{ std_pdno: 'US0378331005' }, { istt_usge_isin_cd: 'US0378331005' }],
  );
});

test('CLI retains raw-field identity conflicts when identifier formats differ', () => {
  const a = observation();
  a.rows[0].std_pdno = 'US0378331005';
  const b = observation();
  b.rows[0].std_pdno = '123456789';
  const result = run([a, b]);
  diagnostic(result, 'IDENTITY_AMBIGUOUS');
  assert.deepEqual(result.requests, []);
});

test('CLI uses semantic namespaces and same-security context rather than prefixes or issuer-wide titles', () => {
  for (const scenario of ['spoof-dei', 'missing-title', 'wrong-context']) {
    const report = diagnostic(run([observation()], scenario), 'CURRENTNESS_UNVERIFIED');
    assert.equal(report.observations[0].reportedType, 'unknown', scenario);
  }
  const report = diagnostic(
    run([observation('BBDO', 'NYS')], 'spoof-rights'),
    'CURRENTNESS_UNVERIFIED',
  );
  assert.equal(report.observations[0].reportedType, 'unknown');
});

test('CLI rejects malformed XML, DTD declarations and unsafe context references without source text', () => {
  for (const [scenario, error] of [
    ['malformed-xml', 'SOURCE_XML_FAILURE'],
    ['doctype', 'SOURCE_XML_FAILURE'],
    ['unsafe-context', 'SOURCE_SHAPE'],
  ]) {
    const report = diagnostic(run([observation()], scenario), error);
    assert.equal(report.observations, undefined);
  }
});

for (const scenario of ['duplicate-instant', 'mixed-period', 'reversed-period']) {
  test(`CLI rejects invalid XBRL reporting periods with ${scenario}`, () => {
    const report = diagnostic(run([observation()], scenario), 'SOURCE_SHAPE');
    assert.equal(report.observations, undefined);
  });
}

test('CLI accepts valid XBRL reporting periods with one ordered duration', () => {
  const report = diagnostic(run([observation()], 'valid-duration'), 'CURRENTNESS_UNVERIFIED');
  assert.deepEqual(report.observations[0].evidence[0].period, {
    startDate: '2025-01-01',
    endDate: '2025-12-31',
  });
});

test('CLI attributes a cached XML context failure to the consumed source rather than the last fetch', () => {
  const result = run(
    [observation('BBD', 'NYS'), observation('AAPL'), observation('BBDO', 'NYS')],
    'cached-context-error',
  );
  const report = diagnostic(result, 'SOURCE_SHAPE');
  assert.deepEqual(report.failedSource, {
    url: 'https://www.sec.gov/Archives/edgar/data/1001/000000100026000001/example_htm.xml',
    status: 200,
  });
  assert.equal(result.requests.filter((url) => url.endsWith('/example_htm.xml')).length, 2);
  assert.equal(
    result.requests.at(-1),
    'https://www.sec.gov/Archives/edgar/data/1000/000000100026000001/example_htm.xml',
  );
  assert.equal(report.observations, undefined);
});

test('CLI distinguishes unresolved type conflict from ambiguous issuer or security identity', () => {
  const report = diagnostic(run([observation()], 'title-conflict'), 'CURRENTNESS_UNVERIFIED');
  assert.equal(report.observations[0].reportedType, 'unknown');
  assert.equal(report.observations[0].reason, 'CONFLICTING_SEC_CONTEXT');
  for (const scenario of ['ambiguous-issuer', 'ambiguous-context'])
    diagnostic(run([observation()], scenario), 'IDENTITY_AMBIGUOUS');
  const input = observation();
  input.rows[0].ovrs_stck_dvsn_cd = '04';
  const conflicting = diagnostic(run([input]), 'CURRENTNESS_UNVERIFIED').observations[0];
  assert.equal(conflicting.reportedType, 'unknown');
  assert.equal(conflicting.reason, 'KIS_TYPE_CONFLICT');
  assert.equal(conflicting.evidence[0].reportedType, 'common');
});

test('CLI retains raw symbols and does not assume a single exchange for KIS AMS', () => {
  for (const [symbol, exchange, reason] of [
    ['BAC/B', 'NYS', 'NO_SEC_TICKER_MATCH'],
    ['SPY', 'AMS', 'EXCHANGE_LINK_UNSUPPORTED'],
  ]) {
    const result = run([observation(symbol, exchange)]);
    const row = diagnostic(result, 'CURRENTNESS_UNVERIFIED').observations[0];
    assert.equal(row.symbol, symbol);
    assert.equal(row.reason, reason);
    assert.equal(result.requests.length, 1);
  }
});

test('CLI applies the same reported-title rules to unseen symbols and preserves separate share classes', () => {
  const result = run([observation('ZZGENERIC'), observation('GOOG'), observation('GOOGL')]);
  const report = diagnostic(result, 'CURRENTNESS_UNVERIFIED');
  assert.deepEqual(
    report.observations.map((row) => row.symbol),
    ['ZZGENERIC', 'GOOG', 'GOOGL'],
  );
  assert.deepEqual(
    report.observations.map((row) => row.reportedType),
    ['common', 'capital_stock', 'common'],
  );
  assert.equal(result.requests.filter((url) => url.includes('CIK0000001002')).length, 1);
});

test('CLI stops on unsupported amended or missing extracted instances rather than reusing older evidence', () => {
  for (const [scenario, reason, requests] of [
    ['amendment', 'ANNUAL_AMENDMENT_UNSUPPORTED', 2],
    ['no-instance', 'EXTRACTED_INSTANCE_UNSUPPORTED', 3],
  ]) {
    const result = run([observation()], scenario);
    assert.equal(diagnostic(result, 'CURRENTNESS_UNVERIFIED').observations[0].reason, reason);
    assert.equal(result.requests.length, requests);
  }
  diagnostic(run([observation()], 'unsafe-filing-path'), 'SOURCE_SHAPE');
});

for (const scenario of [
  'missing-index-name',
  'numeric-index-name',
  'empty-index-name',
  'whitespace-index-name',
]) {
  test(`CLI rejects malformed accession index names with ${scenario}`, () => {
    const result = run([observation()], scenario);
    const report = diagnostic(result, 'SOURCE_SHAPE');
    assert.deepEqual(report.failedSource, {
      url: 'https://www.sec.gov/Archives/edgar/data/1000/000000100026000001/index.json',
      status: 200,
    });
    assert.equal(result.requests.length, 3);
    assert.equal(report.observations, undefined);
  });
}

test('CLI reports safe HTTP status and rejects transport, malformed or oversized required responses', () => {
  for (const [scenario, error, status] of [
    ['http', 'SOURCE_HTTP_FAILURE', 403],
    ['rate-limit', 'SOURCE_HTTP_FAILURE', 429],
    ['redirect', 'SOURCE_HTTP_FAILURE', 302],
    ['transport', 'SOURCE_REQUEST_FAILED', undefined],
    ['bad-json', 'SOURCE_SHAPE', undefined],
    ['declared-oversize', 'COLLECTION_LIMIT', 200],
    ['actual-oversize', 'COLLECTION_LIMIT', 200],
    ['truncated', 'SOURCE_SHAPE', 200],
    ['deadline', 'COLLECTION_LIMIT', 200],
    ['deadline-during-interval', 'COLLECTION_LIMIT', undefined],
  ]) {
    const result = run([observation()], scenario);
    const report = diagnostic(result, error);
    if (status !== undefined) assert.equal(report.failedSource.status, status, scenario);
    assert.equal(report.observations, undefined);
    assert.equal(result.requests.length, 1);
  }
});

test('CLI enforces the per-run request ceiling without publishing a partial result', () => {
  const ranking = {
    ...observation(),
    request: { path: '/uapi/overseas-stock/v1/ranking/trade-vol', params: { EXCD: 'NAS' } },
    rows: Array.from({ length: 20 }, (_, index) => ({ symb: `GEN${index}`, excd: 'NAS' })),
  };
  const result = run([ranking], 'request-limit');
  const report = diagnostic(result, 'COLLECTION_LIMIT');
  assert.equal(result.requests.length, 40);
  assert.equal(report.observations, undefined);
});

test('CLI observes explicit excluded security titles without promoting underlying common-stock words', () => {
  for (const [scenario, expected] of [
    ['type-warrant', 'warrant'],
    ['type-preferred', 'preferred'],
    ['type-etf', 'etf'],
    ['type-etn', 'etn'],
    ['unsupported-ads', 'unknown'],
    ['purchase-warrant', 'warrant'],
    ['mixed-unit', 'unknown'],
  ]) {
    const report = diagnostic(run([observation()], scenario), 'CURRENTNESS_UNVERIFIED');
    assert.equal(report.observations[0].reportedType, expected, scenario);
    assert.equal(report.runtimeEligible, false);
  }
});

test('CLI accepts a native 100-row ranking page and reports input resource ceilings separately', () => {
  const ranking = {
    ...observation(),
    request: { path: '/uapi/overseas-stock/v1/ranking/trade-pbmn', params: { EXCD: 'NAS' } },
    rows: Array.from({ length: 100 }, (_, index) => ({ symb: `UNSEEN${index}`, excd: 'NAS' })),
  };
  const report = diagnostic(run([ranking]), 'CURRENTNESS_UNVERIFIED');
  assert.equal(report.observations.length, 100);
  assert.equal(report.limits.maxSecurities, 1000);
  const excessive = {
    ...ranking,
    rows: Array.from({ length: 1001 }, () => ({ symb: 'AAPL', excd: 'NAS' })),
  };
  const result = run([excessive]);
  diagnostic(result, 'INPUT_LIMIT');
  assert.deepEqual(result.requests, []);
});
