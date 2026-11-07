import { TossError } from './toss-client.ts';
import { validDate } from './toss-sessions.ts';
import { decimal, items, record, validTime } from './toss-values.ts';

const types = new Set([
  'BUY',
  'SELL',
  'SECURITIES_TRANSFER_IN',
  'SECURITIES_TRANSFER_OUT',
  'DEPOSIT',
  'WITHDRAWAL',
  'EXCHANGE_IN',
  'EXCHANGE_OUT',
  'DIVIDEND',
  'INTEREST',
  'FEE',
]);
export function transactionQuery(from: string | undefined, args: string[]) {
  const [to, ...options] = args;
  if (!validDate(from) || !validDate(to) || from > to) throw new TossError('INPUT_INVALID');
  const query = new URLSearchParams({ from, to, limit: '20' });
  const seen = new Set<string>();
  let context: string | undefined;
  for (const arg of options) {
    const separator = arg.indexOf('=');
    const key = arg.slice(0, separator);
    const value = arg.slice(separator + 1);
    if (
      separator < 0 ||
      seen.has(key) ||
      !(
        (key === 'limit' && /^(?:[1-9]\d?|100)$/.test(value)) ||
        (key === 'transactionTypes' &&
          (value === '' || value.split(',').every((type) => types.has(type)))) ||
        (key === 'cursor' && value.length > 0) ||
        (key === 'context' && /^[a-f0-9]{64}$/.test(value))
      )
    )
      throw new TossError('INPUT_INVALID');
    seen.add(key);
    if (key === 'context') context = value;
    else query.set(key, value);
  }
  if (query.has('cursor') !== (context !== undefined)) throw new TossError('INPUT_INVALID');
  return { query, context, from, to };
}
export function transactionResult(
  value: unknown,
  { query, from, to }: ReturnType<typeof transactionQuery>,
) {
  if (
    !record(value) ||
    !Array.isArray(value.transactions) ||
    value.transactions.length > Number(query.get('limit')) ||
    typeof value.hasNext !== 'boolean' ||
    (value.nextCursor !== null &&
      (typeof value.nextCursor !== 'string' || !value.nextCursor.length)) ||
    value.hasNext !== (value.nextCursor !== null)
  )
    throw new TossError('RESPONSE_INVALID');
  const filter = query.get('transactionTypes');
  const requestedTypes = filter ? new Set(filter.split(',')) : undefined;
  const result = items(value.transactions, (row) => {
    if (!record(row)) return;
    const output: Record<string, unknown> = {};
    for (const key of ['transactionType', 'marketCountry', 'currency']) {
      if (typeof row[key] !== 'string' || !row[key].trim()) return;
      output[key] = row[key];
    }
    for (const key of ['symbol', 'assetClass', 'isinCode']) {
      if (row[key] !== null && (typeof row[key] !== 'string' || !row[key].trim())) return;
      output[key] = row[key];
    }
    for (const key of [
      'quantity',
      'filledPrice',
      'amount',
      'netAmount',
      'exchangeRate',
      'commission',
      'tax',
    ]) {
      if (
        !(row[key] === null && key !== 'commission' && key !== 'tax') &&
        (!decimal(row[key]) || row[key].startsWith('-'))
      )
        return;
      output[key] = row[key];
    }
    if (
      !validDate(row.settlementDate) ||
      row.settlementDate < from ||
      row.settlementDate > to ||
      typeof row.settled !== 'boolean' ||
      typeof row.isCancellation !== 'boolean' ||
      (row.transactionTime !== null && (!row.settled || !validTime(row.transactionTime))) ||
      (requestedTypes && !requestedTypes.has(String(row.transactionType)))
    )
      return;
    return {
      ...output,
      settlementDate: row.settlementDate,
      settled: row.settled,
      transactionTime: row.transactionTime,
      isCancellation: row.isCancellation,
    };
  });
  if (value.hasNext) result.omissions.push({ reason: 'next_page' });
  return { ...result, page: { hasNext: value.hasNext, nextCursor: value.nextCursor } };
}
