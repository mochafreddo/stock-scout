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
import { type ExecutionContext, requestSignal } from './candidate-runtime.ts';
import { type ObservedOperation, observeFetch, observeResponse } from './execution-observation.ts';

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
function stored(directory: string) {
  const raw = read(join(directory, 'token.json'));
  if (raw === undefined) return undefined;
  try {
    const token = JSON.parse(raw);
    return token && typeof token === 'object' && !Array.isArray(token)
      ? (token as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
function invalidate(directory: string, fingerprint: string, rejectedToken: string) {
  const token = stored(directory);
  if (token?.fingerprint === fingerprint && token.access_token === rejectedToken) {
    unlinkSync(join(directory, 'token.json'));
    syncDirectory(directory);
  }
}
function cached(directory: string, fingerprint: string) {
  const token = stored(directory);
  if (
    token?.fingerprint === fingerprint &&
    typeof token.access_token === 'string' &&
    /^[A-Za-z0-9._~+/-]+=*$/.test(token.access_token) &&
    expiry(token.access_token_token_expired) - Date.now() > 60_000
  )
    return token.access_token as string;
  return undefined;
}
async function withCache<T>(
  appKey: string,
  appSecret: string,
  operation: (directory: string, fingerprint: string, context: ExecutionContext) => T | Promise<T>,
  context: ExecutionContext = {},
): Promise<T> {
  const observer = context.observation ?? context.runtime?.observation;
  const auth = observer?.start('kis.auth', context.parentId);
  context = { ...context, observation: observer, parentId: auth?.id };
  let lockOperation: ObservedOperation | undefined;
  try {
    context.runtime?.check();
    context.signal?.throwIfAborted();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([appKey, appSecret]))
      .digest('hex');
    try {
      const directory = join(homedir(), 'Library/Caches/stock-scout');
      lockOperation = observer?.start('kis.auth.lock', auth?.id);
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
      observer?.end(lockOperation);
      const release = () => {
        const unlock = observer?.start('kis.auth.unlock', auth?.id);
        try {
          rmdirSync(lock);
          syncDirectory(directory);
          observer?.end(unlock);
        } catch (error) {
          observer?.fail(unlock, error, 'AUTH_STORAGE');
          throw error;
        }
      };
      try {
        return await operation(directory, fingerprint, context);
      } finally {
        release();
      }
    } catch (error) {
      context.runtime?.check();
      context.signal?.throwIfAborted();
      if (lockOperation?.status === 'in_progress')
        observer?.fail(
          lockOperation,
          error,
          error instanceof AuthError ? error.message : 'AUTH_STORAGE',
        );
      if (error instanceof AuthError) throw error;
      const failure = new AuthError('AUTH_STORAGE');
      observer?.propagate(failure, error);
      throw failure;
    }
  } catch (error) {
    observer?.fail(auth, error);
    throw error;
  } finally {
    observer?.end(auth);
  }
}
export async function invalidateToken(
  appKey: string,
  appSecret: string,
  rejectedToken: string,
  context: ExecutionContext = {},
) {
  await withCache(
    appKey,
    appSecret,
    (directory, fingerprint, context) => {
      const observer = context.observation ?? context.runtime?.observation;
      const operation = observer?.start('kis.auth.invalidate', context.parentId);
      try {
        invalidate(directory, fingerprint, rejectedToken);
        observer?.end(operation);
      } catch (error) {
        observer?.fail(operation, error, 'AUTH_STORAGE');
        throw error;
      }
    },
    context,
  );
}
export async function accessToken(
  appKey: string,
  appSecret: string,
  rejectedToken?: string,
  context: ExecutionContext = {},
): Promise<string> {
  return withCache(
    appKey,
    appSecret,
    async (directory, fingerprint, context) => {
      const observer = context.observation ?? context.runtime?.observation;
      let operation: ObservedOperation | undefined;
      try {
        if (rejectedToken !== undefined) {
          operation = observer?.start('kis.auth.invalidate', context.parentId);
          invalidate(directory, fingerprint, rejectedToken);
          observer?.end(operation);
        }
        operation = observer?.start('kis.auth.load', context.parentId);
        const previous = record(directory);
        const token = cached(directory, fingerprint);
        observer?.end(operation);
        if (previous?.kind === 'attempt' && token) {
          observer?.end(observer.start('kis.auth.reuse', context.parentId));
          return token;
        }
        if (!previous) {
          operation = observer?.start('kis.auth.store', context.parentId);
          save(directory, 'issuance.json', { kind: 'initial', at: Date.now() });
          observer?.end(operation);
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
        if (token) {
          observer?.end(observer.start('kis.auth.reuse', context.parentId));
          return token;
        }
        context.runtime?.check();
        context.signal?.throwIfAborted();
        context.runtime?.checkRequest('issuance');
        operation = observer?.start('kis.auth.store', context.parentId);
        save(directory, 'issuance.json', { kind: 'attempt', at: Date.now() });
        observer?.end(operation);
        const issuance = observer?.start('kis.auth.issuance', context.parentId);
        operation = issuance;
        let request: ObservedOperation | undefined;
        let signal: AbortSignal | undefined;
        let raw: unknown;
        try {
          signal = requestSignal(context, 15_000);
          context.runtime?.take('issuance');
          request = observer?.start('kis.auth.issuance.http', issuance?.id, 'request');
          let response = await observeFetch(
            'https://openapi.koreainvestment.com:9443/oauth2/tokenP',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                grant_type: 'client_credentials',
                appkey: appKey,
                appsecret: appSecret,
              }),
              signal,
              redirect: 'error',
            },
            observer,
            request,
          );
          if (!response.ok) {
            observer?.headers(request, response.status);
            throw new AuthError('AUTH_FAILED');
          }
          response = observeResponse(response, observer, request, signal);
          raw = await response.json();
          context.runtime?.check();
          context.signal?.throwIfAborted();
          observer?.end(request);
        } catch (error) {
          if (request?.streamEnd === null && request.httpStatus === null)
            observer?.streamEnd(request, 'read_error', signal);
          observer?.fail(request, error);
          context.runtime?.check();
          context.signal?.throwIfAborted();
          const failure = new AuthError('AUTH_FAILED');
          observer?.propagate(failure, error);
          throw failure;
        }
        observer?.end(issuance);
        operation = observer?.start('kis.auth.validation', context.parentId);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
          throw new AuthError('AUTH_FAILED');
        const body = raw as Record<string, unknown>;
        if (
          typeof body.access_token !== 'string' ||
          body.access_token === rejectedToken ||
          !/^[A-Za-z0-9._~+/-]+=*$/.test(body.access_token) ||
          expiry(body.access_token_token_expired) - Date.now() <= 60_000 ||
          !Number.isFinite(expiry(body.access_token_token_expired)) ||
          (body.rt_cd !== undefined && body.rt_cd !== '0') ||
          body.error_code !== undefined
        )
          throw new AuthError('AUTH_FAILED');
        observer?.end(operation);
        operation = observer?.start('kis.auth.store', context.parentId);
        save(directory, 'token.json', {
          fingerprint,
          access_token: body.access_token,
          access_token_token_expired: body.access_token_token_expired,
        });
        observer?.end(operation);
        return body.access_token;
      } catch (error) {
        if (operation?.status === 'in_progress')
          observer?.fail(
            operation,
            error,
            error instanceof AuthError ? error.message : 'AUTH_STORAGE',
          );
        throw error;
      }
    },
    context,
  );
}
