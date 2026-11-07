import { TossError } from './toss-client.ts';

export const symbolPattern = /^[A-Za-z0-9.-]+$/;

export function wholeSecondMillis(value: string) {
  return Date.parse(value.replace(/\.\d+/, ''));
}

export function laterThan(left: string, right: string) {
  const difference = wholeSecondMillis(left) - wholeSecondMillis(right);
  if (difference !== 0) return difference > 0;
  const fraction = (value: string) => /\.(\d+)/.exec(value)?.[1] ?? '';
  const a = fraction(left);
  const b = fraction(right);
  const length = Math.max(a.length, b.length);
  return a.padEnd(length, '0') > b.padEnd(length, '0');
}

export function validTime(value: unknown) {
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
export function decimal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 30 && /^-?\d+(?:\.\d+)?$/.test(value);
}

export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function items<T>(rows: unknown[], parse: (row: unknown) => T | undefined) {
  const data: T[] = [];
  const omissions: { index?: number; reason: string }[] = [];
  for (const [index, row] of rows.entries()) {
    const item = parse(row);
    if (item === undefined) omissions.push({ index, reason: 'invalid_item' });
    else data.push(item);
  }
  if (rows.length && !data.length) throw new TossError('RESPONSE_INVALID');
  return { data, omissions };
}
