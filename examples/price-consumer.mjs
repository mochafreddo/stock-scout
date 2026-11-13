import { readFileSync } from 'node:fs';
import { priceAge } from '../scripts/toss-prices.ts';
import { validTime } from '../scripts/toss-values.ts';

const [asOf, ...extra] = process.argv.slice(2);
if (!asOf || !validTime(asOf) || extra.length)
  throw new TypeError('Usage: node examples/price-consumer.mjs REPORT_TIMESTAMP < prices.json');
const query = JSON.parse(readFileSync(0, 'utf8'));
if (
  query.version !== 1 ||
  !['success', 'partial'].includes(query.status) ||
  query.source?.endpoint !== '/api/v1/prices' ||
  !Array.isArray(query.data)
)
  throw new TypeError('Expected a usable prices CLI response');
const prices = query.data.map((row) => {
  const threshold = row.priceAge?.thresholdSeconds;
  if (
    !Number.isSafeInteger(threshold) ||
    threshold < 0 ||
    (row.timestamp !== undefined &&
      row.timestamp !== null &&
      (typeof row.timestamp !== 'string' || !validTime(row.timestamp)))
  )
    throw new TypeError('Expected the query threshold and a valid source timestamp');
  const [price] = priceAge([row], { staleAfterSeconds: threshold }, asOf);
  return {
    ...price,
    classification:
      price.priceAge.exceedsThreshold === null
        ? 'timestamp_unknown'
        : price.priceAge.exceedsThreshold
          ? 'reference_price'
          : 'within_threshold',
  };
});
process.stdout.write(`${JSON.stringify({ query, report: { asOf, prices } })}\n`);
