import { TossError } from './toss-client.ts';
import { laterThan, record, symbolPattern, validTime, wholeSecondMillis } from './toss-values.ts';

const sessions = ['dayMarket', 'preMarket', 'regularMarket', 'afterMarket'] as const;
type SessionName = (typeof sessions)[number];
type SessionInterval = { startTime: string; endTime: string };
type MarketDay = { date: string } & Partial<Record<SessionName, SessionInterval | null>>;
const usDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
export function validDate(value: unknown): value is string {
  return typeof value === 'string' && validTime(`${value}T00:00:00Z`);
}

export function parseSessionInterval(
  value: unknown,
  date: string,
  name: SessionName,
): SessionInterval | 'invalid_time' | 'invalid_interval' {
  if (!record(value)) return 'invalid_time';
  const { startTime, endTime } = value;
  if (
    typeof startTime !== 'string' ||
    typeof endTime !== 'string' ||
    !validTime(startTime) ||
    !validTime(endTime)
  )
    return 'invalid_time';

  const earliestOpeningDate =
    name === 'dayMarket'
      ? new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
      : date;
  const openingDate = usDate.format(new Date(startTime));
  if (
    !laterThan(endTime, startTime) ||
    openingDate < earliestOpeningDate ||
    openingDate > date ||
    usDate.format(new Date(endTime)) !== date
  )
    return 'invalid_interval';
  return { startTime, endTime };
}

export function sessionQuery(
  command: 'sessions' | 'constraints',
  firstArg: string | undefined,
  args: string[],
) {
  const date = command === 'sessions' ? firstArg : args[0];
  if (!validDate(date) || args.length !== (command === 'sessions' ? 0 : 1))
    throw new TossError('INPUT_INVALID');
  const request = {
    query: new URLSearchParams({ date }),
    source: {
      date,
      dateTimeZone: 'America/New_York',
      sessionTimeZone: 'Asia/Seoul',
      scope: 'provider_US_market_calendar',
    },
  };
  if (command === 'sessions')
    return { ...request, parse: (value: unknown) => sessionResult(value, date) };
  if (!firstArg || !symbolPattern.test(firstArg)) throw new TossError('INPUT_INVALID');
  return {
    ...request,
    source: {
      ...request.source,
      symbol: firstArg,
      symbolMarket: 'unverified_US_requested',
      rulesVersion: '1.2.28',
      rulesCheckedOn: '2026-11-07',
      rulesSource: 'https://openapi.tossinvest.com/openapi-docs/latest/openapi.json',
      rulesScope: 'documented_API_rules_not_live_eligibility',
    },
    parse: (value: unknown) => constraintResult(value, firstArg, date),
  };
}

function sessionResult(value: unknown, date: string) {
  if (!record(value)) throw new TossError('RESPONSE_INVALID');
  const data: Record<string, MarketDay> = {};
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
    const parsed: MarketDay = { date: day.date };
    for (const name of sessions) {
      const session = day[name];
      if (session === null) {
        parsed[name] = null;
        continue;
      }
      const interval = parseSessionInterval(session, day.date, name);
      if (typeof interval === 'string')
        omissions.push({
          field: `${role}.${name}`,
          reason: name in day ? 'invalid_session' : 'session_unknown',
        });
      else parsed[name] = interval;
    }
    if (role === 'today' && Object.keys(parsed).length === 1)
      throw new TossError('RESPONSE_INVALID');
    data[role] = parsed;
  }
  return { data: [data], omissions };
}

function constraintResult(value: unknown, symbol: string, date: string) {
  const calendar = sessionResult(value, date);
  const regular = calendar.data[0].today.regularMarket;
  let acceptanceWindow: Record<string, unknown> = { status: 'unknown' };
  if (regular === null) acceptanceWindow = { status: 'closed' };
  else if (regular !== undefined) {
    const fraction = (/\.\d+/.exec(regular.endTime)?.[0] ?? '.000').padEnd(4, '0');
    const end = new Date(wholeSecondMillis(regular.endTime) - 3_600_000)
      .toISOString()
      .replace('.000', fraction);
    if (laterThan(end, regular.startTime))
      acceptanceWindow = {
        status: 'documented_schedule',
        startTime: regular.startTime,
        endTime: end,
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
