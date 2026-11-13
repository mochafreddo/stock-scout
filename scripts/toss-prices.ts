import { TossError } from './toss-client.ts';
import { decimal, laterThan, symbolPattern, validTime, wholeSecondMillis } from './toss-values.ts';

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
  const data: Record<string, unknown>[] = [];
  const omissions: { index?: number; symbol?: string; reason: string }[] = [];
  const counts = new Map<string, number>();
  for (const row of rows)
    if (row && typeof row === 'object' && 'symbol' in row && typeof row.symbol === 'string')
      counts.set(row.symbol, (counts.get(row.symbol) ?? 0) + 1);
  for (const [index, row] of rows.entries()) {
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
      ('timestamp' in row &&
        row.timestamp !== undefined &&
        row.timestamp !== null &&
        !validTime(row.timestamp))
    ) {
      omissions.push({ index, reason: 'invalid_item' });
      continue;
    }
    data.push({
      symbol: row.symbol,
      lastPrice: row.lastPrice,
      currency: row.currency,
      ...('timestamp' in row ? { timestamp: row.timestamp } : {}),
    });
  }
  if (rows.length && !data.length) throw new TossError('RESPONSE_INVALID');
  if (rows.length)
    for (const symbol of requested)
      if (!data.some((row) => row.symbol === symbol))
        omissions.push({ symbol, reason: 'missing_item' });
  return { data, omissions };
}
export function priceAge(
  data: Record<string, unknown>[],
  { staleAfterSeconds }: ReturnType<typeof priceQuery>,
  retrievedAt: string,
) {
  return data.map((row) => {
    const timestamp = 'timestamp' in row ? row.timestamp : undefined;
    const unavailableReason =
      timestamp === undefined
        ? 'timestamp_missing'
        : timestamp === null
          ? 'timestamp_null'
          : typeof timestamp === 'string' && laterThan(timestamp, retrievedAt)
            ? 'timestamp_future'
            : undefined;
    if (unavailableReason)
      return {
        ...row,
        priceAge: {
          seconds: null,
          thresholdSeconds: staleAfterSeconds,
          exceedsThreshold: null,
          unavailableReason,
        },
      };
    if (typeof timestamp !== 'string') throw new TossError('RESPONSE_INVALID');
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
