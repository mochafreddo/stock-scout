import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeSiwcFixture } from './siwc-fixture.mjs';

export function runCalendar(args = [], env = {}, includeRequiredArgs = true) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'stock-scout-calendar-')));
  const auth = join(directory, 'siwc');
  writeSiwcFixture(auth, Date.parse(env.AUTH_EXPIRES || '2030-01-01T00:00:00Z'));
  const trace = join(directory, 'trace');
  writeFileSync(trace, '', { mode: 0o600 });
  const streamTrace = join(directory, 'stream-trace');
  writeFileSync(streamTrace, '', { mode: 0o600 });
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        new URL('./market-calendar-http-mock.mjs', import.meta.url).pathname,
        new URL('../scripts/market-calendar.ts', import.meta.url).pathname,
        ...(includeRequiredArgs
          ? ['--auth-dir', auth, '--model', env.TEST_MODEL || 'gpt-6-luna']
          : []),
        ...args,
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          TEST_TRACE: trace,
          TEST_STREAM_TRACE: streamTrace,
          ...env,
        },
      },
    );
    return {
      ...result,
      requests: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
      auth: {
        locked: existsSync(join(auth, '.login.lock')),
        expiresAt: JSON.parse(readFileSync(join(auth, 'credentials.json'), 'utf8')).expiresAt,
      },
      streamEvents: readFileSync(streamTrace, 'utf8').trim().split('\n').filter(Boolean),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
