import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { CandidateRuntime } from '../scripts/candidate-runtime.ts';
import { advanceElapsed } from './candidate-universe-http-mock.mjs';

const fetch = globalThis.fetch;
let models = 0;
let queries = 0;
const mode = process.env.KIS_TEST;
if (mode === 'retry-budget' || mode === 'retry-last-slot') {
  const take = CandidateRuntime.prototype.take;
  mock.method(CandidateRuntime.prototype, 'take', function (kind) {
    if (kind === 'kis' && this.counts.kis === 0)
      this.counts.kis = mode === 'retry-budget' ? 89 : 88;
    return take.call(this, kind);
  });
}
if (mode === 'retry-execution' || mode === 'retry-open') {
  const signal = CandidateRuntime.prototype.signal;
  mock.method(CandidateRuntime.prototype, 'signal', function (ms, ...args) {
    if (ms > 500_000) {
      const controller = new AbortController();
      setTimeout(() => {
        if (mode === 'retry-execution') advanceElapsed(600_001);
        else Date.now = () => Date.parse('2026-10-19T13:30:00Z');
        controller.abort();
      }, 5);
      return controller.signal;
    }
    return signal.call(this, ms, ...args);
  });
}
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
      if (
        mode?.startsWith('retry-') &&
        (queries === 1 || (queries === 2 && mode === 'retry-repeat'))
      ) {
        if (mode === 'retry-short') advanceElapsed(599_500);
        if (mode === 'retry-boundary') advanceElapsed(599_000);
        appendFileSync(process.env.TEST_TRACE, `${JSON.stringify({ retryQuery: queries })}\n`);
        return Response.json(
          { rt_cd: '1', msg_cd: 'EGW00316', msg1: 'test-secret' },
          { status: 500 },
        );
      }
      if (mode?.startsWith('retry-'))
        appendFileSync(process.env.TEST_TRACE, `${JSON.stringify({ retryQuery: queries })}\n`);
      if (queries === 2 && mode === 'retry-invalid')
        return Response.json({ rt_cd: '0', output1: {}, output2: {} });
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
