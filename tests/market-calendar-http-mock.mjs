import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { mock } from 'node:test';

let elapsedMs = 0;
mock.method(performance, 'now', () => elapsedMs);
if (process.env.TEST_OBSERVATION_ID_FAILURE)
  mock.method(crypto, 'randomUUID', () => {
    throw new Error('synthetic-observation-creation');
  });
if (process.env.TEST_OBSERVATION_SERIALIZATION_FAILURE) {
  const stringify = JSON.stringify;
  let failed = false;
  JSON.stringify = (value, ...args) => {
    if (!failed && value?.runId && Array.isArray(value.operations)) {
      failed = true;
      throw new Error('synthetic-observation-serialization');
    }
    return stringify(value, ...args);
  };
}
const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
let matchingTimeouts = 0;
if (process.env.TEST_TIMEOUT_MATCH)
  mock.method(AbortSignal, 'timeout', (ms) => {
    if (ms === Number(process.env.TEST_TIMEOUT_MATCH)) matchingTimeouts++;
    return originalTimeout(
      ms === Number(process.env.TEST_TIMEOUT_MATCH) &&
        (!process.env.TEST_TIMEOUT_OCCURRENCE ||
          matchingTimeouts === Number(process.env.TEST_TIMEOUT_OCCURRENCE))
        ? 5
        : ms,
    );
  });

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/market-calendar/${name}.html.txt`, import.meta.url), 'utf8');
const scenario = process.env.SCENARIO || 'ok';
let officialRequests = 0;
const closureDate = process.env.CLOSURE_DATE || 'Monday, October 26, 2026';
function hoursPdf() {
  const stream = `BT /F1 12 Tf 40 750 Td (Nasdaq Trading Hours of Operation) Tj 0 -20 Td (Market Open: ${scenario === 'guide-hours-mismatch' ? '10:00' : '9:30'} a.m., ET) Tj 0 -20 Td (Market Close: 4:00 p.m., ET) Tj 0 -20 Td (System Hours: 4:00 a.m. to 8:00 p.m., ET) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}
Date.now = () => Date.parse(process.env.TEST_NOW || '2026-10-26T06:00:00Z');
globalThis.fetch = async (url, options) => {
  appendFileSync(
    process.env.TEST_TRACE,
    `${JSON.stringify({ url, method: options?.method || 'GET', ...(String(url).endsWith('/responses') ? { body: JSON.parse(options.body) } : {}) })}\n`,
  );
  const address = new URL(url);
  if (address.href === 'https://api.openai.com/v1/responses') {
    assert.equal(
      new Headers(options.headers).get('authorization'),
      'Bearer synthetic-subscription',
    );
    elapsedMs += Number(process.env.MODEL_ELAPSED || 0);
    if (scenario === 'model-final-open') Date.now = () => Date.parse('2026-10-26T13:30:00Z');
    if (scenario === 'model-calculation-open') {
      let reads = 0;
      Date.now = () => Date.parse(++reads === 1 ? '2026-10-26T13:29:59Z' : '2026-10-26T13:30:00Z');
    }
    if (scenario === 'model-final-future') Date.now = () => Date.parse('2026-12-04T22:00:00Z');
    if (scenario === 'model-http-failure')
      return Response.json(
        {
          error: {
            code: 'private_error',
            message: process.env.TEST_PROVIDER_MESSAGE || 'synthetic-subscription',
          },
        },
        { status: 503 },
      );
    if (scenario === 'model-quota')
      return Response.json(
        {
          error: {
            code: 'subscription_sharing_usage_limit_exceeded',
            message: 'synthetic-subscription',
          },
        },
        { status: 429 },
      );
    if (scenario === 'model-rate-limit')
      return Response.json(
        { error: { code: 'rate_limit_exceeded', message: 'synthetic-subscription' } },
        { status: 429 },
      );
    if (scenario === 'model-unavailable')
      return Response.json(
        { error: { code: 'model_not_found', message: 'synthetic-subscription' } },
        { status: 404 },
      );
    const request = JSON.parse(options.body);
    const input = JSON.parse(request.input.find((item) => item.role === 'user').content[0].text);
    const value = process.env.MODEL_RESPONSE
      ? JSON.parse(process.env.MODEL_RESPONSE)
      : {
          assessments: input.notices.map((notice) => ({
            id: notice.id,
            status: 'no_schedule_impact',
            reason: 'Routine notice.',
            spanIds: notice.entries.map((entry) => entry.spans[0].id),
            supersedes: [],
          })),
        };
    const events = [
      {
        type: 'response.created',
        response: { id: 'resp_result', model: 'gpt-6-luna', created_at: 1 },
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'msg_result' },
      },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        item_id: 'msg_result',
        delta: scenario === 'model-partial-json' ? '{"assessments":[' : JSON.stringify(value),
      },
      ...(scenario === 'model-no-completion'
        ? []
        : [
            {
              type:
                scenario === 'model-incomplete'
                  ? 'response.incomplete'
                  : scenario === 'model-failed'
                    ? 'response.failed'
                    : 'response.completed',
              response: { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } },
            },
          ]),
      ...(scenario === 'model-error-after-completion'
        ? [{ type: 'error', code: 'private_error', message: 'synthetic-subscription' }]
        : []),
    ];
    if (process.env.TEST_UNKNOWN_MODEL_EVENTS === 'reasoning')
      events.splice(
        0,
        events.length,
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'reasoning', id: 'rs_synthetic', summary: [] },
        },
        {
          type: 'response.reasoning_summary_text.delta',
          output_index: 0,
          item_id: 'rs_synthetic',
          summary_index: 0,
          delta: 'synthetic-private-reasoning',
        },
      );
    else if (process.env.TEST_UNKNOWN_MODEL_EVENTS)
      events.splice(0, events.length, {
        type: 'synthetic-private-future-event',
        private: 'synthetic-private-body',
      });
    if (scenario === 'model-duplicate-completion') events.push(events.at(-1));
    if (
      [
        'model-header-stall',
        'model-body-error',
        'model-incomplete-then-cancel',
        'model-completed-then-cancel',
      ].includes(scenario)
    ) {
      if (scenario === 'model-incomplete-then-cancel') events.at(-1).type = 'response.incomplete';
      let sent = false;
      let keepAlive;
      return new Response(
        new ReadableStream(
          {
            start(controller) {
              if (scenario !== 'model-body-error')
                keepAlive = setTimeout(
                  () => controller.error(new Error('synthetic-stall-not-cancelled')),
                  2000,
                );
              options.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(keepAlive);
                  controller.error(options.signal.reason);
                },
                { once: true },
              );
            },
            pull(controller) {
              if (scenario === 'model-header-stall') return;
              if (!sent) {
                sent = true;
                elapsedMs += 10;
                controller.enqueue(
                  new TextEncoder().encode(
                    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
                  ),
                );
              } else if (scenario === 'model-body-error')
                controller.error(new Error('synthetic-private-transport'));
            },
            cancel() {
              clearTimeout(keepAlive);
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    if (process.env.TEST_EVENT_PADDING_BYTES)
      events[0].private = 'synthetic-private-event'.repeat(
        Math.ceil(Number(process.env.TEST_EVENT_PADDING_BYTES) / 23),
      );
    const encoded = new TextEncoder().encode(
      events
        .map(
          (event) =>
            `data: ${JSON.stringify(event)}${process.env.TEST_SSE_NEWLINE || '\n'}${process.env.TEST_SSE_NEWLINE || '\n'}`,
        )
        .join('') + (process.env.TEST_MODEL_CANCEL_ERROR ? 'data: {\n\n' : ''),
    );
    let offset = 0;
    let cancelFallback;
    const body =
      process.env.TEST_SSE_CHUNK_BYTES || process.env.TEST_MODEL_CANCEL_ERROR
        ? new ReadableStream(
            {
              start(controller) {
                if (process.env.TEST_MODEL_CANCEL_ERROR)
                  cancelFallback = setTimeout(() => controller.close(), 1000);
              },
              pull(controller) {
                if (offset >= encoded.length) {
                  if (process.env.TEST_MODEL_CANCEL_ERROR) return;
                  controller.close();
                  return;
                }
                const next = Math.min(
                  encoded.length,
                  offset + Number(process.env.TEST_SSE_CHUNK_BYTES || encoded.length),
                );
                elapsedMs += 10;
                controller.enqueue(encoded.slice(offset, next));
                offset = next;
              },
              cancel() {
                clearTimeout(cancelFallback);
                if (process.env.TEST_MODEL_CANCEL_ERROR) {
                  appendFileSync(process.env.TEST_STREAM_TRACE, 'model-cancel\n');
                  throw new Error(process.env.TEST_MODEL_CANCEL_ERROR);
                }
              },
            },
            { highWaterMark: 0 },
          )
        : encoded;
    const response = new Response(body, {
      headers:
        process.env.TEST_MODEL_CONTENT_TYPE === ''
          ? {}
          : { 'content-type': process.env.TEST_MODEL_CONTENT_TYPE ?? 'text/event-stream' },
    });
    if (process.env.TEST_MODEL_RELEASE_ERROR) {
      const getReader = response.body.getReader.bind(response.body);
      response.body.getReader = (...args) => {
        const reader = getReader(...args);
        const releaseLock = reader.releaseLock.bind(reader);
        let rejected = false;
        reader.releaseLock = () => {
          releaseLock();
          if (!rejected) {
            rejected = true;
            appendFileSync(process.env.TEST_STREAM_TRACE, 'model-release\n');
            throw new Error(process.env.TEST_MODEL_RELEASE_ERROR);
          }
        };
        return reader;
      };
    }
    return response;
  }
  if (address.href === 'https://auth.openai.com/api/accounts/oauth/token') {
    elapsedMs += Number(process.env.AUTH_ELAPSED || 0);
    return Response.json({
      access_token: 'synthetic-subscription',
      refresh_token: 'synthetic-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  }
  if (scenario === 'transport-failure') throw new Error('PRIVATE-TRANSPORT-CONTENT');
  officialRequests++;
  if (scenario === 'official-preheader-stall') {
    if (process.env.TEST_OFFICIAL_STAGE_LIMIT && officialRequests === 1) elapsedMs = 110_000;
    else
      return new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error('synthetic-unexpected-wait')), 2000);
        options.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(keepAlive);
            reject(options.signal.reason);
          },
          { once: true },
        );
      });
  }
  if (scenario === 'official-body-limit') {
    let sent = false;
    return new Response(
      new ReadableStream(
        {
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(new Uint8Array(2_000_001));
            }
          },
          cancel() {
            appendFileSync(process.env.TEST_STREAM_TRACE, 'cancel\n');
            if (process.env.TEST_OFFICIAL_CANCEL_ERROR)
              throw new Error(process.env.TEST_OFFICIAL_CANCEL_ERROR);
          },
        },
        { highWaterMark: 0 },
      ),
    );
  }
  if (['http-failure', 'calendar-http-failure'].includes(scenario))
    return new Response('PRIVATE-HTTP-CONTENT', { status: 503 });
  if (scenario === 'oversize') return new Response('x'.repeat(2_000_001));
  if (address.pathname === '/TraderNews.aspx' && address.searchParams.get('id') === 'ETA2026-1')
    return new Response(
      `<html><body><div id="MainContainer"><div class="genTableNews"><table><tr><th>Category: Equity Alert. Contact information.</th><td><p>${process.env.NASDAQ_BODY || (['closure', 'correction', 'ambiguous-child', 'marked-closure'].includes(scenario) ? `Nasdaq U.S. equities and options markets will be closed on ${closureDate}, in observance of a National Day of Mourning.` : 'Nasdaq will begin listing and trading the following exchange-traded funds: Example ETF (TEST).')}</p></td></tr></table></div></div></body></html>`,
    );
  if (address.pathname.endsWith('/oe_refguide.pdf')) return new Response(hoursPdf());
  if (address.hostname === 'www.nyse.com' && address.pathname === '/trade/hours-calendars')
    return new Response(
      scenario === 'ams-hours'
        ? fixture('nyse').replace(
            'NYSE American</button><div><p>Core Trading Session: 9:30',
            'NYSE American</button><div><p>Core Trading Session: 9:45',
          )
        : scenario === 'footnote-weekday'
          ? fixture('nyse').replace('Friday, November 27, 2026', 'Monday, November 27, 2026')
          : fixture('nyse'),
    );
  if (address.hostname === 'www.nasdaqtrader.com' && address.searchParams.get('id') === 'Calendar')
    return new Response(
      scenario === 'mismatch'
        ? fixture('nasdaq').replace(/1:00 p.m./g, '2:00 p.m.')
        : ['correction', 'ambiguous-child'].includes(scenario)
          ? fixture('nasdaq').replace(
              '<tbody>',
              '<tbody><tr><td>October 27, 2026</td><td>Additional official holiday</td><td>Closed</td></tr>',
            )
          : fixture('nasdaq'),
    );
  if (address.hostname === 'www.nyse.com' && address.pathname.includes('/summaries/filter')) {
    const data =
      scenario === 'snapshot'
        ? [
            {
              id: 100,
              publishedDate: 1792706400000,
              subject: 'Options notice',
              body: '<p>NYSE American Options is introducing new option series.</p>',
              marketLinks: ['NYSE AMERICAN OPTIONS'],
              childNotifications: [
                {
                  publishedDate: 1792710000000,
                  subject: 'Options update',
                  body: '<p>The options series update is complete.</p>',
                },
              ],
            },
          ]
        : ['closure', 'correction', 'ambiguous-child', 'marked-closure'].includes(scenario) &&
            address.pathname.includes('/system/1/')
          ? [
              {
                id: 101,
                publishedDate: 1792706400000,
                subject:
                  scenario === 'marked-closure'
                    ? 'Correction: replacement notice'
                    : 'Mourning closure',
                body: `<p>On ${closureDate}, The New York Stock Exchange, NYSE American Equities will close in observance of the National Day of Mourning.</p>`,
                marketLinks: ['NYSE', 'NYSE AMERICAN EQUITIES'],
                childNotifications: ['correction', 'ambiguous-child'].includes(scenario)
                  ? [
                      {
                        publishedDate: 1792710000000,
                        subject:
                          scenario === 'correction' ? 'Correction: replacement date' : 'Update',
                        body: '<p>On Tuesday, October 27, 2026, The New York Stock Exchange, NYSE American Equities will close in observance of the National Day of Mourning.</p>',
                      },
                    ]
                  : [],
              },
            ]
          : [];
    if (scenario === 'unknown-notice')
      data.push({
        id: 102,
        publishedDate: 1792706400000,
        subject: 'Notice',
        body: '<p>Important market changes. Details to follow.</p>',
        marketLinks: ['NYSE'],
        childNotifications: [],
      });
    if (
      (process.env.NYSE_BODY || process.env.LARGE_NOTICE_BYTES) &&
      address.pathname.includes('/system/1/')
    )
      data.push({
        id: 103,
        publishedDate: 1792706400000,
        subject: 'Informational notice',
        body: `<p>${process.env.NYSE_BODY || (process.env.NOTICE_CHARACTER || 'x').repeat(Number(process.env.LARGE_NOTICE_BYTES))}</p>`,
        marketLinks:
          scenario === 'trailing-market' ? ['NYSE '] : ['NYSE', 'NYSE AMERICAN EQUITIES'],
        childNotifications: process.env.NYSE_CHILD
          ? [
              {
                publishedDate: 1792710000000,
                subject: 'Update',
                body: `<p>${process.env.NYSE_CHILD}</p>`,
              },
            ]
          : [],
      });
    if (process.env.NYSE_EXTRA && address.pathname.includes('/system/1/'))
      data.push(...JSON.parse(process.env.NYSE_EXTRA));
    return Response.json({
      data,
      totalCount: scenario === 'truncated-nyse' ? 1 : data.length,
      oldestPublishedYear: 2006,
    });
  }
  if (address.hostname === 'www.nasdaqtrader.com' && address.pathname === '/rss.aspx') {
    elapsedMs += Number(process.env.COLLECTION_ELAPSED || 0);
    if (scenario === 'final-open') Date.now = () => Date.parse('2026-10-26T13:30:00Z');
    if (scenario === 'calculation-open') {
      let reads = 0;
      Date.now = () => Date.parse(++reads <= 2 ? '2026-10-26T13:29:59Z' : '2026-10-26T13:30:00Z');
    }
    if (scenario === 'final-year') Date.now = () => Date.parse('2027-01-01T05:00:00Z');
    const item = [
      'snapshot',
      'closure',
      'article',
      'correction',
      'ambiguous-child',
      'marked-closure',
      'marked-expansion',
    ].includes(scenario)
      ? `<item><title>${scenario === 'marked-expansion' ? 'Correction: expansion date' : 'Equity alert'}</title><pubDate>Fri, 23 Oct 2026 18:00:00 GMT</pubDate><link>http://www.nasdaqtrader.com/TraderNews.aspx?id=ETA2026-1</link><Markets>The Nasdaq Stock Market</Markets></item>`
      : '';
    return new Response(
      `<rss version="2.0"><channel><title>Nasdaq News</title>${item}</channel></rss>`,
    );
  }
  throw new Error(`Unexpected external request: ${url}`);
};
