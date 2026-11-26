import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { marketArgs, marketTools } from './dot-mcp-tools.ts';
import type { DotWindow } from './dot-mcp-window.ts';
import { record } from './toss-values.ts';

const protocol = '2025-11-25';

async function handle(req: IncomingMessage, res: ServerResponse, window: DotWindow) {
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
      return reply({ result: { tools: marketTools } });
    case 'tools/call': {
      const args = marketArgs(rpc.params);
      if (!args) return fail(-32602, 'Unknown tool or invalid arguments');
      const { payload, isError, text } = await window.query(args, () => !res.destroyed);
      if (res.destroyed) return;
      return reply({
        result: { isError, structuredContent: payload, content: [{ type: 'text', text }] },
      });
    }
    default:
      return fail(-32601, 'Method not found');
  }
}

export function createDotServer(window: DotWindow) {
  return createServer({ requestTimeout: 10000 }, (req, res) => handle(req, res, window));
}
