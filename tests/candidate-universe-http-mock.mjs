import './market-calendar-http-mock.mjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mock } from 'node:test';

const calendarFetch = globalThis.fetch;
const scenario = process.env.SCENARIO;
let elapsed = 0;
mock.method(performance, 'now', () => elapsed);
export function advanceElapsed(milliseconds) {
  elapsed += milliseconds;
}
let typeRequests = 0;
let advancedBeforeType = false;
let expired = false;
let token = 'test-token';
const identityKeys =
  scenario === 'second-refresh-id'
    ? generateKeyPairSync('rsa', { modulusLength: 2048 })
    : undefined;
let refreshRequests = 0;
let refreshedIdentity;
const samples = process.env.REPORT_COUNT
  ? [
      { exchange: 'NAS', symbol: 'AAPL', name: 'Apple', type: 'common' },
      { exchange: 'NYS', symbol: 'BBDO', name: 'Bradesco', type: 'common_adr' },
      { exchange: 'AMS', symbol: 'SPY', name: 'SPDR', type: 'common' },
      { exchange: 'NAS', symbol: 'MSFT', name: 'Microsoft', type: 'common' },
      { exchange: 'NYS', symbol: 'IBM', name: 'IBM', type: 'common' },
      { exchange: 'AMS', symbol: 'IWM', name: 'Controlled company', type: 'common' },
    ]
  : [
      { exchange: 'NAS', symbol: 'AAPL', name: 'Apple', type: 'common' },
      { exchange: 'NYS', symbol: 'BBDO', name: 'Bradesco', type: 'common_adr' },
      { exchange: 'AMS', symbol: 'SPY', name: 'SPDR', type: 'etf' },
    ];
const dates = [
  '20260921',
  '20260922',
  '20260923',
  '20260924',
  '20260925',
  '20260928',
  '20260929',
  '20260930',
  '20261001',
  '20261002',
  '20261005',
  '20261006',
  '20261007',
  '20261008',
  '20261009',
  '20261012',
  '20261013',
  '20261014',
  '20261015',
  '20261016',
];
globalThis.fetch = async (url, init = {}) => {
  const address = new URL(url);
  const body =
    typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : undefined;
  if (scenario === 'second-refresh-id' && address.origin === 'https://auth.openai.com') {
    appendFileSync(process.env.TEST_TRACE, `${JSON.stringify({ url: address.href })}\n`);
    if (address.pathname.endsWith('/openid-configuration'))
      return Response.json({ issuer: address.origin, jwks_uri: 'https://auth.openai.com/jwks' });
    if (address.pathname === '/jwks')
      return Response.json({
        keys: [
          {
            ...identityKeys.publicKey.export({ format: 'jwk' }),
            kid: 'refresh',
            alg: 'RS256',
            use: 'sig',
          },
        ],
      });
    assert.equal(address.pathname, '/api/accounts/oauth/token');
    refreshRequests++;
    const payload = [
      Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'refresh' })).toString('base64url'),
      Buffer.from(
        JSON.stringify({
          iss: address.origin,
          aud: 'oaiapp_synthetic',
          sub: 'synthetic-user',
          exp: Math.floor(Date.now() / 1000) + 3600,
          jti: `refresh-${refreshRequests}`,
        }),
      ).toString('base64url'),
    ].join('.');
    refreshedIdentity = `${payload}.${sign('RSA-SHA256', Buffer.from(payload), identityKeys.privateKey).toString('base64url')}`;
    return Response.json({
      access_token: 'synthetic-subscription',
      refresh_token: 'synthetic-refresh',
      token_type: 'Bearer',
      expires_in: refreshRequests === 1 ? 60 : 3600,
      id_token: refreshedIdentity,
    });
  }
  if (address.href === 'https://api.openai.com/v1/responses' && body.tools) {
    appendFileSync(process.env.TEST_TRACE, `${JSON.stringify({ url: address.href, body })}\n`);
    const prompt = JSON.parse(body.input.find((m) => m.role === 'user').content[0].text);
    typeRequests++;
    if (scenario === 'execution-limit') elapsed = 600_000;
    if (scenario === 'type-limit') elapsed += 180_000;
    if (scenario === 'candidate-final-open') Date.now = () => Date.parse('2026-10-19T13:30:00Z');
    const value = {
      judgments: prompt.securities.map((s) => ({
        exchange: s.exchange,
        symbol: s.symbol,
        identity: 'confirmed',
        type:
          scenario === 'all-unknown'
            ? 'unknown'
            : scenario === 'all-excluded'
              ? 'etf'
              : samples.find((sample) => sample.symbol === s.symbol).type,
        applicable: scenario !== 'all-unknown',
        reason:
          scenario === 'second-refresh-id'
            ? refreshedIdentity
            : 'Controlled listed-security type evidence.',
        evidence: [
          { sourceId: 's1', explanation: 'Official current classification in controlled fixture.' },
        ],
      })),
    };
    let events = [
      {
        type: 'response.created',
        response: { id: 'resp_types', model: body.model, created_at: 1 },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'web_search_call',
          id: 'ws1',
          status: 'completed',
          action: { type: 'open_page', url: 'https://www.sec.gov/controlled-types' },
        },
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'message', id: 'msg_types' },
      },
      {
        type: 'response.output_text.delta',
        output_index: 1,
        item_id: 'msg_types',
        delta: JSON.stringify(value),
      },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
      },
    ];
    if (scenario === 'model-budget' || scenario === 'type-batch-execution') {
      const call = {
        type: 'function_call',
        id: `fc${typeRequests}`,
        call_id: `call${typeRequests}`,
        namespace: 'stock_scout',
        name: scenario === 'type-batch-execution' ? 'get_infos' : 'list_sources',
        arguments:
          scenario === 'type-batch-execution'
            ? JSON.stringify({
                securities: prompt.securities.map(({ exchange, symbol }) => ({ exchange, symbol })),
              })
            : '{}',
      };
      events = [
        events[0],
        { type: 'response.output_item.added', output_index: 0, item: call },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { ...call, status: 'completed' },
        },
        events.at(-1),
      ];
    }
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  if (address.hostname !== 'openapi.koreainvestment.com') {
    const response = await calendarFetch(url, init);
    if (scenario === 'cross-close' && address.pathname.endsWith('/responses'))
      Date.now = () => Date.parse('2026-10-16T20:00:00Z');
    if (scenario === 'calendar-limit' && address.pathname.endsWith('/responses')) elapsed = 300_000;
    return response;
  }
  appendFileSync(process.env.TEST_TRACE, `${JSON.stringify({ url: address.href, body })}\n`);
  if (address.pathname === '/oauth2/tokenP') {
    token = 'renewed-test-token';
    return Response.json({
      access_token: token,
      access_token_token_expired: '2026-10-18 11:00:00',
    });
  }
  assert.equal(init.headers.authorization, `Bearer ${token}`);
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  if (address.pathname.endsWith('/search-info')) {
    assert.equal(scenario, 'type-batch-execution');
    elapsed = 600_000;
    return Response.json({
      rt_cd: '0',
      output: { std_pdno: address.searchParams.get('PDNO'), ovrs_stck_dvsn_cd: '01' },
    });
  }
  const matchedSamples = samples.filter((s) => s.exchange === address.searchParams.get('EXCD'));
  const sample =
    matchedSamples[process.env.REPORT_COUNT && address.pathname.endsWith('trade-pbmn') ? 1 : 0];
  if (address.pathname.includes('/ranking/')) {
    if (!advancedBeforeType && process.env.TYPE_BEFORE_MS) {
      advancedBeforeType = true;
      advanceElapsed(Number(process.env.TYPE_BEFORE_MS));
    }
    if (scenario === 'rank-expired' && !expired) {
      expired = true;
      return Response.json({ rt_cd: '1', msg_cd: 'EGW00123' });
    }
    const rows = [
      {
        symb: sample.symbol,
        excd: sample.exchange,
        rsym: `D${sample.exchange}${sample.symbol}`,
        rank: '1',
        name: sample.name,
        tvol: '123',
        tamt: '456',
      },
    ];
    if (scenario === 'unsorted-ranks')
      rows.unshift({ ...rows[0], symb: 'OTHER', rsym: `D${sample.exchange}OTHER`, rank: '2' });
    if (scenario === 'missing-ranking-field') delete rows[0][process.env.OMIT_RANKING_FIELD];
    if (scenario === 'empty-ranks' && sample.exchange === 'NYS') rows.length = 0;
    if (scenario === 'conflicting-identity' && address.pathname.endsWith('trade-pbmn'))
      rows[0].rsym = 'CONFLICT';
    if (scenario === 'rank-failure') return new Response('test-secret', { status: 503 });
    return Response.json({ rt_cd: '0', output1: {}, output2: rows });
  }
  assert.ok(address.pathname.endsWith('/dailyprice'));
  const rows = dates.map((xymd) => ({
    xymd,
    open: '10',
    high: '12',
    low: '9',
    clos: '11',
    tvol: '123',
    tamt: '456',
  }));
  if (scenario === 'daily-missing') rows.pop();
  if (scenario === 'daily-duplicate') rows.push({ ...rows[0] });
  if (scenario === 'daily-invalid-date') rows[0].xymd = '20260931';
  if (scenario === 'daily-field') rows[0][process.env.DAILY_FIELD] = process.env.DAILY_VALUE;
  if (scenario === 'daily-current') rows.push({ xymd: '20261019', open: '', clos: '' });
  if (scenario === 'daily-sensitive') rows[0].tamt = token;
  if (scenario === 'daily-zero-prices')
    for (const field of ['open', 'high', 'low', 'clos']) rows[0][field] = '0';
  return Response.json({
    rt_cd: '0',
    output1: scenario === 'daily-wrong-identity' ? { rsym: 'DNYSTSM' } : {},
    output2: rows,
  });
};
