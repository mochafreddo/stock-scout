import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export class AuthError extends Error {
  readonly retryAfterSeconds?: number;
  readonly guidance?: string;
  constructor(code: string, retryAfterSeconds?: number, guidance?: string) {
    super(code);
    this.retryAfterSeconds = retryAfterSeconds;
    this.guidance = guidance;
  }
}
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
function secure(path: string, directory = false) {
  const stat = lstatSync(path);
  if (
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  )
    throw new AuthError('AUTH_STORAGE');
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function read(path: string) {
  try {
    secure(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 65536
    )
      throw new AuthError('AUTH_STORAGE');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
function save(directory: string, name: string, value: unknown) {
  const target = join(directory, name);
  if (existsSync(target)) secure(target);
  const temporary = join(directory, `${name}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, target);
    syncDirectory(directory);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function expiry(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return NaN;
  const time = Date.parse(`${value.replace(' ', 'T')}+09:00`);
  return Number.isFinite(time) &&
    new Date(time + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ') === value
    ? time
    : NaN;
}
function record(directory: string) {
  const raw = read(join(directory, 'issuance.json'));
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      !['initial', 'attempt'].includes(value.kind) ||
      !Number.isSafeInteger(value.at) ||
      value.at < 0 ||
      value.at > 8_640_000_000_000_000 - 300_000
    )
      throw new Error();
    return value as { kind: string; at: number };
  } catch {
    throw new AuthError(
      'AUTH_RECORD',
      undefined,
      'Stop all stock-scout CLI executions. Preserve token.json; remove only the damaged issuance.json, then rerun to record a new 300-second initial wait.',
    );
  }
}
function cached(directory: string, fingerprint: string) {
  const raw = read(join(directory, 'token.json'));
  if (raw === undefined) return undefined;
  try {
    const token = JSON.parse(raw);
    if (
      token?.fingerprint === fingerprint &&
      typeof token.access_token === 'string' &&
      /^[A-Za-z0-9._~+/-]+=*$/.test(token.access_token) &&
      expiry(token.access_token_token_expired) - Date.now() > 60_000
    )
      return token.access_token as string;
  } catch {
    return undefined;
  }
  return undefined;
}
export async function accessToken(appKey: string, appSecret: string): Promise<string> {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([appKey, appSecret]))
    .digest('hex');
  try {
    const directory = join(homedir(), 'Library/Caches/stock-scout');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== resolve(directory)) throw new AuthError('AUTH_STORAGE');
    secure(directory, true);
    const lock = join(directory, 'issuance.lock');
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new AuthError(
          'AUTH_LOCKED',
          undefined,
          'Stop all stock-scout CLI executions, then remove only issuance.lock. Preserve token.json and issuance.json.',
        );
      throw error;
    }
    try {
      const previous = record(directory);
      const token = cached(directory, fingerprint);
      if (previous?.kind === 'attempt' && token) return token;
      if (!previous) {
        save(directory, 'issuance.json', { kind: 'initial', at: Date.now() });
        throw new AuthError('AUTH_COOLDOWN', 300, 'Run again after the remaining seconds.');
      }
      const remaining = previous.at + 300_000 - Date.now();
      if (remaining > 0)
        throw new AuthError(
          'AUTH_COOLDOWN',
          Math.ceil(remaining / 1000),
          previous.at > Date.now()
            ? 'Check the system clock. Run again after the remaining seconds.'
            : 'Run again after the remaining seconds.',
        );
      if (token) return token;
      save(directory, 'issuance.json', { kind: 'attempt', at: Date.now() });
      let raw: unknown;
      try {
        const response = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'client_credentials',
            appkey: appKey,
            appsecret: appSecret,
          }),
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
        });
        if (!response.ok) throw new Error();
        raw = await response.json();
      } catch {
        throw new AuthError('AUTH_FAILED');
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AuthError('AUTH_FAILED');
      const body = raw as Record<string, unknown>;
      if (
        typeof body.access_token !== 'string' ||
        !/^[A-Za-z0-9._~+/-]+=*$/.test(body.access_token) ||
        expiry(body.access_token_token_expired) - Date.now() <= 60_000 ||
        !Number.isFinite(expiry(body.access_token_token_expired)) ||
        (body.rt_cd !== undefined && body.rt_cd !== '0') ||
        body.error_code !== undefined
      )
        throw new AuthError('AUTH_FAILED');
      save(directory, 'token.json', {
        fingerprint,
        access_token: body.access_token,
        access_token_token_expired: body.access_token_token_expired,
      });
      return body.access_token;
    } finally {
      rmdirSync(lock);
      syncDirectory(directory);
    }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('AUTH_STORAGE');
  }
}
