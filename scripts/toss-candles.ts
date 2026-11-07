import { TossError } from './toss-client.ts';
import { decimal, items, record, symbolPattern, validTime } from './toss-values.ts';

export function candleQuery(symbol: string | undefined, args: string[]) {
  const [interval] = args;
  if (!symbol || !symbolPattern.test(symbol) || !['1d', '1m'].includes(interval))
    throw new TossError('INPUT_INVALID');
  const query = new URLSearchParams({ symbol, interval, count: '100', adjusted: 'true' });
  const seen = new Set<string>();
  for (const arg of args.slice(1)) {
    const [key, value, ...extra] = arg.split('=');
    if (
      extra.length ||
      seen.has(key) ||
      !(
        (key === 'count' && /^(?:[1-9]\d?|1\d\d|200)$/.test(value)) ||
        (key === 'adjusted' && ['true', 'false'].includes(value)) ||
        (key === 'before' && validTime(value))
      )
    )
      throw new TossError('INPUT_INVALID');
    seen.add(key);
    query.set(key, value);
  }
  return query;
}

export function candleResult(value: unknown, query: URLSearchParams) {
  const count = Number(query.get('count'));
  if (!record(value) || !Array.isArray(value.candles) || value.candles.length > count)
    throw new TossError('RESPONSE_INVALID');
  const result = items(value.candles, (row) => {
    if (
      !record(row) ||
      typeof row.timestamp !== 'string' ||
      !validTime(row.timestamp) ||
      !decimal(row.openPrice) ||
      !decimal(row.highPrice) ||
      !decimal(row.lowPrice) ||
      !decimal(row.closePrice) ||
      !decimal(row.volume) ||
      typeof row.currency !== 'string' ||
      !row.currency.trim()
    )
      return;
    return {
      timestamp: row.timestamp,
      openPrice: row.openPrice,
      highPrice: row.highPrice,
      lowPrice: row.lowPrice,
      closePrice: row.closePrice,
      volume: row.volume,
      currency: row.currency,
      completion: 'unknown',
      inProgress: 'unknown',
    };
  });
  const before = query.get('before');
  if (
    result.data.some(
      (row, index) =>
        (before !== null && Date.parse(row.timestamp) > Date.parse(before)) ||
        (index > 0 && Date.parse(row.timestamp) > Date.parse(result.data[index - 1].timestamp)),
    )
  )
    throw new TossError('RESPONSE_INVALID');
  if (value.nextBefore !== null && value.nextBefore !== undefined && !validTime(value.nextBefore))
    throw new TossError('RESPONSE_INVALID');
  if (value.nextBefore === undefined) result.omissions.push({ reason: 'pagination_unknown' });
  else if (value.nextBefore !== null) result.omissions.push({ reason: 'next_page' });
  return {
    ...result,
    page: 'nextBefore' in value ? { nextBefore: value.nextBefore } : {},
  };
}
