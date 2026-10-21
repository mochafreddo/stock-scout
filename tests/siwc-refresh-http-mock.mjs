import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs, { appendFileSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import './llm-security-http-mock.mjs';

const modelFetch = globalThis.fetch;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'refresh', alg: 'RS256', use: 'sig' };
const mode = process.env.TEST_REFRESH_MODE;
if (process.env.TEST_CHECK_MODE?.includes('timeout')) {
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds) => timeout(milliseconds === 15_000 ? 30 : milliseconds);
}
if (mode === 'locked' || mode === 'deadline') {
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds) => timeout(milliseconds === 30_000 ? 50 : milliseconds);
}
if (
  mode === 'save-failure' ||
  mode?.startsWith('postvalidation-') ||
  mode?.startsWith('readback-')
) {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (mode === 'save-failure') throw new Error('Synthetic write failure');
    rename(from, to);
    if (mode.startsWith('readback-')) {
      const stored = JSON.parse(fs.readFileSync(to, 'utf8'));
      stored[mode.slice('readback-'.length)] =
        mode === 'readback-expiresAt' ? Date.now() + 60_000 : 'synthetic-corrupt';
      fs.writeFileSync(to, JSON.stringify(stored));
    } else process.kill(process.pid, mode.split('-')[1]);
  };
  syncBuiltinESMExports();
}
globalThis.fetch = async (url, options = {}) => {
  if (process.env.TEST_CHECK_MODE && String(url) === 'https://api.openai.com/v1/models') {
    appendFileSync(
      process.env.TEST_TRACE,
      `${JSON.stringify({ url: String(url), method: options.method, headers: options.headers, signalPresent: Boolean(options.signal) })}\n`,
    );
    assert.equal(
      new Headers(options.headers).get('authorization'),
      `Bearer ${process.env.TEST_MODEL_TOKEN ?? 'synthetic-refreshed'}`,
    );
    const checkMode = process.env.TEST_CHECK_MODE;
    if (checkMode === 'http') return Response.json({ error: 'RAW_PRIVATE_HTTP' }, { status: 503 });
    if (checkMode === 'network') throw new Error('RAW_PRIVATE_NETWORK');
    if (checkMode === 'timeout') {
      await delay(120, undefined, { signal: options.signal });
    }
    if (checkMode === 'body-timeout') {
      return {
        ok: true,
        text: async () => {
          await delay(120, undefined, { signal: options.signal });
          return JSON.stringify({ models: [] });
        },
      };
    }
    if (checkMode === 'json') return new Response('RAW_PRIVATE_JSON');
    if (checkMode === 'large')
      return Response.json({ models: [], metadata: 'x'.repeat(1_048_577) });
    const checkBody = process.env.TEST_CHECK_BODY_FILE
      ? fs.readFileSync(process.env.TEST_CHECK_BODY_FILE, 'utf8')
      : process.env.TEST_CHECK_BODY;
    return Response.json(
      checkBody
        ? JSON.parse(checkBody)
        : {
            models: [
              { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
              { slug: 'gpt-6.1-sol', display_name: 'GPT 6.1', visibility: 'list' },
            ],
          },
    );
  }
  if (new URL(url).origin !== 'https://auth.openai.com') return modelFetch(url, options);
  appendFileSync(
    process.env.TEST_TRACE,
    `${JSON.stringify({ url: String(url), method: options.method, body: String(options.body), headers: options.headers })}\n`,
  );
  const phase = String(url).endsWith('/oauth/token')
    ? 'token'
    : String(url).endsWith('/jwks')
      ? 'jwks'
      : 'discovery';
  if (mode === `cancel-${phase}`) await delay(30_000, undefined, { signal: options.signal });
  if (mode === 'deadline') await delay(35, undefined, { signal: options.signal });
  if (mode === 'hold' && phase === 'token') {
    while (!existsSync(process.env.TEST_REFRESH_GATE))
      await delay(10, undefined, { signal: options.signal });
  }
  if (String(url).endsWith('/openid-configuration'))
    return Response.json({
      issuer: 'https://auth.openai.com',
      jwks_uri: 'https://auth.openai.com/jwks',
    });
  if (String(url).endsWith('/jwks')) return Response.json({ keys: [jwk] });
  assert.equal(String(url), 'https://auth.openai.com/api/accounts/oauth/token');
  if (mode?.startsWith('error:')) {
    const [, status, error] = mode.split(':');
    return Response.json(
      { error, error_description: 'RAW_PRIVATE_ERROR' },
      { status: Number(status) },
    );
  }
  if (mode === 'malformed-error') return new Response('{', { status: 400 });
  if (mode === 'bad-json') return new Response('{');
  if (mode === 'large-response') return Response.json({ content: 'x'.repeat(131_073) });
  if (mode === 'network') throw new Error('RAW_PRIVATE_NETWORK');
  const tokens = {
    access_token: 'synthetic-refreshed',
    refresh_token: 'synthetic-rotated',
    token_type: 'Bearer',
    expires_in: 3600,
    ...(process.env.TEST_REFRESH_EARLIEST
      ? { earliest_refresh_at: JSON.parse(process.env.TEST_REFRESH_EARLIEST) }
      : {}),
  };
  const overrides = {
    'missing-access': { access_token: undefined },
    'missing-refresh': { refresh_token: undefined },
    'bad-expiry': { expires_in: 0 },
    'fraction-expiry': { expires_in: 1.5 },
    'bad-type': { token_type: 'Basic' },
    'bad-scope-type': { scope: null },
    'missing-permission': { scope: 'openid resource.invoke' },
    'duplicate-scope': { scope: 'openid resource.invoke chatgpt.tokens.use.direct openid' },
    'new-scope': { scope: 'openid resource.invoke chatgpt.tokens.use.direct email' },
    'bad-id': { id_token: 'invalid' },
    'null-id': { id_token: null },
  }[mode];
  Object.assign(tokens, overrides);
  if (mode?.startsWith('identity-') || mode?.startsWith('cancel-') || mode === 'deadline') {
    const claims = {
      iss: mode === 'identity-issuer' ? 'https://untrusted.invalid' : 'https://auth.openai.com',
      aud: mode === 'identity-audience' ? 'other-client' : 'oaiapp_synthetic',
      sub: mode === 'identity-account' ? 'other-user' : 'synthetic-user',
      nonce: 'unrelated-refresh-nonce',
      exp: Math.floor(Date.now() / 1000) + (mode === 'identity-expired' ? -1 : 3600),
    };
    const payload = [
      Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'refresh' })).toString('base64url'),
      Buffer.from(JSON.stringify(claims)).toString('base64url'),
    ].join('.');
    tokens.id_token = `${payload}.${mode === 'identity-signature' ? 'bad' : sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`;
  }
  return Response.json(tokens);
};
