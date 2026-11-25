import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createDotServer } from './dot-mcp.ts';
import { DotWindow } from './dot-mcp-window.ts';

type Options = {
  launcher: string;
  port: number;
  state: string;
  tunnel: string;
  now?: () => number;
  log?: (entry: Record<string, string>) => void;
};

export async function runScheduledDot(options: Options) {
  const { now = Date.now, log = (entry) => console.log(JSON.stringify(entry)) } = options;
  const time = now();
  const session = new Date(time + 9 * 3600000).toISOString().slice(0, 10);
  const start = Date.parse(`${session}T20:55:00+09:00`);
  const end = Date.parse(`${session}T21:20:00+09:00`);
  const report = (status: string, code?: string) =>
    log({ session, time: new Date(now()).toISOString(), status, ...(code && { code }) });
  const isOpen = () => {
    const at = now();
    return at >= start && at < end;
  };
  if (!isOpen()) {
    report('skipped', 'WINDOW_CLOSED');
    return;
  }
  try {
    mkdirSync(options.state, { recursive: true, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const state = lstatSync(options.state);
  if (!state.isDirectory() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) {
    report('error', 'SESSION_STORAGE_UNSAFE');
    return;
  }
  try {
    mkdirSync(join(options.state, session), { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    report('skipped', 'SESSION_CLAIMED');
    return;
  }
  const window = new DotWindow(options.launcher, isOpen, report);
  const server = createDotServer(window);
  server.listen(options.port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('LISTEN_FAILED');
  if (!isOpen()) {
    server.close();
    report('skipped', 'WINDOW_CLOSED');
    return;
  }
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const tunnel = spawn(options.tunnel, [url], { stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = new Promise<void>((resolve) => tunnel.once('close', () => resolve()));
  try {
    await once(tunnel, 'spawn');
  } catch {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await exited;
    report('error', 'TUNNEL_START_FAILED');
    return;
  }
  const finished = Promise.withResolvers<void>();
  let stopping = false;
  const stop = async (code?: string) => {
    if (stopping) return finished.promise;
    stopping = true;
    const pending = window.close();
    clearInterval(timer);
    await Promise.all([pending, new Promise<void>((resolve) => server.close(() => resolve()))]);
    tunnel.kill();
    const force = setTimeout(() => tunnel.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(force);
    report('closed', code);
    finished.resolve();
  };
  const timer = setInterval(() => {
    if (!isOpen()) void stop('WINDOW_CLOSED');
  }, 1000);
  void exited.then(() => stop('TUNNEL_EXIT'));
  report('started');
  return { url, done: finished.promise, stop };
}

if (import.meta.main) {
  const [launcher, tunnel, state, port] = process.argv.slice(2);
  if (
    process.argv.length !== 6 ||
    ![launcher, tunnel, state].every((path) => isAbsolute(path)) ||
    !/^\d+$/.test(port) ||
    Number(port) > 65535
  ) {
    process.exitCode = 1;
  } else {
    try {
      const run = await runScheduledDot({
        launcher,
        tunnel,
        state,
        port: Number(port),
        log(entry) {
          console.log(JSON.stringify(entry));
          if (entry.status === 'error') process.exitCode = 1;
        },
      });
      if (run) {
        process.once('SIGTERM', () => void run.stop());
        process.once('SIGINT', () => void run.stop());
        await run.done;
      }
    } catch {
      console.error(
        JSON.stringify({ time: new Date().toISOString(), status: 'error', code: 'START_FAILED' }),
      );
      process.exitCode = 1;
    }
  }
}
