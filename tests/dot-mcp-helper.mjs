import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

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
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill();
    await closed;
  });
  const [url] = await Promise.race([
    once(createInterface({ input: child.stdout }), 'line'),
    closed.then(([code]) => {
      throw Error(`server exited ${code}`);
    }),
  ]);
  return url;
}
