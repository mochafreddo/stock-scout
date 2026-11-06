import { TossError } from './toss-client.ts';
import { isinPattern, securityTypes } from './toss-stock.ts';
import { decimal, validTime } from './toss-values.ts';

export function rankingQuery(type: string | undefined, args: string[]) {
  const [duration, count = '20'] = args;
  if (
    !type ||
    !['MARKET_TRADING_AMOUNT', 'MARKET_TRADING_VOLUME', 'TOP_GAINERS', 'TOP_LOSERS'].includes(
      type,
    ) ||
    !['realtime', '1d', '1w', '1mo', '3mo', '6mo', '1y'].includes(duration) ||
    (type.startsWith('TOP_') && duration === 'realtime') ||
    !/^(?:[1-9]\d?|100)$/.test(count) ||
    args.length > 2
  )
    throw new TossError('INPUT_INVALID');
  return new URLSearchParams({ type, duration, count, marketCountry: 'US' });
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function rankingItem(row: unknown) {
  if (
    !record(row) ||
    typeof row.rank !== 'number' ||
    !Number.isInteger(row.rank) ||
    row.rank < 1 ||
    row.rank > 100 ||
    typeof row.symbol !== 'string' ||
    !/^[A-Za-z0-9.-]+$/.test(row.symbol) ||
    typeof row.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(row.currency) ||
    !decimal(row.tradingVolume) ||
    !decimal(row.tradingAmount) ||
    !record(row.price)
  )
    return;
  const { lastPrice, basePrice, changeRate } = row.price;
  if (
    !decimal(lastPrice) ||
    !decimal(basePrice) ||
    (changeRate != null && (!decimal(changeRate) || /^-?0+(?:\.0+)?$/.test(basePrice)))
  )
    return;
  return {
    rank: row.rank,
    symbol: row.symbol,
    currency: row.currency,
    price: { lastPrice, basePrice, changeRate },
    tradingVolume: row.tradingVolume,
    tradingAmount: row.tradingAmount,
  };
}
function items<T>(rows: unknown[], parse: (row: unknown) => T | undefined) {
  const data: T[] = [];
  const omissions: { index?: number; reason: string }[] = [];
  for (const [index, row] of rows.entries()) {
    const item = parse(row);
    if (item === undefined) omissions.push({ index, reason: 'invalid_item' });
    else data.push(item);
  }
  if (rows.length && !data.length) throw new TossError('RESPONSE_INVALID');
  return { data, omissions };
}
export function rankingResult(value: unknown, count: number) {
  if (!record(value) || !Array.isArray(value.rankings) || value.rankings.length > count)
    throw new TossError('RESPONSE_INVALID');
  const { rankedAt, rankings } = value;
  if (
    rankedAt !== undefined &&
    (rankedAt === null ? rankings.length > 0 : !rankings.length || !validTime(rankedAt))
  )
    throw new TossError('RESPONSE_INVALID');
  const result = items(rankings, rankingItem);
  if (result.data.some((row, index) => index > 0 && row.rank < result.data[index - 1].rank))
    throw new TossError('RESPONSE_INVALID');
  if (rankings.length && rankings.length < count)
    result.omissions.push({ reason: 'fewer_than_requested' });
  return { ...result, timing: { rankedAt } };
}

export function tradableQuery(market: string | undefined, args: string[]) {
  if (!market || !['NYSE', 'NASDAQ', 'AMEX', 'US_ETC'].includes(market))
    throw new TossError('INPUT_INVALID');
  const query = new URLSearchParams({ market });
  for (const arg of args) {
    const [key, value, ...extra] = arg.split('=');
    if (
      extra.length ||
      query.has(key) ||
      !(
        (key === 'status' && ['ACTIVE', 'DELISTED', 'SCHEDULED'].includes(value)) ||
        (key === 'securityType' && securityTypes.has(value)) ||
        (key === 'commonShare' && ['true', 'false'].includes(value))
      )
    )
      throw new TossError('INPUT_INVALID');
    query.set(key, value);
  }
  if (!query.has('status')) query.set('status', 'ACTIVE');
  return query;
}
export function tradableResult(value: unknown, query: URLSearchParams) {
  if (!Array.isArray(value)) throw new TossError('RESPONSE_INVALID');
  return items(value, (row) => {
    if (!record(row)) return;
    const { symbol, name, securityType, isCommonShare, isinCode } = row;
    if (
      typeof symbol !== 'string' ||
      !/^[A-Za-z0-9.-]+$/.test(symbol) ||
      typeof name !== 'string' ||
      !name.trim() ||
      typeof securityType !== 'string' ||
      !/^[A-Z][A-Z0-9_]*$/.test(securityType) ||
      typeof isCommonShare !== 'boolean' ||
      typeof isinCode !== 'string' ||
      (isinCode !== '' && !isinPattern.test(isinCode)) ||
      (query.has('securityType') && securityType !== query.get('securityType')) ||
      (query.has('commonShare') && String(isCommonShare) !== query.get('commonShare'))
    )
      return;
    return { symbol, name, securityType, isCommonShare, isinCode };
  });
}
