import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function fixture(clientSecret = 'synthetic-secret') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'stock-scout-toss-')));
  writeFileSync(
    join(directory, 'credentials.json'),
    JSON.stringify({ clientId: 'synthetic-client', clientSecret }),
    { mode: 0o600 },
  );
  const trace = join(directory, 'trace.jsonl');
  writeFileSync(trace, '', { mode: 0o600 });
  return { directory, trace, close: () => rmSync(directory, { recursive: true, force: true }) };
}
export function readRequests(trace) {
  return readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
export function runCli(f, steps = [], args = ['prices', 'AAPL'], extra = {}) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      new URL('./toss-http-mock.mjs', import.meta.url).pathname,
      new URL('../scripts/toss.ts', import.meta.url).pathname,
      ...args,
    ],
    {
      env: {
        PATH: process.env.PATH,
        TOSS_STATE_DIR: f.directory,
        TEST_STEPS: JSON.stringify(steps),
        TEST_TRACE: f.trace,
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const result = new Promise((resolve, reject) => {
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CLI test timed out'));
    }, 10000);
    child.once('error', reject);
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout,
        stderr,
        requests: readRequests(f.trace),
      });
    });
  });
  return Object.assign(result, { child });
}
export const price = {
  symbol: 'AAPL',
  lastPrice: '185.7000',
  currency: 'USD',
  timestamp: '2026-11-06T10:30:00-05:00',
};
