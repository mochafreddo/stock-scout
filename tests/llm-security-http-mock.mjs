import assert from 'node:assert/strict';
import fs, { appendFileSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';

mock.timers.enable({ apis: ['Date'], now: Number(process.env.TEST_NOW) });
let elapsedMs = 0;
mock.method(performance, 'now', () => elapsedMs);
function tickClock(milliseconds) {
  elapsedMs += milliseconds;
  mock.timers.tick(milliseconds);
}
const usage = { input_tokens: 100, output_tokens: 50, total_tokens: 150 };
const completed = { type: 'response.completed', response: { usage } };
let modelRequests = 0;
const scenario = process.env.SCENARIO;
if (process.env.TEST_SERIALIZATION_STAGE) {
  const stringify = JSON.stringify;
  let outputSerializations = 0;
  JSON.stringify = (value, ...args) => {
    if (
      value?.stage === process.env.TEST_SERIALIZATION_STAGE ||
      (value?.validation === 'unverified' &&
        value?.status &&
        ++outputSerializations === Number(process.env.TEST_OUTPUT_SERIALIZATION))
    )
      throw Object.assign(new Error(process.env.TEST_SERIALIZATION_EXCEPTION), {
        reason: 'AUTH_FAILED',
        location: 'private-field.private-value',
      });
    return stringify(value, ...args);
  };
}
if (process.env.TEST_ARGUMENTS)
  process.argv.splice(2, process.argv.length, ...JSON.parse(process.env.TEST_ARGUMENTS));
if (process.env.TEST_ARGUMENT_EXCEPTION)
  Object.defineProperty(process.argv, '2', {
    get() {
      throw new Error(process.env.TEST_ARGUMENT_EXCEPTION);
    },
  });
if (process.env.TEST_EVALUATION_EXCEPTION) {
  const read = fs.readFileSync;
  fs.readFileSync = (path, ...args) => {
    if (typeof path === 'string' && path.endsWith('/case.json'))
      throw Object.assign(new Error(process.env.TEST_EVALUATION_EXCEPTION), {
        reason: 'RANKING_INCOMPLETE',
        location: ['securities', 0, 'symbol'],
      });
    return read(path, ...args);
  };
  syncBuiltinESMExports();
}
if (process.env.TEST_IMPORT_EXCEPTION)
  registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith('/siwc-auth.ts')) throw new Error(process.env.TEST_IMPORT_EXCEPTION);
      return nextLoad(url, context);
    },
  });
if (process.env.TEST_STORAGE_EXCEPTION) {
  const open = fs.openSync;
  fs.openSync = (path, ...args) => {
    if (typeof path === 'string' && path.endsWith('/credentials.json'))
      throw Object.assign(new Error(process.env.TEST_STORAGE_EXCEPTION), {
        reason: 'RANKING_INCOMPLETE',
        retryAt: '2026-10-18T00:10:00.000Z',
      });
    return open(path, ...args);
  };
  syncBuiltinESMExports();
}
if (['retrieval-blocked', 'judgment-blocked'].includes(scenario)) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) =>
    originalSetTimeout(
      () => {
        tickClock(delay);
        callback(...args);
      },
      (scenario === 'retrieval-blocked' && delay === 120_000) ||
        (scenario === 'judgment-blocked' && delay === 180_000)
        ? 10
        : delay,
      ...args,
    );
}
const samples = scenario.startsWith('types')
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
if (scenario.startsWith('types'))
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
  if (process.env.TEST_STATISTICS_CLOCK)
    tickClock(
      request.pathname.endsWith('/responses')
        ? 7
        : request.pathname.endsWith('/search-info')
          ? 11
          : 0,
    );
  appendFileSync(
    process.env.TEST_TRACE,
    `${JSON.stringify({ url: request.href, body: init.body ? JSON.parse(init.body) : null })}\n`,
  );
  if (request.origin === 'https://openapi.koreainvestment.com:9443') {
    if (request.pathname === '/oauth2/tokenP')
      return Response.json({ error: 'synthetic-subscription' }, { status: 401 });
    assert.equal(init.headers.authorization, 'Bearer test-token');
    if (request.pathname.includes('/ranking/')) {
      assert.equal(init.headers.appkey, 'test-key');
      assert.equal(init.headers.appsecret, 'test-secret');
      assert.equal(init.headers.custtype, 'P');
      assert.equal(
        init.headers.tr_id,
        request.pathname.endsWith('trade-vol') ? 'HHDFS76310010' : 'HHDFS76320010',
      );
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      if (scenario === 'ranking-auth') return Response.json({ rt_cd: '1', msg_cd: 'EGW00123' });
      if (scenario === 'ranking-http-auth')
        return Response.json({ msg_cd: 'EGW00123', rt_cd: '0' }, { status: 401 });
      if (scenario === 'ranking-exception')
        throw Object.assign(new Error(process.env.TEST_RANKING_EXCEPTION), {
          reason: 'AUTH_FAILED',
          providerCode: 'EGW00123',
          location: 'private-field.private-value',
        });
    }
    const body = { rt_cd: '0', msg_cd: 'MCA00000', output1: { nrec: '0' }, output2: [] };
    if (request.pathname.endsWith('search-info')) {
      if (scenario === 'retrieval-blocked') {
        setTimeout(() => {}, 30);
        return new Promise(() => {});
      }
      if (scenario === 'lookup-auth') return Response.json({ rt_cd: '1', msg_cd: 'EGW00123' });
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
      if (scenario === 'sensitive-lookup') body.output.prdt_clsf_name = 'synthetic-subscription';
      if (scenario.startsWith('types'))
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
    if (scenario.startsWith('types') && request.pathname.includes('/ranking/')) {
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
    if (scenario === 'ranking-incomplete') {
      body.output1.nrec = '0';
      body.output2 = [];
      return Response.json(body, { headers: { tr_cont: 'F' } });
    }
    if (scenario === 'partial-ranking-incomplete' && request.pathname.endsWith('trade-pbmn'))
      return Response.json(body, { headers: { tr_cont: 'F' } });
    if (scenario === 'empty-rankings') {
      body.output1.nrec = '0';
      body.output2 = [];
    }
    if (scenario === 'ranking-shape') body.output2 = { 'private-field': 'private-value' };
    if (scenario === 'ranking-invalid-row') {
      body.output2[0].rank = 'private-value';
      body.output2[0].symb = 'private-symbol';
      return Response.json(body, { headers: { tr_cont: 'F' } });
    }
    if (scenario === 'ranking-first-failure' && request.pathname.endsWith('trade-pbmn')) {
      body.output2[0].rank = '0';
      body.output2[0].rsym = 'DIFFERENT';
      return Response.json(body, { headers: { tr_cont: 'F' } });
    }
    return Response.json(body, { headers: { tr_cont: 'D' } });
  }
  assert.equal(request.origin, 'https://api.openai.com');
  assert.equal(
    new Headers(init.headers).get('authorization'),
    `Bearer ${process.env.TEST_MODEL_TOKEN ?? 'synthetic-subscription'}`,
  );
  if (request.pathname === '/v1/models')
    return Response.json({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] });
  assert.equal(request.pathname, '/v1/responses');
  if (process.env.SCENARIO === 'auth-failure')
    return Response.json(
      { error: { code: 'invalid_api_key', message: 'synthetic-subscription' } },
      { status: 401 },
    );
  if (scenario === 'search-unsupported')
    return Response.json({ error: { code: 'unsupported_tool' } }, { status: 400 });
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
  const prompt = JSON.parse(body.input.find((item) => item.role === 'user').content[0].text);
  const judging = prompt.stage === 'judgment';
  if (prompt.stage === process.env.TEST_HTTP_EXCEPTION_STAGE)
    throw Object.assign(new Error(process.env.TEST_HTTP_EXCEPTION), { reason: 'AUTH_FAILED' });
  if (judging && scenario === 'judgment-blocked') {
    setTimeout(() => {}, 30);
    return new Promise(() => {});
  }
  if (judging && process.env.TEST_WALL_CLOCK_SHIFT)
    mock.timers.setTime(Date.now() + Number(process.env.TEST_WALL_CLOCK_SHIFT));
  if (judging) {
    assert.equal(body.tools?.length ?? 0, 0);
    assert.ok(prompt.evidenceRecords);
  } else {
    assert.ok(body.tools.some((item) => item.type === 'web_search'));
    assert.ok(body.tools.some((item) => item.type === 'namespace' && item.name === 'stock_scout'));
    assert.ok(body.tools.every((item) => ['namespace', 'web_search'].includes(item.type)));
  }
  if (++modelRequests === 1 || (scenario === 'model-limit' && modelRequests < 12)) {
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
      ...(scenario === 'web-duplicates'
        ? [
            {
              type: 'response.output_item.added',
              output_index: 9,
              item: {
                type: 'web_search_call',
                id: 'private-id synthetic-subscription',
                status: 'in_progress',
              },
            },
            {
              type: 'response.output_item.done',
              output_index: 9,
              item: {
                type: 'web_search_call',
                id: 'private-id synthetic-subscription',
                status: 'completed',
                action: { type: 'search', queries: ['AAPL'] },
              },
            },
          ]
        : []),
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
  assert.ok(
    modelRequests === 2 ||
      (judging && modelRequests === 3) ||
      (scenario === 'model-limit' && modelRequests === 12),
  );
  const toolResult = body.input.find((item) => item.type === 'function_call_output');
  if (!judging) {
    assert.ok(toolResult, 'Full tool history must reach the next request');
    if (scenario === 'individual-lookup') assert.match(toolResult.output, /SECURITY_LOOKUP_FAILED/);
    else if (scenario !== 'global-lookup' && !scenario.startsWith('types'))
      assert.match(toolResult.output, /Common stock/);
  }
  if (
    [
      'unknown',
      'individual-lookup',
      'search-failed',
      'search-service-failed',
      'search-scope-unknown',
    ].includes(scenario)
  ) {
    assessment.judgments[0].type = 'unknown';
    assessment.judgments[0].evidence = [];
    assessment.judgments[0].reason = 'Insufficient source evidence.';
  }
  if (scenario === 'excluded') assessment.judgments[0].type = 'etf';
  if (scenario === 'unobserved-source')
    assessment.judgments[0].evidence[0].source = 'https://example.invalid/invented';
  if (scenario === 'unknown-unobserved-source') {
    assessment.judgments[0].type = 'unknown';
    assessment.judgments[0].evidence[0].source = 'https://example.invalid/unread';
  }
  if (scenario === 'no-evidence-excluded') assessment.judgments[0].type = 'etf';
  if (['no-evidence', 'no-evidence-excluded'].includes(scenario))
    assessment.judgments[0].evidence = [];
  if (scenario === 'not-current') assessment.judgments[0].applicable = false;
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
  let value;
  if (judging) {
    value = {
      judgments: assessment.judgments.map((judgment) => ({
        ...judgment,
        evidence: prompt.evidenceRecords
          .filter(
            (record) => record.exchange === judgment.exchange && record.symbol === judgment.symbol,
          )
          .map((record) => record.id),
      })),
    };
    if (scenario === 'off-ranking') value.judgments[0].symbol = 'MSFT';
    if (['ambiguous', 'ambiguous-sensitive'].includes(scenario))
      value.judgments[0].identity = 'ambiguous';
    if (['sensitive-judgment', 'ambiguous-sensitive'].includes(scenario))
      value.judgments[0].reason = 'synthetic-subscription';
    if (scenario === 'malformed-judgment') value.judgments[0].applicable = 'true';
    if (scenario === 'missing-result') value.judgments = [];
    if (scenario === 'duplicate-result') value.judgments.push(value.judgments[0]);
    if (scenario === 'forged-provenance') {
      value.judgments[0].rsym = 'FORGED';
      value.judgments[0].rankings = [];
    }
    if (scenario === 'invented-id') value.judgments[0].evidence = ['e999'];
    if (scenario === 'url-instead-of-id') value.judgments[0].evidence = ['kis:NAS:AAPL'];
    if (scenario === 'types-cross-id') value.judgments[0].evidence = ['e2'];
    if (scenario === 'malformed-context-identity') value.judgments[0].evidence = ['e1'];
  } else {
    value = {
      evidence: assessment.judgments.flatMap((judgment) =>
        judgment.evidence.map((evidence) => ({
          exchange: judgment.exchange,
          symbol: judgment.symbol,
          source: evidence.source,
          excerpt: evidence.detail,
          identityLink: 'Matched individual NAS/AAPL exchange and symbol.',
          asOf: evidence.asOf,
          effectiveDate: '2026-10-18',
          subsequentChanges: 'Controlled subsequent-change check found no change.',
          currentness: evidence.currentness,
        })),
      ),
    };
    if (scenario === 'missing-context') delete value.evidence[0].subsequentChanges;
    if (scenario === 'malformed-context-identity') value.evidence[0].exchange = ['NAS'];
  }
  if (['within-deadlines', 'judgment-overrun'].includes(scenario))
    tickClock(judging ? (scenario === 'judgment-overrun' ? 61_000 : 59_000) : 119_000);
  if (scenario === 'retrieval-overrun' && !judging) tickClock(120_000);
  if (prompt.stage === process.env.TEST_RESPONSE_STAGE)
    value = JSON.parse(process.env.TEST_RESPONSE_VALUE);
  const text = JSON.stringify(value);
  return sse([
    { type: 'response.created', response: { id: 'resp_result', model: body.model, created_at: 1 } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_result' },
    },
    ...(judging && scenario === 'judgment-web-call'
      ? [{ type: 'response.output_item.done', output_index: 1, item: webItem }]
      : []),
    ...(!judging &&
    [
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
    ...(!judging && scenario === 'web-duplicates'
      ? [
          {
            type: 'response.output_item.added',
            output_index: 8,
            item: { ...webItem, id: 'private-id synthetic-subscription', status: 'in_progress' },
          },
          {
            type: 'response.output_item.done',
            output_index: 8,
            item: { ...webItem, id: 'private-id synthetic-subscription' },
          },
          { type: 'response.output_item.done', output_index: 9, item: webItem },
        ]
      : []),
    ...(!judging && scenario === 'web-limit'
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
    ...(judging && scenario === 'missing-final-completion'
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
