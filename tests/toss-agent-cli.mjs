import assert from 'node:assert/strict';
import { fixture, runCli } from './toss-cli-helper.mjs';

const [scenario, ...args] = process.argv.slice(2);
console.error('SYNTHETIC: isolated state and mocked HTTP; no live Toss data.');
if (
  !['success', 'partial', 'error'].includes(scenario) ||
  !['--help', 'prices', 'rankings', 'tradable', 'candles'].includes(args[0]) ||
  (args[0] === 'candles' ? scenario !== 'partial' : scenario === 'partial') ||
  (args[0] === '--help' && scenario !== 'success')
) {
  console.error(
    'Use success with --help; success|error with prices/rankings/tradable; partial with candles.',
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
  const responses = {
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
      result: args.includes(`before=${boundary}`)
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
  const result = await runCli(
    f,
    selected
      ? [
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
  if (args[0] === 'candles' && (result.status === 0 || result.status === 2)) {
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
