import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { TossError } from './toss-client.ts';
import { parseSessionInterval, validDate } from './toss-sessions.ts';
import { isinPattern, usMarkets } from './toss-stock.ts';
import { decimal, laterThan, record, symbolPattern, validTime } from './toss-values.ts';

const maxDraftBytes = 1024 * 1024;

const fields = [
  'symbol',
  'market',
  'listingMarket',
  'isinCode',
  'side',
  'orderType',
  'amount',
  'quantity',
  'currency',
  'tradeDate',
  'session',
  'expiresAt',
  'sessions',
  'referencePrice',
];
function positiveDecimal(value: unknown): value is string {
  return decimal(value) && !value.startsWith('-') && /[1-9]/.test(value);
}

export function orderDraft(path: string | undefined, args: string[]) {
  if (!path || args.length) throw new TossError('INPUT_INVALID');
  let input: unknown;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new TossError('INPUT_INVALID');
      const buffer = Buffer.allocUnsafe(maxDraftBytes + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
        if (count === 0) break;
        bytesRead += count;
      }
      if (bytesRead > maxDraftBytes) throw new TossError('INPUT_INVALID');
      input = JSON.parse(buffer.toString('utf8', 0, bytesRead));
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new TossError('INPUT_INVALID');
  }
  if (!record(input) || Object.keys(input).some((key) => !fields.includes(key)))
    throw new TossError('INPUT_INVALID');
  const {
    symbol,
    market,
    listingMarket = null,
    isinCode = null,
    side,
    orderType,
    amount,
    quantity,
    currency,
    tradeDate,
    session,
    expiresAt,
  } = input;
  if (amount === undefined && quantity === undefined) throw new TossError('DRAFT_AMOUNT_REQUIRED');
  if (amount !== undefined && quantity !== undefined)
    throw new TossError('DRAFT_AMOUNT_QUANTITY_CONFLICT');
  if (
    market !== 'US' ||
    (side !== 'BUY' && side !== 'SELL') ||
    orderType !== 'MARKET' ||
    currency !== 'USD' ||
    (side === 'BUY' ? quantity !== undefined : amount !== undefined)
  )
    throw new TossError('ORDER_UNSUPPORTED');
  if (
    typeof symbol !== 'string' ||
    !symbolPattern.test(symbol) ||
    (listingMarket !== null &&
      (typeof listingMarket !== 'string' || !usMarkets.has(listingMarket))) ||
    (isinCode !== null && (typeof isinCode !== 'string' || !isinPattern.test(isinCode))) ||
    !positiveDecimal(side === 'BUY' ? amount : quantity) ||
    !validDate(tradeDate) ||
    typeof expiresAt !== 'string' ||
    !validTime(expiresAt)
  )
    throw new TossError('INPUT_INVALID');
  if (session !== 'regularMarket') throw new TossError('DRAFT_SESSION_MISMATCH');
  const evidence = input.sessions;
  if (
    !record(evidence) ||
    evidence.version !== 1 ||
    (evidence.status !== 'success' && evidence.status !== 'partial') ||
    !record(evidence.source) ||
    evidence.source.provider !== 'tossinvest' ||
    evidence.source.endpoint !== '/api/v1/market-calendar/US' ||
    evidence.source.dateTimeZone !== 'America/New_York'
  )
    throw new TossError('DRAFT_SCHEDULE_MISSING');
  if (evidence.source.date !== tradeDate) throw new TossError('DRAFT_DATE_MISMATCH');
  if (
    !Array.isArray(evidence.data) ||
    evidence.data.length !== 1 ||
    !record(evidence.data[0]) ||
    !record(evidence.data[0].today)
  )
    throw new TossError('DRAFT_SCHEDULE_MISSING');
  const day = evidence.data[0].today;
  if (day.date !== tradeDate) throw new TossError('DRAFT_DATE_MISMATCH');
  if (day.regularMarket === null) throw new TossError('DRAFT_MARKET_CLOSED');
  const regularMarket = parseSessionInterval(day.regularMarket, tradeDate, session);
  if (regularMarket === 'invalid_time') throw new TossError('DRAFT_SCHEDULE_MISSING');
  if (regularMarket === 'invalid_interval') throw new TossError('DRAFT_SESSION_MISMATCH');
  if (laterThan(expiresAt, regularMarket.startTime)) throw new TossError('DRAFT_EXPIRY_AFTER_OPEN');
  const now = new Date().toISOString();
  if (!laterThan(expiresAt, now)) throw new TossError('DRAFT_EXPIRED');
  let referencePrice:
    | { price: string; currency: 'USD'; timestamp: string; meaning: 'observed_not_execution' }
    | undefined;
  if (input.referencePrice !== undefined) {
    const reference = input.referencePrice;
    if (
      !record(reference) ||
      Object.keys(reference).some((key) => !['price', 'currency', 'timestamp'].includes(key)) ||
      !decimal(reference.price) ||
      reference.price.startsWith('-') ||
      reference.currency !== 'USD' ||
      typeof reference.timestamp !== 'string' ||
      !validTime(reference.timestamp) ||
      laterThan(reference.timestamp, now)
    )
      throw new TossError('INPUT_INVALID');
    referencePrice = {
      price: reference.price,
      currency: reference.currency,
      timestamp: reference.timestamp,
      meaning: 'observed_not_execution',
    };
  }
  return {
    data: [
      {
        draftVersion: 1,
        symbol,
        market,
        listingMarket,
        isinCode,
        side,
        orderType,
        ...(side === 'BUY' ? { amount } : { quantity }),
        currency,
        tradeDate,
        session,
        regularMarket,
        expiresAt,
        ...(referencePrice ? { referencePrice } : {}),
        submission: {
          route: 'toss_app',
          method: 'manual',
          workflow: 'fractional_pre_market_reservation',
        },
        appConditions: 'unknown',
      },
    ],
    omissions: [
      ...(listingMarket === null ? [{ field: 'listingMarket', reason: 'not_verified' }] : []),
      { field: 'appConditions', reason: 'not_verified' },
    ],
  };
}
