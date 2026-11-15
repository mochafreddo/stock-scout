import { TossError } from './toss-client.ts';

export function accountPageQuery(
  query: URLSearchParams,
  args: string[],
  validFilter: (key: string, value: string) => boolean,
  cursorFormat: 'opaque' | 'url-safe' | false = 'opaque',
) {
  if (cursorFormat) query.set('limit', '20');
  const seen = new Set<string>();
  let context: string | undefined;
  for (const arg of args) {
    const separator = arg.indexOf('=');
    const key = arg.slice(0, separator);
    const value = arg.slice(separator + 1);
    let valid: boolean;
    switch (key) {
      case 'limit':
        valid = cursorFormat && /^(?:[1-9]\d?|100)$/.test(value);
        break;
      case 'cursor':
        valid =
          cursorFormat &&
          value.length > 0 &&
          (cursorFormat !== 'url-safe' || /^[A-Za-z0-9_-]+$/.test(value));
        break;
      case 'context':
        valid = cursorFormat && /^[a-f0-9]{64}$/.test(value);
        break;
      default:
        valid = validFilter(key, value);
    }
    if (separator < 0 || seen.has(key) || !valid) throw new TossError('INPUT_INVALID');
    seen.add(key);
    if (key === 'context') context = value;
    else query.set(key, value);
  }
  if (query.has('cursor') !== (context !== undefined)) throw new TossError('INPUT_INVALID');
  return { query, context };
}

export function accountCursorPayload(
  clientId: string,
  accountSeq: string,
  query: URLSearchParams,
  cursor: string,
  endpoint: string,
) {
  if (endpoint === '/api/v1/transactions')
    return JSON.stringify([
      clientId,
      accountSeq,
      query.get('from'),
      query.get('to'),
      query.get('transactionTypes') || '',
      cursor,
    ]);
  const filters = new URLSearchParams(query);
  filters.delete('cursor');
  filters.delete('limit');
  filters.sort();
  return JSON.stringify([clientId, accountSeq, endpoint, filters.toString(), cursor]);
}
