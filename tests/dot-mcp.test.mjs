import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { authState, fixture, readRequests } from './toss-cli-helper.mjs';

async function start(t, { steps = [], state = authState() } = {}) {
  const f = fixture();
  t.after(f.close);
  const launcher = join(dirname(f.cliTrace), 'approved launcher');
  writeFileSync(launcher, '#!/bin/sh\nexec "$TEST_NODE" --import "$TEST_MOCK" "$TEST_CLI" "$@"\n', {
    mode: 0o700,
  });
  writeFileSync(join(f.directory, 'state.json'), JSON.stringify(state), { mode: 0o600 });
  const child = spawn(process.execPath, ['scripts/dot-mcp.ts', launcher, '0'], {
    env: {
      PATH: process.env.PATH,
      TEST_NODE: process.execPath,
      TEST_MOCK: new URL('./toss-http-mock.mjs', import.meta.url).href,
      TEST_CLI: fileURLToPath(new URL('../scripts/toss.ts', import.meta.url)),
      TEST_PLATFORM: 'darwin',
      TOSS_STATE_DIR: f.directory,
      TEST_TRACE: f.trace,
      TEST_CLI_TRACE: f.cliTrace,
      TEST_STEPS: JSON.stringify(steps),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill();
    await closed;
  });
  const lines = createInterface({ input: child.stdout });
  const [url] = await Promise.race([
    once(lines, 'line'),
    closed.then(([code]) => {
      throw Error(`server exited ${code}`);
    }),
  ]);
  const post = (rpc, headers) =>
    new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8').on('data', (chunk) => {
            body += chunk;
          });
          res.on('error', reject).on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on('error', reject).end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...rpc }));
    });
  const rpc = async (method, params) => JSON.parse((await post({ method, params })).body);
  const call = async (args, name = 'prices') => rpc('tools/call', { name, arguments: args });
  return { f, post, rpc, call };
}

test('prices forwards structured arguments and preserves decimal strings, absent and null provider times', async (t) => {
  const { f, call, rpc } = await start(t, {
    steps: [
      {
        path: '/api/v1/prices',
        body: {
          result: [
            { symbol: 'DEMO', currency: 'USD', lastPrice: '12.3400' },
            { symbol: 'NEXT', currency: 'USD', lastPrice: '0.0100', timestamp: null },
          ],
        },
      },
    ],
  });
  const init = await rpc('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  const listed = await rpc('tools/list');
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ['prices', 'rankings', 'stock', 'candles', 'sessions'],
  );
  const { result } = await call({ symbols: ['DEMO', 'NEXT'], staleAfterSeconds: 60 });
  assert.deepEqual(readRequests(f.cliTrace), [
    ['readiness'],
    ['prices', 'DEMO,NEXT', 'staleAfterSeconds=60'],
  ]);
  const { response, stage, exitCode } = result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.deepEqual([stage, exitCode, response.status], ['query', 0, 'success']);
  assert.equal(response.retrievedAt, '2026-11-06T15:00:00.000Z');
  assert.deepEqual(
    response.data.map(({ symbol, lastPrice, currency }) => [symbol, lastPrice, currency]),
    [
      ['DEMO', '12.3400', 'USD'],
      ['NEXT', '0.0100', 'USD'],
    ],
  );
  assert.equal(Object.hasOwn(response.data[0], 'timestamp'), false);
  assert.equal(response.data[1].timestamp, null);
});

test('blocked readiness returns its CLI reason and starts no market lookup', async (t) => {
  const { f, call } = await start(t, {
    state: authState({ version: undefined, clock: undefined, nextAt: 0 }),
  });
  const { result } = await call({ symbols: ['DEMO'] });
  assert.deepEqual(readRequests(f.cliTrace), [['readiness']]);
  assert.deepEqual(readRequests(f.trace), []);
  assert.equal(result.isError, true);
  const { stage, exitCode, response } = result.structuredContent;
  assert.deepEqual(
    [stage, exitCode, response.status, response.data[0].readiness],
    ['readiness', 1, 'error', 'blocked'],
  );
  assert.equal(response.error.code, 'AUTH_STATE_TRANSITION_REQUIRED');
});

test('only same-host JSON MCP requests and allowed structured market arguments reach the launcher', async (t) => {
  const { f, call, post } = await start(t);
  const rpc = {
    method: 'tools/call',
    params: { name: 'prices', arguments: { symbols: ['DEMO'] } },
  };
  for (const headers of [
    { origin: 'https://outside.invalid' },
    { origin: 'null' },
    { host: 'outside.invalid' },
  ])
    assert.equal((await post(rpc, headers)).status, 403);
  assert.equal((await post(rpc, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(rpc, { 'mcp-protocol-version': 'unknown' })).status, 400);
  for (const [name, args] of [
    ['holdings', {}],
    ['prices', { symbols: ['DEMO'], command: 'accounts' }],
    ['prices', { symbols: ['DEMO,OTHER'] }],
    ['prices', { symbols: ['DEMO;'] }],
    ['prices', { symbols: ['--help'] }],
    ['prices', { symbols: ['DEMO'], staleAfterSeconds: '10' }],
    ['prices', { symbols: [] }],
    ['prices', { symbols: Array(201).fill('DEMO') }],
  ])
    assert.equal((await call(args, name)).error.code, -32602);
  assert.deepEqual(readRequests(f.cliTrace), []);
});

test('partial and provider error results keep their original CLI exits and safe details', async (t) => {
  const partial = await start(t, {
    steps: [{ body: { result: [{ symbol: 'DEMO', currency: 'USD', lastPrice: '12.000' }] } }],
  });
  const p = (await partial.call({ symbols: ['DEMO', 'NEXT'] })).result.structuredContent;
  assert.deepEqual([p.stage, p.exitCode, p.response.status], ['query', 2, 'partial']);
  assert.deepEqual(p.response.omissions, [{ symbol: 'NEXT', reason: 'missing_item' }]);
  assert.equal(p.response.data[0].lastPrice, '12.000');
  const failed = await start(t, {
    steps: [
      {
        status: 403,
        body: {
          error: {
            code: 'ip-not-allowed',
            requestId: 'SYNTHETIC_357',
            message: 'private upstream synthetic-secret',
          },
        },
      },
    ],
  });
  const { result } = await failed.call({ symbols: ['DEMO'] });
  const { stage, exitCode, response } = result.structuredContent;
  assert.deepEqual(
    [result.isError, stage, exitCode, response.status, response.data],
    [true, 'query', 1, 'error', []],
  );
  assert.equal(response.error.requestId, 'SYNTHETIC_357');
  assert.doesNotMatch(JSON.stringify(result), /private upstream|synthetic-secret/);
});

test('an unreadable launcher result returns only safe uncertainty and keeps the server available', async (t) => {
  const { f, call, rpc } = await start(t);
  writeFileSync(
    join(dirname(f.cliTrace), 'approved launcher'),
    '#!/bin/sh\necho private-diagnostic >&2\necho non-json-private-output\n',
  );
  const { result } = await call({ symbols: ['DEMO'] });
  assert.deepEqual(result.structuredContent, {
    stage: 'readiness',
    error: { code: 'CLI_RESULT_UNAVAILABLE' },
  });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.deepEqual((await rpc('ping')).result, {});
});
