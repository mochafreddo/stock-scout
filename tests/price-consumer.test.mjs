import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fixture, runCli } from './toss-cli-helper.mjs';

const reportAsOf = '2026-11-06T15:45:00Z';

async function consume(t, timestamp, threshold) {
  const f = fixture();
  t.after(f.close);
  const row = {
    symbol: 'DEMO',
    lastPrice: '10.0100',
    currency: 'USD',
    ...(timestamp === undefined ? {} : { timestamp }),
  };
  const query = await runCli(
    f,
    [{ body: { result: [row] }, freezeAt: '2026-11-06T15:40:00Z' }],
    ['prices', 'DEMO', ...(threshold === undefined ? [] : [`staleAfterSeconds=${threshold}`])],
    { TEST_CLOCK_START: String(Date.parse('2026-11-06T15:40:00Z')) },
  );
  assert.equal(query.status, 0, query.stderr);
  assert.equal(query.requests.filter((r) => r.path === '/api/v1/prices').length, 1);
  const result = spawnSync(process.execPath, ['examples/price-consumer.mjs', reportAsOf], {
    input: query.stdout,
    encoding: 'utf8',
    timeout: 10000,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.query, JSON.parse(query.stdout));
  assert.equal(output.report.asOf, reportAsOf);
  return output;
}

test('consumer recalculates elapsed time at the report instant and preserves the query', async (t) => {
  const output = await consume(t, '2026-11-06T15:29:59Z');
  assert.equal(output.query.data[0].priceAge.exceedsThreshold, false);
  assert.deepEqual(output.report.prices, [
    {
      symbol: 'DEMO',
      lastPrice: '10.0100',
      currency: 'USD',
      timestamp: '2026-11-06T15:29:59Z',
      classification: 'reference_price',
      priceAge: { seconds: 901, thresholdSeconds: 900, exceedsThreshold: true },
    },
  ]);
});

for (const [name, timestamp, threshold, seconds, classification] of [
  ['below default', '2026-11-06T15:30:01Z', undefined, 899, 'within_threshold'],
  ['equal default', '2026-11-06T15:30:00Z', undefined, 900, 'within_threshold'],
  ['custom threshold', '2026-11-06T15:39:59Z', 300, 301, 'reference_price'],
  ['equal custom threshold', '2026-11-06T15:40:00Z', 300, 300, 'within_threshold'],
  [
    'fraction above threshold',
    '2026-11-06T15:29:59.999999999Z',
    undefined,
    900.000000001,
    'reference_price',
  ],
  ['zero threshold', '2026-11-06T15:45:00Z', 0, 0, 'within_threshold'],
]) {
  test(`consumer classifies ${name}`, async (t) => {
    const output = await consume(t, timestamp, threshold);
    assert.deepEqual(output.report.prices[0].priceAge, {
      seconds,
      thresholdSeconds: threshold ?? 900,
      exceedsThreshold: classification === 'reference_price',
    });
    assert.equal(output.report.prices[0].classification, classification);
  });
}

for (const [name, timestamp, reason] of [
  ['missing', undefined, 'timestamp_missing'],
  ['null', null, 'timestamp_null'],
  ['future', '2026-11-06T15:45:00.000000001Z', 'timestamp_future'],
]) {
  test(`consumer separates ${name} source time from reference prices`, async (t) => {
    const output = await consume(t, timestamp);
    const price = output.report.prices[0];
    assert.equal(price.classification, 'timestamp_unknown');
    assert.equal(Object.hasOwn(price, 'timestamp'), name !== 'missing');
    assert.equal(price.timestamp, timestamp);
    assert.deepEqual(price.priceAge, {
      seconds: null,
      thresholdSeconds: 900,
      exceedsThreshold: null,
      unavailableReason: reason,
    });
  });
}

test('consumer rejects an invalid report instant and a failed query', () => {
  for (const [args, input] of [
    [[], '{}'],
    [['not-a-time'], '{}'],
    [[reportAsOf], '{"version":1,"status":"error","data":[]}'],
  ]) {
    const result = spawnSync(process.execPath, ['examples/price-consumer.mjs', ...args], {
      input,
      encoding: 'utf8',
      timeout: 10000,
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /TypeError/);
  }
});
