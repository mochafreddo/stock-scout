import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accounts, fixture, runAccountCli as runCli, selectAccount } from './toss-cli-helper.mjs';

function select(f, scopes = ['orders', 'conditional-orders'], accountSeq = 741) {
  return selectAccount(f, accountSeq, scopes);
}
const order = {
  orderId: 'order-one',
  symbol: 'AAPL',
  side: 'BUY',
  orderType: 'MARKET',
  timeInForce: 'DAY',
  status: 'PARTIAL_FILLED',
  price: null,
  quantity: '0.123456789012345678',
  orderAmount: '23.450000',
  currency: 'USD',
  orderedAt: '2026-11-01T00:30:00+09:00',
  canceledAt: null,
  execution: {
    filledQuantity: '0.1',
    averageFilledPrice: '185.5000',
    filledAmount: '18.55000',
    commission: '0',
    tax: null,
    filledAt: '2026-11-01T00:31:00+09:00',
    settlementDate: null,
  },
};
const leg = {
  type: 'STOP',
  status: 'WATCHING',
  orderSide: 'SELL',
  triggerPrice: '180.50',
  targetProfitRate: null,
  orderPrice: null,
  triggeredOrderId: null,
};
const conditional = {
  conditionalOrderId: 'condition-one',
  type: 'SINGLE',
  status: 'WATCHING',
  symbol: 'AAPL',
  market: 'US',
  quantity: '0.123456789012345678',
  orderType: 'MARKET',
  first: leg,
  second: null,
  createdAt: '2026-11-01T00:30:00+09:00',
};
const closedConditional = {
  ...conditional,
  status: 'COMPLETED',
  first: { ...leg, status: 'COMPLETED' },
};

function page(command, rows, extra = {}) {
  return {
    path: `/api/v1/${command}`,
    body: {
      result: {
        [command === 'orders' ? 'orders' : 'conditionalOrders']: rows,
        hasNext: false,
        nextCursor: null,
        ...extra,
      },
    },
  };
}

test('regular and conditional order scopes authorize only their own query', async () => {
  for (const [allowed, denied, row] of [
    ['orders', 'conditional-orders', order],
    ['conditional-orders', 'orders', conditional],
  ]) {
    const f = fixture();
    try {
      const selected = await select(f, [allowed]);
      assert.equal(selected.status, 0, selected.stdout + selected.stderr);
      const rejected = await runCli(f, [], [denied, 'OPEN']);
      assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
      assert.equal(JSON.parse(rejected.stdout).error.code, 'ACCOUNT_SCOPE_DENIED');
      assert.equal(rejected.stderr, 'ACCOUNT_SCOPE_DENIED\n');
      assert.deepEqual(rejected.requests, []);
      const accepted = await runCli(f, [accounts, page(allowed, [row])], [allowed, 'OPEN']);
      assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
      assert.equal(accepted.stderr, '');
      assert.deepEqual(JSON.parse(accepted.stdout).data, [row]);
      assert.equal(accepted.requests.at(-1).account, '741');
      assert.doesNotMatch(
        rejected.stdout + rejected.stderr + accepted.stdout + accepted.stderr,
        /accountSeq|741|99887766554|synthetic-token|synthetic-secret/,
      );
    } finally {
      f.close();
    }
  }
});

test('orders preserve current state, decimal strings and execution on the selected account', async () => {
  const f = fixture();
  try {
    const selected = await select(f);
    assert.equal(selected.status, 0, selected.stdout);
    const r = await runCli(f, [accounts, page('orders', [order])], ['orders', 'OPEN']);
    assert.equal(r.status, 0, r.stdout);
    const output = JSON.parse(r.stdout);
    assert.deepEqual(output.data, [order]);
    assert.equal(output.source.accountAlias, 'primary');
    assert.equal(output.source.dateMeaning, 'orderedAt');
    assert.equal(r.requests.at(-1).query, '?status=OPEN');
    assert.equal(r.requests.at(-1).account, '741');
    assert.equal(r.stderr, '');
    assert.doesNotMatch(
      r.stdout + r.stderr,
      /accountSeq|99887766554|synthetic-token|synthetic-secret/,
    );
    assert.ok(
      r.requests.every((request) => request.path === '/oauth2/token' || request.method === 'GET'),
    );
  } finally {
    f.close();
  }
});

test('orders validate timestamps without date filters (characterization)', async () => {
  for (const status of ['OPEN', 'CLOSED']) {
    const f = fixture();
    try {
      const selected = await select(f);
      assert.equal(selected.status, 0, selected.stdout);
      const invalid = { ...order, orderedAt: '2026-02-30T10:00:00Z' };
      const partial = await runCli(
        f,
        [accounts, page('orders', [invalid, order])],
        ['orders', status],
      );
      assert.equal(partial.status, 2, partial.stdout + partial.stderr);
      const output = JSON.parse(partial.stdout);
      assert.equal(output.status, 'partial');
      assert.deepEqual(output.data, [order]);
      assert.deepEqual(output.omissions, [{ index: 0, reason: 'invalid_item' }]);
      assert.equal(
        partial.requests.at(-1).query,
        status === 'OPEN' ? '?status=OPEN' : '?status=CLOSED&limit=20',
      );
      const rejected = await runCli(f, [accounts, page('orders', [invalid])], ['orders', status]);
      assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
      assert.equal(JSON.parse(rejected.stdout).error.code, 'RESPONSE_INVALID');
    } finally {
      f.close();
    }
  }
});

test('orders attach request semantics only after account validation (characterization)', async (t) => {
  for (const command of ['orders', 'conditional-orders']) {
    const f = fixture();
    t.after(f.close);
    const args = [command, 'CLOSED', 'symbol=AAPL', 'limit=7'];
    const missing = await runCli(f, [], args);
    assert.equal(missing.status, 1, missing.stdout);
    const base = { provider: 'tossinvest', endpoint: `/api/v1/${command}`, freshness: 'unknown' };
    assert.deepEqual(JSON.parse(missing.stdout).source, base);
    assert.deepEqual(missing.requests, []);
    await select(f);
    const denied = await runCli(
      f,
      [accounts, { path: `/api/v1/${command}`, status: 403, body: {} }],
      args,
    );
    assert.equal(denied.status, 1, denied.stdout);
    assert.equal(denied.stderr.trim(), 'PERMISSION_DENIED');
    assert.deepEqual(JSON.parse(denied.stdout).source, {
      ...base,
      accountAlias: 'primary',
      snapshot: 'unknown',
      status: 'CLOSED',
      limit: '7',
      symbol: 'AAPL',
      scope:
        command === 'orders'
          ? 'KR_US_API_supported_order_types_only'
          : 'KR_US_all_channels_conditional_orders',
      dateTimeZone: 'Asia/Seoul',
      dateMeaning: command === 'orders' ? 'orderedAt' : 'createdAt',
      quantityUnit: 'securities',
      priceUnit: 'currency_per_security',
    });
  }
});

test('conditional orders preserve both legs, optional fields and future codes', async () => {
  const f = fixture();
  try {
    await select(f);
    const rows = [
      conditional,
      {
        ...conditional,
        type: 'OTO',
        status: 'ORDERED',
        first: { ...leg, type: 'PROFIT_RATE' },
        second: {
          ...leg,
          type: 'PROFIT_RATE',
          status: 'HOLDING',
          targetProfitRate: '-10.50',
          triggeredOrderId: 'linked-order',
        },
        expireDate: '2026-12-31',
      },
      { ...conditional, type: 'FUTURE', status: 'FUTURE', second: undefined },
    ];
    const r = await runCli(
      f,
      [accounts, page('conditional-orders', rows)],
      ['conditional-orders', 'OPEN'],
    );
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(JSON.parse(r.stdout).data, JSON.parse(JSON.stringify(rows)));
    assert.equal(r.requests.at(-1).query, '?status=OPEN&limit=20');
    assert.ok(
      r.requests.every((request) => request.path === '/oauth2/token' || request.method === 'GET'),
    );
  } finally {
    f.close();
  }
});

test('order pages keep empty-page cursors and bind continuation to endpoint, account and filters', async () => {
  for (const command of ['orders', 'conditional-orders']) {
    const f = fixture();
    try {
      await select(f);
      const r = await runCli(
        f,
        [accounts, page(command, [], { hasNext: true, nextCursor: 'next_cursor-1' })],
        [command, 'CLOSED', 'symbol=AAPL'],
      );
      assert.equal(r.status, 2, r.stdout);
      const output = JSON.parse(r.stdout);
      assert.deepEqual(output.data, []);
      assert.deepEqual(output.omissions, [{ reason: 'next_page' }]);
      const continuation = ['cursor=next_cursor-1', `context=${output.page.context}`];
      const next = await runCli(
        f,
        [accounts, page(command, [])],
        [command, 'CLOSED', 'symbol=AAPL', 'limit=100', ...continuation],
      );
      assert.equal(next.status, 0, next.stdout);
      assert.equal(
        next.requests.at(-1).query,
        '?status=CLOSED&limit=100&symbol=AAPL&cursor=next_cursor-1',
      );
      assert.deepEqual(JSON.parse(next.stdout).page, { hasNext: false, nextCursor: null });
      for (const args of [
        [command, 'CLOSED', 'symbol=MSFT'],
        [command, 'OPEN', 'symbol=AAPL'],
        [command === 'orders' ? 'conditional-orders' : 'orders', 'CLOSED', 'symbol=AAPL'],
        ...(command === 'orders' ? [[command, 'CLOSED', 'symbol=AAPL', 'from=2026-11-01']] : []),
      ]) {
        const changed = await runCli(f, [], [...args, ...continuation]);
        assert.equal(changed.status, 1, changed.stdout);
        assert.equal(JSON.parse(changed.stdout).error.code, 'INPUT_INVALID');
        assert.deepEqual(changed.requests, next.requests);
        assert.equal('accountAlias' in JSON.parse(changed.stdout).source, false);
      }
      await select(f, ['orders', 'conditional-orders'], 742);
      const changed = await runCli(f, [], [command, 'CLOSED', 'symbol=AAPL', ...continuation]);
      assert.equal(JSON.parse(changed.stdout).error.code, 'INPUT_INVALID');
      assert.deepEqual(changed.requests, next.requests);
    } finally {
      f.close();
    }
  }
});

test('OPEN regular orders return every row without a fabricated page or truncation', async () => {
  const f = fixture();
  try {
    await select(f);
    const r = await runCli(
      f,
      [
        accounts,
        page(
          'orders',
          Array.from({ length: 25 }, () => order),
        ),
      ],
      ['orders', 'OPEN'],
    );
    assert.equal(r.status, 0, r.stdout);
    assert.equal(JSON.parse(r.stdout).data.length, 25);
    assert.equal('page' in JSON.parse(r.stdout), false);
    for (const option of ['limit=20', 'cursor=next', `context=${'a'.repeat(64)}`]) {
      const bad = await runCli(f, [], ['orders', 'OPEN', option]);
      assert.equal(JSON.parse(bad.stdout).error.code, 'INPUT_INVALID');
    }
  } finally {
    f.close();
  }
});

test('orders distinguish optional null, omission, zero and malformed required fields', async () => {
  for (const [command, row] of [
    ['orders', order],
    ['conditional-orders', closedConditional],
  ]) {
    const f = fixture();
    try {
      await select(f);
      const minimal = structuredClone(row);
      if (command === 'orders') {
        delete minimal.price;
        delete minimal.orderAmount;
        delete minimal.canceledAt;
      } else {
        delete minimal.second;
      }
      const r = await runCli(
        f,
        [accounts, page(command, [minimal, { ...row, quantity: 0 }])],
        [command, 'CLOSED'],
      );
      assert.equal(r.status, 2, r.stdout);
      assert.deepEqual(JSON.parse(r.stdout).data, [minimal]);
      assert.deepEqual(JSON.parse(r.stdout).omissions, [{ index: 1, reason: 'invalid_item' }]);
      const invalid = [
        { ...row, quantity: null },
        ...(command === 'orders' ? [{ ...row, quantity: '1'.repeat(31) }] : []),
        { ...row, status: null },
        { ...row, [command === 'orders' ? 'execution' : 'first']: {} },
      ];
      for (const item of invalid) {
        const bad = await runCli(f, [accounts, page(command, [item])], [command, 'CLOSED']);
        assert.equal(JSON.parse(bad.stdout).error.code, 'RESPONSE_INVALID');
      }
    } finally {
      f.close();
    }
  }
});

test('order creation dates use KST and are separate from settlement dates', async () => {
  const f = fixture();
  try {
    await select(f);
    const r = await runCli(
      f,
      [
        accounts,
        page('orders', [
          {
            ...order,
            orderedAt: '2026-10-31T15:30:00Z',
            execution: { ...order.execution, settlementDate: '2026-11-05' },
          },
        ]),
      ],
      ['orders', 'CLOSED', 'from=2026-11-01', 'to=2026-11-01'],
    );
    assert.equal(r.status, 0, r.stdout);
    assert.equal(JSON.parse(r.stdout).data[0].execution.settlementDate, '2026-11-05');
    const bad = await runCli(
      f,
      [accounts, page('orders', [order])],
      ['orders', 'CLOSED', 'to=2026-10-31'],
    );
    assert.equal(JSON.parse(bad.stdout).error.code, 'RESPONSE_INVALID');
  } finally {
    f.close();
  }
});

test('invalid order arguments fail before authentication', async () => {
  const f = fixture();
  try {
    for (const args of [
      [],
      ['PENDING'],
      ['CLOSED', 'limit=0'],
      ['CLOSED', 'limit=101'],
      ['CLOSED', 'limit=1', 'limit=2'],
      ['CLOSED', 'symbol='],
      ['CLOSED', 'cursor=next'],
      ['CLOSED', 'from=2026-02-30'],
      ['CLOSED', 'from=2026-12-01', 'to=2026-11-01'],
      ['CLOSED', 'type=SINGLE'],
    ]) {
      const r = await runCli(f, [], ['orders', ...args]);
      assert.equal(JSON.parse(r.stdout).error.code, 'INPUT_INVALID', r.stdout);
      assert.deepEqual(r.requests, []);
    }
    for (const args of [
      ['OPEN', 'from=2026-11-01'],
      ['CLOSED', 'cursor=a=', `context=${'a'.repeat(64)}`],
    ]) {
      const r = await runCli(f, [], ['conditional-orders', ...args]);
      assert.equal(JSON.parse(r.stdout).error.code, 'INPUT_INVALID');
    }
  } finally {
    f.close();
  }
});

test('order access, provider errors and output masking do not become empty success', async () => {
  for (const command of ['orders', 'conditional-orders']) {
    const f = fixture();
    try {
      let r = await runCli(f, [], [command, 'OPEN']);
      assert.equal(JSON.parse(r.stdout).error.code, 'ACCOUNT_SELECTION_REQUIRED');
      await select(f, ['holdings']);
      r = await runCli(f, [], [command, 'OPEN']);
      assert.equal(JSON.parse(r.stdout).error.code, 'ACCOUNT_SCOPE_DENIED');
      await select(f);
      for (const [status, code, expected] of [
        [403, 'ip-not-allowed', 'PERMISSION_DENIED'],
        [401, 'invalid-token', 'AUTH_FAILED'],
        [404, 'not-found', 'NOT_FOUND'],
      ]) {
        r = await runCli(
          f,
          [
            accounts,
            {
              path: `/api/v1/${command}`,
              status,
              body: { error: { code, message: '99887766554' } },
            },
          ],
          [command, 'CLOSED'],
        );
        assert.equal(JSON.parse(r.stdout).error.code, expected, r.stdout);
        assert.doesNotMatch(r.stdout + r.stderr, /99887766554/);
      }
      const row = command === 'orders' ? order : closedConditional;
      r = await runCli(
        f,
        [accounts, page(command, [{ ...row, status: 'synthetic-token' }])],
        [command, 'CLOSED'],
      );
      assert.equal(r.status, 1, r.stdout);
      assert.equal(JSON.parse(r.stdout).error.code, 'SENSITIVE_OUTPUT');
      r = await runCli(
        f,
        [accounts, page(command, [{ ...row, accountNo: '99887766554', accountSeq: 741 }])],
        [command, 'CLOSED'],
      );
      assert.equal(r.status, 0, r.stdout);
      assert.doesNotMatch(r.stdout, /accountSeq|99887766554/);
      assert.ok(
        r.requests.every((request) => request.path === '/oauth2/token' || request.method === 'GET'),
      );
    } finally {
      f.close();
    }
  }
});

test('order pagination validates envelopes and preserves an unavailable optional conditional cursor', async () => {
  const f = fixture();
  try {
    await select(f);
    for (const command of ['orders', 'conditional-orders']) {
      const r = await runCli(f, [accounts, page(command, [])], [command, 'CLOSED']);
      assert.equal(r.status, 0, r.stdout);
      assert.deepEqual(JSON.parse(r.stdout).data, []);
      for (const extra of [{ hasNext: 'false' }, { nextCursor: 'orphan' }, { nextCursor: '' }]) {
        const bad = await runCli(f, [accounts, page(command, [], extra)], [command, 'CLOSED']);
        assert.equal(JSON.parse(bad.stdout).error.code, 'RESPONSE_INVALID');
      }
      const row = command === 'orders' ? order : closedConditional;
      const tooMany = await runCli(
        f,
        [accounts, page(command, [row, row])],
        [command, 'CLOSED', 'limit=1'],
      );
      assert.equal(JSON.parse(tooMany.stdout).error.code, 'RESPONSE_INVALID');
    }
    const missing = {
      path: '/api/v1/conditional-orders',
      body: { result: { conditionalOrders: [conditional], hasNext: true } },
    };
    const r = await runCli(f, [accounts, missing], ['conditional-orders', 'OPEN']);
    assert.equal(r.status, 2, r.stdout);
    assert.equal(JSON.parse(r.stdout).omissions.at(-1).reason, 'missing_next_cursor');
    const malformed = await runCli(
      f,
      [accounts, page('orders', [], { hasNext: true, nextCursor: 'next' })],
      ['orders', 'OPEN'],
    );
    assert.equal(JSON.parse(malformed.stdout).error.code, 'RESPONSE_INVALID');
  } finally {
    f.close();
  }
});

test('conditional decimal fields have no schema length cap while known lifecycle and leg contradictions fail', async () => {
  const f = fixture();
  try {
    await select(f);
    const long = {
      ...conditional,
      quantity: '1234567890123456789012345678901',
      first: {
        ...leg,
        triggerPrice: '1234567890123456789012345678901.50',
      },
    };
    let r = await runCli(
      f,
      [accounts, page('conditional-orders', [long])],
      ['conditional-orders', 'OPEN'],
    );
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(JSON.parse(r.stdout).data, [long]);
    for (const item of [
      conditional,
      { ...conditional, status: 'COMPLETED', type: 'OCO', second: null },
      { ...conditional, status: 'COMPLETED', type: 'OTO', second: { ...leg, type: 'PROFIT_RATE' } },
      { ...conditional, status: 'COMPLETED', second: leg },
    ]) {
      r = await runCli(
        f,
        [accounts, page('conditional-orders', [item])],
        ['conditional-orders', 'CLOSED'],
      );
      assert.equal(r.status, 1, r.stdout);
      assert.equal(JSON.parse(r.stdout).error.code, 'RESPONSE_INVALID', r.stdout);
    }
    r = await runCli(
      f,
      [accounts, page('orders', [{ ...order, status: 'FILLED' }])],
      ['orders', 'OPEN'],
    );
    assert.equal(r.status, 1, r.stdout);
    assert.equal(JSON.parse(r.stdout).error.code, 'RESPONSE_INVALID');
    r = await runCli(
      f,
      [accounts, page('conditional-orders', [], { hasNext: true, nextCursor: 'a=' })],
      ['conditional-orders', 'OPEN'],
    );
    assert.equal(r.status, 1, r.stdout);
    assert.equal(JSON.parse(r.stdout).error.code, 'RESPONSE_INVALID');
    r = await runCli(
      f,
      [accounts, page('orders', [], { hasNext: true, nextCursor: null })],
      ['orders', 'CLOSED'],
    );
    assert.equal(r.status, 1, r.stdout);
    assert.equal(JSON.parse(r.stdout).error.code, 'RESPONSE_INVALID');
  } finally {
    f.close();
  }
});

test('leg-only statuses cannot describe a conditional order group and future types retain their legs', async () => {
  const f = fixture();
  try {
    await select(f);
    for (const status of ['HOLDING', 'CANCELED']) {
      const r = await runCli(
        f,
        [accounts, page('conditional-orders', [{ ...conditional, status }])],
        ['conditional-orders', 'OPEN'],
      );
      assert.equal(r.status, 1, r.stdout);
      assert.equal(JSON.parse(r.stdout).error.code, 'RESPONSE_INVALID');
    }
    const future = { ...conditional, type: 'FUTURE', second: { ...leg, type: 'FUTURE_CONDITION' } };
    const r = await runCli(
      f,
      [accounts, page('conditional-orders', [future])],
      ['conditional-orders', 'OPEN'],
    );
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(JSON.parse(r.stdout).data, [future]);
  } finally {
    f.close();
  }
});
