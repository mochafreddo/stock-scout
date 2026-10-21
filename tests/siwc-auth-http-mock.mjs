import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

const issuer = 'https://auth.openai.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
const mode = process.env.TEST_MODE;
let clock = 2_000_000_000_000;
if (mode?.startsWith('validation-')) Date.now = () => clock;
globalThis.fetch = async (url, options = {}) => {
  if (mode === 'reader-block-network') throw new Error('Reader HTTP disabled');
  const address = String(url);
  const body = options.body ? String(options.body) : null;
  appendFileSync(
    process.env.TEST_TRACE,
    `${JSON.stringify({ url: address, method: options.method ?? 'GET', body, headers: options.headers })}\n`,
  );
  const [, phase] = mode?.split(':') ?? [];
  const pausedAddress = {
    token: `${issuer}/api/accounts/oauth/token`,
    discovery: `${issuer}/.well-known/openid-configuration`,
    jwks: `${issuer}/.well-known/jwks.json`,
  }[phase];
  if (mode?.startsWith('cancel:') && address === pausedAddress) {
    await new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture cancellation timeout')), 5000);
      options.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          appendFileSync(
            process.env.TEST_TRACE,
            `${JSON.stringify({ event: 'aborted', url: address })}\n`,
          );
          reject(options.signal.reason);
        },
        { once: true },
      );
    });
  }
  if (address === `${issuer}/.well-known/openid-configuration`) {
    if (mode?.startsWith('validation-')) clock += 30_000;
    return Response.json({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json` });
  }
  if (address === `${issuer}/.well-known/jwks.json`) {
    if (mode?.startsWith('validation-')) clock += 30_000;
    return Response.json({ keys: [jwk] });
  }
  if (address !== `${issuer}/api/accounts/oauth/token`)
    throw new Error('Unexpected network request');
  const authorization = new URL(readFileSync(process.env.TEST_AUTH_URL, 'utf8'));
  const form = new URLSearchParams(body);
  if (
    createHash('sha256').update(form.get('code_verifier')).digest('base64url') !==
    authorization.searchParams.get('code_challenge')
  )
    throw new Error('PKCE mismatch');
  if (mode === 'token-error') return Response.json({ error: 'RAW_PRIVATE_ERROR' }, { status: 400 });
  const claims = {
    iss: issuer,
    aud: mode === 'audience' ? 'other-client' : 'oaiapp_fixture',
    sub: mode === 'account' ? 'other-account' : 'fixture-account',
    nonce: mode === 'nonce' ? 'wrong-nonce' : authorization.searchParams.get('nonce'),
    exp: Math.floor(Date.now() / 1000) + (mode === 'expired-id' ? -10 : 3600),
  };
  const payload = [
    Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
  ].join('.');
  const signature = sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url');
  return Response.json({
    access_token: 'PRIVATE_ACCESS_TOKEN',
    refresh_token: 'PRIVATE_REFRESH_TOKEN',
    id_token: `${payload}.${mode === 'signature' ? 'bad' : signature}`,
    token_type: 'Bearer',
    expires_in: mode === 'validation-delay' ? 120 : mode === 'validation-stale' ? 30 : 3600,
    ...(mode === 'earliest' ? { earliest_refresh_at: 1792285200 } : {}),
    scope:
      mode === 'scope'
        ? 'openid profile email resource.invoke'
        : 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  });
};
