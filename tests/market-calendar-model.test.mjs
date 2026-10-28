import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCalendar } from './market-calendar-cli-helper.mjs';

function response(change, extra = {}) {
  return JSON.stringify({
    assessments: [
      {
        id: 'nyse:1:103',
        status: 'schedule_change',
        reason: 'Explicit session change.',
        spanIds: ['nyse:1:103:0:s0'],
        changes: [{ exchanges: ['NYS', 'AMS'], ...change }],
        effectiveDate: null,
        supersedes: [],
        ...extra,
      },
      {
        id: 'nasdaq:ETA2026-1',
        status: 'schedule_change',
        reason: 'Explicit session change.',
        spanIds: ['nasdaq:ETA2026-1:0:s0'],
        changes: [{ exchanges: ['NAS'], ...change }],
        effectiveDate: null,
        supersedes: [],
        ...extra,
      },
    ],
  });
}

test('trusted span references preserve original non-ASCII whitespace without model-copied quote pairs', () => {
  const body = 'Markets\u00a0\u00a0remain operational during the test.';
  const child = 'The child\u00a0notice confirms completion.';
  const result = runCalendar([], { NYSE_BODY: body, NYSE_CHILD: child });
  assert.equal(result.status, 0, result.stderr);
  const request = result.requests.find(({ url }) => url.endsWith('/responses'));
  const input = JSON.parse(request.body.input.find((item) => item.role === 'user').content[0].text);
  assert.equal(input.notices[0].entries[0].body, undefined);
  assert.deepEqual(
    input.notices[0].entries.map((entry) => entry.spans.map((span) => span.text).join('')),
    [body, child],
  );
  assert.deepEqual(JSON.parse(result.stdout).noticeAssessments[0].evidence, [
    { entryId: 'nyse:1:103:0', quote: body },
    { entryId: 'nyse:1:103:1', quote: child },
  ]);
  assert.deepEqual(
    request.body.text.format.schema.properties.assessments.items.properties.spanIds,
    { type: 'array', items: { type: 'string' } },
  );
  assert.equal(
    request.body.text.format.schema.properties.assessments.items.properties.evidence,
    undefined,
  );
});

test('long punctuation-free Unicode notices remain complete and each returned quote is bounded', () => {
  const body = `${'🧭'.repeat(481)} Done.`;
  const result = runCalendar([], { NYSE_BODY: body });
  assert.equal(result.status, 0, result.stderr);
  const request = result.requests.find(({ url }) => url.endsWith('/responses'));
  const entry = JSON.parse(request.body.input.find((item) => item.role === 'user').content[0].text)
    .notices[0].entries[0];
  assert.equal(entry.body, undefined);
  assert.equal(entry.spans.map((span) => span.text).join(''), body);
  assert.deepEqual(
    entry.spans.map((span) => [...span.text].length),
    [240, 240, 7],
  );
  assert.deepEqual(
    entry.spans.map((span) => span.id),
    ['nyse:1:103:0:s0', 'nyse:1:103:0:s1', 'nyse:1:103:0:s2'],
  );
  assert.deepEqual(JSON.parse(result.stdout).noticeAssessments[0].evidence, [
    { entryId: 'nyse:1:103:0', quote: '🧭'.repeat(240) },
  ]);
});

test('a whitespace-only trusted span cannot replace nonempty evidence', () => {
  const body = `A${'\u00a0'.repeat(480)}B.`;
  const result = runCalendar([], {
    NYSE_BODY: body,
    MODEL_RESPONSE: JSON.stringify({
      assessments: [
        {
          id: 'nyse:1:103',
          status: 'no_schedule_impact',
          reason: 'Routine notice.',
          spanIds: ['nyse:1:103:0:s1'],
          changes: [],
          effectiveDate: null,
          supersedes: [],
        },
      ],
    }),
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'MODEL_OUTPUT');
});

test('span membership allows evidence from another group only with an explicit correction reference', () => {
  const body = 'This notice withdraws the previous operational update.';
  const records = [
    {
      id: 'nyse:1:103',
      status: 'no_schedule_impact',
      reason: 'Withdrawn update.',
      spanIds: ['nyse:1:103:0:s0', 'nyse:1:104:0:s0'],
      changes: [],
      effectiveDate: null,
      supersedes: [],
    },
    {
      id: 'nyse:1:104',
      status: 'no_schedule_impact',
      reason: 'Operational update.',
      spanIds: ['nyse:1:104:0:s0'],
      changes: [],
      effectiveDate: null,
      supersedes: [],
    },
  ];
  const env = {
    NYSE_BODY: body,
    NYSE_EXTRA: JSON.stringify([
      {
        id: 104,
        publishedDate: 1792706400000,
        subject: 'Update',
        body: 'The update affects system availability.',
        marketLinks: ['NYSE', 'NYSE AMERICAN EQUITIES'],
        childNotifications: [],
      },
    ]),
  };
  const unrelated = runCalendar([], {
    ...env,
    MODEL_RESPONSE: JSON.stringify({ assessments: records }),
  });
  assert.equal(unrelated.status, 1);
  assert.equal(unrelated.stdout, '');
  assert.equal(JSON.parse(unrelated.stderr).error, 'MODEL_OUTPUT');
  records[0].supersedes = ['nyse:1:104'];
  const explicit = runCalendar([], {
    ...env,
    MODEL_RESPONSE: JSON.stringify({ assessments: records }),
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(
    JSON.parse(explicit.stdout).noticeAssessments[0].evidence[1].entryId,
    'nyse:1:104:0',
  );
});

test('calendar uses one explicit subscription model request even for an empty notice snapshot', () => {
  const result = runCalendar();
  assert.equal(result.status, 0, result.stderr);
  const requests = result.requests.filter(({ url }) => url.endsWith('/responses'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, 'gpt-6-luna');
  assert.equal(requests[0].body.store, false);
  assert.equal(requests[0].body.stream, true);
  assert.ok(!requests[0].body.tools?.length);
  const record = JSON.parse(result.stdout);
  assert.equal(record.noticeAssessment.semanticReliability, 'unverified');
  assert.equal(record.noticeAssessment.model, 'gpt-6-luna');
  assert.deepEqual(record.noticeAssessments, []);
});

test('full routine paragraphs and child text enter the one model request and exact evidence is enforced', () => {
  const env = {
    NYSE_BODY: 'A new matching engine rollout is complete. All systems operate normally.',
    NYSE_CHILD: 'The rollout was verified by the operations team.',
  };
  const result = runCalendar([], env);
  assert.equal(result.status, 0, result.stderr);
  const request = result.requests.find(({ url }) => url.endsWith('/responses'));
  const input = JSON.parse(request.body.input.find((item) => item.role === 'user').content[0].text);
  assert.equal(input.notices.length, 1);
  assert.deepEqual(
    input.notices[0].entries.map((entry) => entry.spans.map((span) => span.text).join('')),
    [env.NYSE_BODY, env.NYSE_CHILD],
  );
  const record = JSON.parse(result.stdout);
  const baseline = {
    assessments: record.noticeAssessments.map(({ url, evidence, ...assessment }) => ({
      ...assessment,
      spanIds: ['nyse:1:103:0:s0', 'nyse:1:103:1:s0'],
    })),
  };
  const confirmed = runCalendar([], { ...env, MODEL_RESPONSE: JSON.stringify(baseline) });
  assert.equal(confirmed.status, 0, confirmed.stderr);
  const invalid = structuredClone(baseline);
  invalid.assessments[0].spanIds[1] = 'nyse:1:103:1:s999';
  const rejected = runCalendar([], { ...env, MODEL_RESPONSE: JSON.stringify(invalid) });
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, '');
  assert.equal(JSON.parse(rejected.stderr).error, 'MODEL_OUTPUT');
});

test('evidenced closures, delayed opens and early closes change the common session deterministically', () => {
  for (const [body, change, at, expected] of [
    [
      'Markets will close on Monday, October 26, 2026.',
      { date: '2026-10-26', kind: 'closed', open: null, close: null },
      '2026-10-26T22:00:00Z',
      ['2026-10-23', '2026-10-27', '2026-10-27T13:30:00.000Z', '2026-10-27T20:00:00.000Z'],
    ],
    [
      'On Monday, October 26, 2026, markets open at 10:00 a.m. ET.',
      { date: '2026-10-26', kind: 'session_hours', open: '10:00', close: null },
      '2026-10-26T13:45:00Z',
      ['2026-10-23', '2026-10-26', '2026-10-26T14:00:00.000Z', '2026-10-26T20:00:00.000Z'],
    ],
    [
      'On Monday, October 26, 2026, markets close at 1:00 p.m. ET.',
      { date: '2026-10-26', kind: 'session_hours', open: null, close: '13:00' },
      '2026-10-26T17:00:00Z',
      ['2026-10-26', '2026-10-27', '2026-10-27T13:30:00.000Z', '2026-10-27T20:00:00.000Z'],
    ],
  ]) {
    const result = runCalendar(['--at', at], {
      SCENARIO: 'article',
      NYSE_BODY: body,
      NASDAQ_BODY: body,
      MODEL_RESPONSE: response(change),
    });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.deepEqual(
      [
        record.dataSession.date,
        record.targetSession.date,
        record.targetSession.open,
        record.targetSession.close,
      ],
      expected,
    );
    assert.equal(record.analysisEligible, true);
    assert.equal(record.scheduleChanges.length, 2);
  }
});

test('a parent-child corrected closure and cross-notice withdrawal suppress the original date', () => {
  const original = 'Markets will close on Monday, October 26, 2026.';
  const child = 'Correction: markets will instead close on Tuesday, October 27, 2026.';
  const body = `${original} ${child}`;
  const records = JSON.parse(
    response({ date: '2026-10-27', kind: 'closed', open: null, close: null }),
  ).assessments;
  records[0].spanIds = ['nyse:1:103:0:s0', 'nyse:1:103:1:s0'];
  let result = runCalendar(['--at', '2026-10-26T22:00:00Z'], {
    SCENARIO: 'article',
    NYSE_BODY: original,
    NYSE_CHILD: child,
    NASDAQ_BODY: body,
    MODEL_RESPONSE: JSON.stringify({ assessments: records }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dataSession.date, '2026-10-26');
  assert.equal(JSON.parse(result.stdout).targetSession.date, '2026-10-28');

  const wrongWeekday = 'Markets will close on Monday, October 27, 2026.';
  const corrected = structuredClone(records);
  const correction = runCalendar(['--at', '2026-10-26T22:00:00Z'], {
    SCENARIO: 'article',
    NYSE_BODY: wrongWeekday,
    NYSE_CHILD: child,
    NASDAQ_BODY: `${wrongWeekday} ${child}`,
    MODEL_RESPONSE: JSON.stringify({ assessments: corrected }),
  });
  assert.equal(correction.status, 0, correction.stderr);
  assert.equal(JSON.parse(correction.stdout).targetSession.date, '2026-10-28');

  const withdrawal = 'The previous closure notice is withdrawn. Markets operate normally.';
  const withdrawals = [
    {
      id: 'nyse:1:104',
      status: 'schedule_change',
      reason: 'Original closure.',
      spanIds: ['nyse:1:104:0:s0'],
      changes: [
        { exchanges: ['NYS', 'AMS'], date: '2026-10-26', kind: 'closed', open: null, close: null },
      ],
      effectiveDate: null,
      supersedes: [],
    },
    {
      id: 'nyse:1:103',
      status: 'no_schedule_impact',
      reason: 'Closure withdrawn.',
      spanIds: ['nyse:1:103:0:s0'],
      changes: [],
      effectiveDate: null,
      supersedes: ['nyse:1:104'],
    },
  ];
  result = runCalendar(['--at', '2026-10-26T22:00:00Z'], {
    NYSE_BODY: withdrawal,
    NYSE_EXTRA: JSON.stringify([
      {
        id: 104,
        publishedDate: 1792706400000,
        subject: 'Original closure',
        body: original,
        marketLinks: ['NYSE', 'NYSE AMERICAN EQUITIES'],
        childNotifications: [],
      },
    ]),
    MODEL_RESPONSE: JSON.stringify({ assessments: withdrawals }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dataSession.date, '2026-10-26');
  assert.equal(JSON.parse(result.stdout).targetSession.date, '2026-10-27');
  assert.deepEqual(JSON.parse(result.stdout).scheduleChanges, []);
});

test('unsupported future session scope fails when the required next session reaches its effective date', () => {
  const body =
    'Nearly continuous trading begins on December 6, 2026. Testing opportunities precede the launch.';
  const records = JSON.parse(response({})).assessments.map((record) => ({
    ...record,
    status: 'future_effective',
    changes: [],
    effectiveDate: '2026-12-06',
  }));
  const env = {
    SCENARIO: 'article',
    NYSE_BODY: body,
    NASDAQ_BODY: body,
    MODEL_RESPONSE: JSON.stringify({ assessments: records }),
  };
  const before = runCalendar([], env);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).deferredNotices[0].effectiveDate, '2026-12-06');
  const effective = runCalendar(['--at', '2026-12-04T22:00:00Z'], env);
  assert.equal(effective.status, 1);
  assert.equal(effective.stdout, '');
  assert.equal(JSON.parse(effective.stderr).error, 'NOTICE_UNRESOLVED');
});

test('model budget includes authentication elapsed time and never exceeds the 180-second model limit', () => {
  for (const env of [
    { MODEL_ELAPSED: '180000' },
    { AUTH_EXPIRES: '2020-01-01T00:00:00Z', AUTH_ELAPSED: '130000', MODEL_ELAPSED: '170000' },
  ]) {
    const result = runCalendar([], env);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(
      ['MODEL_INCOMPLETE', 'EXECUTION_LIMIT'].includes(JSON.parse(result.stderr).error),
      result.stderr,
    );
  }
});

test('incomplete, interrupted, malformed, unavailable and quota model responses fail safely without retry or fallback', () => {
  for (const scenario of [
    'model-no-completion',
    'model-incomplete',
    'model-failed',
    'model-error-after-completion',
    'model-partial-json',
    'model-http-failure',
    'model-quota',
    'model-unavailable',
  ]) {
    const result = runCalendar([], { SCENARIO: scenario, OPENAI_API_KEY: 'synthetic-paid-key' });
    assert.equal(result.status, 1, scenario);
    assert.equal(result.stdout, '', scenario);
    assert.match(JSON.parse(result.stderr).error, /^(MODEL_|SUBSCRIPTION_LIMIT)/, result.stderr);
    assert.doesNotMatch(result.stderr, /synthetic-|private_error/);
    assert.equal(result.requests.filter(({ url }) => url.endsWith('/responses')).length, 1);
    assert.equal(
      result.requests.filter(({ url }) => new URL(url).hostname === 'api.openai.com').length,
      1,
    );
  }
});

test('generic rate limiting is distinguished from confirmed subscription exhaustion', () => {
  const quota = runCalendar([], { SCENARIO: 'model-quota' });
  assert.equal(JSON.parse(quota.stderr).error, 'SUBSCRIPTION_LIMIT');
  const rate = runCalendar([], { SCENARIO: 'model-rate-limit' });
  assert.equal(rate.status, 1);
  assert.equal(rate.stdout, '');
  assert.equal(JSON.parse(rate.stderr).error, 'MODEL_FAILED');
});

test('missing, duplicate, fabricated and unresolved notice records and evidence fail the entire result', () => {
  const body = 'Routine operational notice.';
  const child = 'The operational change is complete.';
  const baseline = {
    assessments: [
      {
        id: 'nyse:1:103',
        status: 'no_schedule_impact',
        reason: 'No regular-session changes.',
        spanIds: ['nyse:1:103:0:s0', 'nyse:1:103:1:s0'],
        changes: [],
        effectiveDate: null,
        supersedes: [],
      },
    ],
  };
  for (const mutate of [
    (value) => value.assessments.pop(),
    (value) => value.assessments.push(value.assessments[0]),
    (value) => {
      value.assessments[0].id = 'invented';
    },
    (value) => {
      value.assessments[0].status = 'unresolved';
    },
    (value) => {
      value.assessments[0].status = 'invented';
    },
    (value) => {
      value.assessments[0].status = ['no_schedule_impact'];
    },
    (value) => {
      value.assessments[0].spanIds.pop();
    },
    (value) => {
      value.assessments[0].spanIds[0] = 'invented';
    },
    (value) => {
      value.assessments[0].spanIds[0] = { entryId: 'nyse:1:103:0', quote: 'Invented quote' };
    },
    (value) => {
      value.assessments[0].spanIds.push('nyse:1:103:0:s0');
    },
    (value) => {
      value.assessments[0].evidence = [{ entryId: 'nyse:1:103:1', quote: 'Invented quote' }];
    },
    (value) => {
      value.assessments[0].supersedes = ['invented'];
    },
    (value) => {
      value.assessments[0].supersedes = ['nyse:1:103'];
    },
    (value) => {
      value.assessments[0].reason = 'synthetic-subscription';
    },
    (value) => {
      value.assessments[0].unknown = true;
    },
  ]) {
    const value = structuredClone(baseline);
    mutate(value);
    const result = runCalendar([], {
      NYSE_BODY: body,
      NYSE_CHILD: child,
      MODEL_RESPONSE: JSON.stringify(value),
    });
    assert.equal(result.status, 1, JSON.stringify(value));
    assert.equal(result.stdout, '');
    assert.ok(
      ['MODEL_OUTPUT', 'NOTICE_UNRESOLVED', 'SENSITIVE_OUTPUT'].includes(
        JSON.parse(result.stderr).error,
      ),
      result.stderr,
    );
    assert.doesNotMatch(result.stderr, /synthetic-/);
  }
});

test('a notice confirming an existing annual early close preserves common effective hours', () => {
  for (const [close, expectedStatus] of [
    ['13:00', 0],
    ['14:00', 1],
  ]) {
    const body = `NYSE confirms November 27, 2026 closes at ${close} ET.`;
    const assessment = {
      id: 'nyse:1:103',
      status: 'schedule_change',
      reason: 'Confirmed early close.',
      spanIds: ['nyse:1:103:0:s0'],
      changes: [
        { exchanges: ['NYS', 'AMS'], date: '2026-11-27', kind: 'session_hours', open: null, close },
      ],
      effectiveDate: null,
      supersedes: [],
    };
    const result = runCalendar(['--at', '2026-11-27T14:00:00Z'], {
      NYSE_BODY: body,
      MODEL_RESPONSE: JSON.stringify({ assessments: [assessment] }),
    });
    assert.equal(result.status, expectedStatus, result.stderr);
    if (expectedStatus === 0) {
      assert.equal(JSON.parse(result.stdout).targetSession.close, '2026-11-27T18:00:00.000Z');
      assert.equal(JSON.parse(result.stdout).analysisEligible, true);
    } else {
      assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr).error, 'EXCHANGE_MISMATCH');
    }
  }
});

test('invalid normalized dates, times and venues cannot alter the annual schedule', () => {
  const body = 'On Monday, October 26, 2026, markets open at 10:00 a.m. ET.';
  for (const change of [
    { date: '2026-13-27', kind: 'closed', open: null, close: null },
    { date: '2026-10-26', kind: 'session_hours', open: '24:00', close: null },
    { date: '2026-10-26', kind: 'session_hours', open: '10:60', close: null },
    { exchanges: ['NAS'], date: '2026-10-26', kind: 'closed', open: null, close: null },
    { date: '2026-10-26', kind: 'closed', open: '10:00', close: null },
    { date: '2026-02-30', kind: 'closed', open: null, close: null },
  ]) {
    const result = runCalendar([], {
      SCENARIO: 'article',
      NYSE_BODY: body,
      NASDAQ_BODY: body,
      MODEL_RESPONSE: response(change),
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'MODEL_OUTPUT');
  }
});

test('model-normalized dates and times accept source abbreviations and hour-only spelling', () => {
  const body = 'On Oct. 26, 2026, markets close at 1 p.m. ET.';
  const result = runCalendar([], {
    SCENARIO: 'article',
    NYSE_BODY: body,
    NASDAQ_BODY: body,
    MODEL_RESPONSE: response({
      date: '2026-10-26',
      kind: 'session_hours',
      open: null,
      close: '13:00',
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).targetSession.close, '2026-10-26T17:00:00.000Z');
});

test('unsupported future scope fails on the effective target date itself', () => {
  const body = 'The regular-session expansion begins October 26, 2026.';
  const record = {
    id: 'nyse:1:103',
    status: 'future_effective',
    reason: 'Unresolved regular-session scope.',
    spanIds: ['nyse:1:103:0:s0'],
    changes: [],
    effectiveDate: '2026-10-26',
    supersedes: [],
  };
  const result = runCalendar([], {
    NYSE_BODY: body,
    MODEL_RESPONSE: JSON.stringify({ assessments: [record] }),
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'NOTICE_UNRESOLVED');
});

test('competing cross-notice withdrawals and cyclic references are rejected instead of choosing a branch', () => {
  const original = 'Markets will close on Monday, October 26, 2026.';
  const withdrawn = 'The previous closure notice is withdrawn.';
  const input = [104, 105].map((id) => ({
    id,
    publishedDate: 1792706400000,
    subject: 'Notice',
    body: id === 104 ? original : withdrawn,
    marketLinks: ['NYSE', 'NYSE AMERICAN EQUITIES'],
    childNotifications: [],
  }));
  const baseline = [
    {
      id: 'nyse:1:103',
      status: 'no_schedule_impact',
      reason: 'Withdrawal.',
      spanIds: ['nyse:1:103:0:s0'],
      changes: [],
      effectiveDate: null,
      supersedes: ['nyse:1:104'],
    },
    {
      id: 'nyse:1:104',
      status: 'schedule_change',
      reason: 'Original closure.',
      spanIds: ['nyse:1:104:0:s0'],
      changes: [
        { exchanges: ['NYS', 'AMS'], date: '2026-10-26', kind: 'closed', open: null, close: null },
      ],
      effectiveDate: null,
      supersedes: [],
    },
    {
      id: 'nyse:1:105',
      status: 'no_schedule_impact',
      reason: 'Competing withdrawal.',
      spanIds: ['nyse:1:105:0:s0'],
      changes: [],
      effectiveDate: null,
      supersedes: ['nyse:1:104'],
    },
  ];
  for (const mutate of [
    () => {},
    (records) => {
      records[1].supersedes = ['nyse:1:103'];
    },
  ]) {
    const records = structuredClone(baseline);
    mutate(records);
    const result = runCalendar([], {
      NYSE_BODY: withdrawn,
      NYSE_EXTRA: JSON.stringify(input),
      MODEL_RESPONSE: JSON.stringify({ assessments: records }),
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'MODEL_OUTPUT');
  }
});

test('indirect competing correction tips cannot silently contribute two distinct closure dates', () => {
  const bodies = new Map([
    [103, 'Original closure: Monday, October 26, 2026.'],
    [104, 'Corrected closure: Tuesday, October 27, 2026.'],
    [105, 'Alternative corrected closure: Wednesday, October 28, 2026.'],
    [106, 'Follow-up corrected closure: Thursday, October 29, 2026.'],
    [107, 'Both competing corrections are replaced. Final closure: Friday, October 30, 2026.'],
  ]);
  const notice = (id) => ({
    id,
    publishedDate: 1792706400000,
    subject: 'Correction',
    body: bodies.get(id),
    marketLinks: ['NYSE', 'NYSE AMERICAN EQUITIES'],
    childNotifications: [],
  });
  const changed = (id, date, supersedes) => ({
    id: `nyse:1:${id}`,
    status: 'schedule_change',
    reason: 'Corrected date.',
    spanIds: [`nyse:1:${id}:0:s0`],
    changes: [{ exchanges: ['NYS', 'AMS'], date, kind: 'closed', open: null, close: null }],
    effectiveDate: null,
    supersedes: supersedes.map((value) => `nyse:1:${value}`),
  });
  const records = [
    changed(103, '2026-10-26', []),
    changed(104, '2026-10-27', [103]),
    changed(105, '2026-10-28', [103]),
    changed(106, '2026-10-29', [104]),
  ];
  const nasdaqBody =
    'Closures: Wednesday, October 28, 2026; Thursday, October 29, 2026; Friday, October 30, 2026.';
  const nasdaq = {
    id: 'nasdaq:ETA2026-1',
    status: 'schedule_change',
    reason: 'Explicit closures.',
    spanIds: ['nasdaq:ETA2026-1:0:s0'],
    changes: ['2026-10-28', '2026-10-29'].map((date) => ({
      exchanges: ['NAS'],
      date,
      kind: 'closed',
      open: null,
      close: null,
    })),
    effectiveDate: null,
    supersedes: [],
  };
  const env = {
    SCENARIO: 'article',
    NYSE_BODY: bodies.get(103),
    NYSE_EXTRA: JSON.stringify([104, 105, 106].map(notice)),
    NASDAQ_BODY: nasdaqBody,
  };
  const conflict = runCalendar([], {
    ...env,
    MODEL_RESPONSE: JSON.stringify({ assessments: [...records, nasdaq] }),
  });
  assert.equal(conflict.status, 1);
  assert.equal(conflict.stdout, '');
  assert.equal(JSON.parse(conflict.stderr).error, 'MODEL_OUTPUT');
  const final = changed(107, '2026-10-30', [105, 106]);
  nasdaq.changes = [
    { exchanges: ['NAS'], date: '2026-10-30', kind: 'closed', open: null, close: null },
  ];
  const resolved = runCalendar([], {
    ...env,
    NYSE_EXTRA: JSON.stringify([104, 105, 106, 107].map(notice)),
    MODEL_RESPONSE: JSON.stringify({ assessments: [...records, final, nasdaq] }),
  });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.deepEqual(
    JSON.parse(resolved.stdout).scheduleChanges.map((change) => change.date),
    ['2026-10-30', '2026-10-30'],
  );
});

test('oversized complete inputs and the official collection deadline fail before a model request', () => {
  for (const [env, expected] of [
    [{ LARGE_NOTICE_BYTES: '270000' }, 'MODEL_INPUT_LIMIT'],
    [{ COLLECTION_ELAPSED: '120000' }, 'COLLECTION_LIMIT'],
  ]) {
    const result = runCalendar([], env);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, expected);
    assert.equal(result.requests.filter(({ url }) => url.endsWith('/responses')).length, 0);
  }
});

test('the actual serialized model request stays within 256KiB including SDK wrappers', (t) => {
  let accepted = 0;
  let rejected = 0;
  for (const bytes of [180000, 200000, 220000, 270000]) {
    const result = runCalendar([], { LARGE_NOTICE_BYTES: String(bytes) });
    const requests = result.requests.filter(({ url }) => url.endsWith('/responses'));
    for (const request of requests) {
      const actualBytes = Buffer.byteLength(JSON.stringify(request.body));
      assert.ok(actualBytes <= 262144, `${actualBytes} actual request bytes`);
      t.diagnostic(`${bytes} notice bytes -> ${actualBytes} serialized request bytes`);
    }
    if (result.status === 0) accepted++;
    else {
      rejected++;
      assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr).error, 'MODEL_INPUT_LIMIT');
      assert.equal(requests.length, 0);
    }
  }
  assert.ok(accepted > 0);
  assert.ok(rejected > 0);
});

test('JSON escaping overhead is rejected at the actual wire limit before any external model request', () => {
  const result = runCalendar([], { LARGE_NOTICE_BYTES: '100000', NOTICE_CHARACTER: '"' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'MODEL_INPUT_LIMIT');
  assert.equal(result.requests.filter(({ url }) => url.endsWith('/responses')).length, 0);
});

test('authentication and model are explicit CLI inputs and duplicate flags fail before HTTP', () => {
  for (const args of [
    [],
    ['--model', 'gpt-6-luna'],
    ['--auth-dir', '/tmp/unused'],
    ['--auth-dir', '/tmp/unused', '--model', 'x', '--model', 'y'],
  ]) {
    const result = runCalendar(args, {}, false);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'USAGE');
    assert.deepEqual(result.requests, []);
  }
  const explicit = runCalendar([], { TEST_MODEL: 'explicit-model' });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(
    explicit.requests.find(({ url }) => url.endsWith('/responses')).body.model,
    'explicit-model',
  );
});

test('the clock advancing during the model request recomputes eligibility and the unsupported future boundary', () => {
  const opened = runCalendar([], { SCENARIO: 'model-final-open' });
  assert.equal(opened.status, 0, opened.stderr);
  const record = JSON.parse(opened.stdout);
  assert.equal(record.evaluatedAt, '2026-10-26T13:30:00.000Z');
  assert.equal(record.analysisEligible, false);
  assert.equal(record.targetSession.date, '2026-10-27');
  const finalCheck = runCalendar([], { SCENARIO: 'model-calculation-open' });
  assert.equal(finalCheck.status, 0, finalCheck.stderr);
  assert.equal(JSON.parse(finalCheck.stdout).analysisEligible, false);
  assert.equal(JSON.parse(finalCheck.stdout).evaluatedAt, '2026-10-26T13:30:00.000Z');
  const body = 'Nearly continuous trading begins on December 6, 2026.';
  const assessment = {
    id: 'nyse:1:103',
    status: 'future_effective',
    reason: 'Unresolved future core session scope.',
    spanIds: ['nyse:1:103:0:s0'],
    changes: [],
    effectiveDate: '2026-12-06',
    supersedes: [],
  };
  const reached = runCalendar([], {
    SCENARIO: 'model-final-future',
    NYSE_BODY: body,
    MODEL_RESPONSE: JSON.stringify({ assessments: [assessment] }),
  });
  assert.equal(reached.status, 1);
  assert.equal(reached.stdout, '');
  assert.equal(JSON.parse(reached.stderr).error, 'NOTICE_UNRESOLVED');
});
