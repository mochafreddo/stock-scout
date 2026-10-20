import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const requestedScopes =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const repository = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
function fail(code: string): never {
  throw new Error(code);
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('siwc_invalid_response');
  return value as Record<string, unknown>;
};
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 32_768 &&
  [...value].every((character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127);
const clientId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{1,200}$/.test(value) &&
  value !== 'dynamic_agent_client';
const hostId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export type SiwcCredentials = {
  schemaVersion: 1;
  issuer: string;
  subject: string;
  clientId: string;
  hostId: string;
  accessToken: string;
  idToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  scopes: string[];
  expiresAt: number;
};

function directoryPath(directory: string, create: boolean) {
  if (!isAbsolute(directory) || normalize(directory) !== directory) fail('siwc_unsafe_directory');
  const fromRepository = relative(repository, directory);
  if (
    fromRepository === '' ||
    (!fromRepository.startsWith(`..${sep}`) &&
      fromRepository !== '..' &&
      !isAbsolute(fromRepository))
  )
    fail('siwc_unsafe_directory');
  for (let current = directory; ; current = dirname(current)) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('siwc_unsafe_directory');
    }
    if (dirname(current) === current) break;
  }
  if (create && !lstatSync(directory, { throwIfNoEntry: false }))
    mkdirSync(directory, { mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    realpathSync(directory) !== directory ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    fail('siwc_unsafe_directory');
  return directory;
}

function readPrivate(path: string): unknown {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 131_072
    )
      fail('siwc_unsafe_credentials');
    return JSON.parse(readFileSync(descriptor, 'utf8'));
  } finally {
    closeSync(descriptor);
  }
}

function atomicWrite(directory: string, filename: string, data: unknown) {
  const target = join(directory, filename);
  if (lstatSync(target, { throwIfNoEntry: false })) readPrivate(target);
  const temporary = join(directory, `.${filename}.${randomUUID()}`);
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(data)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    renameSync(temporary, target);
    const parent = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {}
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

function loadCredentials(directory: string): SiwcCredentials {
  const host = object(readPrivate(join(directory, 'host.json')));
  const data = object(readPrivate(join(directory, 'credentials.json')));
  const scopes = data.scopes;
  if (
    data.schemaVersion !== 1 ||
    data.issuer !== issuer ||
    !text(data.subject) ||
    !clientId(data.clientId) ||
    !hostId(data.hostId) ||
    data.hostId !== host.hostId ||
    !text(data.accessToken) ||
    !text(data.idToken) ||
    !text(data.refreshToken) ||
    data.tokenType !== 'Bearer' ||
    !Array.isArray(scopes) ||
    scopes.length > 32 ||
    !scopes.every((scope) => typeof scope === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(scope)) ||
    new Set(scopes).size !== scopes.length ||
    !['openid', 'resource.invoke', 'chatgpt.tokens.use.direct'].every((scope) =>
      scopes.includes(scope),
    ) ||
    typeof data.expiresAt !== 'number' ||
    !Number.isSafeInteger(data.expiresAt) ||
    data.expiresAt <= 0
  )
    fail('siwc_invalid_credentials');
  return data as SiwcCredentials;
}

export function readSiwcCredentials(directory: string): SiwcCredentials {
  try {
    directoryPath(directory, false);
    const credentials = loadCredentials(directory);
    if (credentials.expiresAt <= Date.now()) fail('siwc_credentials_expired');
    return credentials;
  } catch (error) {
    if (error instanceof Error && error.message === 'siwc_credentials_expired') throw error;
    fail('siwc_invalid_credentials');
  }
}

async function request(url: string, options: RequestInit = {}) {
  options.signal?.throwIfAborted();
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (!response.ok) fail('siwc_authentication_failed');
  const body = await response.text();
  options.signal?.throwIfAborted();
  if (body.length > 131_072) fail('siwc_invalid_response');
  return object(JSON.parse(body));
}

async function identity(idToken: string, issuedClient: string, nonce: string, signal: AbortSignal) {
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
    fail('siwc_invalid_identity');
  const header = object(JSON.parse(Buffer.from(parts[0], 'base64url').toString()));
  const claims = object(JSON.parse(Buffer.from(parts[1], 'base64url').toString()));
  if (header.alg !== 'RS256' || !text(header.kid)) fail('siwc_invalid_identity');
  const discovery = await request(`${issuer}/.well-known/openid-configuration`, { signal });
  if (discovery.issuer !== issuer || typeof discovery.jwks_uri !== 'string')
    fail('siwc_invalid_identity');
  const jwksUri = new URL(discovery.jwks_uri);
  if (
    jwksUri.origin !== issuer ||
    jwksUri.username ||
    jwksUri.password ||
    jwksUri.hash ||
    jwksUri.search
  )
    fail('siwc_invalid_identity');
  const jwks = await request(jwksUri.href, { signal });
  if (!Array.isArray(jwks.keys)) fail('siwc_invalid_identity');
  const keys = jwks.keys
    .map(object)
    .filter(
      (key) =>
        key.kid === header.kid &&
        key.kty === 'RSA' &&
        (key.use === undefined || key.use === 'sig') &&
        (key.alg === undefined || key.alg === 'RS256'),
    );
  if (
    keys.length !== 1 ||
    !verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: keys[0], format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'),
    )
  )
    fail('siwc_invalid_identity');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== issuer ||
    !audiences.includes(issuedClient) ||
    (audiences.length > 1 && claims.azp !== issuedClient) ||
    (claims.azp !== undefined && claims.azp !== issuedClient) ||
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= Date.now() / 1000 ||
    claims.nonce !== nonce ||
    !text(claims.sub)
  )
    fail('siwc_invalid_identity');
  return claims.sub;
}

async function login(directory: string) {
  directoryPath(directory, true);
  const lock = join(directory, '.login.lock');
  let lockDescriptor: number;
  try {
    lockDescriptor = openSync(
      lock,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    fail('siwc_login_locked');
  }
  const server = createServer();
  const cancellation = new AbortController();
  let stop: (() => void) | undefined;
  let callbackTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    let saved: SiwcCredentials | undefined;
    if (lstatSync(join(directory, 'credentials.json'), { throwIfNoEntry: false }))
      saved = loadCredentials(directory);
    let host: string;
    if (lstatSync(join(directory, 'host.json'), { throwIfNoEntry: false })) {
      const data = object(readPrivate(join(directory, 'host.json')));
      if (!hostId(data.hostId)) fail('siwc_invalid_credentials');
      host = data.hostId;
    } else {
      host = `urn:uuid:${randomUUID()}`;
      atomicWrite(directory, 'host.json', { hostId: host });
    }
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    await new Promise<void>((resolve, reject) => {
      server.once('error', () => reject(new Error('siwc_listener_failed')));
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') fail('siwc_callback_failed');
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const callback = new Promise<URL>((resolve, reject) => {
      let received = false;
      callbackTimer = setTimeout(() => reject(new Error('siwc_login_timeout')), 300_000);
      stop = () => {
        clearTimeout(callbackTimer);
        cancellation.abort(new Error('siwc_login_cancelled'));
        reject(new Error('siwc_login_cancelled'));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      server.on('request', (incoming, response) => {
        let url: URL;
        try {
          url = new URL(incoming.url ?? '/', redirectUri);
        } catch {
          response.writeHead(404).end();
          return;
        }
        if (
          incoming.method !== 'GET' ||
          url.origin !== new URL(redirectUri).origin ||
          incoming.headers.host !== `127.0.0.1:${address.port}` ||
          url.pathname !== '/auth/callback'
        ) {
          response.writeHead(404).end();
          return;
        }
        if (received) {
          response.writeHead(409).end();
          return;
        }
        received = true;
        clearTimeout(callbackTimer);
        response
          .writeHead(200, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'",
          })
          .end('Continue in the Stock Scout terminal.');
        resolve(url);
      });
    });
    const authorization = new URL(`${issuer}/api/accounts/authorize`);
    authorization.search = new URLSearchParams({
      client_id: saved?.clientId ?? 'dynamic_agent_client',
      ...(saved ? {} : { agent_name_hint: 'Stock Scout' }),
      ext_agent_host_id: host,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: requestedScopes,
      resource,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    process.stdout.write(`${JSON.stringify({ authorizationUrl: authorization.href })}\n`);
    const returned = await callback;
    const params = returned.searchParams;
    for (const key of ['state', 'code', 'client_id', 'error'])
      if (params.getAll(key).length > 1) fail('siwc_invalid_callback');
    const receivedState = params.get('state') ?? '';
    if (
      receivedState.length !== state.length ||
      !timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))
    )
      fail('siwc_invalid_callback');
    if (params.has('error')) fail('siwc_authorization_denied');
    const issued = params.get('client_id') ?? saved?.clientId;
    if (!clientId(issued) || (saved && issued !== saved.clientId) || !text(params.get('code')))
      fail('siwc_invalid_callback');
    const tokens = await request(`${issuer}/api/accounts/oauth/token`, {
      method: 'POST',
      signal: cancellation.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: issued,
        code: params.get('code') ?? '',
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource,
      }),
    });
    const receivedAt = Date.now();
    if (
      !text(tokens.access_token) ||
      !text(tokens.id_token) ||
      !text(tokens.refresh_token) ||
      tokens.token_type !== 'Bearer' ||
      typeof tokens.scope !== 'string' ||
      typeof tokens.expires_in !== 'number' ||
      !Number.isSafeInteger(tokens.expires_in) ||
      tokens.expires_in <= 0 ||
      tokens.expires_in > 31_536_000
    )
      fail('siwc_invalid_response');
    const subject = await identity(tokens.id_token, issued, nonce, cancellation.signal);
    if (saved && subject !== saved.subject) fail('siwc_account_mismatch');
    const credentials: SiwcCredentials = {
      schemaVersion: 1,
      issuer,
      subject,
      clientId: issued,
      hostId: host,
      accessToken: tokens.access_token,
      idToken: tokens.id_token,
      refreshToken: tokens.refresh_token,
      tokenType: 'Bearer',
      scopes: tokens.scope.trim().split(/\s+/),
      expiresAt: receivedAt + tokens.expires_in * 1000,
    };
    if (
      !['openid', 'resource.invoke', 'chatgpt.tokens.use.direct'].every((scope) =>
        credentials.scopes.includes(scope),
      ) ||
      credentials.scopes.length > 32 ||
      new Set(credentials.scopes).size !== credentials.scopes.length ||
      !credentials.scopes.every((scope) => /^[A-Za-z0-9._:-]{1,100}$/.test(scope))
    )
      fail('siwc_plan_permission_missing');
    directoryPath(directory, false);
    if (credentials.expiresAt <= Date.now()) fail('siwc_credentials_expired');
    atomicWrite(directory, 'credentials.json', credentials);
    process.stdout.write(`${JSON.stringify({ status: 'authenticated' })}\n`);
  } catch (error) {
    if (cancellation.signal.aborted) fail('siwc_login_cancelled');
    throw error;
  } finally {
    clearTimeout(callbackTimer);
    if (stop) {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    server.close();
    server.closeAllConnections();
    closeSync(lockDescriptor);
    unlinkSync(lock);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== 'login') fail('siwc_usage');
    await login(process.argv[3]);
  } catch (error) {
    const message =
      error instanceof Error && /^siwc_[a-z_]+$/.test(error.message)
        ? error.message
        : 'siwc_authentication_failed';
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  }
}
