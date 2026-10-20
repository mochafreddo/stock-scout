import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mock } from 'node:test';

mock.timers.enable({ apis: ['Date'], now: Number(process.env.TEST_NOW) });
const usage = { input_tokens: 100, output_tokens: 50, total_tokens: 150 };
const completed = { type: 'response.completed', response: { usage } };
let modelRequests = 0;
const scenario = process.env.SCENARIO;
const samples =
  scenario === 'types'
    ? [
        { exchange: 'NAS', symbol: 'AAPL', kind: 'volume', rank: 1, type: 'common' },
        { exchange: 'NAS', symbol: 'GOOG', kind: 'volume', rank: 2, type: 'common' },
        { exchange: 'NAS', symbol: 'ACONW', kind: 'amount', rank: 1, type: 'warrant' },
        { exchange: 'NAS', symbol: 'GOOGL', kind: 'amount', rank: 2, type: 'common' },
        { exchange: 'NYS', symbol: 'BBD', kind: 'volume', rank: 1, type: 'preferred_adr' },
        { exchange: 'NYS', symbol: 'BAC/B', kind: 'volume', rank: 2, type: 'preferred' },
        { exchange: 'NYS', symbol: 'BBDO', kind: 'amount', rank: 1, type: 'common_adr' },
        { exchange: 'NYS', symbol: 'BAC/L', kind: 'amount', rank: 2, type: 'preferred' },
        { exchange: 'AMS', symbol: 'SPY', kind: 'volume', rank: 1, type: 'etf' },
        { exchange: 'AMS', symbol: 'VXX', kind: 'amount', rank: 1, type: 'etn' },
      ]
    : [{ exchange: 'NAS', symbol: 'AAPL', type: 'common' }];
const assessment = {
  judgments: [
    {
      exchange: 'NAS',
      symbol: 'AAPL',
      type: 'common',
      identity: 'confirmed',
      applicable: true,
      reason: 'Explicit common-stock classification for this listed security.',
      evidence: [
        {
          source: 'kis:NAS:AAPL',
          detail: 'Common stock, matched to NAS/AAPL.',
          asOf: '2026-10-18',
          currentness: 'Current classification returned for this symbol.',
        },
      ],
    },
  ],
};
if (scenario === 'types')
  assessment.judgments = samples.map((sample) => ({
    exchange: sample.exchange,
    symbol: sample.symbol,
    type: sample.type,
    identity: 'confirmed',
    applicable: true,
    reason: 'Explicit security-level classification in controlled source fixture.',
    evidence: [
      {
        source: `kis:${sample.exchange}:${sample.symbol}`,
        detail: `Explicit ${sample.type} classification.`,
        asOf: '2026-10-18',
        currentness: 'Current controlled classification fixture.',
      },
    ],
  }));
function sse(events) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}
globalThis.fetch = async (url, init = {}) => {
  const request = new URL(url);
  appendFileSync(
    process.env.TEST_TRACE,
    `${JSON.stringify({ url: request.href, body: init.body ? JSON.parse(init.body) : null })}\n`,
  );
  if (request.origin === 'https://openapi.koreainvestment.com:9443') {
    assert.equal(init.headers.authorization, 'Bearer test-token');
    const body = { rt_cd: '0', msg_cd: 'MCA00000', output1: { nrec: '0' }, output2: [] };
    if (request.pathname.endsWith('search-info')) {
      const sample = samples.find((sample) => sample.symbol === request.searchParams.get('PDNO'));
      assert.ok(sample);
      if (scenario === 'individual-lookup')
        return Response.json({ error: 'not found' }, { status: 404 });
      if (scenario === 'global-lookup')
        return Response.json({ error: 'unavailable' }, { status: 503 });
      assert.equal(
        request.searchParams.get('PRDT_TYPE_CD'),
        { NAS: '512', NYS: '513', AMS: '529' }[sample.exchange],
      );
      body.output = {
        std_pdno: 'US0378331005',
        ovrs_stck_dvsn_cd: '01',
        prdt_clsf_name: 'Common stock',
      };
      if (scenario === 'types')
        body.output = { prdt_clsf_name: sample.type, ovrs_item_name: sample.symbol };
    } else if (request.searchParams.get('EXCD') === 'NAS') {
      body.output1.nrec = '1';
      body.output2 = [
        {
          symb: 'AAPL',
          excd: 'NAS',
          rsym: 'DNASAAPL',
          rank: '1',
          name: 'Apple',
          tvol: '123',
          tamt: '456',
        },
      ];
    }
    if (scenario === 'types' && request.pathname.includes('/ranking/')) {
      const kind = request.pathname.endsWith('trade-vol') ? 'volume' : 'amount';
      body.output2 = samples
        .filter(
          (sample) => sample.exchange === request.searchParams.get('EXCD') && sample.kind === kind,
        )
        .map((sample) => ({
          excd: sample.exchange,
          symb: sample.symbol,
          rsym: `D${sample.exchange}${sample.symbol}`,
          rank: String(sample.rank),
        }));
      body.output1.nrec = String(body.output2.length);
    }
    if (scenario === 'rank-failure' && request.searchParams.get('EXCD') === 'AMS')
      return Response.json({ rt_cd: '1' }, { status: 503 });
    if (
      scenario === 'identity-conflict' &&
      request.pathname.endsWith('trade-pbmn') &&
      body.output2[0]
    )
      body.output2[0].rsym = 'DIFFERENT';
    return Response.json(body, { headers: { tr_cont: 'D' } });
  }
  assert.equal(request.origin, 'https://api.openai.com');
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-subscription');
  if (request.pathname === '/v1/models')
    return Response.json({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] });
  assert.equal(request.pathname, '/v1/responses');
  if (process.env.SCENARIO === 'auth-failure')
    return Response.json(
      { error: { code: 'invalid_api_key', message: 'synthetic-subscription' } },
      { status: 401 },
    );
  if (process.env.SCENARIO === 'quota-http')
    return Response.json(
      {
        error: {
          code: 'subscription_sharing_usage_limit_exceeded',
          message: 'synthetic-subscription',
        },
      },
      { status: 429 },
    );
  const body = JSON.parse(init.body);
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.model, 'gpt-6.1-sol');
  for (const key of [
    'max_output_tokens',
    'max_tool_calls',
    'previous_response_id',
    'temperature',
    'metadata',
    'user',
  ])
    assert.ok(!(key in body), key);
  assert.ok(body.input.every((item) => item.role !== 'system'));
  assert.ok(body.tools.some((item) => item.type === 'web_search'));
  assert.ok(body.tools.some((item) => item.type === 'namespace' && item.name === 'stock_scout'));
  assert.ok(body.tools.every((item) => ['namespace', 'web_search'].includes(item.type)));
  if (++modelRequests === 1) {
    const callSamples =
      scenario === 'info-limit' ? Array.from({ length: 33 }, () => samples[0]) : samples;
    const calls = callSamples.map((sample, index) => ({
      type: 'function_call',
      id: `fc_info_${index}`,
      call_id: `call_info_${index}`,
      name: 'get_info',
      namespace: 'stock_scout',
      arguments: JSON.stringify({ exchange: sample.exchange, symbol: sample.symbol }),
    }));
    return sse([
      { type: 'response.created', response: { id: 'resp_info', model: body.model, created_at: 1 } },
      ...calls.flatMap((item, index) => [
        { type: 'response.output_item.added', output_index: index, item },
        {
          type: 'response.output_item.done',
          output_index: index,
          item: { ...item, status: 'completed' },
        },
      ]),
      ...(scenario === 'missing-intermediate-completion'
        ? []
        : scenario === 'duplicate-completion'
          ? [completed, completed]
          : [completed]),
    ]);
  }
  assert.equal(modelRequests, 2);
  const toolResult = body.input.find((item) => item.type === 'function_call_output');
  assert.ok(toolResult, 'Full tool history must reach the next request');
  if (scenario === 'individual-lookup') assert.match(toolResult.output, /SECURITY_LOOKUP_FAILED/);
  else if (scenario !== 'global-lookup' && scenario !== 'types')
    assert.match(toolResult.output, /Common stock/);
  if (['unknown', 'individual-lookup'].includes(scenario)) {
    assessment.judgments[0].type = 'unknown';
    assessment.judgments[0].evidence = [];
    assessment.judgments[0].reason = 'Insufficient source evidence.';
  }
  if (scenario === 'excluded') assessment.judgments[0].type = 'etf';
  if (scenario === 'unobserved-source')
    assessment.judgments[0].evidence[0].source = 'https://example.invalid/invented';
  if (scenario === 'off-ranking') assessment.judgments[0].symbol = 'MSFT';
  if (scenario === 'ambiguous') assessment.judgments[0].identity = 'ambiguous';
  if (scenario === 'unknown-unobserved-source') {
    assessment.judgments[0].type = 'unknown';
    assessment.judgments[0].evidence[0].source = 'https://example.invalid/unread';
  }
  if (['search-failed', 'search-service-failed', 'search-scope-unknown'].includes(scenario)) {
    assessment.judgments[0].type = 'unknown';
    assessment.judgments[0].evidence = [];
  }
  if (scenario === 'no-evidence-excluded') {
    assessment.judgments[0].type = 'etf';
    assessment.judgments[0].evidence = [];
  }
  if (scenario === 'no-evidence') assessment.judgments[0].evidence = [];
  if (scenario === 'malformed-judgment') assessment.judgments[0].applicable = 'true';
  if (scenario === 'not-current') assessment.judgments[0].applicable = false;
  if (scenario === 'missing-result') assessment.judgments = [];
  if (scenario === 'duplicate-result') assessment.judgments.push(assessment.judgments[0]);
  if (['search-only', 'opened-source'].includes(scenario))
    assessment.judgments[0].evidence[0].source = 'https://www.sec.gov/sample';
  const webItem = {
    type: 'web_search_call',
    id: 'ws_source',
    status: ['search-failed', 'search-service-failed', 'search-scope-unknown'].includes(scenario)
      ? 'failed'
      : 'completed',
    action: ['opened-source', 'search-failed'].includes(scenario)
      ? { type: 'open_page', url: 'https://www.sec.gov/sample' }
      : {
          type: 'search',
          queries: ['AAPL security type'],
          sources: [{ type: 'url', url: 'https://www.sec.gov/sample' }],
        },
  };
  if (scenario === 'search-scope-unknown') delete webItem.action;
  const text = JSON.stringify(assessment);
  return sse([
    { type: 'response.created', response: { id: 'resp_result', model: body.model, created_at: 1 } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_result' },
    },
    ...([
      'search-only',
      'opened-source',
      'search-failed',
      'search-service-failed',
      'search-scope-unknown',
    ].includes(scenario)
      ? [
          {
            type: 'response.output_item.added',
            output_index: 1,
            item: { type: 'web_search_call', id: 'ws_source', status: 'in_progress' },
          },
          { type: 'response.output_item.done', output_index: 1, item: webItem },
        ]
      : []),
    ...(scenario === 'web-limit'
      ? Array.from({ length: 33 }, (_, index) => [
          {
            type: 'response.output_item.added',
            output_index: index + 1,
            item: { type: 'web_search_call', id: `ws_limit_${index}`, status: 'in_progress' },
          },
          {
            type: 'response.output_item.done',
            output_index: index + 1,
            item: { ...webItem, id: `ws_limit_${index}` },
          },
        ]).flat()
      : []),
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_result', delta: text },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_result',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    ...(['missing-final-completion', 'duplicate-completion'].includes(scenario)
      ? []
      : [
          scenario === 'incomplete'
            ? {
                type: 'response.incomplete',
                response: { usage, incomplete_details: { reason: 'max_output_tokens' } },
              }
            : completed,
        ]),
  ]);
};
