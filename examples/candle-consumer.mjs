import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compareNonnegativeDecimals,
  decimal,
  laterThan,
  record,
  symbolPattern,
  validTime,
} from '../scripts/toss-values.ts';

const tradeDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function closeChange(bars) {
  const newest = bars[0];
  const oldest = bars.at(-1);
  let reason;
  if (!laterThan(newest.timestamp, oldest.timestamp)) {
    reason = 'insufficient_distinct_timestamps';
  } else if (
    [newest, oldest].some((endpoint) =>
      bars.some(
        (bar) =>
          !laterThan(bar.timestamp, endpoint.timestamp) &&
          !laterThan(endpoint.timestamp, bar.timestamp) &&
          (bar.currency !== endpoint.currency ||
            compareNonnegativeDecimals(bar.closePrice, endpoint.closePrice) !== 0),
      ),
    )
  ) {
    reason = 'ambiguous_endpoint';
  } else if (newest.currency !== oldest.currency) {
    reason = 'currency_mismatch';
  }
  if (reason) return { closeChangePercent: null, closeChangeUnavailableReason: reason };
  return {
    closeChangePercent:
      Number(oldest.closePrice) === 0
        ? null
        : (Number(newest.closePrice) / Number(oldest.closePrice) - 1) * 100,
  };
}

const output = JSON.parse(readFileSync(0, 'utf8'));
assert.equal(output.version, 1);
assert.ok(['success', 'partial', 'error'].includes(output.status), 'valid CLI status required');
assert.ok(Array.isArray(output.data), 'CLI data must be an array');
const emptyError = output.status === 'error' && !output.data.length;
if (emptyError) {
  assert.ok(
    record(output.error) && typeof output.error.code === 'string' && output.error.code.length > 0,
    'CLI error code required',
  );
  assert.ok(
    Object.keys(output.error).every((field) =>
      ['code', 'providerCode', 'requestId', 'choices'].includes(field),
    ),
    'CLI error contains unexpected fields',
  );
  for (const field of ['providerCode', 'requestId'])
    assert.ok(
      !Object.hasOwn(output.error, field) || typeof output.error[field] === 'string',
      `CLI error ${field} must be a string`,
    );
  assert.ok(
    !Object.hasOwn(output.error, 'choices') ||
      (Array.isArray(output.error.choices) &&
        output.error.choices.every(
          (choice) =>
            record(choice) &&
            Object.keys(choice).length === 4 &&
            typeof choice.symbol === 'string' &&
            typeof choice.market === 'string' &&
            (choice.name === null || typeof choice.name === 'string') &&
            (choice.isinCode === null || typeof choice.isinCode === 'string'),
        )),
    'CLI error choices must contain stock choices',
  );
}
assert.ok(
  record(output.source) &&
    ((emptyError &&
      output.source.provider === 'tossinvest' &&
      Object.keys(output.source).length === 1) ||
      (output.source.endpoint === '/api/v1/candles' &&
        (!Object.hasOwn(output.source, 'interval') || output.source.interval === '1d'))),
  'daily candle output required',
);
const batch = !Object.hasOwn(output.source, 'interval');
const rows = batch ? output.data : [{ ...output, symbol: output.source.symbol }];
assert.ok(emptyError || rows.length > 0, 'daily candle batch requires at least one symbol row');
if (batch && !emptyError) {
  const states = rows.map(({ status }) => status);
  assert.ok(
    states.every((status) => ['success', 'partial', 'error', 'not_queried'].includes(status)),
    'daily candle batch row status required',
  );
  const expected = states.every((status) => status === 'success')
    ? 'success'
    : states.some((status) => status === 'success' || status === 'partial')
      ? 'partial'
      : 'error';
  assert.equal(output.status, expected, 'daily candle batch status must match its rows');
}
const data = rows.map((row) => {
  const usable = row.status === 'success' || row.status === 'partial';
  if (usable)
    assert.ok(
      typeof row.symbol === 'string' && symbolPattern.test(row.symbol),
      'daily candle symbol required',
    );
  if (batch && usable)
    assert.ok(
      row.source?.symbol === row.symbol &&
        row.source.endpoint === '/api/v1/candles' &&
        row.source.interval === '1d',
      'batch item must match its daily candle source',
    );
  const knownMarket =
    ['NYSE', 'NASDAQ', 'AMEX', 'US_ETC'].includes(row.source.market) &&
    row.source.dateTimeZone === 'America/New_York';
  const bars = row.data.map((bar) => {
    assert.ok(
      typeof bar.currency === 'string' && bar.currency.trim(),
      'currency must be a nonempty string',
    );
    assert.ok(decimal(bar.closePrice), 'closePrice must be a decimal string');
    assert.ok(decimal(bar.volume), 'volume must be a decimal string');
    assert.ok(Number(bar.closePrice) >= 0, 'closePrice must be nonnegative');
    assert.ok(Number(bar.volume) >= 0, 'volume must be nonnegative');
    assert.ok(validTime(bar.timestamp), 'timestamp must be valid');
    const tradeDate = knownMarket ? tradeDateFormat.format(new Date(bar.timestamp)) : null;
    return {
      timestamp: bar.timestamp,
      tradeDate,
      closePrice: bar.closePrice,
      volume: bar.volume,
      currency: bar.currency,
    };
  });
  return {
    symbol: row.symbol,
    status: row.status,
    retrievedAt: batch ? row.retrievedAt : undefined,
    source: row.source,
    ...(Object.hasOwn(row, 'summary') ? { summary: row.summary } : {}),
    ...(row.omissions ? { omissions: row.omissions } : {}),
    ...(row.page ? { page: row.page } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    tradeDateUnavailableReason:
      usable && bars.length && !knownMarket ? 'market_timezone_unconfirmed' : null,
    bars,
    analysis:
      usable && bars.length
        ? {
            ...closeChange(bars),
            totalVolume: bars.reduce((total, bar) => total + Number(bar.volume), 0),
          }
        : null,
  };
});
process.stdout.write(
  `${JSON.stringify({
    status: output.status,
    retrievedAt: output.retrievedAt,
    data,
    ...(output.error ? { error: output.error } : {}),
  })}\n`,
);
