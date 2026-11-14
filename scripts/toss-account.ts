import { TossError } from './toss-client.ts';
import { orderQuery, orderResult } from './toss-orders.ts';
import { transactionQuery, transactionResult } from './toss-transactions.ts';
import { decimal, record, symbolPattern } from './toss-values.ts';

export function accountQuery(
  command: 'holdings' | 'buying-power' | 'transactions' | 'orders' | 'conditional-orders',
  firstArg: string | undefined,
  args: string[],
) {
  if (command === 'transactions') {
    const request = transactionQuery(firstArg, args);
    return {
      query: request.query,
      context: request.context,
      source: request.source,
      parse: (value: unknown) => transactionResult(value, request),
    };
  }
  if (command === 'orders' || command === 'conditional-orders') {
    const request = orderQuery(firstArg, args, command === 'conditional-orders');
    return {
      query: request.query,
      context: request.context,
      source: request.source,
      parse: (value: unknown) => orderResult(value, request),
    };
  }
  if (command === 'buying-power') {
    if (!firstArg || !/^[A-Z]{3}$/.test(firstArg) || args.length)
      throw new TossError('INPUT_INVALID');
    return {
      query: new URLSearchParams({ currency: firstArg }),
      source: { currency: firstArg, scope: 'cash_based_excluding_margin' },
      parse: (value: unknown) => buyingPowerResult(value, firstArg),
    };
  }
  if (args.length || (firstArg !== undefined && !symbolPattern.test(firstArg)))
    throw new TossError('INPUT_INVALID');
  return {
    query: new URLSearchParams(firstArg ? { symbol: firstArg } : {}),
    source: {
      scope: 'KR_US_stocks_excluding_options_bonds',
      quantityUnit: 'securities',
      priceUnit: 'currency_per_security',
      ...(firstArg ? { symbol: firstArg } : {}),
    },
    parse: (value: unknown) => holdingsResult(value, firstArg),
  };
}

function decimals(value: unknown, required: string[], optional: string[] = []) {
  if (!record(value)) throw new TossError('RESPONSE_INVALID');
  const result: Record<string, string | null> = {};
  for (const key of required) {
    if (!decimal(value[key])) throw new TossError('RESPONSE_INVALID');
    result[key] = value[key];
  }
  for (const key of optional) {
    if (!(key in value)) continue;
    if (value[key] !== null && !decimal(value[key])) throw new TossError('RESPONSE_INVALID');
    result[key] = value[key];
  }
  return result;
}
function price(value: unknown) {
  return decimals(value, ['krw'], ['usd']);
}
function valuation(value: unknown, overview: boolean, profit = false) {
  if (!record(value)) throw new TossError('RESPONSE_INVALID');
  return {
    ...(!overview && !profit ? decimals(value, ['purchaseAmount']) : {}),
    ...(overview
      ? { amount: price(value.amount), amountAfterCost: price(value.amountAfterCost) }
      : decimals(value, ['amount', 'amountAfterCost'])),
    ...(profit ? decimals(value, ['rate', 'rateAfterCost']) : {}),
  };
}
function daily(value: unknown, overview: boolean) {
  if (!record(value)) throw new TossError('RESPONSE_INVALID');
  return {
    ...(overview ? { amount: price(value.amount) } : decimals(value, ['amount'])),
    ...decimals(value, ['rate']),
  };
}
function holdingsResult(value: unknown, symbol?: string) {
  if (!record(value)) throw new TossError('RESPONSE_INVALID');
  function parseHolding(row: unknown) {
    if (
      !record(row) ||
      typeof row.symbol !== 'string' ||
      !symbolPattern.test(row.symbol) ||
      (symbol !== undefined && row.symbol !== symbol) ||
      !['name', 'marketCountry', 'currency'].every(
        (key) => typeof row[key] === 'string' && row[key].trim().length > 0,
      )
    )
      return;
    try {
      return {
        symbol: row.symbol,
        name: row.name,
        marketCountry: row.marketCountry,
        currency: row.currency,
        ...decimals(row, ['quantity', 'lastPrice', 'averagePurchasePrice']),
        marketValue: valuation(row.marketValue, false),
        profitLoss: valuation(row.profitLoss, false, true),
        dailyProfitLoss: daily(row.dailyProfitLoss, false),
        cost: decimals(row.cost, ['commission'], ['tax']),
      };
    } catch {
      return;
    }
  }
  const data = [];
  const omissions: { index?: number; field?: string; reason: string }[] = [];
  const rows = Array.isArray(value.items) ? value.items : undefined;
  if (!rows) omissions.push({ field: 'items', reason: 'invalid_items' });
  for (const [index, row] of (rows ?? []).entries()) {
    const item = parseHolding(row);
    if (item) data.push(item);
    else omissions.push({ index, reason: 'invalid_item' });
  }
  const summary: Record<string, unknown> = {};
  for (const [field, parse] of [
    ['totalPurchaseAmount', price],
    ['marketValue', (v: unknown) => valuation(v, true)],
    ['profitLoss', (v: unknown) => valuation(v, true, true)],
    ['dailyProfitLoss', (v: unknown) => daily(v, true)],
  ] as const) {
    try {
      summary[field] = parse(value[field]);
    } catch {
      omissions.push({ field, reason: 'invalid_summary' });
    }
  }
  if (!data.length && !Object.keys(summary).length) throw new TossError('RESPONSE_INVALID');
  return { data: [{ ...summary, ...(rows ? { items: data } : {}) }], omissions };
}
function buyingPowerResult(value: unknown, currency: string) {
  if (
    !record(value) ||
    value.currency !== currency ||
    !decimal(value.cashBuyingPower) ||
    (currency === 'KRW' && !/^-?\d+$/.test(value.cashBuyingPower))
  )
    throw new TossError('RESPONSE_INVALID');
  return { data: [{ currency, cashBuyingPower: value.cashBuyingPower }], omissions: [] };
}
