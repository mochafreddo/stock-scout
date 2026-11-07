import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, runCli } from './toss-cli-helper.mjs';

const day = {
  date: '2026-03-25',
  dayMarket: { startTime: '2026-03-25T09:00:00+09:00', endTime: '2026-03-25T16:50:00+09:00' },
  preMarket: { startTime: '2026-03-25T17:00:00+09:00', endTime: '2026-03-25T22:30:00+09:00' },
  regularMarket: { startTime: '2026-03-25T22:30:00+09:00', endTime: '2026-03-26T05:00:00+09:00' },
  afterMarket: { startTime: '2026-03-26T05:00:00+09:00', endTime: '2026-03-26T07:00:00+09:00' },
};
const closed = (date) => ({
  date,
  dayMarket: null,
  preMarket: null,
  regularMarket: null,
  afterMarket: null,
});
const calendar = {
  today: day,
  previousBusinessDay: closed('2026-03-24'),
  nextBusinessDay: closed('2026-03-26'),
};
async function lookup(t, result = calendar, args = ['sessions', day.date], extra, steps) {
  const f = fixture();
  t.after(f.close);
  const r = await runCli(
    f,
    steps ?? [{ path: '/api/v1/market-calendar/US', body: { result } }],
    args,
    extra,
  );
  return { ...r, out: JSON.parse(r.stdout) };
}

test('sessions sends the explicit US local date and preserves KST sessions without a market-hours gate', async (t) => {
  const r = await lookup(t);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stderr, '');
  assert.deepEqual(r.out.data, [calendar]);
  assert.deepEqual(r.out.omissions, []);
  assert.equal(r.out.source.dateTimeZone, 'America/New_York');
  assert.equal(r.out.source.sessionTimeZone, 'Asia/Seoul');
  assert.equal(r.out.source.date, day.date);
  assert.equal(r.out.source.freshness, 'unknown');
  assert.deepEqual(
    r.requests.map(({ method, path, query }) => [method, path, query]),
    [
      ['POST', '/oauth2/token', ''],
      ['GET', '/api/v1/market-calendar/US', '?date=2026-03-25'],
    ],
  );
});

test('constraints distinguishes documented API rules from unprovided symbol eligibility and app unknowns', async (t) => {
  const r = await lookup(t, calendar, ['constraints', 'AAPL', day.date]);
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.stderr, '');
  const c = r.out.data[0];
  assert.equal(c.symbol, 'AAPL');
  assert.equal(c.date, day.date);
  assert.equal(c.eligibility, 'unknown');
  assert.equal(c.eligibilityLookup, 'api_not_provided');
  assert.equal(c.appConditions, 'unknown');
  assert.equal(c.regular.availability, 'unknown');
  assert.equal(c.conditional.availability, 'unknown');
  assert.equal(c.fractional.availability, 'unknown');
  assert.deepEqual(c.fractional.acceptanceWindow, {
    status: 'documented_schedule',
    startTime: '2026-03-25T22:30:00+09:00',
    endTime: '2026-03-25T19:00:00.000Z',
    endBoundary: 'unknown',
  });
  assert.equal(c.fractional.quantitySellMaxScale, 6);
  assert.equal(c.fractional.minimumAmount, 'unknown');
  assert.equal(c.conditional.fractionalQuantity, 'unknown');
  assert.deepEqual(c.regular.orderTypes, ['LIMIT', 'MARKET']);
  assert.deepEqual(c.regular.timeInForce, { DAY: 'default', CLS: 'US_LIMIT_only', OPG: 'KR_only' });
  assert.deepEqual(c.regular.limitPriceScale, {
    belowOneUSD: 4,
    atLeastOneUSD: 2,
    excessDigits: 'truncated',
  });
  assert.deepEqual(c.conditional.orderTypes, {
    SINGLE: ['LIMIT', 'MARKET'],
    OCO: ['LIMIT'],
    OTO: ['LIMIT'],
  });
  assert.equal(c.conditional.triggerSessions, 'all_tradable_sessions');
  assert.equal(c.conditional.sessionSelection, 'not_supported');
  assert.equal(c.fractional.amountOrder, 'US_MARKET_only');
  assert.equal(c.fractional.quantityOrder, 'US_MARKET_SELL_only');
  assert.deepEqual(c.conditional.sides, { OCO: ['SELL', 'SELL'], OTO: ['BUY', 'SELL'] });
  assert.equal(c.conditional.ocoTriggerPrices, 'first_above_current_above_second');
  assert.deepEqual(c.highValueConfirmation, {
    thresholdAmount: '100000000',
    currency: 'KRW',
    required: true,
    conversion: 'unknown',
  });
  assert.equal(c.regular.amountAndQuantity, 'exactly_one');
  assert.equal(r.out.source.rulesVersion, '1.2.28');
  assert.equal(r.requests.at(-1).query, '?date=2026-03-25');
  assert.deepEqual(
    r.requests.map(({ method, path }) => [method, path]),
    [
      ['POST', '/oauth2/token'],
      ['GET', '/api/v1/market-calendar/US'],
    ],
  );
});

test('sessions preserves positive submillisecond intervals across offsets and fractional precision', async (t) => {
  for (const [startTime, endTime] of [
    ['2026-03-25T22:30:00.1234+09:00', '2026-03-25T22:30:00.1235+09:00'],
    ['2026-03-25T09:30:00.12340000000000000001-04:00', '2026-03-25T13:30:00.12340000000000000002Z'],
    ['2026-03-25T13:30:00Z', '2026-03-25T22:30:00.00000000000000000001+09:00'],
  ]) {
    const today = Object.fromEntries([
      ['date', day.date],
      ...['dayMarket', 'preMarket', 'regularMarket', 'afterMarket'].map((name) => [
        name,
        { startTime, endTime },
      ]),
    ]);
    const value = { ...calendar, today };
    const r = await lookup(t, value);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.stderr, '');
    assert.deepEqual(r.out.data, [value]);
    assert.deepEqual(r.out.omissions, []);
  }
});

test('fractional acceptance cutoff preserves provider submillisecond digits when subtracting an hour', async (t) => {
  for (const [endTime, expected] of [
    ['2026-03-26T05:00:00.1234+09:00', '2026-03-25T19:00:00.1234Z'],
    ['2026-03-25T20:00:00.00000000000000000001Z', '2026-03-25T19:00:00.00000000000000000001Z'],
    ['2026-03-25T16:00:00.123400-04:00', '2026-03-25T19:00:00.123400Z'],
    ['2026-03-26T05:00:00.1+09:00', '2026-03-25T19:00:00.100Z'],
    ['2026-03-26T05:00:00.12+09:00', '2026-03-25T19:00:00.120Z'],
    ['2026-03-26T00:30:00.99999999999999999999Z', '2026-03-25T23:30:00.99999999999999999999Z'],
  ]) {
    const regularMarket = { startTime: '2026-03-25T00:00:00-04:00', endTime };
    const r = await lookup(t, { ...calendar, today: { ...day, regularMarket } }, [
      'constraints',
      'AAPL',
      day.date,
    ]);
    assert.equal(r.status, 2, r.stdout);
    assert.equal(r.stderr, '');
    assert.deepEqual(r.out.data[0].fractional.acceptanceWindow, {
      status: 'documented_schedule',
      startTime: regularMarket.startTime,
      endTime: expected,
      endBoundary: 'unknown',
    });
    assert.deepEqual(r.out.data[0].calendar.today.regularMarket, regularMarket);
  }
});

test('sessions rejects equal and reversed submillisecond instants across offsets', async (t) => {
  for (const [startTime, endTime] of [
    ['2026-03-25T22:30:00.1235+09:00', '2026-03-25T13:30:00.1234Z'],
    ['2026-03-25T09:30:00.1234-04:00', '2026-03-25T22:30:00.123400+09:00'],
    ['2026-03-25T13:30:00.0000Z', '2026-03-25T22:30:00+09:00'],
    ['2026-03-25T13:30:00.12340000000000000002Z', '2026-03-25T13:30:00.12340000000000000001Z'],
  ]) {
    const r = await lookup(t, {
      ...calendar,
      today: { ...day, regularMarket: { startTime, endTime } },
    });
    assert.equal(r.status, 2, r.stdout);
    assert.equal(r.stderr, '');
    assert.equal('regularMarket' in r.out.data[0].today, false);
    assert.deepEqual(r.out.omissions, [
      { field: 'today.regularMarket', reason: 'invalid_session' },
    ]);
  }
});

test('fractional acceptance requires a strictly positive interval at submillisecond boundaries', async (t) => {
  for (const [endTime, expected] of [
    [
      '2026-03-25T14:30:00.12340000000000000002Z',
      {
        status: 'documented_schedule',
        startTime: '2026-03-25T22:30:00.12340000000000000001+09:00',
        endTime: '2026-03-25T13:30:00.12340000000000000002Z',
        endBoundary: 'unknown',
      },
    ],
    ['2026-03-25T10:30:00.1234000000000000000100-04:00', { status: 'unknown' }],
    ['2026-03-25T23:30:00.12340000000000000000+09:00', { status: 'unknown' }],
    ['2026-03-25T13:45:00Z', { status: 'unknown' }],
  ]) {
    const regularMarket = {
      startTime: '2026-03-25T22:30:00.12340000000000000001+09:00',
      endTime,
    };
    const r = await lookup(t, { ...calendar, today: { ...day, regularMarket } }, [
      'constraints',
      'AAPL',
      day.date,
    ]);
    assert.equal(r.status, 2, r.stdout);
    assert.equal(r.stderr, '');
    assert.deepEqual(r.out.data[0].calendar.today.regularMarket, regularMarket);
    assert.deepEqual(r.out.data[0].fractional.acceptanceWindow, expected);
  }
});

test('holidays, short sessions, standard time and local-clock changes use only provider sessions', async (t) => {
  for (const [today, expected] of [
    [closed('2026-07-03'), { status: 'closed' }],
    [
      {
        ...closed('2026-11-27'),
        regularMarket: {
          startTime: '2026-11-27T23:30:00+09:00',
          endTime: '2026-11-28T03:00:00+09:00',
        },
      },
      {
        status: 'documented_schedule',
        startTime: '2026-11-27T23:30:00+09:00',
        endTime: '2026-11-27T17:00:00.000Z',
        endBoundary: 'unknown',
      },
    ],
  ]) {
    const value = {
      today,
      previousBusinessDay: closed('2026-01-01'),
      nextBusinessDay: closed('2026-12-31'),
    };
    for (const now of ['2026-11-06T15:00:00Z', '2026-11-07T23:00:00Z']) {
      const r = await lookup(t, value, ['constraints', 'BRK.B', today.date], {
        TEST_CLOCK_START: String(Date.parse(now)),
      });
      assert.equal(r.status, 2, r.stdout);
      assert.deepEqual(r.out.data[0].fractional.acceptanceWindow, expected);
      assert.equal(r.out.data[0].eligibility, 'unknown');
      assert.deepEqual(r.out.data[0].calendar, value);
    }
  }
});

test('missing and malformed sessions remain partial and cannot turn into holiday or an acceptance window', async (t) => {
  for (const regularMarket of [
    undefined,
    {},
    { startTime: day.regularMarket.startTime, endTime: '2026-02-30T05:00:00+09:00' },
    { startTime: day.regularMarket.endTime, endTime: day.regularMarket.startTime },
  ]) {
    const today = { ...day, regularMarket, extra: 'private upstream message' };
    const r = await lookup(t, { ...calendar, today }, ['constraints', 'AAPL', day.date]);
    assert.equal(r.status, 2, r.stdout);
    assert.deepEqual(r.out.data[0].fractional.acceptanceWindow, { status: 'unknown' });
    assert.equal('regularMarket' in r.out.data[0].calendar.today, false);
    assert.ok(r.out.omissions.some((x) => x.field === 'today.regularMarket'));
    assert.doesNotMatch(r.stdout, /private upstream message/);
  }
  const r = await lookup(t, { ...calendar, previousBusinessDay: null });
  assert.equal(r.status, 2, r.stdout);
  assert.deepEqual(r.out.data, [{ today: day, nextBusinessDay: calendar.nextBusinessDay }]);
});

test('invalid dates and unsupported options fail before authentication', async (t) => {
  for (const date of [
    '2026-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-01',
    '2026-1-01',
    'today',
    '2026-03-25T00:00:00Z',
  ]) {
    for (const args of [
      ['sessions', date],
      ['constraints', 'AAPL', date],
    ]) {
      const r = await lookup(t, calendar, args);
      assert.equal(r.out.error.code, 'INPUT_INVALID');
      assert.equal(r.status, 1);
      assert.equal(r.stderr.trim(), 'INPUT_INVALID');
      assert.deepEqual(r.requests, []);
    }
  }
  for (const args of [
    ['sessions'],
    ['sessions', day.date, 'extra'],
    ['constraints', 'AAPL'],
    ['constraints', 'AAPL,MSFT', day.date],
    ['constraints', 'AAPL/OTHER', day.date],
    ['constraints', 'AAPL', day.date, 'extra'],
  ]) {
    const r = await lookup(t, calendar, args);
    assert.equal(r.out.error.code, 'INPUT_INVALID');
    assert.deepEqual(r.requests, []);
  }
  const r = await lookup(
    t,
    {
      today: closed('2028-02-29'),
      previousBusinessDay: closed('2028-02-28'),
      nextBusinessDay: closed('2028-03-01'),
    },
    ['sessions', '2028-02-29'],
  );
  assert.equal(r.status, 0, r.stdout);
});

test('invalid envelopes, mismatched dates and no usable requested sessions are errors', async (t) => {
  for (const value of [
    null,
    [],
    {},
    { ...calendar, today: null },
    { ...calendar, today: closed('2026-03-24') },
    { ...calendar, today: { ...day, date: '2026-03-24' } },
    { ...calendar, today: { date: day.date } },
    { ...calendar, today: { ...day, date: '2026-02-30' } },
  ]) {
    const r = await lookup(t, value);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.out.error.code, 'RESPONSE_INVALID');
    assert.deepEqual(r.out.data, []);
  }
});

test('session commands retain permission and bounded rate errors with safe diagnostics and GET-only reads', async (t) => {
  for (const args of [
    ['sessions', day.date],
    ['constraints', 'AAPL', day.date],
  ]) {
    for (const [step, code, count] of [
      [
        {
          status: 403,
          body: {
            error: {
              code: 'ip-not-allowed',
              requestId: 'SAFE_1',
              message: 'private upstream message',
            },
          },
        },
        'PERMISSION_DENIED',
        1,
      ],
      [{ status: 429, body: { error: { code: 'rate-limit-exceeded' } } }, 'RATE_LIMIT', 2],
      [{ status: 429, headers: { 'Retry-After': '60' }, body: {} }, 'TIMEOUT', 1],
      [{ hang: true }, 'TIMEOUT', 1],
      [{ status: 401, body: { error: { code: 'invalid-token' } } }, 'AUTH_FAILED', 1],
    ]) {
      const r = await lookup(
        t,
        calendar,
        args,
        {},
        Array.from({ length: count }, () => ({ ...step, path: '/api/v1/market-calendar/US' })),
      );
      assert.equal(r.status, 1, r.stdout);
      assert.equal(r.out.error.code, code);
      assert.equal(r.stderr.trim(), code);
      assert.equal(r.requests.filter((x) => x.method === 'GET').length, count);
      assert.ok(r.requests.every((x) => x.method === 'GET' || x.path === '/oauth2/token'));
      assert.doesNotMatch(
        r.stdout + r.stderr,
        /private upstream message|synthetic-(secret|token|client)/,
      );
    }
  }
});

test('help discovers session and constraint commands without authentication', async (t) => {
  const r = await lookup(t, calendar, ['--help']);
  assert.equal(r.status, 0);
  for (const name of ['sessions', 'constraints'])
    assert.ok(r.out.data.commands.some((x) => x.name === name));
  assert.deepEqual(r.requests, []);
});

test('regular session dates must match the owning US local day before deriving a fractional window', async (t) => {
  for (const regularMarket of [
    day.regularMarket,
    { startTime: '2026-11-27T23:30:00+09:00', endTime: '2026-11-29T03:00:00+09:00' },
  ]) {
    const today = {
      ...closed('2026-11-27'),
      preMarket: { startTime: '2026-11-27T18:00:00+09:00', endTime: '2026-11-27T23:30:00+09:00' },
      regularMarket,
    };
    const r = await lookup(
      t,
      { today, previousBusinessDay: closed('2026-11-26'), nextBusinessDay: closed('2026-11-30') },
      ['constraints', 'AAPL', '2026-11-27'],
    );
    assert.equal(r.status, 2, r.stdout);
    assert.equal('regularMarket' in r.out.data[0].calendar.today, false);
    assert.deepEqual(r.out.data[0].fractional.acceptanceWindow, { status: 'unknown' });
    assert.ok(
      r.out.omissions.some(
        (x) => x.field === 'today.regularMarket' && x.reason === 'invalid_session',
      ),
    );
  }
});

test('all session intervals belong to their US day, including day market crossing New York midnight', async (t) => {
  for (const name of ['dayMarket', 'preMarket', 'afterMarket']) {
    const today = {
      ...day,
      [name]: { startTime: '2026-11-27T09:00:00+09:00', endTime: '2026-11-27T16:00:00+09:00' },
    };
    const r = await lookup(t, { ...calendar, today });
    assert.equal(r.status, 2, r.stdout);
    assert.equal(name in r.out.data[0].today, false);
    assert.ok(
      r.out.omissions.some((x) => x.field === `today.${name}` && x.reason === 'invalid_session'),
    );
  }
});
