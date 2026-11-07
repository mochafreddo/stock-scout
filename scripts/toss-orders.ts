import { TossError } from './toss-client.ts';
import { validDate } from './toss-sessions.ts';
import { decimal, items, record, symbolPattern, validTime } from './toss-values.ts';

export function orderQuery(status: string | undefined, args: string[], conditional: boolean) {
  if (status !== 'OPEN' && status !== 'CLOSED') throw new TossError('INPUT_INVALID');
  const paginated = conditional || status === 'CLOSED';
  const query = new URLSearchParams({ status, ...(paginated ? { limit: '20' } : {}) });
  const seen = new Set<string>();
  let context: string | undefined;
  for (const arg of args) {
    const separator = arg.indexOf('=');
    const key = arg.slice(0, separator);
    const value = arg.slice(separator + 1);
    if (
      separator < 0 ||
      seen.has(key) ||
      !(
        (key === 'symbol' && symbolPattern.test(value)) ||
        (!conditional && (key === 'from' || key === 'to') && validDate(value)) ||
        (paginated && key === 'limit' && /^(?:[1-9]\d?|100)$/.test(value)) ||
        (paginated &&
          key === 'cursor' &&
          value.length > 0 &&
          (!conditional || /^[A-Za-z0-9_-]+$/.test(value))) ||
        (paginated && key === 'context' && /^[a-f0-9]{64}$/.test(value))
      )
    )
      throw new TossError('INPUT_INVALID');
    seen.add(key);
    if (key === 'context') context = value;
    else query.set(key, value);
  }
  const from = query.get('from');
  const to = query.get('to');
  if ((from && to && from > to) || query.has('cursor') !== (context !== undefined))
    throw new TossError('INPUT_INVALID');
  return { query, context, conditional, paginated };
}

function fields(
  value: unknown,
  required: Record<string, (value: unknown) => boolean>,
  optional: Record<string, (value: unknown) => boolean> = {},
) {
  if (!record(value)) throw new TossError('RESPONSE_INVALID');
  const result: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(required)) {
    if (!check(value[key])) throw new TossError('RESPONSE_INVALID');
    result[key] = value[key];
  }
  for (const [key, check] of Object.entries(optional)) {
    if (!(key in value)) continue;
    if (!check(value[key])) throw new TossError('RESPONSE_INVALID');
    result[key] = value[key];
  }
  return result;
}
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const nullableDecimal = (value: unknown) => value === null || decimal(value);
const conditionalDecimal = (value: unknown) => decimal(value, Number.POSITIVE_INFINITY);
const nullableConditionalDecimal = (value: unknown) => value === null || conditionalDecimal(value);
const nullableTime = (value: unknown) => value === null || validTime(value);
function condition(value: unknown) {
  return fields(
    value,
    { type: text, status: text, orderSide: text },
    {
      triggerPrice: nullableConditionalDecimal,
      targetProfitRate: nullableConditionalDecimal,
      orderPrice: nullableConditionalDecimal,
      triggeredOrderId: (v) => v === null || text(v),
    },
  );
}
function parseOrder(value: unknown, conditional: boolean) {
  if (!record(value)) throw new TossError('RESPONSE_INVALID');
  if (conditional) {
    const result = fields(
      value,
      {
        conditionalOrderId: text,
        type: text,
        status: text,
        symbol: text,
        market: text,
        quantity: conditionalDecimal,
        orderType: text,
        createdAt: validTime,
      },
      { expireDate: validDate },
    );
    result.first = condition(value.first);
    if ('second' in value) result.second = value.second === null ? null : condition(value.second);
    if (
      (value.type === 'SINGLE' && value.second != null) ||
      ((value.type === 'OCO' || value.type === 'OTO') && !record(result.second)) ||
      ((value.type === 'OCO' || value.type === 'OTO') &&
        record(result.second) &&
        record(result.first) &&
        result.second.type !== result.first.type)
    )
      throw new TossError('RESPONSE_INVALID');
    return result;
  }
  return {
    ...fields(
      value,
      {
        orderId: text,
        symbol: text,
        side: text,
        orderType: text,
        timeInForce: text,
        status: text,
        quantity: decimal,
        currency: text,
        orderedAt: validTime,
      },
      { price: nullableDecimal, orderAmount: nullableDecimal, canceledAt: nullableTime },
    ),
    execution: fields(value.execution, {
      filledQuantity: decimal,
      averageFilledPrice: nullableDecimal,
      filledAmount: nullableDecimal,
      commission: nullableDecimal,
      tax: nullableDecimal,
      filledAt: nullableTime,
      settlementDate: (v) => v === null || validDate(v),
    }),
  };
}
export function orderResult(value: unknown, request: ReturnType<typeof orderQuery>) {
  const { query, conditional, paginated } = request;
  const key = conditional ? 'conditionalOrders' : 'orders';
  if (
    !record(value) ||
    !Array.isArray(value[key]) ||
    typeof value.hasNext !== 'boolean' ||
    (!conditional && !('nextCursor' in value)) ||
    ('nextCursor' in value && value.nextCursor !== null && !text(value.nextCursor)) ||
    (conditional &&
      typeof value.nextCursor === 'string' &&
      !/^[A-Za-z0-9_-]+$/.test(value.nextCursor)) ||
    (!conditional && value.hasNext && value.nextCursor == null) ||
    (!value.hasNext && value.nextCursor != null) ||
    (!paginated && value.hasNext) ||
    (paginated && value[key].length > Number(query.get('limit')))
  )
    throw new TossError('RESPONSE_INVALID');
  const result = items(value[key], (row) => {
    try {
      const parsed = parseOrder(row, conditional);
      const groups = conditional
        ? { OPEN: ['WATCHING', 'PAUSED', 'ORDERING', 'ORDERED'], CLOSED: ['COMPLETED', 'EXPIRED'] }
        : {
            OPEN: ['PENDING', 'PARTIAL_FILLED', 'PENDING_CANCEL', 'PENDING_REPLACE'],
            CLOSED: [
              'FILLED',
              'CANCELED',
              'REJECTED',
              'REPLACED',
              'CANCEL_REJECTED',
              'REPLACE_REJECTED',
              'PARTIAL_FILLED',
            ],
          };
      const status = String(parsed.status);
      if (conditional && (status === 'HOLDING' || status === 'CANCELED')) return;
      if (
        Object.values(groups).flat().includes(status) &&
        !groups[query.get('status') === 'OPEN' ? 'OPEN' : 'CLOSED'].includes(status)
      )
        return;
      if (query.has('symbol') && parsed.symbol !== query.get('symbol')) return;
      if (!conditional) {
        const date = new Date(Date.parse(String(parsed.orderedAt)) + 9 * 3600000)
          .toISOString()
          .slice(0, 10);
        if (
          (query.has('from') && date < String(query.get('from'))) ||
          (query.has('to') && date > String(query.get('to')))
        )
          return;
      }
      return parsed;
    } catch {
      return;
    }
  });
  if (value.hasNext) result.omissions.push({ reason: 'next_page' });
  if (value.hasNext && value.nextCursor == null)
    result.omissions.push({ reason: 'missing_next_cursor' });
  return {
    ...result,
    ...(paginated
      ? {
          page: {
            hasNext: value.hasNext,
            ...('nextCursor' in value ? { nextCursor: value.nextCursor } : {}),
          },
        }
      : {}),
  };
}
