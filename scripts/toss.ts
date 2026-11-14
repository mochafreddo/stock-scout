import { buyingPowerResult, holdingsResult } from './toss-account.ts';
import {
  candleBatchQuery,
  candleQuery,
  queryCandleBatch,
  queryCandlePage,
} from './toss-candles.ts';
import { TossClient, TossError } from './toss-client.ts';
import { rankingQuery, rankingResult, tradableQuery, tradableResult } from './toss-discovery.ts';
import { orderbookResult, tradesResult } from './toss-market.ts';
import { orderQuery, orderResult } from './toss-orders.ts';
import { priceAge, priceQuery, priceResult } from './toss-prices.ts';
import { constraintResult, sessionResult, validDate } from './toss-sessions.ts';
import { AmbiguousStock, stockQuery, stockResult } from './toss-stock.ts';
import { transactionQuery, transactionResult } from './toss-transactions.ts';
import { symbolPattern } from './toss-values.ts';

const interruption = new AbortController();
const interrupt = () => interruption.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
let client: TossClient | undefined;
function errorDetail(error: unknown) {
  const code = error instanceof TossError ? error.code : 'INTERNAL_ERROR';
  let detail = {
    code,
    ...(error instanceof AmbiguousStock ? { choices: error.choices } : {}),
    ...(error instanceof TossError
      ? { providerCode: error.providerCode, requestId: error.requestId }
      : {}),
  };
  for (const field of ['choices', 'providerCode', 'requestId'] as const)
    if (
      detail[field] !== undefined &&
      client?.containsAccountIdentifier(JSON.stringify(detail[field]))
    )
      delete detail[field];
  if (client?.containsSecret(JSON.stringify(detail))) detail = { code: 'SENSITIVE_OUTPUT' };
  return detail;
}
const [command, symbols, ...rest] = process.argv.slice(2);
const endpoints: Record<string, string> = {
  stock: '/api/v1/stocks',
  prices: '/api/v1/prices',
  rankings: '/api/v1/rankings',
  tradable: '/api/v1/stocks/all',
  orderbook: '/api/v1/orderbook',
  trades: '/api/v1/trades',
  candles: '/api/v1/candles',
  'candles-batch': '/api/v1/candles',
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
              name: 'candles-batch',
              usage:
                'node scripts/toss.ts candles-batch SYMBOL[,SYMBOL...] [count=COUNT] [adjusted=true|false] [before=TIMESTAMP | date=YYYY-MM-DD]',
              maxSymbols: 20,
              interval: '1d',
              defaultCount: 100,
              maxCount: 200,
              executionLimits: { maxSeconds: 120, maxHttpTransmissions: 40, maxHttpSeconds: 15 },
              semantics:
                'Sequential one-page daily queries with one budget including market checks, authentication, retries, locks and waits; common HTTP spacing still applies. Limits do not guarantee completion. Date selection uses the same verified US inclusive New York date as candles. Copy each page.nextBefore to the individual candles command without date. Completion and inProgress remain unknown.',
              results:
                'Ordered per-symbol success, partial, error or not_queried. Valid empty pages are usable. Handled SIGINT/SIGTERM and limits preserve completed results and distinguish the current error from unqueried symbols. No automatic file storage, resume or recovery after forced termination/crash.',
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
  function read(query: URLSearchParams) {
    client = new TossClient(process.env.TOSS_STATE_DIR, interruption.signal);
    return client.get(`${source.endpoint}?${query}`);
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
    if (command === 'candles-batch') {
      const requests = candleBatchQuery(symbols, rest);
      client = new TossClient(process.env.TOSS_STATE_DIR, interruption.signal, 'batch');
      return queryCandleBatch(client, requests, source, errorDetail, (code) => console.error(code));
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
    if (command === 'stock') {
      const request = stockQuery(symbols, rest);
      return stockResult(await read(request.query), request.symbol, request.market, request.isin);
    }
    if (command === 'prices') {
      const priceRequest = priceQuery(symbols, rest);
      return { ...priceResult(await read(priceRequest.query), priceRequest), priceRequest };
    }
    throw new TossError('INPUT_INVALID');
  }
  const result = await lookup();
  const { data, omissions } = result;
  const status = 'status' in result ? result.status : omissions.length ? 'partial' : 'success';
  if (command !== 'candles-batch') client?.check();
  const retrievedAt = new Date().toISOString();
  const outputData =
    'priceRequest' in result ? priceAge(result.data, result.priceRequest, retrievedAt) : data;
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
  process.exitCode = status === 'error' ? 1 : status === 'partial' ? 2 : 0;
} catch (error) {
  const detail = errorDetail(error);
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
