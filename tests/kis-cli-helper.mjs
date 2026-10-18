import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const now = Date.parse('2026-10-18T00:00:00Z');
export function fixture(record = true) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stock-scout-auth-')));
  const cache = join(home, 'Library/Caches/stock-scout');
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  if (record)
    writeFileSync(
      join(cache, 'issuance.json'),
      JSON.stringify({ kind: 'attempt', at: now - 300_000 }),
      { mode: 0o600 },
    );
  return { home, cache, close: () => rmSync(home, { recursive: true, force: true }) };
}
export function runCli(f, scenario = 'ok', args = ['volume', 'NAS'], env = {}) {
  const trace = join(f.home, 'requests');
  writeFileSync(trace, '', { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      new URL('./kis-http-mock.mjs', import.meta.url).pathname,
      new URL('../scripts/kis-probe.ts', import.meta.url).pathname,
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        HOME: f.home,
        KIS_APP_KEY: 'test-key',
        KIS_APP_SECRET: 'test-secret',
        SCENARIO: scenario,
        TEST_NOW: String(now),
        TEST_TRACE: trace,
        ...env,
      },
    },
  );
  return {
    ...result,
    requests: existsSync(trace)
      ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean)
      : [],
  };
}
