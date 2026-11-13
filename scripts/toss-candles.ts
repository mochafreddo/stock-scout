import { payload, type TossClient, TossError } from './toss-client.ts';
import { validDate } from './toss-sessions.ts';
import { stockResult } from './toss-stock.ts';
import { decimal, items, laterThan, record, symbolPattern, validTime } from './toss-values.ts';

const newYorkOffset = new Intl.DateTimeFormat('en', {
  timeZone: 'America/New_York',
  timeZoneName: 'longOffset',
});

function tradeDateMidnight(date: string) {
  const utc = Date.parse(`${date}T00:00:00Z`);
  let midnight = utc;
  for (let correction = 0; correction < 2; correction++) {
    const offset = Object.fromEntries(
      newYorkOffset.formatToParts(midnight).map(({ type, value }) => [type, value]),
    ).timeZoneName;
    const [hours, minutes, seconds = 0] = offset.slice(4).split(':').map(Number);
    midnight = utc - (offset[3] === '-' ? -1 : 1) * (hours * 3600 + minutes * 60 + seconds) * 1000;
  }
  return new Date(midnight).toISOString();
}

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
        (key === 'before' && validTime(value)) ||
        (key === 'date' && interval === '1d' && validDate(value))
      )
    )
      throw new TossError('INPUT_INVALID');
    seen.add(key);
    query.set(key, value);
  }
  const date = query.get('date');
  if (date !== null) {
    if (query.has('before')) throw new TossError('INPUT_INVALID');
    query.delete('date');
    query.set('before', tradeDateMidnight(date));
  }
  const daily = interval === '1d';
  return {
    symbol,
    query,
    date,
    source: {
      ...Object.fromEntries(query),
      ...(date === null ? {} : { date, dateTimeZone: 'America/New_York' }),
      count: Number(query.get('count')),
      adjusted: query.get('adjusted') === 'true',
      originalPricesGuaranteed: false,
      priceUnit: 'currency_per_security',
      volumeUnit: 'securities',
      timestampMeaning: daily ? 'trade_date_local_midnight' : 'minute_end_exclusive',
      usSessionSemantics: {
        ohlc: daily ? 'regular' : 'provider_trades_session_unknown',
        volume: daily ? 'consolidated_including_extended_hours' : 'selected_US_exchanges',
      },
    },
  };
}

export async function queryCandlePage(client: TossClient, request: ReturnType<typeof candleQuery>) {
  let market: string | undefined;
  if (request.date !== null) {
    const { symbol } = request;
    const rows = payload(
      await client.get(`/api/v1/stocks?${new URLSearchParams({ symbols: symbol })}`),
    );
    const identity = stockResult(rows, symbol);
    if (identity.omissions.some(({ reason }) => reason === 'invalid_item'))
      throw new TossError('RESPONSE_INVALID');
    market = identity.data[0].market;
    if (!['NYSE', 'NASDAQ', 'AMEX', 'US_ETC'].includes(market)) throw new TossError('UNSUPPORTED');
  }
  const value = payload(await client.get(`/api/v1/candles?${request.query}`));
  return {
    ...candleResult(value, request),
    source: { ...request.source, ...(market === undefined ? {} : { market }) },
  };
}

export function candleResult(value: unknown, { query }: ReturnType<typeof candleQuery>) {
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
        (before !== null && laterThan(row.timestamp, before)) ||
        (index > 0 && laterThan(row.timestamp, result.data[index - 1].timestamp)),
    )
  )
    throw new TossError('RESPONSE_INVALID');
  if (value.nextBefore !== null && value.nextBefore !== undefined && !validTime(value.nextBefore))
    throw new TossError('RESPONSE_INVALID');
  if (value.nextBefore === undefined) result.omissions.push({ reason: 'pagination_unknown' });
  else if (value.nextBefore !== null) result.omissions.push({ reason: 'next_page' });
  return {
    ...result,
    page: { nextBefore: value.nextBefore },
  };
}
