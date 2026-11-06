import { TossError } from './toss-client.ts';

const securityTypes = new Set([
  'STOCK',
  'FOREIGN_STOCK',
  'DEPOSITARY_RECEIPT',
  'INFRASTRUCTURE_FUND',
  'REIT',
  'ETF',
  'FOREIGN_ETF',
  'ETN',
  'STOCK_WARRANTS',
]);
export const isinPattern = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
type StockChoice = { symbol: string; name: string | null; market: string; isinCode: string | null };
export class AmbiguousStock extends TossError {
  readonly choices: StockChoice[];
  constructor(choices: StockChoice[]) {
    super('IDENTITY_AMBIGUOUS');
    this.choices = choices;
  }
}

function stockChoice(row: Record<string, unknown>, symbol: string): StockChoice | undefined {
  if (
    row.symbol !== symbol ||
    typeof row.market !== 'string' ||
    !/^[A-Z][A-Z0-9_]*$/.test(row.market) ||
    typeof row.isinCode !== 'string' ||
    (row.isinCode !== '' && !isinPattern.test(row.isinCode))
  )
    return;
  return {
    symbol,
    market: row.market,
    isinCode: row.isinCode || null,
    name: typeof row.name === 'string' && row.name.trim() ? row.name : null,
  };
}

function stockInfo(row: Record<string, unknown>, choice: StockChoice) {
  if (
    !choice.name ||
    typeof row.englishName !== 'string' ||
    typeof row.status !== 'string' ||
    !/^[A-Z][A-Z0-9_]*$/.test(row.status) ||
    typeof row.securityType !== 'string' ||
    typeof row.isCommonShare !== 'boolean' ||
    typeof row.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(row.currency) ||
    typeof row.sharesOutstanding !== 'string' ||
    row.sharesOutstanding.length > 30 ||
    !/^-?\d+(?:\.\d+)?$/.test(row.sharesOutstanding)
  )
    return;
  return {
    ...choice,
    status: row.status,
    securityType: securityTypes.has(row.securityType) ? row.securityType : null,
  };
}

export function stockResult(rows: unknown[], symbol: string, market?: string, isin?: string) {
  const listings = new Map<string, { choice: StockChoice; row: Record<string, unknown> | null }>();
  const omissions: { index?: number; symbol?: string; reason: string }[] = [];
  for (const [index, value] of rows.entries()) {
    const row =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const choice = row && stockChoice(row, symbol);
    if (!choice) {
      omissions.push({ index, reason: 'invalid_item' });
      continue;
    }
    if ((market && choice.market !== market) || (isin && (choice.isinCode ?? '-') !== isin))
      continue;
    const key = `${choice.market}/${choice.isinCode ?? ''}`;
    const listing = listings.get(key);
    if (listing) {
      listing.row = null;
      if (listing.choice.name !== choice.name) listing.choice.name = null;
    } else listings.set(key, { choice, row });
  }
  if (!listings.size) throw new TossError(omissions.length ? 'RESPONSE_INVALID' : 'NOT_FOUND');
  const candidates = [...listings.values()];
  if (candidates.length > 1) throw new AmbiguousStock(candidates.map(({ choice }) => choice));
  const [listing] = candidates;
  if (!listing.row) throw new TossError('RESPONSE_INVALID');
  const stock = stockInfo(listing.row, listing.choice);
  if (!stock) throw new TossError('RESPONSE_INVALID');
  if (stock.securityType === null) omissions.push({ symbol, reason: 'type_unknown' });
  return { data: [stock], omissions };
}
