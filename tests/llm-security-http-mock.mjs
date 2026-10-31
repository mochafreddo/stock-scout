import assert from 'node:assert/strict';
import fs, { appendFileSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import timers from 'node:timers/promises';

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
let streamSignal;
let infoResponses = 0;
let infoAttempts = 0;
const sourceIds = new Map();
const scenario = process.env.SCENARIO;
if (scenario === 'retry-stage') {
  const wait = timers.setTimeout;
  mock.method(timers, 'setTimeout', (ms, value, options) => {
    if (ms === 1000)
      appendFileSync(
        process.env.TEST_TRACE,
        `${JSON.stringify({ retryWaitHasSignal: options?.signal instanceof AbortSignal })}\n`,
      );
    return wait(ms, value, options);
  });
  syncBuiltinESMExports();
}
const identityExclusion = scenario.startsWith('identity-') && scenario !== 'identity-conflict';
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
      if (process.env.TEST_INPUT_DELAY) tickClock(Number(process.env.TEST_INPUT_DELAY));
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
if (
  [
    'info-blocked',
    'model-blocked',
    'body-blocked',
    'provider-then-blocked',
    'retry-stage',
  ].includes(scenario) ||
  process.env.TEST_INFO_BLOCK_AT
) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) =>
    originalSetTimeout(
      () => {
        tickClock(delay);
        callback(...args);
      },
      delay === 180_000 ? 10 : delay,
      ...args,
    );
}
const typeSource = 'https://www.sec.gov/controlled-security-type';
const suppliesTypeSource =
  scenario === 'kis-name-with-web' ||
  (!scenario.startsWith('types') && !scenario.startsWith('kis-') && !identityExclusion);
const samples = identityExclusion
  ? [
      { exchange: 'NAS', symbol: 'AAPL', kind: 'volume', rank: 1, type: 'common' },
      { exchange: 'AMS', symbol: 'SPY', kind: 'amount', rank: 1, type: 'etf' },
    ]
  : scenario.startsWith('kis-')
    ? [
        scenario.startsWith('kis-specific')
          ? { exchange: 'NYS', symbol: 'BAC/B', type: 'preferred' }
          : { exchange: 'AMS', symbol: 'SPY', type: 'etf' },
      ]
    : scenario.startsWith('types')
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
          source: typeSource,
          detail: 'Common stock, matched to NAS/AAPL.',
          asOf: '2026-10-18',
          currentness: 'Current classification returned for this symbol.',
        },
      ],
    },
  ],
};
if (scenario.startsWith('kis-'))
  assessment.judgments = [
    {
      exchange: 'AMS',
      symbol: 'SPY',
      type: 'etf',
      identity: 'confirmed',
      applicable: true,
      reason: 'The product name identifies an ETF.',
      evidence: [
        {
          source: 'kis:AMS:SPY',
          detail: 'STATE STREET SPDR S&P 500 ETF; listed.',
          asOf: '2026-10-18',
          currentness: 'Recent listing identity.',
        },
      ],
    },
  ];
if (scenario === 'kis-name-unknown') {
  assessment.judgments[0].type = 'unknown';
  assessment.judgments[0].applicable = false;
  assessment.judgments[0].reason = 'Listing identity and broad stock code do not establish type.';
}
if (scenario === 'kis-name-with-web')
  assessment.judgments[0].evidence.push({
    source: typeSource,
    detail: 'Explicit ETF classification for this individual listed security.',
    asOf: '2026-10-18',
    currentness: 'Current controlled type-source fixture.',
  });
if (scenario.startsWith('kis-specific')) {
  const judgment = assessment.judgments[0];
  judgment.exchange = 'NYS';
  judgment.symbol = 'BAC/B';
  judgment.type = 'preferred';
  judgment.reason = 'Controlled specific KIS code fixture.';
  judgment.evidence[0].source = 'kis:NYS:BAC/B';
  judgment.evidence[0].detail = 'Preferred stock in controlled specific-code fixture.';
}
if (scenario.startsWith('types') || identityExclusion)
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
  const requestIndex = modelRequests;
  const signal = streamSignal;
  const delays = JSON.parse(process.env.TEST_STREAM_DELAYS ?? '[]');
  const delay = delays[requestIndex - 1];
  const ending = process.env.TEST_STREAM_END;
  if (ending && requestIndex === 2) {
    if (ending === 'missing')
      events = events.filter((event) => event.type !== 'response.completed');
    else if (ending !== 'transport')
      events.push({
        type: ending,
        response: { usage, error: { code: 'private-code synthetic-subscription' } },
        error: { message: 'private-message synthetic-subscription' },
      });
  }
  const encoded = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  );
  if (scenario === 'provider-then-blocked' && requestIndex === 2) {
    setTimeout(() => {}, 30);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoded);
          signal.addEventListener('abort', () => controller.close(), { once: true });
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  if (delay !== undefined || (ending === 'transport' && requestIndex === 2)) {
    let sent = false;
    return new Response(
      new ReadableStream({
        async pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(encoded);
          } else {
            if (ending === 'transport' && requestIndex === 2)
              await new Promise((resolve) => setImmediate(resolve));
            tickClock(delay ?? 0);
            if (ending === 'transport' && requestIndex === 2)
              controller.error(new Error('private-transport synthetic-subscription'));
            else controller.close();
          }
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
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
    assert.equal(
      init.headers.authorization,
      `Bearer ${process.env.TEST_KIS_TOKEN ?? 'test-token'}`,
    );
    if (request.pathname.includes('/ranking/')) {
      assert.equal(init.headers.appkey, 'test-key');
      assert.equal(init.headers.appsecret, process.env.KIS_APP_SECRET);
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
      if (scenario === 'ranking-reader-exception')
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error(process.env.TEST_RANKING_EXCEPTION));
            },
          }),
        );
    }
    const body = { rt_cd: '0', msg_cd: 'MCA00000', output1: { nrec: '0' }, output2: [] };
    if (request.pathname.endsWith('search-info')) {
      infoAttempts++;
      if (infoAttempts === Number(process.env.TEST_INFO_BLOCK_AT)) {
        setTimeout(() => {}, 30);
        return new Promise(() => {});
      }
      if (infoAttempts === Number(process.env.TEST_INFO_STATUS_AT))
        return Response.json(
          { error: 'controlled lookup failure' },
          { status: Number(process.env.TEST_INFO_STATUS) },
        );
      if (infoAttempts === Number(process.env.TEST_INFO_AUTH_AT))
        return Response.json({ rt_cd: '1', msg_cd: 'EGW00123' });
      if (scenario === 'retry-stage')
        return Response.json({ rt_cd: '1', msg_cd: 'EGW00316' }, { status: 500 });
      if (scenario === 'info-blocked') {
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
      if (scenario === 'lookup-diagnostic')
        return new Response(process.env.TEST_KIS_BODY, {
          status: Number(process.env.TEST_KIS_STATUS ?? 500),
          headers: { 'content-type': 'application/json', 'x-private': 'header-secret' },
        });
      assert.equal(
        request.searchParams.get('PRDT_TYPE_CD'),
        { NAS: '512', NYS: '513', AMS: '529' }[sample.exchange],
      );
      infoResponses++;
      body.output = {
        std_pdno: 'US0378331005',
        ovrs_stck_dvsn_cd: '01',
        prdt_eng_name: 'APPLE INC',
        prdt_clsf_name: '해외주식',
      };
      if (scenario.startsWith('kis-name-'))
        body.output = {
          std_pdno: 'US78462F1030',
          prdt_eng_name: 'STATE STREET SPDR S&P 500 ETF',
          ovrs_stck_dvsn_cd: '01',
          prdt_clsf_cd: '101210',
          prdt_clsf_name: '해외주식',
          ovrs_excg_cd: 'AMEX',
          lstg_yn: 'Y',
        };
      if (scenario.startsWith('kis-specific'))
        body.output = {
          std_pdno: 'US0605056821',
          ovrs_stck_dvsn_cd: scenario === 'kis-specific-repeat' && infoResponses > 1 ? '01' : '04',
          prdt_clsf_name: '해외주식',
          prdt_eng_name: 'BANK OF AMERICA PREFERRED',
        };
      if (scenario === 'sensitive-lookup') body.output.prdt_clsf_name = 'synthetic-subscription';
      if (scenario.startsWith('types') || identityExclusion)
        body.output = { prdt_clsf_name: sample.type, ovrs_item_name: sample.symbol };
      if (scenario.startsWith('types-partial-') && sample.symbol === 'AAPL')
        body.output.ovrs_stck_dvsn_cd = '01';
      if (infoAttempts === Number(process.env.TEST_INFO_TICK_AT)) tickClock(180_000);
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
    if (
      (scenario.startsWith('types') || identityExclusion) &&
      request.pathname.includes('/ranking/')
    ) {
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
    return Response.json({ models: [{ slug: 'gpt-6-luna', visibility: 'list' }] });
  assert.equal(request.pathname, '/v1/responses');
  streamSignal = init.signal;
  if (scenario === 'model-http-spoof')
    return Response.json(
      { error: { code: 'private_error', message: 'siwc_relogin_required' } },
      { status: 503 },
    );
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
  assert.equal(body.model, process.env.TEST_MODEL ?? 'gpt-6-luna');
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
  assert.equal(prompt.stage, 'assessment');
  assert.equal(prompt.evidenceRecords, undefined);
  if (
    prompt.stage === process.env.TEST_HTTP_EXCEPTION_STAGE &&
    modelRequests === Number(process.env.TEST_HTTP_EXCEPTION_AFTER ?? 0)
  )
    throw Object.assign(new Error(process.env.TEST_HTTP_EXCEPTION), { reason: 'AUTH_FAILED' });
  if (scenario === 'model-blocked') {
    setTimeout(() => {}, 30);
    return new Promise(() => {});
  }
  if (scenario === 'body-blocked') {
    setTimeout(() => {}, 30);
    return new Response(
      new ReadableStream({
        start(controller) {
          init.signal.addEventListener('abort', () => controller.close(), { once: true });
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  if (process.env.TEST_WALL_CLOCK_SHIFT && modelRequests > 0)
    mock.timers.setTime(Date.now() + Number(process.env.TEST_WALL_CLOCK_SHIFT));
  assert.ok(body.tools.some((item) => item.type === 'web_search'));
  assert.ok(body.tools.some((item) => item.type === 'namespace' && item.name === 'stock_scout'));
  assert.ok(body.tools.every((item) => ['namespace', 'web_search'].includes(item.type)));
  if (scenario.startsWith('catalog') || scenario === 'opened-source') {
    const catalogSource =
      scenario === 'opened-source'
        ? 'https://www.sec.gov/sample'
        : 'https://www.sec.gov/catalog-source';
    modelRequests++;
    if (modelRequests === 1) {
      const web = (id, action, status = 'completed') => [
        {
          type: 'response.output_item.added',
          output_index: Number(id.slice(2)),
          item: { type: 'web_search_call', id, status: 'in_progress' },
        },
        {
          type: 'response.output_item.done',
          output_index: Number(id.slice(2)),
          item: { type: 'web_search_call', id, status, action },
        },
      ];
      const call = {
        type: 'function_call',
        id: 'fc_sources',
        call_id: 'call_sources',
        name: 'list_sources',
        namespace: 'stock_scout',
        arguments: '{}',
      };
      return sse([
        {
          type: 'response.created',
          response: { id: 'catalog_research', model: body.model, created_at: 1 },
        },
        ...web('ws1', {
          type: 'search',
          queries: [process.env.TEST_RESEARCH_QUERY ?? 'controlled source'],
          sources: [{ type: 'url', url: 'https://example.org/search-only' }],
        }),
        ...web('ws2', {
          type: 'open_page',
          url:
            scenario === 'catalog-sensitive'
              ? `${catalogSource}/synthetic-subscription`
              : (process.env.TEST_RESEARCH_URL ?? catalogSource),
        }),
        ...web('ws3', {
          type: 'find_in_page',
          url:
            scenario === 'catalog-sensitive'
              ? `${catalogSource}/synthetic-subscription`
              : catalogSource,
          pattern: 'common stock',
        }),
        ...web(
          'ws4',
          {
            type: 'open_page',
            url: process.env.TEST_RESEARCH_FAILURE_URL ?? 'https://example.org/failed',
          },
          'failed',
        ),
        { type: 'response.output_item.added', output_index: 5, item: call },
        {
          type: 'response.output_item.done',
          output_index: 5,
          item: { ...call, status: 'completed' },
        },
        completed,
      ]);
    }
    const catalog = JSON.parse(
      body.input.find(
        (item) => item.type === 'function_call_output' && item.call_id === 'call_sources',
      ).output,
    );
    assert.deepEqual(catalog, [{ id: 's1', source: catalogSource }]);
    if (scenario === 'catalog-model-limit' && modelRequests < 13) {
      const call = {
        type: 'function_call',
        id: `fc_sources_${modelRequests}`,
        call_id: `call_sources_${modelRequests}`,
        name: 'list_sources',
        namespace: 'stock_scout',
        arguments: '{}',
      };
      return sse([
        {
          type: 'response.created',
          response: { id: `catalog_loop_${modelRequests}`, model: body.model, created_at: 1 },
        },
        { type: 'response.output_item.added', output_index: 0, item: call },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { ...call, status: 'completed' },
        },
        completed,
      ]);
    }
    if (scenario === 'catalog-overrun') tickClock(180_000);
    const value = {
      judgments: [
        {
          exchange: 'NAS',
          symbol: 'AAPL',
          type: 'common',
          identity: 'confirmed',
          applicable: true,
          reason: 'Controlled current common stock source.',
          evidence: [
            {
              sourceId:
                scenario === 'catalog-unknown-id'
                  ? 's999'
                  : scenario === 'catalog-search-only-id'
                    ? 'https://example.org/search-only'
                    : catalog[0].id,
              explanation: 'Common stock in a controlled opened source.',
            },
          ],
        },
      ],
    };
    const text = JSON.stringify(value);
    return sse([
      {
        type: 'response.created',
        response: { id: `catalog_${modelRequests}`, model: body.model, created_at: 1 },
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'catalog_message', role: 'assistant', content: [] },
      },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        item_id: 'catalog_message',
        delta: text,
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'catalog_message',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      },
      completed,
    ]);
  }
  if (++modelRequests === 1 || (scenario === 'model-limit' && modelRequests < 13)) {
    const callSamples =
      scenario === 'info-limit'
        ? Array.from({ length: 33 }, () => samples[0])
        : scenario === 'kis-specific-repeat'
          ? [samples[0], samples[0]]
          : samples;
    const batches = process.env.TEST_INFO_BATCHES
      ? JSON.parse(process.env.TEST_INFO_BATCHES)
      : scenario === 'types-batch-subset'
        ? [[samples[2], samples[0]]]
        : ['info-limit', 'kis-specific-repeat'].includes(scenario)
          ? callSamples.map((sample) => [sample])
          : [callSamples];
    const calls = batches.map((batch, index) => ({
      type: 'function_call',
      id: `fc_info_${index}`,
      call_id: `call_info_${index}`,
      name: 'get_infos',
      namespace: 'stock_scout',
      arguments: JSON.stringify({
        securities: batch.map(({ exchange, symbol }) => ({ exchange, symbol })),
      }),
    }));
    if (suppliesTypeSource)
      calls.push({
        type: 'function_call',
        id: 'fc_type_sources',
        call_id: 'call_type_sources',
        name: 'list_sources',
        namespace: 'stock_scout',
        arguments: '{}',
      });
    return sse([
      { type: 'response.created', response: { id: 'resp_info', model: body.model, created_at: 1 } },
      ...(suppliesTypeSource
        ? [
            {
              type: 'response.output_item.added',
              output_index: 100,
              item: { type: 'web_search_call', id: 'ws_type_source', status: 'in_progress' },
            },
            {
              type: 'response.output_item.done',
              output_index: 100,
              item: {
                type: 'web_search_call',
                id: 'ws_type_source',
                status: 'completed',
                action: { type: 'open_page', url: typeSource },
              },
            },
          ]
        : []),
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
  assert.ok(modelRequests === 2);
  const toolResult = body.input.find((item) => item.type === 'function_call_output');
  for (const item of body.input.filter((item) => item.type === 'function_call_output')) {
    const output = JSON.parse(item.output);
    if (output.sourceId) sourceIds.set(output.source, output.sourceId);
    if (Array.isArray(output))
      for (const source of output) sourceIds.set(source.source, source.sourceId ?? source.id);
  }
  assert.ok(toolResult, 'Full tool history must reach the next request');
  if (scenario === 'individual-lookup') assert.match(toolResult.output, /SECURITY_LOOKUP_FAILED/);
  else if (scenario !== 'global-lookup') assert.match(toolResult.output, /sourceId/);
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
  let value = {
    judgments: assessment.judgments.map((judgment) => ({
      ...judgment,
      evidence: judgment.evidence.map((evidence) => ({
        sourceId: sourceIds.get(evidence.source) ?? 's999',
        explanation: evidence.detail,
      })),
    })),
  };
  if (scenario.startsWith('types-batch'))
    for (const judgment of value.judgments)
      if (judgment.evidence.some((record) => record.sourceId === 's999')) {
        judgment.type = 'unknown';
        judgment.evidence = [];
      }
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
  if (scenario === 'invented-id') value.judgments[0].evidence[0].sourceId = 's999';
  if (scenario === 'url-instead-of-id') value.judgments[0].evidence[0].sourceId = 'kis:NAS:AAPL';
  if (scenario === 'types-cross-id')
    value.judgments[0].evidence[0].sourceId = sourceIds.get('kis:NAS:GOOG');
  if (scenario.startsWith('types-partial-')) value.judgments[1].evidence = [];
  if (scenario === 'types-partial-invalid-id') value.judgments[2].evidence[0].sourceId = 's999';
  if (scenario === 'types-partial-cross-id')
    value.judgments[2].evidence[0].sourceId = sourceIds.get('kis:NAS:AAPL');
  if (scenario === 'types-partial-ambiguous') value.judgments[2].identity = 'ambiguous';
  if (scenario === 'types-identity-mixed') value.judgments[0].identity = 'ambiguous';
  if (identityExclusion) {
    value.judgments[0].identity = 'ambiguous';
    if (scenario === 'identity-all') {
      value.judgments[1].identity = 'ambiguous';
      value.judgments[1].type = 'unknown';
    }
    if (scenario === 'identity-unknown-source') value.judgments[0].evidence[0].sourceId = 's999';
    if (scenario === 'identity-cross-source')
      value.judgments[0].evidence[0].sourceId = sourceIds.get('kis:AMS:SPY');
    if (scenario === 'identity-other-unknown-source')
      value.judgments[1].evidence[0].sourceId = 's999';
    if (scenario === 'identity-missing') value.judgments.pop();
    if (scenario === 'identity-duplicate') value.judgments.push(value.judgments[0]);
    if (scenario === 'identity-outside') value.judgments[0].symbol = 'OUTSIDE';
    if (scenario === 'identity-reordered') value.judgments.reverse();
  }
  if (scenario === 'missing-explanation') delete value.judgments[0].evidence[0].explanation;
  if (scenario === 'malformed-evidence') value.judgments[0].evidence[0].explanation = ['Common'];
  if (scenario === 'past-former-deadline') tickClock(120_000);
  if (scenario === 'within-deadline') tickClock(179_000);
  if (scenario === 'assessment-overrun') tickClock(180_000);
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
    ...(scenario === 'web-duplicates'
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
    ...(scenario === 'missing-final-completion'
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
