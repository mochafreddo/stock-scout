import { TossError } from './toss-client.ts';
import {
  decimal,
  items,
  laterThan,
  symbolPattern,
  validTime,
  wholeSecondMillis,
} from './toss-values.ts';

type Price = { symbol: string; lastPrice: string; currency: string; timestamp?: string | null };

export function priceQuery(symbols: string | undefined, args: string[]) {
  if (
    !symbols ||
    symbols.split(',').length > 200 ||
    !symbols.split(',').every((symbol) => symbolPattern.test(symbol))
  )
    throw new TossError('INPUT_INVALID');
  let staleAfterSeconds = 900;
  if (args.length) {
    if (
      args.length !== 1 ||
      !/^staleAfterSeconds=(?:0|[1-9]\d*)$/.test(args[0]) ||
      !Number.isSafeInteger(Number(args[0].slice('staleAfterSeconds='.length)))
    )
      throw new TossError('INPUT_INVALID');
    staleAfterSeconds = Number(args[0].slice('staleAfterSeconds='.length));
  }
  return { query: new URLSearchParams({ symbols }), symbols, staleAfterSeconds };
}

export function priceResult(value: unknown, { symbols }: ReturnType<typeof priceQuery>) {
  if (!Array.isArray(value)) throw new TossError('RESPONSE_INVALID');
  const rows: unknown[] = value;
  const requested = new Set(symbols.split(','));
  const counts = new Map<string, number>();
  for (const row of rows)
    if (row && typeof row === 'object' && 'symbol' in row && typeof row.symbol === 'string')
      counts.set(row.symbol, (counts.get(row.symbol) ?? 0) + 1);
  const { data, omissions } = items<Price>(rows, (row) => {
    const timestamp =
      row && typeof row === 'object' && 'timestamp' in row ? row.timestamp : undefined;
    if (
      !row ||
      typeof row !== 'object' ||
      !('symbol' in row) ||
      typeof row.symbol !== 'string' ||
      !('lastPrice' in row) ||
      !('currency' in row) ||
      !requested.has(row.symbol) ||
      counts.get(row.symbol) !== 1 ||
      !decimal(row.lastPrice) ||
      typeof row.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(row.currency) ||
      (timestamp !== undefined &&
        timestamp !== null &&
        (typeof timestamp !== 'string' || !validTime(timestamp)))
    )
      return;
    requested.delete(row.symbol);
    return {
      symbol: row.symbol,
      lastPrice: row.lastPrice,
      currency: row.currency,
      ...('timestamp' in row ? { timestamp } : {}),
    };
  });
  const missing = rows.length
    ? Array.from(requested, (symbol) => ({ symbol, reason: 'missing_item' }))
    : [];
  return { data, omissions: [...omissions, ...missing] };
}
export function priceAge(
  data: ReturnType<typeof priceResult>['data'],
  { staleAfterSeconds }: ReturnType<typeof priceQuery>,
  retrievedAt: string,
) {
  return data.map((row) => {
    const { timestamp } = row;
    if (timestamp === undefined || timestamp === null || laterThan(timestamp, retrievedAt))
      return {
        ...row,
        priceAge: {
          seconds: null,
          thresholdSeconds: staleAfterSeconds,
          exceedsThreshold: null,
          unavailableReason:
            timestamp === undefined
              ? 'timestamp_missing'
              : timestamp === null
                ? 'timestamp_null'
                : 'timestamp_future',
        },
      };
    const fraction = (value: string) => Number(`0.${/\.(\d+)/.exec(value)?.[1] ?? '0'}`);
    const seconds =
      (wholeSecondMillis(retrievedAt) - wholeSecondMillis(timestamp)) / 1000 +
      fraction(retrievedAt) -
      fraction(timestamp);
    return {
      ...row,
      priceAge: {
        seconds,
        thresholdSeconds: staleAfterSeconds,
        exceedsThreshold: laterThan(retrievedAt, timestamp, staleAfterSeconds),
      },
    };
  });
}
