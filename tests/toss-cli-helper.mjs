import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export function fixture(clientSecret = 'synthetic-secret') {
  const allocated = mkdtempSync(join(tmpdir(), 'stock-scout-toss-'));
  let cliTraceDirectory;
  const close = () => {
    try {
      rmSync(allocated, { recursive: true, force: true });
    } finally {
      if (cliTraceDirectory) rmSync(cliTraceDirectory, { recursive: true, force: true });
    }
  };
  try {
    const directory = realpathSync(allocated);
    writeFileSync(
      join(directory, 'credentials.json'),
      JSON.stringify({ clientId: 'synthetic-client', clientSecret }),
      { mode: 0o600 },
    );
    const trace = join(directory, 'trace.jsonl');
    writeFileSync(trace, '', { mode: 0o600 });
    cliTraceDirectory = mkdtempSync(join(tmpdir(), 'stock-scout-cli-trace-'));
    const cliTrace = join(realpathSync(cliTraceDirectory), 'argv.jsonl');
    writeFileSync(cliTrace, '', { mode: 0o600 });
    return { directory, trace, cliTrace, close };
  } catch (error) {
    close();
    throw error;
  }
}
export function authState(changes = {}) {
  return {
    fingerprint: createHash('sha256')
      .update(JSON.stringify(['synthetic-client', 'synthetic-secret']))
      .digest('hex'),
    version: 2,
    nextAt: null,
    clock: {
      id: 'darwin-mach-continuous:11111111-1111-4111-8111-111111111111',
      nextNs: '0'.repeat(30),
    },
    pending: false,
    token: { value: 'synthetic-token', expiresAt: Date.parse('2026-11-07T15:00:00Z') },
    ...changes,
  };
}
export function readRequests(trace) {
  return readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
export function snapshot(directory) {
  const stat = lstatSync(directory, { bigint: true });
  return {
    mode: stat.mode,
    uid: stat.uid,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    ...(stat.isDirectory()
      ? {
          entries: Object.fromEntries(
            readdirSync(directory)
              .sort()
              .map((name) => [name, snapshot(join(directory, name))]),
          ),
        }
      : stat.isSymbolicLink()
        ? { link: readlinkSync(directory) }
        : { content: readFileSync(directory) }),
  };
}
export function runCli(f, steps = [], args = ['prices', 'AAPL'], extra = {}) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      new URL('./toss-http-mock.mjs', import.meta.url).href,
      fileURLToPath(new URL('../scripts/toss.ts', import.meta.url)),
      ...args,
    ],
    {
      env: {
        PATH: process.env.PATH,
        TOSS_STATE_DIR: f.directory,
        TEST_STEPS: JSON.stringify(steps),
        TEST_TRACE: f.trace,
        TEST_CLI_TRACE: f.cliTrace,
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const result = new Promise((resolve, reject) => {
    let failure;
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const timer = setTimeout(() => {
      failure ??= new Error('CLI test timed out');
      child.kill('SIGKILL');
    }, 10000);
    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      try {
        const requests = readRequests(f.trace);
        if (failure) reject(failure);
        else resolve({ status, signal, stdout, stderr, requests });
      } catch (error) {
        reject(failure ?? error);
      }
    });
  });
  return Object.assign(result, { child });
}
export async function runFreshCli(steps, args, extra) {
  const f = fixture();
  try {
    const result = await runCli(f, steps, args, extra);
    return { ...result, out: JSON.parse(result.stdout) };
  } finally {
    f.close();
  }
}
export async function waitForFile(path, run, timeout = 5000) {
  let failure;
  run.then(
    (result) => {
      failure = new Error(`CLI exited before creating ${path}`, { cause: result });
    },
    (error) => {
      failure = error;
    },
  );
  const deadline = Date.now() + timeout;
  while (!existsSync(path)) {
    if (failure) throw failure;
    assert.ok(Date.now() < deadline, `CLI did not create ${path}`);
    await sleep(10);
  }
}
export async function closeRuns(f, runs, gates) {
  for (const gate of gates) writeFileSync(gate, '', { mode: 0o600 });
  for (const run of runs) run.child.kill('SIGKILL');
  await Promise.allSettled(runs);
  f.close();
}
export const price = {
  symbol: 'AAPL',
  lastPrice: '185.7000',
  currency: 'USD',
  timestamp: '2026-11-06T10:30:00-05:00',
};

let accountExecution = 0;
export function runAccountCli(f, steps, args) {
  return runCli(f, steps, args, {
    TEST_CLOCK_START: String(Date.parse('2026-11-06T15:00:00Z') + accountExecution++ * 60000),
  });
}

export const accounts = {
  path: '/api/v1/accounts',
  body: { result: [{ accountSeq: 741, accountNo: '99887766554', accountType: 'BROKERAGE' }] },
};
export function selectAccount(f, accountSeq, scopes) {
  const path = join(f.directory, 'selection-input.json');
  writeFileSync(path, JSON.stringify({ alias: 'primary', accountSeq, scopes }), { mode: 0o600 });
  return runAccountCli(f, [], ['account-select', path]);
}
