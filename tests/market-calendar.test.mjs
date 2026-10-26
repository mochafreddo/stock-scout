import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCalendar as run } from './market-calendar-cli-helper.mjs';

test('calendar CLI reports Friday data and Monday target under an explicit bounded-notice assumption', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.evaluatedAt, '2026-10-26T06:00:00.000Z');
  assert.deepEqual(record.dataSession, {
    date: '2026-10-23',
    open: '2026-10-23T13:30:00.000Z',
    close: '2026-10-23T20:00:00.000Z',
  });
  assert.deepEqual(record.targetSession, {
    date: '2026-10-26',
    open: '2026-10-26T13:30:00.000Z',
    close: '2026-10-26T20:00:00.000Z',
  });
  assert.equal(record.analysisEligible, true);
  assert.equal(record.noticeCompleteness, 'unverified');
  assert.equal(result.stderr, '');
  for (const channel of ['1', '2']) {
    const request = result.requests.find(({ url }) => url.includes(`/system/${channel}/`));
    assert.ok(request);
    assert.equal(new URL(request.url).searchParams.get('pageSize'), '100');
    assert.equal(new URL(request.url).searchParams.get('pageNumber'), '0');
    assert.equal(new URL(request.url).searchParams.get('sortKey'), 'publishedDate');
    assert.equal(new URL(request.url).searchParams.get('sortOrder'), 'desc');
  }
});

test('invalid dates, missing offsets and extra arguments fail before any HTTP request', () => {
  for (const args of [
    ['--at', '2026-02-30T10:00:00Z'],
    ['--at', '2026-10-26T06:00:00'],
    ['--at', '2026-10-26T24:00:00Z'],
    ['--at', '2026-10-26T06:00:00+25:00'],
    ['--at'],
    ['--other'],
    ['--at', '2026-10-26T06:00:00Z', 'extra'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'USAGE');
    assert.deepEqual(result.requests, []);
  }
});

test('Nasdaq regular hours are checked against its fetched official reference, separately from system hours', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const guide = 'https://www.nasdaqtrader.com/content/productsservices/trading/oe_refguide.pdf';
  assert.ok(result.requests.some(({ url }) => url === guide));
  assert.ok(JSON.parse(result.stdout).sources.some(({ url }) => url === guide));
  const changed = run([], { SCENARIO: 'guide-hours-mismatch' });
  assert.equal(changed.status, 1);
  assert.equal(changed.stdout, '');
  assert.equal(JSON.parse(changed.stderr).error, 'EXCHANGE_MISMATCH');
});

test('current snapshots include NYSE children and fetched Nasdaq article bodies, with observed rather than continuous date coverage', () => {
  const result = run([], { SCENARIO: 'snapshot' });
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  const status = record.noticeCollections.find((entry) => entry.channel === 'NYSE Market Status');
  assert.equal(status.parentCount, 1);
  assert.equal(status.childCount, 1);
  assert.equal(status.totalAvailable, 1);
  assert.equal(status.continuousCoverage, 'unverified');
  const nasdaq = record.noticeCollections.find((entry) => entry.channel === 'Nasdaq Equity RSS');
  assert.equal(nasdaq.parentCount, 1);
  assert.equal(nasdaq.linkedBodyCount, 1);
  assert.ok(
    result.requests.some(
      ({ url }) => url === 'https://www.nasdaqtrader.com/TraderNews.aspx?id=ETA2026-1',
    ),
  );
});

test('a supported dated official mourning closure moves all three exchanges to Tuesday without using Monday data', () => {
  const result = run(['--at', '2026-10-26T22:00:00Z'], { SCENARIO: 'closure' });
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.dataSession.date, '2026-10-23');
  assert.equal(record.targetSession.date, '2026-10-27');
  assert.equal(record.targetSession.open, '2026-10-27T13:30:00.000Z');
  assert.equal(record.scheduleChanges.length, 2);
});

test('the output uses the current clock after collection crosses the opening boundary', () => {
  const result = run([], { SCENARIO: 'final-open' });
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.evaluatedAt, '2026-10-26T13:30:00.000Z');
  assert.equal(record.analysisEligible, false);
  assert.equal(record.targetSession.date, '2026-10-27');
});

test('a final clock advance across open invalidates the initially calculated eligible result', () => {
  const result = run([], { SCENARIO: 'calculation-open' });
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.evaluatedAt, '2026-10-26T13:30:00.000Z');
  assert.equal(record.analysisEligible, false);
  assert.equal(record.targetSession.date, '2026-10-27');
});

test('unknown notices, truncated pages, source failures, exchange disagreement and final year changes never leave partial success', () => {
  for (const [scenario, error, args] of [
    ['unknown-notice', 'NOTICE_UNRESOLVED', []],
    ['truncated-nyse', 'SOURCE_SHAPE', []],
    ['http-failure', 'SOURCE_HTTP_FAILURE', []],
    ['transport-failure', 'REQUEST_FAILED', []],
    ['oversize', 'COLLECTION_LIMIT', []],
    ['final-year', 'CALENDAR_RANGE', []],
    ['mismatch', 'EXCHANGE_MISMATCH', ['--at', '2026-11-27T17:00:00Z']],
    ['ams-hours', 'EXCHANGE_MISMATCH', []],
  ]) {
    const result = run(args, { SCENARIO: scenario });
    assert.equal(result.status, 1, scenario);
    assert.equal(result.stdout, '', scenario);
    assert.equal(JSON.parse(result.stderr).error, error, scenario);
    assert.doesNotMatch(result.stderr, /PRIVATE-/);
  }
});

test('the supported full-body security listing and normal-operations formats do not require session hours', () => {
  for (const body of [
    'NYSE markets are operational and we expect a normal open this morning.',
    'NYSE American has determined that the shares are part of a new security offering that will trade under the ticker GUNN with CUSIP 402880207.',
  ]) {
    const result = run([], { NYSE_BODY: body });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).targetSession.date, '2026-10-26');
  }
  const listing = run([], {
    SCENARIO: 'article',
    NASDAQ_BODY:
      'Effective Tuesday, February 8, 2022, Nasdaq will list the following ETF: Example ETF (Ticker: TEST).',
  });
  assert.equal(listing.status, 0, listing.stderr);
});

test('an announced future expansion is deferred only before its effective date and never treated as a test-only notice', () => {
  const body =
    'To prepare for the launch of nearly continuous 23-hour, 5-day trading on the Nasdaq Stock Market beginning December 6, 2026, Nasdaq is offering the following testing opportunities.';
  const before = run([], { SCENARIO: 'article', NASDAQ_BODY: body });
  assert.equal(before.status, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).deferredNotices[0].effectiveDate, '2026-12-06');
  const effective = run(['--at', '2026-12-04T22:00:00Z'], {
    SCENARIO: 'article',
    NASDAQ_BODY: body,
  });
  assert.equal(effective.status, 1);
  assert.equal(effective.stdout, '');
  assert.equal(JSON.parse(effective.stderr).error, 'NOTICE_UNRESOLVED');
  const correction = run([], { SCENARIO: 'marked-expansion', NASDAQ_BODY: body });
  assert.equal(correction.status, 1);
  assert.equal(correction.stdout, '');
  assert.equal(JSON.parse(correction.stderr).error, 'NOTICE_UNRESOLVED');
});

test('trailing whitespace in the official NYSE market label keeps the explicit venue identity', () => {
  const result = run([], {
    SCENARIO: 'trailing-market',
    NYSE_BODY: 'NYSE markets are operational and we expect a normal open this morning.',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('a known non-session clause cannot hide an unresolved calendar change in the same body or a child update', () => {
  for (const env of [
    { NYSE_BODY: 'NYSE markets are operational. NYSE will not open tomorrow.' },
    {
      NYSE_BODY: 'NYSE markets are operational.',
      NYSE_CHILD: 'The regular trading session is postponed; timing is not yet confirmed.',
    },
    {
      SCENARIO: 'article',
      NASDAQ_BODY:
        'Nasdaq will begin listing and trading the following exchange-traded funds: Example ETF (TEST). Nasdaq will not open tomorrow.',
    },
    {
      SCENARIO: 'article',
      NASDAQ_BODY:
        'Nasdaq U.S. equities and options markets will be closed on Monday, October 26, 2026, in observance of a National Day of Mourning. The next opening auction has been moved to 10:00 a.m.',
    },
    {
      SCENARIO: 'article',
      NASDAQ_BODY:
        'To prepare for the launch of nearly continuous 23-hour, 5-day trading on the Nasdaq Stock Market beginning December 6, 2026, Nasdaq is offering the following testing opportunities. Another immediate schedule change will be announced.',
    },
  ]) {
    const result = run([], env);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'NOTICE_UNRESOLVED');
  }
});

test('a closure whose weekday conflicts with its numeric date fails instead of choosing either interpretation', () => {
  const result = run(['--at', '2026-10-27T22:00:00Z'], {
    SCENARIO: 'closure',
    CLOSURE_DATE: 'Monday, October 27, 2026',
  });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'SOURCE_SHAPE');
  const footnote = run(['--at', '2026-11-27T17:00:00Z'], { SCENARIO: 'footnote-weekday' });
  assert.equal(footnote.status, 1);
  assert.equal(footnote.stdout, '');
  assert.equal(JSON.parse(footnote.stderr).error, 'SOURCE_SHAPE');
});

test('a replacement child closure is not inferred to be an additional holiday even if other exchange dates match the union', () => {
  for (const scenario of ['correction', 'ambiguous-child', 'marked-closure']) {
    const result = run(['--at', '2026-10-26T22:00:00Z'], { SCENARIO: scenario });
    assert.equal(result.status, 1, scenario);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'NOTICE_UNRESOLVED');
  }
});
