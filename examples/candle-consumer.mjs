import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decimal, record, validTime } from '../scripts/toss-values.ts';

const tradeDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
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
  for (const field of ['providerCode', 'requestId'])
    assert.ok(
      !Object.hasOwn(output.error, field) || typeof output.error[field] === 'string',
      `CLI error ${field} must be a string`,
    );
  assert.ok(
    !Object.hasOwn(output.error, 'choices') || Array.isArray(output.error.choices),
    'CLI error choices must be an array',
  );
}
assert.ok(
  emptyError ||
    (output.source.endpoint === '/api/v1/candles' &&
      (!Object.hasOwn(output.source, 'interval') || output.source.interval === '1d')),
  'daily candle output required',
);
const batch = !Object.hasOwn(output.source, 'interval');
const rows = batch ? output.data : [{ ...output, symbol: output.source.symbol }];
const data = rows.map((row) => {
  const usable = row.status === 'success' || row.status === 'partial';
  const knownMarket =
    ['NYSE', 'NASDAQ', 'AMEX', 'US_ETC'].includes(row.source.market) &&
    row.source.dateTimeZone === 'America/New_York';
  const bars = row.data.map((bar) => {
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
  const currencyMismatch = bars.length > 0 && bars[0].currency !== bars.at(-1).currency;
  return {
    symbol: row.symbol,
    status: row.status,
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
            closeChangePercent:
              currencyMismatch || Number(bars.at(-1).closePrice) === 0
                ? null
                : (Number(bars[0].closePrice) / Number(bars.at(-1).closePrice) - 1) * 100,
            ...(currencyMismatch ? { closeChangeUnavailableReason: 'currency_mismatch' } : {}),
            totalVolume: bars.reduce((total, bar) => total + Number(bar.volume), 0),
          }
        : null,
  };
});
process.stdout.write(
  `${JSON.stringify({
    status: output.status,
    data,
    ...(output.error ? { error: output.error } : {}),
  })}\n`,
);
