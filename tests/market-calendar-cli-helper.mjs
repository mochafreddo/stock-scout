import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function runCalendar(args = [], env = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stock-scout-calendar-'));
  const trace = join(directory, 'trace');
  writeFileSync(trace, '', { mode: 0o600 });
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        new URL('./market-calendar-http-mock.mjs', import.meta.url).pathname,
        new URL('../scripts/market-calendar.ts', import.meta.url).pathname,
        ...args,
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: { PATH: process.env.PATH, HOME: directory, TEST_TRACE: trace, ...env },
      },
    );
    return {
      ...result,
      requests: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
