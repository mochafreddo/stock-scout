import { readFileSync } from 'node:fs';
import { TossError } from './toss-client.ts';
import { validDate } from './toss-sessions.ts';
import { decimal, laterThan, record, symbolPattern, validTime } from './toss-values.ts';

const fields = [
  'symbol',
  'market',
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
const usDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

export function orderDraft(path: string | undefined, args: string[]) {
  if (!path || args.length) throw new TossError('INPUT_INVALID');
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new TossError('INPUT_INVALID');
  }
  if (!record(input) || Object.keys(input).some((key) => !fields.includes(key)))
    throw new TossError('INPUT_INVALID');
  const { symbol, market, side, orderType, amount, currency, tradeDate, session, expiresAt } =
    input;
  if (amount === undefined && input.quantity === undefined)
    throw new TossError('DRAFT_AMOUNT_REQUIRED');
  if (amount !== undefined && input.quantity !== undefined)
    throw new TossError('DRAFT_AMOUNT_QUANTITY_CONFLICT');
  if (
    market !== 'US' ||
    side !== 'BUY' ||
    orderType !== 'MARKET' ||
    currency !== 'USD' ||
    input.quantity !== undefined
  )
    throw new TossError('ORDER_UNSUPPORTED');
  if (
    typeof symbol !== 'string' ||
    !symbolPattern.test(symbol) ||
    !positiveDecimal(amount) ||
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
  const regular = day.regularMarket;
  if (regular === null) throw new TossError('DRAFT_MARKET_CLOSED');
  if (
    !record(regular) ||
    typeof regular.startTime !== 'string' ||
    typeof regular.endTime !== 'string' ||
    !validTime(regular.startTime) ||
    !validTime(regular.endTime)
  )
    throw new TossError('DRAFT_SCHEDULE_MISSING');
  const { startTime, endTime } = regular;
  if (
    !laterThan(endTime, startTime) ||
    usDate.format(new Date(startTime)) !== tradeDate ||
    usDate.format(new Date(endTime)) !== tradeDate
  )
    throw new TossError('DRAFT_SESSION_MISMATCH');
  if (laterThan(expiresAt, startTime)) throw new TossError('DRAFT_EXPIRY_AFTER_OPEN');
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
        side,
        orderType,
        amount,
        currency,
        tradeDate,
        session,
        regularMarket: { startTime, endTime },
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
    omissions: [{ field: 'appConditions', reason: 'not_verified' }],
  };
}
