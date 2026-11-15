import { accountPageQuery } from './toss-account-pagination.ts';
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
  const { query, context } = accountPageQuery(
    new URLSearchParams({ from, to }),
    options,
    (key, value) =>
      key === 'transactionTypes' &&
      (value === '' || value.split(',').every((type) => types.has(type))),
  );
  return {
    query,
    context,
    from,
    to,
    source: {
      from,
      to,
      transactionTypes: query.get('transactionTypes'),
      limit: Number(query.get('limit')),
      dateTimeZone: 'Asia/Seoul',
      dateMeaning: 'settlementDate',
      scope: 'KR_US_transactions_including_options_bonds',
    },
  };
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
