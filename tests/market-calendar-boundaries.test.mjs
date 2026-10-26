import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCalendar } from './market-calendar-cli-helper.mjs';

function recordAt(at, env = {}) {
  const result = runCalendar(['--at', at], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function expectSessions(
  at,
  dataDate,
  dataOpen,
  dataClose,
  targetDate,
  targetOpen,
  targetClose,
  analysisEligible,
) {
  const record = recordAt(at);
  assert.equal(record.evaluatedAt, new Date(at).toISOString());
  assert.deepEqual(record.dataSession, { date: dataDate, open: dataOpen, close: dataClose });
  assert.deepEqual(record.targetSession, {
    date: targetDate,
    open: targetOpen,
    close: targetClose,
  });
  assert.equal(record.analysisEligible, analysisEligible);
}

test('regular session boundaries use the NYSE clock on both sides of open and close', () => {
  const cases = [
    [
      '2026-10-26T13:29:59Z',
      '2026-10-23',
      '2026-10-23T13:30:00.000Z',
      '2026-10-23T20:00:00.000Z',
      '2026-10-26',
      '2026-10-26T13:30:00.000Z',
      '2026-10-26T20:00:00.000Z',
      true,
    ],
    [
      '2026-10-26T13:30:00Z',
      '2026-10-23',
      '2026-10-23T13:30:00.000Z',
      '2026-10-23T20:00:00.000Z',
      '2026-10-27',
      '2026-10-27T13:30:00.000Z',
      '2026-10-27T20:00:00.000Z',
      false,
    ],
    [
      '2026-10-26T13:30:01Z',
      '2026-10-23',
      '2026-10-23T13:30:00.000Z',
      '2026-10-23T20:00:00.000Z',
      '2026-10-27',
      '2026-10-27T13:30:00.000Z',
      '2026-10-27T20:00:00.000Z',
      false,
    ],
    [
      '2026-10-26T19:59:59Z',
      '2026-10-23',
      '2026-10-23T13:30:00.000Z',
      '2026-10-23T20:00:00.000Z',
      '2026-10-27',
      '2026-10-27T13:30:00.000Z',
      '2026-10-27T20:00:00.000Z',
      false,
    ],
    [
      '2026-10-26T20:00:00Z',
      '2026-10-26',
      '2026-10-26T13:30:00.000Z',
      '2026-10-26T20:00:00.000Z',
      '2026-10-27',
      '2026-10-27T13:30:00.000Z',
      '2026-10-27T20:00:00.000Z',
      true,
    ],
    [
      '2026-10-23T20:00:00Z',
      '2026-10-23',
      '2026-10-23T13:30:00.000Z',
      '2026-10-23T20:00:00.000Z',
      '2026-10-26',
      '2026-10-26T13:30:00.000Z',
      '2026-10-26T20:00:00.000Z',
      true,
    ],
    [
      '2026-10-24T12:00:00Z',
      '2026-10-23',
      '2026-10-23T13:30:00.000Z',
      '2026-10-23T20:00:00.000Z',
      '2026-10-26',
      '2026-10-26T13:30:00.000Z',
      '2026-10-26T20:00:00.000Z',
      true,
    ],
    [
      '2026-10-26T04:00:00Z',
      '2026-10-23',
      '2026-10-23T13:30:00.000Z',
      '2026-10-23T20:00:00.000Z',
      '2026-10-26',
      '2026-10-26T13:30:00.000Z',
      '2026-10-26T20:00:00.000Z',
      true,
    ],
  ];
  for (const [at, ...expected] of cases) expectSessions(at, ...expected);
});

test('daylight saving changes and official holiday and early close dates select the adjacent sessions', () => {
  const cases = [
    [
      '2026-11-02T14:29:59Z',
      '2026-10-30',
      '2026-10-30T13:30:00.000Z',
      '2026-10-30T20:00:00.000Z',
      '2026-11-02',
      '2026-11-02T14:30:00.000Z',
      '2026-11-02T21:00:00.000Z',
      true,
    ],
    [
      '2026-11-02T14:30:00Z',
      '2026-10-30',
      '2026-10-30T13:30:00.000Z',
      '2026-10-30T20:00:00.000Z',
      '2026-11-03',
      '2026-11-03T14:30:00.000Z',
      '2026-11-03T21:00:00.000Z',
      false,
    ],
    [
      '2026-03-06T21:00:00Z',
      '2026-03-06',
      '2026-03-06T14:30:00.000Z',
      '2026-03-06T21:00:00.000Z',
      '2026-03-09',
      '2026-03-09T13:30:00.000Z',
      '2026-03-09T20:00:00.000Z',
      true,
    ],
    [
      '2026-11-26T18:00:00Z',
      '2026-11-25',
      '2026-11-25T14:30:00.000Z',
      '2026-11-25T21:00:00.000Z',
      '2026-11-27',
      '2026-11-27T14:30:00.000Z',
      '2026-11-27T18:00:00.000Z',
      true,
    ],
    [
      '2026-11-27T18:00:00Z',
      '2026-11-27',
      '2026-11-27T14:30:00.000Z',
      '2026-11-27T18:00:00.000Z',
      '2026-11-30',
      '2026-11-30T14:30:00.000Z',
      '2026-11-30T21:00:00.000Z',
      true,
    ],
    [
      '2026-12-24T18:00:00Z',
      '2026-12-24',
      '2026-12-24T14:30:00.000Z',
      '2026-12-24T18:00:00.000Z',
      '2026-12-28',
      '2026-12-28T14:30:00.000Z',
      '2026-12-28T21:00:00.000Z',
      true,
    ],
  ];
  for (const [at, ...expected] of cases) expectSessions(at, ...expected);
});

test('--at offset notation and process time zones do not change the evaluated sessions', () => {
  const utc = recordAt('2026-10-26T06:00:00Z');
  const offset = recordAt('2026-10-25T23:00:00-07:00');
  for (const tz of ['UTC', 'Asia/Seoul', 'America/Los_Angeles']) {
    const zoned = recordAt('2026-10-26T06:00:00Z', { TZ: tz });
    assert.equal(zoned.evaluatedAt, utc.evaluatedAt, tz);
    assert.deepEqual(zoned.dataSession, utc.dataSession, tz);
    assert.deepEqual(zoned.targetSession, utc.targetSession, tz);
    assert.equal(zoned.analysisEligible, utc.analysisEligible, tz);
  }
  assert.equal(offset.evaluatedAt, utc.evaluatedAt);
  assert.deepEqual(offset.dataSession, utc.dataSession);
  assert.deepEqual(offset.targetSession, utc.targetSession);
  assert.equal(offset.analysisEligible, utc.analysisEligible);

  const fixed = recordAt('2026-10-26T06:00:00Z', { TEST_NOW: '2025-01-02T12:00:00Z' });
  assert.equal(fixed.evaluatedAt, utc.evaluatedAt);
  assert.deepEqual(fixed.dataSession, utc.dataSession);
  assert.deepEqual(fixed.targetSession, utc.targetSession);
  assert.equal(fixed.analysisEligible, utc.analysisEligible);
});

test('calendar requests beyond the shared Nasdaq year range fail without a partial result', () => {
  for (const at of [
    '2025-01-02T12:00:00Z',
    '2027-01-04T12:00:00Z',
    '2026-01-01T12:00:00Z',
    '2026-12-31T22:00:00Z',
  ]) {
    const result = runCalendar(['--at', at]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'CALENDAR_RANGE');
  }
});
