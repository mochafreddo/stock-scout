import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mock } from 'node:test';
import { advanceElapsed } from './candidate-universe-http-mock.mjs';

mock.timers.enable({ apis: ['Date'], now: Date.parse(process.env.TEST_NOW) });

const candidateFetch = globalThis.fetch;
let recommendationRequests = 0;
const scenario = process.env.SCENARIO;
const originalSetTimeout = globalThis.setTimeout;
const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
let recommending = false;
let abortStage;
let executionAdvanced = false;
if (process.env.REPORT_ABORT) {
  mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms === 180_000) {
      recommending = true;
      if (process.env.REPORT_ABORT === 'stage')
        abortStage = () => {
          advanceElapsed(180_000);
          callback(...args);
        };
    }
    return originalSetTimeout(callback, ms, ...args);
  });
  mock.method(AbortSignal, 'timeout', (ms) => {
    if (!recommending || !['target', 'execution'].includes(process.env.REPORT_ABORT))
      return originalTimeout(ms);
    const signal = originalTimeout(20);
    signal.addEventListener('abort', () => {
      if (process.env.REPORT_ABORT === 'execution') {
        if (!executionAdvanced) advanceElapsed(150_000);
        executionAdvanced = true;
      } else Date.now = () => Date.parse('2026-10-19T13:30:00Z');
    });
    return signal;
  });
}
const sse = (events) => {
  const encoded = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  );
  let sent = false;
  return new Response(
    scenario === 'report-body-error' && recommendationRequests === 2
      ? new ReadableStream(
          {
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(encoded);
              } else controller.error(new Error('synthetic-private-transport'));
            },
          },
          { highWaterMark: 0 },
        )
      : encoded,
    {
      headers:
        process.env.TEST_REPORT_CONTENT_TYPE === ''
          ? {}
          : { 'content-type': process.env.TEST_REPORT_CONTENT_TYPE ?? 'text/event-stream' },
    },
  );
};
const completed = {
  type: 'response.completed',
  response: { usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
};
function message(value) {
  const text = JSON.stringify(value);
  return [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_report' },
    },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_report', delta: text },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_report',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
  ];
}
globalThis.fetch = async (url, init = {}) => {
  const body =
    typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : undefined;
  const input = body?.input?.find((item) => item.role === 'user');
  const prompt = input ? JSON.parse(input.content[0].text) : undefined;
  if (!['recommendation', 'report_review'].includes(prompt?.stage))
    return candidateFetch(url, init);
  appendFileSync(process.env.TEST_TRACE, `${JSON.stringify({ url: String(url), body })}\n`);
  assert.equal(String(url), 'https://api.openai.com/v1/responses');
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-subscription');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.ok(body.input.every((item) => item.role !== 'system'));
  assert.equal(body.model, 'gpt-6-luna');
  if (
    (scenario === 'report-header-stall' && prompt.stage === 'recommendation') ||
    (scenario === 'review-header-stall' && prompt.stage === 'report_review')
  ) {
    let keepAlive;
    return new Response(
      new ReadableStream({
        start(controller) {
          if (abortStage) originalSetTimeout(abortStage, 20);
          keepAlive = originalSetTimeout(() => {
            controller.error(new Error('synthetic-stall-not-aborted'));
          }, 2000);
          init.signal.addEventListener('abort', () => {
            clearTimeout(keepAlive);
            appendFileSync(process.env.TEST_TRACE, `${JSON.stringify({ streamAborted: true })}\n`);
            controller.error(new DOMException('synthetic-subscription', 'AbortError'));
          });
        },
        cancel() {
          clearTimeout(keepAlive);
          appendFileSync(process.env.TEST_TRACE, `${JSON.stringify({ streamCancelled: true })}\n`);
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  if (scenario === 'report-time') advanceElapsed(180_000);
  if (scenario === 'report-execution-time') advanceElapsed(600_000);
  if (scenario === 'report-open') Date.now = () => Date.parse('2026-10-19T13:30:00Z');
  if (scenario === 'report-http-spoof')
    return Response.json(
      { error: { code: 'private_error', message: 'siwc_relogin_required' } },
      { status: 503 },
    );
  if (scenario === 'report-auth')
    return Response.json(
      { error: { code: 'invalid_api_key', message: 'synthetic-subscription' } },
      { status: 401 },
    );
  if (scenario === 'report-quota')
    return Response.json(
      {
        error: {
          code: 'subscription_sharing_usage_limit_exceeded',
          message: 'synthetic-subscription',
        },
      },
      { status: 429 },
    );
  const created = {
    type: 'response.created',
    response: { id: `report_${recommendationRequests}`, model: body.model, created_at: 1 },
  };
  if (prompt.stage === 'report_review') {
    assert.ok(!body.tools || body.tools.length === 0);
    if (prompt.candidates.length) assert.equal(prompt.candidates[0].referenceClose.value, '11');
    if (scenario === 'report-news') assert.match(prompt.candidates[0].reason, /실적 발표/);
    assert.equal(
      prompt.observations.length,
      process.env.REPORT_COUNT ? 600 : scenario === 'all-excluded' ? 0 : 200,
    );
    return sse([
      created,
      ...message({
        supported: scenario !== 'report-news',
        reason: '제공된 일봉 수치와 정성 해석을 확인했습니다.',
      }),
      ...(scenario === 'review-eof' ? [] : [completed]),
      ...(scenario === 'review-late-error'
        ? [{ type: 'error', code: 'server_error', message: 'synthetic-subscription' }]
        : []),
    ]);
  }
  recommendationRequests++;
  assert.ok(body.tools.some((item) => item.type === 'namespace' && item.name === 'stock_scout'));
  assert.ok(body.tools.every((item) => item.type === 'namespace'));
  if (
    (recommendationRequests === 1 || scenario === 'report-loop') &&
    scenario !== 'report-skipped-tools' &&
    prompt.securities.length
  ) {
    const call = {
      type: 'function_call',
      id: 'fc_daily',
      call_id: 'call_daily',
      namespace: 'stock_scout',
      name: 'get_daily',
      arguments: JSON.stringify({
        securityIds:
          scenario === 'report-outside-tool'
            ? ['NAS:OUTSIDE']
            : prompt.securities
                .slice(0, scenario === 'report-partial-tools' ? 1 : undefined)
                .map((s) => s.id),
      }),
    };
    return sse([
      created,
      { type: 'response.output_item.added', output_index: 0, item: call },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { ...call, status: 'completed' },
      },
      ...(['report-unknown-tool', 'report-invalid-tool-json'].includes(scenario)
        ? [
            {
              type: 'response.output_item.added',
              output_index: 1,
              item: {
                ...call,
                id: 'fc_invalid',
                call_id: 'call_invalid',
                name: scenario === 'report-unknown-tool' ? 'unknown_tool' : 'get_daily',
                arguments: scenario === 'report-invalid-tool-json' ? '{broken' : '{}',
              },
            },
            {
              type: 'response.output_item.done',
              output_index: 1,
              item: {
                ...call,
                id: 'fc_invalid',
                call_id: 'call_invalid',
                name: scenario === 'report-unknown-tool' ? 'unknown_tool' : 'get_daily',
                arguments: scenario === 'report-invalid-tool-json' ? '{broken' : '{}',
                status: 'completed',
              },
            },
          ]
        : []),
      ...(scenario === 'report-missing-tool-completion' ? [] : [completed]),
    ]);
  }
  const daily =
    scenario === 'report-skipped-tools' || !prompt.securities.length
      ? null
      : JSON.parse(body.input.find((item) => item.type === 'function_call_output').output);
  if (daily) {
    assert.equal(daily[0].securityId, 'NAS:AAPL');
    assert.equal(daily[0].observations.length, 100);
    assert.equal(daily[0].observations.at(-1).value, '123');
  }
  const value = {
    candidates: [
      {
        securityId: 'NAS:AAPL',
        reason: '완료 일봉의 가격 범위와 거래량을 바탕으로 검토합니다.',
        evidence: [
          { observationId: 'NAS:AAPL:2026-10-16:tvol', explanation: '완료 세션의 거래량입니다.' },
        ],
        observationSessions: 3,
        observationReason: '다음 몇 세션에서 가격과 거래량 흐름을 관찰합니다.',
        risks: ['수정주가를 반영하지 않아 가격 비교가 왜곡될 수 있습니다.'],
      },
    ],
    noCandidatesReason: null,
  };
  if (process.env.REPORT_COUNT)
    value.candidates = prompt.securities.slice(0, Number(process.env.REPORT_COUNT)).map((s) => ({
      ...value.candidates[0],
      securityId: s.id,
      evidence: [
        { observationId: `${s.id}:2026-10-16:tvol`, explanation: '완료 세션의 거래량입니다.' },
      ],
    }));
  if (process.env.REPORT_VALUE) Object.assign(value, JSON.parse(process.env.REPORT_VALUE));
  if (scenario === 'report-sensitive') value.candidates[0].reason = 'synthetic-subscription';
  if (scenario === 'report-none' || scenario === 'all-excluded') {
    value.candidates = [];
    value.noCandidatesReason = '반복된 가격과 거래량만으로 선정할 충분한 근거가 없습니다.';
  }
  if (scenario === 'report-news') value.candidates[0].reason = '실적 발표가 주가를 끌어올렸습니다.';
  return sse([
    created,
    ...message(value),
    ...(scenario === 'report-eof'
      ? []
      : scenario === 'report-incomplete'
        ? [
            {
              type: 'response.incomplete',
              response: { incomplete_details: { reason: 'max_output_tokens' } },
            },
          ]
        : [completed]),
    ...(scenario === 'report-late-error'
      ? [{ type: 'error', code: 'server_error', message: 'synthetic-subscription' }]
      : []),
    ...(scenario === 'report-duplicate-completion' ? [completed] : []),
  ]);
};
