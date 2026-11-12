import { buyingPowerResult, holdingsResult } from './toss-account.ts';
import { candleQuery, queryCandlePage } from './toss-candles.ts';
import { payload, TossClient, TossError } from './toss-client.ts';
import { rankingQuery, rankingResult, tradableQuery, tradableResult } from './toss-discovery.ts';
import { orderbookResult, tradesResult } from './toss-market.ts';
import { orderQuery, orderResult } from './toss-orders.ts';
import { constraintResult, sessionResult, validDate } from './toss-sessions.ts';
import { AmbiguousStock, isinPattern, marketPattern, stockResult } from './toss-stock.ts';
import { transactionQuery, transactionResult } from './toss-transactions.ts';
import { decimal, laterThan, symbolPattern, validTime, wholeSecondMillis } from './toss-values.ts';

function priceResult(rows: unknown[], symbols: string) {
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
const interruption = new AbortController();
const interrupt = () => interruption.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
let client: TossClient | undefined;
const [command, symbols, ...rest] = process.argv.slice(2);
let staleAfterSeconds = 900;
const endpoints: Record<string, string> = {
  stock: '/api/v1/stocks',
  prices: '/api/v1/prices',
  rankings: '/api/v1/rankings',
  tradable: '/api/v1/stocks/all',
  orderbook: '/api/v1/orderbook',
  trades: '/api/v1/trades',
  candles: '/api/v1/candles',
  sessions: '/api/v1/market-calendar/US',
  constraints: '/api/v1/market-calendar/US',
  'account-select': 'local:account-selection',
  'buying-power': '/api/v1/buying-power',
  holdings: '/api/v1/holdings',
  transactions: '/api/v1/transactions',
  orders: '/api/v1/orders',
  'conditional-orders': '/api/v1/conditional-orders',
};
const endpoint = Object.hasOwn(endpoints, command) ? endpoints[command] : endpoints.prices;
const source = {
  provider: 'tossinvest',
  endpoint,
  freshness: 'unknown',
  ...(endpoint === endpoints.prices ||
  endpoint === endpoints.orderbook ||
  endpoint === endpoints.trades
    ? {
        session: 'unknown',
        snapshot: 'unknown',
        priceUnit: 'currency_per_security',
        ...(endpoint !== endpoints.prices ? { volumeUnit: 'securities' } : {}),
      }
    : {}),
};
try {
  if (command === '--help' && symbols === undefined) {
    console.log(
      JSON.stringify({
        version: 1,
        status: 'success',
        data: {
          commands: [
            {
              name: 'prices',
              usage: 'node scripts/toss.ts prices SYMBOL[,SYMBOL...] [staleAfterSeconds=SECONDS]',
              maxSymbols: 200,
              defaultStaleAfterSeconds: 900,
              priceAge:
                'Elapsed seconds from provider timestamp to retrievedAt; warns only above the threshold. Missing, null and future timestamps are unavailable. No realtime or transport-delay guarantee.',
            },
            {
              name: 'tradable',
              usage:
                'node scripts/toss.ts tradable MARKET [status=STATUS] [securityType=TYPE] [commonShare=true|false]',
            },
            { name: 'rankings', usage: 'node scripts/toss.ts rankings TYPE DURATION [COUNT]' },
            { name: 'stock', usage: 'node scripts/toss.ts stock SYMBOL [MARKET [ISIN]]' },
            { name: 'orderbook', usage: 'node scripts/toss.ts orderbook SYMBOL' },
            {
              name: 'candles',
              usage:
                'node scripts/toss.ts candles SYMBOL INTERVAL [count=COUNT] [adjusted=true|false] [before=TIMESTAMP | date=YYYY-MM-DD]',
              intervals: ['1d', '1m'],
              defaultCount: 100,
              maxCount: 200,
              dateSelection: {
                interval: '1d',
                market: 'provider_verified_US',
                timeZone: 'America/New_York',
                boundary: 'inclusive_trade_date',
                conflictsWith: 'before',
                continuation: 'copy_page_nextBefore_to_before_without_date',
                completion: 'unknown',
                inProgress: 'unknown',
              },
            },
            {
              name: 'trades',
              usage: 'node scripts/toss.ts trades SYMBOL [COUNT]',
              defaultCount: 50,
              maxCount: 50,
            },
            {
              name: 'account-select',
              usage: 'node scripts/toss.ts account-select PROTECTED_JSON_FILE',
            },
            {
              name: 'transactions',
              usage:
                'node scripts/toss.ts transactions FROM TO [limit=COUNT] [transactionTypes=TYPE,...] [cursor=CURSOR context=CONTEXT]',
              defaultCount: 20,
              maxCount: 100,
            },
            {
              name: 'orders',
              usage:
                'node scripts/toss.ts orders OPEN [symbol=SYMBOL] [from=DATE] [to=DATE] | orders CLOSED [symbol=SYMBOL] [from=DATE] [to=DATE] [limit=COUNT] [cursor=CURSOR context=CONTEXT]',
            },
            {
              name: 'conditional-orders',
              usage:
                'node scripts/toss.ts conditional-orders OPEN|CLOSED [symbol=SYMBOL] [limit=COUNT] [cursor=CURSOR context=CONTEXT]',
            },
            { name: 'holdings', usage: 'node scripts/toss.ts holdings [SYMBOL]' },
            { name: 'buying-power', usage: 'node scripts/toss.ts buying-power CURRENCY' },
            { name: 'sessions', usage: 'node scripts/toss.ts sessions DATE' },
            { name: 'constraints', usage: 'node scripts/toss.ts constraints SYMBOL DATE' },
          ],
        },
      }),
    );
    process.exit(0);
  }
  async function read(query: URLSearchParams) {
    client = new TossClient(process.env.TOSS_STATE_DIR, interruption.signal);
    return payload(await client.get(`${source.endpoint}?${query}`));
  }
  async function lookup() {
    if (command === 'account-select') {
      if (!symbols || rest.length) throw new TossError('INPUT_INVALID');
      client = new TossClient(process.env.TOSS_STATE_DIR, interruption.signal);
      return { data: [await client.selectAccount(symbols)], omissions: [] };
    }
    if (
      command === 'buying-power' ||
      command === 'holdings' ||
      command === 'transactions' ||
      command === 'orders' ||
      command === 'conditional-orders'
    ) {
      const transaction = command === 'transactions' ? transactionQuery(symbols, rest) : undefined;
      const order =
        command === 'orders' || command === 'conditional-orders'
          ? orderQuery(symbols, rest, command === 'conditional-orders')
          : undefined;
      const paged = transaction ?? order;
      if (
        !paged &&
        (rest.length ||
          (command === 'buying-power'
            ? !symbols || !/^[A-Z]{3}$/.test(symbols)
            : symbols !== undefined && !symbolPattern.test(symbols)))
      )
        throw new TossError('INPUT_INVALID');
      client = new TossClient(process.env.TOSS_STATE_DIR, interruption.signal);
      const query = paged?.query ?? new URLSearchParams();
      if (!paged && symbols) query.set(command === 'buying-power' ? 'currency' : 'symbol', symbols);
      return client.queryAccount(
        { scope: command, endpoint, query, context: paged?.context },
        (value) =>
          transaction
            ? transactionResult(value, transaction)
            : order
              ? orderResult(value, order)
              : command === 'holdings'
                ? holdingsResult(value, symbols)
                : buyingPowerResult(value, symbols),
        (alias) =>
          Object.assign(source, {
            accountAlias: alias,
            snapshot: 'unknown',
            ...(paged
              ? paged.source
              : command === 'buying-power'
                ? { currency: symbols, scope: 'cash_based_excluding_margin' }
                : {
                    scope: 'KR_US_stocks_excluding_options_bonds',
                    quantityUnit: 'securities',
                    priceUnit: 'currency_per_security',
                    ...(symbols ? { symbol: symbols } : {}),
                  }),
          }),
      );
    }
    if (command === 'sessions' || command === 'constraints') {
      const date = command === 'sessions' ? symbols : rest[0];
      if (
        !validDate(date) ||
        (command === 'sessions'
          ? rest.length > 0
          : !symbols || !symbolPattern.test(symbols) || rest.length !== 1)
      )
        throw new TossError('INPUT_INVALID');
      Object.assign(source, {
        date,
        dateTimeZone: 'America/New_York',
        sessionTimeZone: 'Asia/Seoul',
        scope: 'provider_US_market_calendar',
      });
      if (command === 'constraints')
        Object.assign(source, {
          symbol: symbols,
          symbolMarket: 'unverified_US_requested',
          rulesVersion: '1.2.28',
          rulesCheckedOn: '2026-11-07',
          rulesSource: 'https://openapi.tossinvest.com/openapi-docs/latest/openapi.json',
          rulesScope: 'documented_API_rules_not_live_eligibility',
        });
      const value = await read(new URLSearchParams({ date }));
      return command === 'sessions'
        ? sessionResult(value, date)
        : constraintResult(value, symbols, date);
    }
    if (command === 'candles') {
      const request = candleQuery(symbols, rest);
      Object.assign(source, request.source);
      client = new TossClient(process.env.TOSS_STATE_DIR, interruption.signal);
      const result = await queryCandlePage(client, request);
      Object.assign(source, result.source);
      return result;
    }
    if (command === 'orderbook' || command === 'trades') {
      const count = rest[0] ?? '50';
      if (
        !symbols ||
        !symbolPattern.test(symbols) ||
        (command === 'orderbook'
          ? rest.length > 0
          : rest.length > 1 || !/^(?:[1-9]|[1-4]\d|50)$/.test(count))
      )
        throw new TossError('INPUT_INVALID');
      const query = new URLSearchParams({ symbol: symbols });
      Object.assign(source, { symbol: symbols });
      if (command === 'trades') {
        query.set('count', count);
        Object.assign(source, {
          count: Number(count),
          scope: 'provider_current_day_recent_trades',
        });
        return tradesResult(await read(query), Number(count));
      }
      return orderbookResult(await read(query));
    }
    if (command === 'rankings') {
      const query = rankingQuery(symbols, rest);
      Object.assign(source, Object.fromEntries(query), { aggregation: 'US_market' });
      const result = rankingResult(await read(query), Number(query.get('count')));
      Object.assign(source, result.timing);
      return result;
    }
    if (command === 'tradable') {
      const query = tradableQuery(symbols, rest);
      Object.assign(source, Object.fromEntries(query));
      return tradableResult(await read(query), query);
    }
    if (command === 'prices' && rest.length) {
      if (
        rest.length !== 1 ||
        !/^staleAfterSeconds=(?:0|[1-9]\d*)$/.test(rest[0]) ||
        !Number.isSafeInteger(Number(rest[0].slice('staleAfterSeconds='.length)))
      )
        throw new TossError('INPUT_INVALID');
      staleAfterSeconds = Number(rest[0].slice('staleAfterSeconds='.length));
    }
    if (
      (command !== 'prices' && command !== 'stock') ||
      (command === 'stock' && symbols?.includes(',')) ||
      !symbols ||
      (command === 'prices'
        ? rest.length > 1
        : rest.length > 2 ||
          (rest[0] !== undefined && !marketPattern.test(rest[0])) ||
          (rest[1] !== undefined && rest[1] !== '-' && !isinPattern.test(rest[1]))) ||
      symbols.split(',').length > 200 ||
      !symbols.split(',').every((symbol) => symbolPattern.test(symbol))
    )
      throw new TossError('INPUT_INVALID');

    const rows = await read(new URLSearchParams({ symbols }));
    if (!Array.isArray(rows)) throw new TossError('RESPONSE_INVALID');
    return command === 'stock'
      ? stockResult(rows, symbols, rest[0], rest[1])
      : priceResult(rows, symbols);
  }
  const result = await lookup();
  const { data, omissions } = result;
  const status = omissions.length ? 'partial' : 'success';
  client?.check();
  const retrievedAt = new Date().toISOString();
  const outputData =
    command === 'prices'
      ? data.map((row) => {
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
        })
      : data;
  const output = JSON.stringify({
    version: 1,
    status,
    data: outputData,
    omissions,
    ...('page' in result ? { page: result.page } : {}),
    source,
    retrievedAt,
  });
  if (client?.containsSecret(output)) throw new TossError('SENSITIVE_OUTPUT');
  console.log(output);
  process.exitCode = status === 'partial' ? 2 : 0;
} catch (error) {
  const code = error instanceof TossError ? error.code : 'INTERNAL_ERROR';
  let detail = {
    code,
    ...(error instanceof AmbiguousStock ? { choices: error.choices } : {}),
    ...(error instanceof TossError
      ? { providerCode: error.providerCode, requestId: error.requestId }
      : {}),
  };
  if (client?.containsAccountIdentifier(JSON.stringify(detail))) detail = { code };
  if (client?.containsSecret(JSON.stringify(detail))) detail = { code: 'SENSITIVE_OUTPUT' };
  console.log(
    JSON.stringify({
      version: 1,
      status: 'error',
      data: [],
      source: client?.containsSecret(JSON.stringify(source)) ? { provider: 'tossinvest' } : source,
      retrievedAt: new Date().toISOString(),
      error: detail,
    }),
  );
  console.error(detail.code);
  process.exitCode = 1;
}

process.removeListener('SIGINT', interrupt);
process.removeListener('SIGTERM', interrupt);
