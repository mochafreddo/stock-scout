import { createHash, randomUUID } from 'node:crypto';
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
import { dirname, isAbsolute, join, resolve } from 'node:path';

export class TossError extends Error {
  readonly code: string;
  readonly providerCode?: string;
  readonly requestId?: string;
  constructor(code: string, providerCode?: string, requestId?: string) {
    super(code);
    this.code = code;
    this.providerCode = providerCode;
    this.requestId = requestId;
  }
}
type State = {
  fingerprint: string;
  nextAt: number;
  pending: boolean;
  token?: { value: string; expiresAt: number };
};
function secure(path: string, directory = false) {
  const stat = lstatSync(path);
  if (
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  )
    throw new TossError('AUTH_STORAGE');
}
function read(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 16384
    )
      throw new TossError('AUTH_STORAGE');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}
function save(directory: string, value: State) {
  const target = join(directory, 'state.json');
  if (existsSync(target)) secure(target);
  const temporary = join(directory, `${randomUUID()}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
    const directoryFd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function failure(response: Response, body: unknown) {
  const envelope = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
  const raw =
    envelope && typeof envelope === 'object' && 'code' in envelope
      ? envelope.code
      : typeof envelope === 'string'
        ? envelope
        : undefined;
  const providerCode =
    typeof raw === 'string' && /^[a-z][a-z0-9_-]{0,79}$/.test(raw) ? raw : undefined;
  const id =
    envelope && typeof envelope === 'object' && 'requestId' in envelope
      ? envelope.requestId
      : (response.headers.get('X-Request-Id') ??
        response.headers.get('referenceId') ??
        response.headers.get('x-amz-cf-id'));
  const requestId = typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined;
  const code =
    response.status === 403
      ? 'PERMISSION_DENIED'
      : response.status === 401
        ? 'AUTH_FAILED'
        : providerCode?.startsWith('unsupported-') ||
            (response.status === 404 && providerCode === 'edge-blocked')
          ? 'UNSUPPORTED'
          : response.status === 400
            ? 'INPUT_INVALID'
            : response.status === 404
              ? 'NOT_FOUND'
              : response.status === 429
                ? 'RATE_LIMIT'
                : 'UPSTREAM_ERROR';
  return new TossError(code, providerCode, requestId);
}

export class TossClient {
  readonly secrets = new Set<string>();
  private readonly directory: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fingerprint: string;
  private readonly signal: AbortSignal;
  private readonly startedWall = Date.now();
  private readonly started = performance.now();
  private requests = 0;
  constructor(directory: string | undefined, signal = new AbortController().signal) {
    this.signal = signal;
    try {
      if (!directory || !isAbsolute(directory) || realpathSync(directory) !== resolve(directory))
        throw new TossError('AUTH_STORAGE');
      for (let parent = directory; ; parent = dirname(parent)) {
        if (existsSync(join(parent, '.git'))) throw new TossError('AUTH_STORAGE');
        if (parent === dirname(parent)) break;
      }
      secure(directory, true);
      const value = read(join(directory, 'credentials.json'));
      if (
        typeof value?.clientId !== 'string' ||
        !value.clientId ||
        typeof value?.clientSecret !== 'string' ||
        !value.clientSecret
      )
        throw new TossError('AUTH_CONFIG');
      this.clientId = value.clientId;
      this.clientSecret = value.clientSecret;
      this.directory = directory;
      this.fingerprint = createHash('sha256')
        .update(JSON.stringify([this.clientId, this.clientSecret]))
        .digest('hex');
      this.secrets.add(this.clientId).add(this.clientSecret);
    } catch (error) {
      throw error instanceof TossError ? error : new TossError('AUTH_STORAGE');
    }
  }
  private remaining() {
    return Math.min(
      60000 - (performance.now() - this.started),
      this.startedWall + 60000 - Date.now(),
    );
  }
  check() {
    if (this.signal.aborted) throw new TossError('INTERRUPTED');
    if (this.remaining() <= 0) throw new TossError('TIMEOUT');
  }
  private async wait(milliseconds: number) {
    this.check();
    if (milliseconds >= this.remaining()) throw new TossError('TIMEOUT');
    if (milliseconds > 0)
      await new Promise<void>((resolveWait, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new TossError('INTERRUPTED'));
        };
        const timer = setTimeout(() => {
          this.signal.removeEventListener('abort', abort);
          resolveWait();
        }, milliseconds);
        this.signal.addEventListener('abort', abort, { once: true });
      });
    this.check();
  }
  private load(): State {
    const path = join(this.directory, 'state.json');
    try {
      secure(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { fingerprint: this.fingerprint, nextAt: 0, pending: false };
      throw error;
    }
    const state = read(path);
    if (
      !state ||
      state.fingerprint !== this.fingerprint ||
      !Number.isFinite(state.nextAt) ||
      state.nextAt < 0 ||
      typeof state.pending !== 'boolean' ||
      (state.token !== undefined &&
        (typeof state.token?.value !== 'string' ||
          !/^[A-Za-z0-9._~+/-]+=*$/.test(state.token.value) ||
          !Number.isFinite(state.token.expiresAt)))
    )
      throw new TossError('AUTH_STORAGE');
    if (state.token) this.secrets.add(state.token.value);
    return state;
  }
  private async withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const lock = join(this.directory, name);
    try {
      for (;;) {
        this.check();
        try {
          mkdirSync(lock, { mode: 0o700 });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          await this.wait(25);
        }
      }
      try {
        return await operation();
      } finally {
        rmdirSync(lock);
      }
    } catch (error) {
      throw error instanceof TossError ? error : new TossError('AUTH_STORAGE');
    }
  }
  private locked<T>(operation: (state: State) => Promise<T>) {
    return this.withLock('client.lock', () => operation(this.load()));
  }
  private async transmit(path: string, token?: string) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectDeadline: (error: Error) => void = () => {};
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    void deadline.catch(() => {});
    const abort = () =>
      rejectDeadline(new TossError(this.signal.aborted ? 'INTERRUPTED' : 'TIMEOUT'));
    signal.addEventListener('abort', abort, { once: true });
    let flight: Promise<Response> | undefined;
    let requestWall = 0,
      requestStarted = 0,
      requestLimit = 0;
    const checkRequest = () => {
      this.check();
      if (signal.aborted) throw new TossError(this.signal.aborted ? 'INTERRUPTED' : 'TIMEOUT');
      if (Math.max(Date.now() - requestWall, performance.now() - requestStarted) >= requestLimit)
        throw new TossError('TIMEOUT');
    };
    try {
      for (;;) {
        this.check();
        const delay = await this.locked(async (state) => {
          this.check();
          const delay = state.nextAt - Date.now();
          if (delay > 0) return delay;
          if (this.requests >= 10) throw new TossError('REQUEST_LIMIT');
          const previousToken = state.token;
          const previousPending = state.pending;
          if (!token) {
            state.pending = true;
            delete state.token;
          }
          state.nextAt = Date.now() + 1000;
          save(this.directory, state);
          try {
            this.check();
          } catch (error) {
            if (!token) {
              state.pending = previousPending;
              state.token = previousToken;
              save(this.directory, state);
            }
            throw error;
          }
          this.requests++;
          requestWall = Date.now();
          requestStarted = performance.now();
          requestLimit = Math.max(1, Math.floor(Math.min(15000, this.remaining())));
          timer = setTimeout(() => {
            controller.abort();
            rejectDeadline(new TossError('TIMEOUT'));
          }, requestLimit);
          flight = fetch(`https://openapi.tossinvest.com${path}`, {
            method: token ? 'GET' : 'POST',
            redirect: 'error',
            signal,
            headers: token
              ? { authorization: `Bearer ${token}` }
              : { 'content-type': 'application/x-www-form-urlencoded' },
            ...(token
              ? {}
              : {
                  body: new URLSearchParams({
                    grant_type: 'client_credentials',
                    client_id: this.clientId,
                    client_secret: this.clientSecret,
                  }).toString(),
                }),
          });
          void flight.catch(() => {});
          state.nextAt = Date.now() + 1000;
          save(this.directory, state);
          return 0;
        });
        if (!delay) break;
        await this.wait(delay);
      }
      const result = await Promise.race([
        deadline,
        (async () => {
          const response = await flight;
          if (!response) throw new TossError('NETWORK_ERROR');
          checkRequest();
          const seconds = Math.max(
            0,
            ...['Retry-After', 'X-RateLimit-Reset'].map((name) => {
              const value = response.headers.get(name);
              return value !== null && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : 0;
            }),
          );
          if (!Number.isSafeInteger(Math.ceil(Date.now() + seconds * 1000)))
            throw new TossError('RESPONSE_INVALID');
          if (seconds)
            await this.locked(async (state) => {
              this.check();
              signal.throwIfAborted();
              state.nextAt = Math.max(state.nextAt, Date.now() + seconds * 1000);
              save(this.directory, state);
            });
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            if (reader)
              for (;;) {
                const part = await reader.read();
                checkRequest();
                if (part.done) break;
                bytes += part.value.length;
                if (bytes > 1048576) {
                  throw new TossError('RESPONSE_INVALID');
                }
                chunks.push(part.value);
              }
          } finally {
            reader?.releaseLock();
          }
          let body: unknown;
          try {
            body = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
            );
          } catch {
            if (response.ok) throw new TossError('RESPONSE_INVALID');
          }
          return { response, body };
        })(),
      ]);
      checkRequest();
      return result;
    } catch (error) {
      try {
        if (flight) checkRequest();
        else this.check();
      } finally {
        controller.abort();
      }
      throw error instanceof TossError ? error : new TossError('NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
  private async token(rejected?: string): Promise<string> {
    return this.withLock('issuance.lock', async () => {
      const cached = await this.locked(async (state) => {
        if (
          state.token &&
          state.token.value !== rejected &&
          state.token.expiresAt > Date.now() + 15000
        )
          return state.token.value;
        if (state.pending) throw new TossError('AUTH_ISSUANCE_UNKNOWN');
        return undefined;
      });
      if (cached) return cached;
      const issuedAt = Date.now();
      const { response, body } = await this.transmit('/oauth2/token');
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500)
          await this.locked(async (state) => {
            state.pending = false;
            save(this.directory, state);
          });
        throw failure(response, body);
      }
      if (
        !body ||
        typeof body !== 'object' ||
        !('access_token' in body) ||
        !('token_type' in body) ||
        !('expires_in' in body) ||
        typeof body.expires_in !== 'number' ||
        typeof body.access_token !== 'string' ||
        !/^[A-Za-z0-9._~+/-]+=*$/.test(body.access_token) ||
        body.token_type !== 'Bearer' ||
        !Number.isSafeInteger(body.expires_in) ||
        body.expires_in <= 0 ||
        !Number.isSafeInteger(issuedAt + body.expires_in * 1000)
      )
        throw new TossError('AUTH_RESPONSE_INVALID');
      const token = body.access_token;
      const expiresAt = issuedAt + body.expires_in * 1000;
      this.secrets.add(token);
      await this.locked(async (state) => {
        state.token = { value: token, expiresAt };
        state.pending = false;
        save(this.directory, state);
      });
      return token;
    });
  }
  async get(path: string) {
    if (!path.startsWith('/api/v1/') || /[\r\n#]/.test(path)) throw new TossError('INPUT_INVALID');
    let token = await this.token();
    let recovered = false,
      retried = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let result: { response: Response; body: unknown };
      try {
        result = await this.transmit(path, token);
      } catch (error) {
        if (
          error instanceof TossError &&
          error.code === 'NETWORK_ERROR' &&
          !retried &&
          attempt < 2
        ) {
          retried = true;
          continue;
        }
        throw error;
      }
      const { response, body } = result;
      if (response.ok) return body;
      const error = failure(response, body);
      if (
        response.status === 401 &&
        error.providerCode === 'expired-token' &&
        !recovered &&
        attempt < 2
      ) {
        recovered = true;
        token = await this.token(token);
      } else if ((response.status === 429 || response.status >= 500) && !retried && attempt < 2) {
        retried = true;
      } else throw error;
    }
    throw new TossError('UPSTREAM_ERROR');
  }
}
