import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

export async function startScheduledTestServer(t, dir, launcher, env) {
  const tunnel = join(dir, 'test-tunnel');
  writeFileSync(tunnel, '#!/bin/sh\nread hold\n', { mode: 0o700 });
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
import { runScheduledDot } from './scripts/run-dot-mcp.ts';
const [launcher, tunnel, state] = process.argv.slice(1);
const run = await runScheduledDot({
  launcher, tunnel, state, port: 0,
  now: () => Date.parse('2026-11-24T12:00:00Z'),
  log() {},
});
process.once('SIGTERM', () => void run.stop());
console.log(run.url);
await run.done;
`,
      launcher,
      tunnel,
      join(dir, 'dot-claims'),
    ],
    { env, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit');
  t.after(async () => {
    try {
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        if (!child.kill(signal)) return;
        if (await Promise.race([exited, delay(1000, false, { ref: false })])) return;
      }
      child.unref();
      throw Error('test server did not exit after SIGKILL');
    } finally {
      child.stdout.destroy();
    }
  });
  const lines = createInterface({ input: child.stdout });
  let timer;
  try {
    const [url] = await Promise.race([
      once(lines, 'line'),
      exited.then(([code, signal]) => {
        throw Error(`server exited ${code ?? signal}`);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('timed out waiting for server URL')), 5000);
      }),
    ]);
    return url;
  } finally {
    clearTimeout(timer);
    lines.close();
  }
}
