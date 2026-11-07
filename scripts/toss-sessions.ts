import { TossError } from './toss-client.ts';
import { record, validTime } from './toss-values.ts';

const sessions = ['dayMarket', 'preMarket', 'regularMarket', 'afterMarket'] as const;
const usDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
export function validDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    validTime(`${value}T00:00:00Z`)
  );
}

export function sessionResult(value: unknown, date: string) {
  if (!record(value)) throw new TossError('RESPONSE_INVALID');
  const data: Record<string, unknown> = {};
  const omissions: { field: string; reason: string }[] = [];
  for (const role of ['today', 'previousBusinessDay', 'nextBusinessDay']) {
    const day = value[role];
    if (
      !record(day) ||
      !validDate(day.date) ||
      (role === 'today'
        ? day.date !== date
        : role === 'previousBusinessDay'
          ? day.date >= date
          : day.date <= date)
    ) {
      if (role === 'today') throw new TossError('RESPONSE_INVALID');
      omissions.push({ field: role, reason: 'invalid_day' });
      continue;
    }
    const parsed: Record<string, unknown> = { date: day.date };
    const previousDate = new Date(Date.parse(`${day.date}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    for (const name of sessions) {
      const session = day[name];
      if (session === null) parsed[name] = null;
      else if (
        record(session) &&
        typeof session.startTime === 'string' &&
        typeof session.endTime === 'string' &&
        validTime(session.startTime) &&
        validTime(session.endTime) &&
        Date.parse(session.startTime) < Date.parse(session.endTime) &&
        usDate.format(new Date(session.startTime)) >=
          (name === 'dayMarket' ? previousDate : day.date) &&
        usDate.format(new Date(session.startTime)) <= day.date &&
        usDate.format(new Date(session.endTime)) === day.date
      )
        parsed[name] = { startTime: session.startTime, endTime: session.endTime };
      else
        omissions.push({
          field: `${role}.${name}`,
          reason: name in day ? 'invalid_session' : 'session_unknown',
        });
    }
    if (role === 'today' && Object.keys(parsed).length === 1)
      throw new TossError('RESPONSE_INVALID');
    data[role] = parsed;
  }
  return { data: [data], omissions };
}

export function constraintResult(value: unknown, symbol: string, date: string) {
  const calendar = sessionResult(value, date);
  const today = calendar.data[0].today;
  const regular = record(today) ? today.regularMarket : undefined;
  let acceptanceWindow: Record<string, unknown> = { status: 'unknown' };
  if (regular === null) acceptanceWindow = { status: 'closed' };
  else if (
    record(regular) &&
    typeof regular.startTime === 'string' &&
    typeof regular.endTime === 'string'
  ) {
    const end = Date.parse(regular.endTime) - 3_600_000;
    if (end > Date.parse(regular.startTime))
      acceptanceWindow = {
        status: 'documented_schedule',
        startTime: regular.startTime,
        endTime: new Date(end).toISOString(),
        endBoundary: 'unknown',
      };
  }
  return {
    data: [
      {
        symbol,
        date,
        requestedMarket: 'US',
        eligibility: 'unknown',
        eligibilityLookup: 'api_not_provided',
        appConditions: 'unknown',
        highValueConfirmation: {
          thresholdAmount: '100000000',
          currency: 'KRW',
          required: true,
          conversion: 'unknown',
        },
        calendar: calendar.data[0],
        regular: {
          availability: 'unknown',
          acceptanceWindow: 'unknown',
          orderTypes: ['LIMIT', 'MARKET'],
          quantity: 'positive_integer_except_US_MARKET_SELL',
          amountAndQuantity: 'exactly_one',
          quantityUnit: 'securities',
          minimumQuantity: 'unknown',
          maximumQuantity: 'unknown',
          timeInForce: { DAY: 'default', CLS: 'US_LIMIT_only', OPG: 'KR_only' },
          limitPriceScale: { belowOneUSD: 4, atLeastOneUSD: 2, excessDigits: 'truncated' },
        },
        conditional: {
          availability: 'unknown',
          acceptanceWindow: 'unknown',
          types: ['SINGLE', 'OCO', 'OTO'],
          orderTypes: { SINGLE: ['LIMIT', 'MARKET'], OCO: ['LIMIT'], OTO: ['LIMIT'] },
          sides: { OCO: ['SELL', 'SELL'], OTO: ['BUY', 'SELL'] },
          ocoTriggerPrices: 'first_above_current_above_second',
          triggerSessions: 'all_tradable_sessions',
          sessionSelection: 'not_supported',
          fractionalQuantity: 'unknown',
          quantityUnit: 'securities',
          minimumQuantity: 'unknown',
          maximumQuantity: 'unknown',
          expiry: 'required_date_up_to_one_year',
        },
        fractional: {
          availability: 'unknown',
          acceptanceWindow,
          amountOrder: 'US_MARKET_only',
          quantityOrder: 'US_MARKET_SELL_only',
          quantitySellMaxScale: 6,
          amountUnit: 'USD',
          quantityUnit: 'securities',
          minimumAmount: 'unknown',
          maximumAmount: 'unknown',
          minimumQuantity: 'unknown',
          maximumQuantity: 'unknown',
        },
      },
    ],
    omissions: [
      ...calendar.omissions,
      { field: 'eligibility', reason: 'constraint_lookup_not_provided' },
      { field: 'appConditions', reason: 'not_verified' },
    ],
  };
}
