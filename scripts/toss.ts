import { buyingPowerResult, holdingsResult } from './toss-account.ts';
import { candleQuery, candleResult } from './toss-candles.ts';
import { TossClient, TossError } from './toss-client.ts';
import { rankingQuery, rankingResult, tradableQuery, tradableResult } from './toss-discovery.ts';
import { orderbookResult, tradesResult } from './toss-market.ts';
import { orderQuery, orderResult } from './toss-orders.ts';
import { constraintResult, sessionResult, validDate } from './toss-sessions.ts';
import { AmbiguousStock, isinPattern, marketPattern, stockResult } from './toss-stock.ts';
import { transactionQuery, transactionResult } from './toss-transactions.ts';
import { decimal, symbolPattern, validTime } from './toss-values.ts';

function containsSecret(json: string, secrets?: Set<string>) {
  for (const secret of secrets ?? [])
    if (json.includes(JSON.stringify(secret).slice(1, -1))) return true;
  return false;
}

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
function payload(body: unknown) {
  if (!body || typeof body !== 'object' || !('result' in body) || 'error' in body)
    throw new TossError('RESPONSE_INVALID');
  return body.result;
}
const interruption = new AbortController();
const interrupt = () => interruption.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
let client: TossClient | undefined;
const [command, symbols, ...rest] = process.argv.slice(2);
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
              usage: 'node scripts/toss.ts prices SYMBOL[,SYMBOL...]',
              maxSymbols: 200,
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
                'node scripts/toss.ts candles SYMBOL INTERVAL [count=COUNT] [adjusted=true|false] [before=TIMESTAMP]',
              intervals: ['1d', '1m'],
              defaultCount: 100,
              maxCount: 200,
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
      const account = client.selectedAccount(command);
      if (
        paged?.context !== undefined &&
        paged.context !==
          client.accountCursorContext(
            account.accountSeq,
            paged.query,
            paged.query.get('cursor') ?? '',
            endpoint,
          )
      )
        throw new TossError('INPUT_INVALID');
      Object.assign(source, {
        accountAlias: account.alias,
        snapshot: 'unknown',
        ...(order
          ? {
              ...Object.fromEntries([...order.query].filter(([key]) => key !== 'cursor')),
              scope: order.conditional
                ? 'KR_US_all_channels_conditional_orders'
                : 'KR_US_API_supported_order_types_only',
              dateTimeZone: 'Asia/Seoul',
              dateMeaning: order.conditional ? 'createdAt' : 'orderedAt',
              quantityUnit: 'securities',
              priceUnit: 'currency_per_security',
            }
          : transaction
            ? {
                from: transaction.from,
                to: transaction.to,
                transactionTypes: transaction.query.get('transactionTypes'),
                limit: Number(transaction.query.get('limit')),
                dateTimeZone: 'Asia/Seoul',
                dateMeaning: 'settlementDate',
                scope: 'KR_US_transactions_including_options_bonds',
              }
            : command === 'buying-power'
              ? { currency: symbols, scope: 'cash_based_excluding_margin' }
              : {
                  scope: 'KR_US_stocks_excluding_options_bonds',
                  quantityUnit: 'securities',
                  priceUnit: 'currency_per_security',
                  ...(symbols ? { symbol: symbols } : {}),
                }),
      });
      const accounts = payload(await client.get('/api/v1/accounts'));
      if (
        !Array.isArray(accounts) ||
        accounts.some(
          (row) =>
            typeof row?.accountSeq !== 'string' ||
            typeof row.accountNo !== 'string' ||
            !row.accountNo ||
            typeof row.accountType !== 'string' ||
            !row.accountType,
        )
      )
        throw new TossError('RESPONSE_INVALID');
      for (const row of accounts) {
        client.secrets.add(row.accountNo);
        client.accountIdentifiers.add(row.accountSeq);
      }
      const matches = accounts.filter((row) => row.accountSeq === account.accountSeq);
      if (!matches.length) throw new TossError('ACCOUNT_SELECTION_REQUIRED');
      if (matches.length !== 1) throw new TossError('RESPONSE_INVALID');
      const query = paged?.query ?? new URLSearchParams();
      if (!paged && symbols) query.set(command === 'buying-power' ? 'currency' : 'symbol', symbols);
      const value = payload(await client.get(`${endpoint}?${query}`, account.accountSeq));
      const result = transaction
        ? transactionResult(value, transaction)
        : order
          ? orderResult(value, order)
          : undefined;
      if (result) {
        if (!result.page) return result;
        const cursor = result.page.nextCursor;
        if (typeof cursor !== 'string') return result;
        if (client.accountIdentifiers.has(cursor)) throw new TossError('SENSITIVE_OUTPUT');
        return {
          ...result,
          page: {
            ...result.page,
            context: client.accountCursorContext(account.accountSeq, query, cursor, endpoint),
          },
        };
      }
      return command === 'holdings'
        ? holdingsResult(value, symbols)
        : buyingPowerResult(value, symbols);
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
      const query = candleQuery(symbols, rest);
      const daily = query.get('interval') === '1d';
      Object.assign(source, {
        ...Object.fromEntries(query),
        count: Number(query.get('count')),
        adjusted: query.get('adjusted') === 'true',
        originalPricesGuaranteed: false,
        priceUnit: 'currency_per_security',
        volumeUnit: 'securities',
        timestampMeaning: daily ? 'trade_date_local_midnight' : 'minute_end_exclusive',
        usSessionSemantics: {
          ohlc: daily ? 'regular' : 'provider_trades_session_unknown',
          volume: daily ? 'consolidated_including_extended_hours' : 'selected_US_exchanges',
        },
      });
      return candleResult(await read(query), query);
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
    if (
      (command !== 'prices' && command !== 'stock') ||
      (command === 'stock' && symbols?.includes(',')) ||
      !symbols ||
      (command === 'prices'
        ? rest.length > 0
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
  const output = JSON.stringify({
    version: 1,
    status,
    data,
    omissions,
    ...('page' in result ? { page: result.page } : {}),
    source,
    retrievedAt: new Date().toISOString(),
  });
  if (containsSecret(output, client?.secrets)) throw new TossError('SENSITIVE_OUTPUT');
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
  if (containsSecret(JSON.stringify(detail), client?.accountIdentifiers)) detail = { code };
  if (containsSecret(JSON.stringify(detail), client?.secrets))
    detail = { code: 'SENSITIVE_OUTPUT' };
  console.log(
    JSON.stringify({
      version: 1,
      status: 'error',
      data: [],
      source: containsSecret(JSON.stringify(source), client?.secrets)
        ? { provider: 'tossinvest' }
        : source,
      retrievedAt: new Date().toISOString(),
      error: detail,
    }),
  );
  console.error(detail.code);
  process.exitCode = 1;
}

process.removeListener('SIGINT', interrupt);
process.removeListener('SIGTERM', interrupt);
