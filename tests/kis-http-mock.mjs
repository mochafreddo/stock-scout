import assert from 'node:assert/strict';
import fs, { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { setTimeout } from 'node:timers/promises';

if (process.env.TEST_NOW) mock.timers.enable({ apis: ['Date'], now: Number(process.env.TEST_NOW) });
let queryCount = 0;

globalThis.fetch = async (url, options) => {
  const request = new URL(url);
  if (process.env.TEST_TRACE) appendFileSync(process.env.TEST_TRACE, `${request.pathname}\n`);
  if (process.env.SCENARIO === 'no-network') throw new Error('Unexpected network');
  assert.equal(request.origin, 'https://openapi.koreainvestment.com:9443');
  if (request.pathname === '/oauth2/tokenP') {
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), {
      grant_type: 'client_credentials',
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
    });
    assert.equal(options.redirect, 'error');
    const record = JSON.parse(
      readFileSync(join(process.env.HOME, 'Library/Caches/stock-scout/issuance.json')),
    );
    assert.equal(record.kind, 'attempt');
    assert.equal(record.at, Date.now());
    if (process.env.TEST_GATE) {
      fs.writeFileSync(`${process.env.TEST_GATE}.ready`, 'ready', { mode: 0o600 });
      while (!fs.existsSync(process.env.TEST_GATE)) await setTimeout(10);
    }
    if (process.env.SCENARIO === 'issue-transport')
      throw new Error('test-key test-secret test-token');
    if (process.env.SCENARIO === 'issue-http') return new Response('test-secret', { status: 403 });
    if (process.env.SCENARIO === 'issue-malformed') return new Response('test-key');
    const body = {
      access_token: 'test-token',
      token_type: 'Bearer',
      access_token_token_expired: '2026-10-18 10:00:00',
      ...JSON.parse(process.env.TEST_TOKEN_BODY || '{}'),
    };
    return Response.json(body);
  }
  assert.equal(
    options.headers.tr_id,
    {
      '/uapi/overseas-stock/v1/ranking/trade-vol': 'HHDFS76310010',
      '/uapi/overseas-stock/v1/ranking/trade-pbmn': 'HHDFS76320010',
      '/uapi/overseas-price/v1/quotations/dailyprice': 'HHDFS76240000',
      '/uapi/overseas-price/v1/quotations/search-info': 'CTPF1702R',
    }[request.pathname],
  );
  const step = JSON.parse(process.env.TEST_QUERY_STEPS || '[]')[queryCount++];
  if (process.env.TEST_QUERY_DETAILS)
    appendFileSync(
      process.env.TEST_QUERY_DETAILS,
      `${JSON.stringify({
        at: performance.now(),
        url: request.href,
        trId: options.headers.tr_id,
        tokenMatches: options.headers.authorization === `Bearer ${step?.token || 'test-token'}`,
      })}\n`,
      { mode: 0o600 },
    );
  const expectedToken = step?.token || 'test-token';
  assert.equal(options.headers.authorization, `Bearer ${expectedToken}`);
  assert.equal(
    JSON.parse(readFileSync(join(process.env.HOME, 'Library/Caches/stock-scout/token.json')))
      .access_token,
    expectedToken,
  );
  assert.equal(options.redirect, 'error');
  if (step?.gate) {
    fs.writeFileSync(`${process.env.TEST_QUERY_GATE}.ready`, 'ready', { mode: 0o600 });
    while (!fs.existsSync(process.env.TEST_QUERY_GATE)) await setTimeout(10);
  }
  if (step?.advance) mock.timers.tick(step.advance);
  if (step?.peer) {
    fs.writeFileSync(
      join(process.env.HOME, 'Library/Caches/stock-scout/token.json'),
      JSON.stringify(step.peer),
      { mode: 0o600 },
    );
  }
  if (step?.lock)
    fs.mkdirSync(join(process.env.HOME, 'Library/Caches/stock-scout/issuance.lock'), {
      mode: 0o700,
    });
  if (step?.unsafe)
    fs.chmodSync(join(process.env.HOME, 'Library/Caches/stock-scout/token.json'), 0o644);
  if (step?.blockSave)
    fs.mkdirSync(join(process.env.HOME, 'Library/Caches/stock-scout/token.json.tmp'), {
      mode: 0o700,
    });
  if (step?.transport) throw new Error('test-key test-secret rejected-token test-token');
  if (step?.raw !== undefined) return new Response(step.raw, { status: step.status || 200 });
  if (step?.body) return Response.json(step.body, { status: step.status || 200 });
  const scenario = process.env.SCENARIO;
  if (scenario === 'transport-error') throw new Error('test-token test-secret');
  if (scenario === 'http-error') return new Response('test-token', { status: 500 });
  if (scenario === 'malformed') return new Response('test-secret');
  if (scenario === 'api-error')
    return Response.json({
      rt_cd: '1',
      msg1: 'test-token',
      output1: { nrec: '1' },
      output2: [{ symb: 'AAPL', rank: '1', tvol: '123' }],
    });
  if (scenario === 'bad-rows') return Response.json({ rt_cd: '0', output2: {} });
  const body = { rt_cd: '0', msg_cd: 'MCA00000', output1: { nrec: '1' } };
  if (request.pathname.endsWith('search-info')) {
    assert.equal(
      request.searchParams.get('PRDT_TYPE_CD'),
      { NAS: '512', NYS: '513', AMS: '529' }[process.argv[3]],
    );
    body.output = { std_pdno: 'US0378331005', ovrs_stck_dvsn_cd: '01', account: 'account-secret' };
  } else if (request.pathname.endsWith('dailyprice')) {
    assert.equal(request.searchParams.get('GUBN'), '0');
    assert.equal(request.searchParams.get('MODP'), '0');
    body.output2 = [{ xymd: '20261016', clos: '250.00', tvol: '123', account: 'account-secret' }];
  } else {
    body.output2 =
      scenario === 'empty'
        ? []
        : [
            {
              symb: 'AAPL',
              excd: 'NAS',
              rank: '1',
              tvol: '123',
              tamt: '456',
              account: 'account-secret',
            },
          ];
  }
  return Response.json(body, { headers: { tr_cont: scenario === 'continued' ? 'M' : 'D' } });
};
