import { TossError } from './toss-client.ts';
import { items, nonnegativeDecimal, record, symbolPattern, validTime } from './toss-values.ts';

export function marketQuery(
  command: 'orderbook' | 'trades',
  symbol: string | undefined,
  args: string[],
) {
  if (!symbol || !symbolPattern.test(symbol)) throw new TossError('INPUT_INVALID');
  const query = new URLSearchParams({ symbol });
  if (command === 'orderbook') {
    if (args.length) throw new TossError('INPUT_INVALID');
    return { query, source: { symbol }, parse: orderbookResult };
  }
  const count = args[0] ?? '50';
  if (args.length > 1 || !/^(?:[1-9]|[1-4]\d|50)$/.test(count))
    throw new TossError('INPUT_INVALID');
  query.set('count', count);
  return {
    query,
    source: { symbol, count: Number(count), scope: 'provider_current_day_recent_trades' },
    parse: (value: unknown) => tradesResult(value, Number(count)),
  };
}

function currency(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function level(row: Record<string, unknown>) {
  if (!nonnegativeDecimal(row.price) || !nonnegativeDecimal(row.volume)) return;
  return { price: row.price, volume: row.volume };
}
function orderbookResult(value: unknown) {
  if (
    !record(value) ||
    !currency(value.currency) ||
    !Array.isArray(value.asks) ||
    !Array.isArray(value.bids)
  )
    throw new TossError('RESPONSE_INVALID');
  const omissions: { side?: string; index?: number; field?: string; reason: string }[] = [];
  const invalidTime =
    'timestamp' in value && value.timestamp !== null && !validTime(value.timestamp);
  if (invalidTime) omissions.push({ field: 'timestamp', reason: 'invalid_timestamp' });
  function side(rows: unknown[], name: string) {
    const data = [];
    for (const [index, row] of rows.entries()) {
      const item = record(row) ? level(row) : undefined;
      if (item) data.push(item);
      else omissions.push({ side: name, index, reason: 'invalid_item' });
    }
    return data;
  }
  const asks = side(value.asks, 'asks');
  const bids = side(value.bids, 'bids');
  if ((value.asks.length || value.bids.length) && !asks.length && !bids.length)
    throw new TossError('RESPONSE_INVALID');
  return {
    data: [
      {
        currency: value.currency,
        ...('timestamp' in value && !invalidTime ? { timestamp: value.timestamp } : {}),
        asks,
        bids,
      },
    ],
    omissions,
  };
}

function tradesResult(value: unknown, count: number) {
  if (!Array.isArray(value) || value.length > count) throw new TossError('RESPONSE_INVALID');
  return items(value, (row) => {
    if (!record(row)) return;
    const item = level(row);
    if (!item || !currency(row.currency) || !validTime(row.timestamp)) return;
    return { ...item, timestamp: row.timestamp, currency: row.currency };
  });
}
