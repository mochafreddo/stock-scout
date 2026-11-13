import assert from 'node:assert/strict';
import { accounts, fixture, runAccountCli, runCli, selectAccount } from './toss-cli-helper.mjs';

const [scenario, ...args] = process.argv.slice(2);
console.error('SYNTHETIC: isolated state and mocked HTTP; no live Toss data.');
const accountCommand = [
  'holdings',
  'buying-power',
  'transactions',
  'orders',
  'conditional-orders',
].includes(args[0]);
const paginated =
  args[0] === 'candles' ||
  args[0] === 'candles-batch' ||
  args[0] === 'transactions' ||
  args[0] === 'conditional-orders' ||
  (args[0] === 'orders' && args[1] === 'CLOSED');
if (
  !['success', 'partial', 'error'].includes(scenario) ||
  (!accountCommand &&
    ![
      '--help',
      'prices',
      'rankings',
      'tradable',
      'candles',
      'candles-batch',
      'stock',
      'orderbook',
      'trades',
      'sessions',
      'constraints',
    ].includes(args[0])) ||
  (args[0] === 'candles' && args[2] !== '1d' && scenario !== 'partial') ||
  (scenario === 'partial' && !paginated) ||
  (args[0] === '--help' && scenario !== 'success')
) {
  console.error(
    'Use success with --help; success|error with query commands; partial with candles, candles-batch or paginated account queries. Minute candles require partial.',
  );
  process.exit(1);
}
process.umask(0o077);
const f = fixture();
try {
  const listed = {
    symbol: 'DEMO',
    name: 'Synthetic Demo',
    securityType: 'STOCK',
    isCommonShare: true,
    isinCode: '',
  };
  const boundary = '2026-11-06T09:31:00.123+09:00';
  const dailyCandles = [
    {
      timestamp: '2026-11-04T23:00:00-06:00',
      openPrice: '10',
      highPrice: '13',
      lowPrice: '9',
      closePrice: '12.50',
      volume: '200',
      currency: 'USD',
    },
    {
      timestamp: '2026-11-03T23:00:00-06:00',
      openPrice: '9',
      highPrice: '11',
      lowPrice: '8',
      closePrice: '10.00',
      volume: '100',
      currency: 'USD',
    },
  ];
  const transaction = {
    transactionType: 'BUY',
    marketCountry: 'US',
    currency: 'USD',
    symbol: 'DEMO',
    assetClass: 'STOCK',
    isinCode: 'US0000000002',
    quantity: '0.123456789012345678',
    filledPrice: null,
    amount: '23.450000',
    commission: '0.01',
    tax: '0',
    netAmount: '23.469999',
    exchangeRate: null,
    settlementDate: '2026-11-10',
    settled: false,
    transactionTime: null,
    isCancellation: false,
  };
  const holding = {
    symbol: 'DEMO',
    name: 'Synthetic Demo',
    marketCountry: 'US',
    currency: 'USD',
    quantity: '0.1250',
    lastPrice: '200.00',
    averagePurchasePrice: '180.0000',
    marketValue: { purchaseAmount: '22.5000', amount: '25.00', amountAfterCost: '24.90' },
    profitLoss: {
      amount: '2.50',
      amountAfterCost: '2.40',
      rate: '0.1111',
      rateAfterCost: '0.1066',
    },
    dailyProfitLoss: { amount: '-0.25', rate: '-0.01' },
    cost: { commission: '0', tax: null },
  };
  const order = {
    orderId: 'synthetic-order',
    symbol: 'DEMO',
    side: 'BUY',
    orderType: 'MARKET',
    timeInForce: 'DAY',
    status: args[1] === 'OPEN' ? 'PENDING' : 'CANCELED',
    quantity: '0.1250',
    currency: 'USD',
    orderedAt: '2026-11-06T00:30:00+09:00',
    execution: {
      filledQuantity: '0',
      averageFilledPrice: null,
      filledAmount: null,
      commission: null,
      tax: null,
      filledAt: null,
      settlementDate: null,
    },
  };
  const conditional = {
    conditionalOrderId: 'synthetic-condition',
    type: 'SINGLE',
    status: args[1] === 'OPEN' ? 'WATCHING' : 'COMPLETED',
    symbol: 'DEMO',
    market: 'US',
    quantity: '0.1250',
    orderType: 'MARKET',
    createdAt: '2026-11-06T00:30:00+09:00',
    first: {
      type: 'STOP',
      status: args[1] === 'OPEN' ? 'WATCHING' : 'COMPLETED',
      orderSide: 'SELL',
      triggerPrice: '180.50',
    },
  };
  const next = scenario === 'partial' && !args.includes('cursor=synthetic_next');
  const accountPage = (key, row) => ({
    [key]: next ? [] : [row],
    hasNext: next,
    nextCursor: next ? 'synthetic_next' : null,
  });
  const closedDay = (date) => ({
    date,
    dayMarket: null,
    preMarket: null,
    regularMarket: null,
    afterMarket: null,
  });
  const calendar = {
    today: {
      ...closedDay('2026-11-06'),
      regularMarket: {
        startTime: '2026-11-06T23:30:00+09:00',
        endTime: '2026-11-07T06:00:00+09:00',
      },
    },
    previousBusinessDay: closedDay('2026-11-05'),
    nextBusinessDay: closedDay('2026-11-09'),
  };
  const responses = {
    stock: {
      path: '/api/v1/stocks',
      result: [
        {
          ...listed,
          market: 'NASDAQ',
          status: 'ACTIVE',
          englishName: 'Synthetic Demo',
          currency: 'USD',
          sharesOutstanding: '100',
        },
      ],
    },
    orderbook: {
      path: '/api/v1/orderbook',
      result: {
        currency: 'USD',
        timestamp: null,
        asks: [{ price: '10.0200', volume: '0.1250' }],
        bids: [{ price: '10.0100', volume: '0' }],
      },
    },
    trades: {
      path: '/api/v1/trades',
      result: [
        {
          price: '10.0100',
          volume: '0.0125',
          currency: 'USD',
          timestamp: '2026-11-06T10:30:42-05:00',
        },
      ],
    },
    sessions: { path: '/api/v1/market-calendar/US', result: calendar },
    constraints: { path: '/api/v1/market-calendar/US', result: calendar },
    holdings: {
      path: '/api/v1/holdings',
      result: {
        totalPurchaseAmount: { krw: '0', usd: '22.5000' },
        marketValue: {
          amount: { krw: '0', usd: '25.00' },
          amountAfterCost: { krw: '0', usd: '24.90' },
        },
        profitLoss: {
          amount: { krw: '0', usd: '2.50' },
          amountAfterCost: { krw: '0', usd: '2.40' },
          rate: '0.1111',
          rateAfterCost: '0.1066',
        },
        dailyProfitLoss: { amount: { krw: '0', usd: '-0.25' }, rate: '-0.01' },
        items: [holding],
      },
    },
    'buying-power': {
      path: '/api/v1/buying-power',
      result: {
        currency: args[1],
        cashBuyingPower: args[1] === 'KRW' ? '3500' : '3500.5000',
      },
    },
    transactions: {
      path: '/api/v1/transactions',
      result: accountPage('transactions', transaction),
    },
    orders: { path: '/api/v1/orders', result: accountPage('orders', order) },
    'conditional-orders': {
      path: '/api/v1/conditional-orders',
      result: accountPage('conditionalOrders', conditional),
    },
    prices: {
      path: '/api/v1/prices',
      result: [{ symbol: 'DEMO', lastPrice: '10.0100', currency: 'USD', timestamp: null }],
    },
    rankings: {
      path: '/api/v1/rankings',
      result: {
        rankedAt: '2026-11-06T15:00:00Z',
        rankings: [
          {
            rank: 1,
            symbol: 'DEMO',
            currency: 'USD',
            price: { lastPrice: '10.0100', basePrice: '10', changeRate: '0.001' },
            tradingVolume: '100',
            tradingAmount: '1001.00',
          },
        ],
      },
    },
    tradable: { path: '/api/v1/stocks/all', result: [listed] },
    candles: {
      path: '/api/v1/candles',
      result:
        args[2] === '1d'
          ? {
              candles: dailyCandles,
              nextBefore: scenario === 'partial' ? '2026-11-03T14:00:00+09:00' : null,
            }
          : args.includes(`before=${boundary}`)
            ? {
                candles: [
                  {
                    timestamp: boundary,
                    openPrice: '10',
                    highPrice: '11',
                    lowPrice: '9',
                    closePrice: '10.0100',
                    volume: '0',
                    currency: 'USD',
                  },
                ],
                nextBefore: null,
              }
            : { candles: [], nextBefore: boundary },
    },
  };
  const selected = responses[args[0]];
  const batchSteps = [];
  if (args[0] === 'candles-batch') {
    for (const symbol of (args[1] ?? '').split(',')) {
      if (args.some((arg) => arg.startsWith('date='))) {
        batchSteps.push({
          path: '/api/v1/stocks',
          body: { result: [{ ...responses.stock.result[0], symbol }] },
        });
      }
      if (scenario === 'error' || (scenario === 'partial' && symbol === 'DENIED')) {
        batchSteps.push({
          path: '/api/v1/candles',
          status: 403,
          body: { error: { code: 'ip-not-allowed', requestId: 'SYNTHETIC_308' } },
        });
        break;
      }
      const partial = scenario === 'partial';
      const candles = symbol === 'EMPTY' ? [] : dailyCandles;
      batchSteps.push({
        path: '/api/v1/candles',
        body: {
          result: {
            candles:
              partial && symbol === 'INVALID' ? [...candles, { timestamp: 'invalid' }] : candles,
            ...(partial && symbol === 'INVALID'
              ? {}
              : {
                  nextBefore:
                    partial && ['PARTIAL', 'EMPTY'].includes(symbol)
                      ? '2026-11-02T23:00:00-06:00'
                      : null,
                }),
          },
        },
      });
    }
  }
  if (accountCommand) {
    const selection = await selectAccount(f, 741, [args[0]]);
    assert.equal(selection.status, 0, selection.stdout);
  }
  const result = await (accountCommand ? runAccountCli : runCli)(
    f,
    args[0] === 'candles-batch'
      ? batchSteps
      : selected
        ? [
            ...(accountCommand ? [accounts] : []),
            ...(args[0] === 'candles' && args.some((arg) => arg.startsWith('date='))
              ? [{ path: responses.stock.path, body: { result: responses.stock.result } }]
              : []),
            {
              path: selected.path,
              ...(scenario === 'error'
                ? {
                    status: 403,
                    body: { error: { code: 'ip-not-allowed', requestId: 'SYNTHETIC_295' } },
                  }
                : { body: { result: selected.result } }),
            },
          ]
        : [],
    args,
  );
  if (accountCommand && (result.status === 0 || result.status === 2)) {
    const request = result.requests.at(-1);
    assert.equal(request.account, '741');
    assert.equal(request.path, selected.path);
    assert.equal(
      new URLSearchParams(request.query).get('cursor'),
      args.find((arg) => arg.startsWith('cursor='))?.slice(7) ?? null,
    );
  }
  if (
    args[0] === 'candles' &&
    !args.some((arg) => arg.startsWith('date=')) &&
    (result.status === 0 || result.status === 2)
  ) {
    const request = result.requests.at(-1);
    assert.equal(request.path, '/api/v1/candles');
    const query = new URLSearchParams(request.query);
    assert.equal(
      query.get('before'),
      args.find((arg) => arg.startsWith('before='))?.slice(7) ?? null,
    );
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} finally {
  f.close();
}
