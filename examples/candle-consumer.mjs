import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decimal, validTime } from '../scripts/toss-values.ts';

const output = JSON.parse(readFileSync(0, 'utf8'));
assert.equal(output.version, 1);
assert.ok(
  output.source.endpoint === '/api/v1/candles' &&
    (!Object.hasOwn(output.source, 'interval') || output.source.interval === '1d'),
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
    const tradeDate = knownMarket
      ? new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/New_York',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(bar.timestamp))
      : null;
    return { timestamp: bar.timestamp, tradeDate, closePrice: bar.closePrice, volume: bar.volume };
  });
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
              Number(bars.at(-1).closePrice) === 0
                ? null
                : (Number(bars[0].closePrice) / Number(bars.at(-1).closePrice) - 1) * 100,
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
