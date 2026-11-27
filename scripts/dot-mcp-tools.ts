import { rankingDurations, rankingTypes } from './toss-discovery.ts';
import { validDate } from './toss-sessions.ts';
import { isinPattern, marketPattern } from './toss-stock.ts';
import { record, symbolPattern, validTime } from './toss-values.ts';

const symbol = { type: 'string', pattern: symbolPattern.source, not: { pattern: '^-' } };
const date = { type: 'string', format: 'date' };
const integer = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });

function tool(
  name: string,
  description: string,
  properties: Record<string, object>,
  required: string[],
  constraints: object = {},
) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
      ...constraints,
    },
    annotations: { readOnlyHint: true },
  };
}

export const marketTools = [
  tool(
    'prices',
    'Query prices by symbol only. A market or ISIN selected with stock does not carry over. For a shared symbol, leave the price unattributed unless other evidence identifies the listing. Provider timestamps can be absent or null. retrievedAt is the CLI retrieval time.',
    {
      symbols: { type: 'array', minItems: 1, maxItems: 200, items: symbol },
      staleAfterSeconds: integer(0, Number.MAX_SAFE_INTEGER),
    },
    ['symbols'],
  ),
  tool(
    'rankings',
    'Query US market rankings by type and duration.',
    {
      type: { type: 'string', enum: rankingTypes },
      duration: { type: 'string', enum: rankingDurations },
      count: integer(1, 100),
    },
    ['type', 'duration'],
    {
      not: {
        properties: {
          type: { enum: ['TOP_GAINERS', 'TOP_LOSERS'] },
          duration: { const: 'realtime' },
        },
      },
    },
  ),
  tool(
    'stock',
    'Identify a stock by symbol. Select an ambiguous listing by market and optional ISIN for this lookup only. Use "-" for a missing ISIN.',
    {
      symbol,
      market: { type: 'string', pattern: marketPattern.source },
      isin: { type: 'string', anyOf: [{ pattern: isinPattern.source }, { const: '-' }] },
    },
    ['symbol'],
    { dependentRequired: { isin: ['market'] } },
  ),
  tool(
    'candles',
    'Query one daily candle page by symbol. No page inherits the market or ISIN selected with stock. With date, the CLI independently confirms a US listing market and rejects ambiguous symbols. For a shared symbol, leave candles unattributed unless other evidence identifies the listing. Track every boundary requested for this query, including source.before from the initial date lookup. Compare page.nextBefore with all of them as instants using their UTC offsets and full fractional seconds. On a match, stop and report the coverage obtained and what remains unconfirmed. If another page is needed and the boundary is new, pass page.nextBefore unchanged as before, omit date, and keep the same symbol, interval, count and adjustment.',
    {
      symbol,
      interval: { type: 'string', const: '1d' },
      count: integer(1, 200),
      adjusted: { type: 'boolean' },
      before: { type: 'string', format: 'date-time' },
      date,
    },
    ['symbol'],
    { not: { required: ['before', 'date'] } },
  ),
  tool(
    'sessions',
    'Query the US market calendar for a date. today.regularMarket.startTime gives the regular opening time when available.',
    { date },
    ['date'],
  ),
];

function validSymbol(value: unknown): value is string {
  return typeof value === 'string' && !value.startsWith('-') && symbolPattern.test(value);
}
function inRange(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function marketArgs(params: unknown): string[] | undefined {
  if (!record(params) || !record(params.arguments)) return;
  const args = params.arguments;
  const definition = marketTools.find(({ name }) => name === params.name);
  if (
    !definition ||
    Object.keys(args).some((key) => !Object.hasOwn(definition.inputSchema.properties, key))
  )
    return;
  switch (params.name) {
    case 'prices': {
      const { symbols, staleAfterSeconds } = args;
      if (
        !Array.isArray(symbols) ||
        !symbols.length ||
        symbols.length > 200 ||
        !symbols.every(validSymbol) ||
        (staleAfterSeconds !== undefined && !inRange(staleAfterSeconds, 0, Number.MAX_SAFE_INTEGER))
      )
        return;
      return [
        'prices',
        symbols.join(','),
        ...(staleAfterSeconds === undefined ? [] : [`staleAfterSeconds=${staleAfterSeconds}`]),
      ];
    }
    case 'rankings': {
      const { type, duration, count } = args;
      if (
        typeof type !== 'string' ||
        !rankingTypes.includes(type) ||
        typeof duration !== 'string' ||
        !rankingDurations.includes(duration) ||
        (type.startsWith('TOP_') && duration === 'realtime') ||
        (count !== undefined && !inRange(count, 1, 100))
      )
        return;
      return ['rankings', type, duration, ...(count === undefined ? [] : [String(count)])];
    }
    case 'stock': {
      const { symbol, market, isin } = args;
      if (
        !validSymbol(symbol) ||
        (market !== undefined && (typeof market !== 'string' || !marketPattern.test(market))) ||
        (isin !== undefined &&
          (market === undefined ||
            typeof isin !== 'string' ||
            (isin !== '-' && !isinPattern.test(isin))))
      )
        return;
      return [
        'stock',
        symbol,
        ...(market === undefined ? [] : [market]),
        ...(isin === undefined ? [] : [isin]),
      ];
    }
    case 'candles': {
      const { symbol, interval, count, adjusted, before, date } = args;
      if (
        !validSymbol(symbol) ||
        (interval !== undefined && interval !== '1d') ||
        (count !== undefined && !inRange(count, 1, 200)) ||
        (adjusted !== undefined && typeof adjusted !== 'boolean') ||
        (before !== undefined && !validTime(before)) ||
        (date !== undefined && (!validDate(date) || before !== undefined))
      )
        return;
      return [
        'candles',
        symbol,
        '1d',
        ...Object.entries({ count, adjusted, before, date })
          .filter(([, v]) => v !== undefined)
          .map(([key, value]) => `${key}=${value}`),
      ];
    }
    case 'sessions':
      if (validDate(args.date)) return ['sessions', args.date];
  }
}
