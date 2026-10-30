import './candidate-universe-http-mock.mjs';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const fetch = globalThis.fetch;
let models = 0;
let queries = 0;
const mode = process.env.KIS_TEST;
const cache = join(process.env.HOME, 'Library/Caches/stock-scout');
if (mode === 'locked') mkdirSync(join(cache, 'issuance.lock'), { mode: 0o700 });
if (mode === 'initial-wait') unlinkSync(join(cache, 'issuance.json'));
process.on('exit', () => {
  appendFileSync(
    process.env.TEST_TRACE,
    `${JSON.stringify({
      authState: {
        locked: existsSync(join(cache, 'issuance.lock')),
        token: existsSync(join(cache, 'token.json')),
        issuance: JSON.parse(readFileSync(join(cache, 'issuance.json'), 'utf8')),
      },
    })}\n`,
  );
});
globalThis.fetch = async (url, init = {}) => {
  const address = new URL(url);
  if (address.hostname === 'openapi.koreainvestment.com') {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (address.pathname === '/oauth2/tokenP') {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), {
        grant_type: 'client_credentials',
        appkey: 'test-key',
        appsecret: 'test-secret',
      });
      assert.equal(JSON.parse(readFileSync(join(cache, 'issuance.json'), 'utf8')).at, Date.now());
      if (mode === 'issue-http')
        return new Response(
          new ReadableStream({
            cancel() {
              appendFileSync(process.env.TEST_TRACE, '{"cancelled":"issuance"}\n');
            },
          }),
          { status: 503 },
        );
      if (mode === 'issue-invalid') return Response.json({ access_token: 'test-secret' });
      if (mode === 'store-failure') mkdirSync(join(cache, 'token.json.tmp'), { mode: 0o700 });
    } else {
      assert.equal(init.headers.appkey, 'test-key');
      assert.equal(init.headers.appsecret, 'test-secret');
      assert.equal(init.headers.custtype, 'P');
      queries++;
      if (queries === 1 && mode === 'query-headers-timeout')
        return new Promise((_resolve, reject) => {
          const keepAlive = setTimeout(() => {}, 1000);
          init.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(keepAlive);
              reject(init.signal.reason);
            },
            { once: true },
          );
        });
      if (queries === 2 && mode === 'second-expiry')
        return Response.json({ rt_cd: '1', msg_cd: 'EGW00123' });
      if (queries === 1 && mode === 'issue-http') unlinkSync(join(cache, 'token.json'));
      if (queries === 1 && mode === 'query-shape')
        return Response.json({ rt_cd: '0', output1: {}, output2: {} });
      if (queries === 1 && ['query-read-error', 'query-timeout'].includes(mode))
        return new Response(
          new ReadableStream({
            start(controller) {
              if (mode === 'query-read-error') controller.error(new Error('test-secret'));
              else {
                const keepAlive = setTimeout(() => {}, 1000);
                init.signal.addEventListener(
                  'abort',
                  () => {
                    clearTimeout(keepAlive);
                    controller.error(init.signal.reason);
                  },
                  { once: true },
                );
              }
            },
          }),
        );
    }
  }
  if (address.pathname.endsWith('/responses') && ++models === 2)
    return Response.json({ error: { message: 'test-secret renewed-test-token' } }, { status: 503 });
  return fetch(url, init);
};
