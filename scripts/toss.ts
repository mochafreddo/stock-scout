import { TossClient, TossError } from './toss-client.ts';
import { AmbiguousStock, isinPattern, marketPattern, stockResult } from './toss-stock.ts';

function containsSecret(json: string, secrets?: Set<string>) {
  for (const secret of secrets ?? [])
    if (json.includes(JSON.stringify(secret).slice(1, -1))) return true;
  return false;
}

function validTime(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  if (
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  )
    return false;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
  );
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
      typeof row.lastPrice !== 'string' ||
      row.lastPrice.length > 30 ||
      !/^-?\d+(?:\.\d+)?$/.test(row.lastPrice) ||
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
const source =
  command === 'stock'
    ? { provider: 'tossinvest', endpoint: '/api/v1/stocks', freshness: 'unknown' }
    : {
        provider: 'tossinvest',
        endpoint: '/api/v1/prices',
        freshness: 'unknown',
        session: 'unknown',
        snapshot: 'unknown',
        priceUnit: 'currency_per_security',
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
            { name: 'stock', usage: 'node scripts/toss.ts stock SYMBOL [MARKET [ISIN]]' },
          ],
        },
      }),
    );
    process.exit(0);
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
    !symbols.split(',').every((symbol) => /^[A-Za-z0-9.-]+$/.test(symbol))
  )
    throw new TossError('INPUT_INVALID');
  client = new TossClient(process.env.TOSS_STATE_DIR, interruption.signal);
  const body = await client.get(`${source.endpoint}?${new URLSearchParams({ symbols })}`);
  if (
    !body ||
    typeof body !== 'object' ||
    !('result' in body) ||
    !Array.isArray(body.result) ||
    'error' in body
  )
    throw new TossError('RESPONSE_INVALID');
  const result =
    command === 'stock'
      ? stockResult(body.result, symbols, rest[0], rest[1])
      : priceResult(body.result, symbols);
  const { data, omissions } = result;
  const status = omissions.length ? 'partial' : 'success';
  client.check();
  const output = JSON.stringify({
    version: 1,
    status,
    data,
    omissions,
    source,
    retrievedAt: new Date().toISOString(),
  });
  if (containsSecret(output, client.secrets)) throw new TossError('SENSITIVE_OUTPUT');
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
      source,
      retrievedAt: new Date().toISOString(),
      error: detail,
    }),
  );
  console.error(detail.code);
  process.exitCode = 1;
}

process.removeListener('SIGINT', interrupt);
process.removeListener('SIGTERM', interrupt);
