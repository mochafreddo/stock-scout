import { TossClient, TossError } from './toss-client.ts';
import { rankingQuery, rankingResult, tradableQuery, tradableResult } from './toss-discovery.ts';
import { AmbiguousStock, isinPattern, marketPattern, stockResult } from './toss-stock.ts';
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
};
const endpoint = Object.hasOwn(endpoints, command) ? endpoints[command] : endpoints.prices;
const source = {
  provider: 'tossinvest',
  endpoint,
  freshness: 'unknown',
  ...(endpoint === endpoints.prices
    ? { session: 'unknown', snapshot: 'unknown', priceUnit: 'currency_per_security' }
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
