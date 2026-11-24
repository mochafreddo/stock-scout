import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';
import { record, symbolPattern } from './toss-values.ts';

const [launcher, port] = process.argv.slice(2);
if (
  process.argv.length !== 4 ||
  !isAbsolute(launcher) ||
  !/^\d+$/.test(port) ||
  Number(port) > 65535
)
  throw new Error('Expected an absolute approved launcher path and local port');

const protocol = '2025-11-25';
const prices = {
  name: 'prices',
  description:
    'Query symbol prices. Provider timestamps can be absent or null. retrievedAt is the CLI retrieval time.',
  inputSchema: {
    type: 'object',
    required: ['symbols'],
    additionalProperties: false,
    properties: {
      symbols: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: { type: 'string', pattern: symbolPattern.source, not: { pattern: '^-' } },
      },
      staleAfterSeconds: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    },
  },
  annotations: { readOnlyHint: true },
};

function priceArgs(params: unknown) {
  if (!record(params) || params.name !== prices.name || !record(params.arguments)) return;
  const args = params.arguments;
  const { symbols, staleAfterSeconds } = args;
  if (
    Object.keys(args).some((key) => key !== 'symbols' && key !== 'staleAfterSeconds') ||
    !Array.isArray(symbols) ||
    !symbols.length ||
    symbols.length > 200 ||
    !symbols.every(
      (symbol) =>
        typeof symbol === 'string' && !symbol.startsWith('-') && symbolPattern.test(symbol),
    ) ||
    (staleAfterSeconds !== undefined &&
      (typeof staleAfterSeconds !== 'number' ||
        !Number.isSafeInteger(staleAfterSeconds) ||
        staleAfterSeconds < 0))
  )
    return;
  return [
    'prices',
    symbols.join(','),
    ...(staleAfterSeconds === undefined ? [] : [`staleAfterSeconds=${staleAfterSeconds}`]),
  ];
}

async function execute(
  args: string[],
): Promise<{ exitCode: number; response: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    execFile(
      launcher,
      args,
      { encoding: 'utf8', timeout: 70000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        const exitCode = error ? error.code : 0;
        try {
          const response: unknown = JSON.parse(stdout);
          if (
            typeof exitCode !== 'number' ||
            !record(response) ||
            response.version !== 1 ||
            !Array.isArray(response.data) ||
            !['success', 'error', 'partial'][exitCode] ||
            response.status !== ['success', 'error', 'partial'][exitCode]
          )
            throw new Error();
          resolve({ exitCode, response });
        } catch {
          reject(new Error('CLI_RESULT_UNAVAILABLE'));
        }
      },
    );
  });
}

function toolResult(payload: object, isError: boolean) {
  return {
    isError,
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

async function query(args: string[]) {
  let stage = 'readiness';
  try {
    const ready = await execute(['readiness']);
    const rows = ready.response.data;
    if (ready.exitCode !== 0) return toolResult({ stage, ...ready }, true);
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.readiness !== 'ready')
      throw new Error('Invalid readiness result');
    stage = 'query';
    const output = await execute(args);
    return toolResult({ stage, ...output }, output.exitCode === 1);
  } catch {
    return toolResult({ stage, error: { code: 'CLI_RESULT_UNAVAILABLE' } }, true);
  }
}

const server = createServer({ requestTimeout: 10000 }, async (req, res) => {
  const host = `127.0.0.1:${req.socket.localPort}`;
  if (
    req.headers.host !== host ||
    (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)
  )
    return res.writeHead(403).end();
  if (req.url !== '/mcp') return res.writeHead(404).end();
  if (req.method !== 'POST') return res.writeHead(405, { Allow: 'POST' }).end();
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    return res.writeHead(415).end();
  let id: unknown = null;
  const reply = (body: object, status = 200) =>
    res
      .writeHead(status, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
  const fail = (code: number, message: string, status?: number) =>
    reply({ error: { code, message } }, status);
  const version = req.headers['mcp-protocol-version'];
  if (version !== undefined && version !== protocol && version !== '2025-06-18')
    return fail(-32600, 'Unsupported protocol version', 400);
  let rpc: unknown;
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      length += chunk.length;
      if (length > 65536) {
        req.resume();
        return res.writeHead(413).end();
      }
      chunks.push(chunk);
    }
    rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return fail(-32700, 'Parse error', 400);
  }
  if (!record(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string')
    return fail(-32600, 'Invalid request', 400);
  if (!Object.hasOwn(rpc, 'id')) return res.writeHead(202).end();
  if (typeof rpc.id !== 'string' && !Number.isSafeInteger(rpc.id))
    return fail(-32600, 'Invalid request ID', 400);
  id = rpc.id;
  switch (rpc.method) {
    case 'initialize':
      return reply({
        result: {
          protocolVersion:
            record(rpc.params) && rpc.params.protocolVersion === '2025-06-18'
              ? '2025-06-18'
              : protocol,
          capabilities: { tools: {} },
          serverInfo: { name: 'stock-scout', version: '1' },
        },
      });
    case 'ping':
      return reply({ result: {} });
    case 'tools/list':
      return reply({ result: { tools: [prices] } });
    case 'tools/call': {
      const args = priceArgs(rpc.params);
      if (!args) return fail(-32602, 'Unknown tool or invalid arguments');
      return reply({ result: await query(args) });
    }
    default:
      return fail(-32601, 'Method not found');
  }
});

server.listen(Number(port), '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address === 'object') console.log(`http://127.0.0.1:${address.port}/mcp`);
});
