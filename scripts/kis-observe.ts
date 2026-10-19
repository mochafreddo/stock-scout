import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceNames = ['kis-observe.ts', 'kis-probe.ts', 'kis-auth.ts'];
const childCodes = [
  'USAGE',
  'CREDENTIALS_MISSING',
  'AUTH_COOLDOWN',
  'AUTH_LOCKED',
  'AUTH_RECORD',
  'AUTH_STORAGE',
  'AUTH_FAILED',
  'HTTP_FAILURE',
  'KIS_FAILURE',
  'RESPONSE_SHAPE',
  'REQUEST_FAILED',
];
const wrapperCodes = [
  'USAGE',
  'OBSERVATION_STORAGE',
  'SOURCE_FAILED',
  'CHILD_TIMEOUT',
  'CHILD_FAILED',
  'CHILD_OUTPUT',
];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function containsCredential(value: string) {
  return [process.env.KIS_APP_KEY, process.env.KIS_APP_SECRET].some(
    (secret) => secret && value.includes(secret),
  );
}
function revision() {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
    env: { PATH: process.env.PATH },
  });
  const value = result.stdout?.trim();
  if (result.status !== 0 || !/^[a-f0-9]{40,64}$/.test(value)) throw new Error('SOURCE_FAILED');
  return value;
}
function sourceBytes(name: string) {
  const fd = openSync(join(root, 'scripts', name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('SOURCE_FAILED');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function secureDirectory(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== path
  )
    throw new Error('OBSERVATION_STORAGE');
}
function save(directory: string, name: string, bytes: Buffer | string) {
  secureDirectory(directory);
  const path = join(directory, name);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      const stat = fstatSync(fd);
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1)
        throw new Error('OBSERVATION_STORAGE');
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const directoryFd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch {
    unlinkSync(path);
    throw new Error('OBSERVATION_STORAGE');
  }
}

let directory: string | undefined;
let snapshot: string | undefined;
let receipt:
  | {
      schemaVersion: number;
      status: 'success' | 'failure';
      args: string[];
      startedAt: string;
      endedAt: string;
      child: { exitCode: number | null; signal: NodeJS.Signals | null };
      source: { revision: string; files: Record<string, string> };
      runtime: { node: string };
      response: { path: string; sha256: string } | null;
      error?: string;
    }
  | undefined;
try {
  const [target, kind, exchange, symbol = '', ...extra] = process.argv.slice(2);
  const needsSymbol = kind === 'daily' || kind === 'info';
  if (
    !target ||
    !['volume', 'amount', 'daily', 'info'].includes(kind ?? '') ||
    !['NAS', 'NYS', 'AMS'].includes(exchange ?? '') ||
    extra.length ||
    (needsSymbol ? !/^[A-Z0-9./^-]{1,20}$/.test(symbol) : symbol !== '')
  )
    throw new Error('USAGE');
  const args = [kind, exchange, ...(needsSymbol ? [symbol] : [])] as string[];
  if (containsCredential(JSON.stringify([resolve(target), ...args]))) throw new Error('USAGE');
  const startedAt = new Date().toISOString();
  let source: { revision: string; files: Record<string, string> };
  let bytes: Record<string, Buffer>;
  try {
    bytes = Object.fromEntries(sourceNames.map((name) => [name, sourceBytes(name)]));
    source = {
      revision: revision(),
      files: Object.fromEntries(sourceNames.map((name) => [`scripts/${name}`, hash(bytes[name])])),
    };
  } catch {
    throw new Error('SOURCE_FAILED');
  }
  receipt = {
    schemaVersion: 1,
    status: 'failure',
    args,
    startedAt,
    endedAt: startedAt,
    child: { exitCode: null, signal: null },
    source,
    runtime: { node: process.version },
    response: null,
  };
  try {
    const destination = resolve(target);
    if (realpathSync(dirname(destination)) !== dirname(destination))
      throw new Error('OBSERVATION_STORAGE');
    mkdirSync(destination, { mode: 0o700 });
    directory = destination;
    secureDirectory(directory);
    snapshot = mkdtempSync(join(directory, '.source-'));
    for (const name of ['kis-probe.ts', 'kis-auth.ts']) save(snapshot, name, bytes[name]);
  } catch {
    throw new Error('OBSERVATION_STORAGE');
  }
  const result = spawnSync(process.execPath, [join(snapshot, 'kis-probe.ts'), ...args], {
    encoding: 'utf8',
    timeout: 90_000,
    killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  receipt.child = { exitCode: result.status, signal: result.signal };
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT')
    throw new Error('CHILD_TIMEOUT');
  if (result.error || result.signal) throw new Error('CHILD_FAILED');
  if (result.status !== 0) {
    let code = 'CHILD_FAILED';
    try {
      const error = JSON.parse(result.stderr);
      if (childCodes.includes(error?.error)) code = error.error;
    } catch {}
    throw new Error(code);
  }
  try {
    const response = JSON.parse(result.stdout);
    if (
      result.stderr ||
      !response ||
      Array.isArray(response) ||
      response.validation !== 'unverified' ||
      response.dataSession !== null ||
      !Array.isArray(response.rows) ||
      containsCredential(result.stdout)
    )
      throw new Error();
  } catch {
    throw new Error('CHILD_OUTPUT');
  }
  if (
    revision() !== source.revision ||
    sourceNames.some((name) => hash(sourceBytes(name)) !== source.files[`scripts/${name}`])
  )
    throw new Error('SOURCE_FAILED');
  rmSync(snapshot, { recursive: true });
  snapshot = undefined;
  try {
    save(directory, 'response.json', result.stdout);
    receipt.response = { path: 'response.json', sha256: hash(Buffer.from(result.stdout)) };
    receipt.status = 'success';
    receipt.endedAt = new Date().toISOString();
    save(directory, 'receipt.json', `${JSON.stringify(receipt)}\n`);
  } catch {
    throw new Error('OBSERVATION_STORAGE');
  }
  console.log(
    JSON.stringify({
      receipt: join(directory, 'receipt.json'),
      response: join(directory, 'response.json'),
    }),
  );
} catch (error) {
  const code =
    error instanceof Error && [...wrapperCodes, ...childCodes].includes(error.message)
      ? error.message
      : 'CHILD_FAILED';
  let recorded: string | undefined;
  if (directory && receipt) {
    receipt.status = 'failure';
    receipt.error = code;
    receipt.response = null;
    receipt.endedAt = new Date().toISOString();
    try {
      save(directory, 'receipt.json', `${JSON.stringify(receipt)}\n`);
      recorded = join(directory, 'receipt.json');
    } catch {}
  }
  console.error(JSON.stringify({ error: code, receipt: recorded }));
  process.exitCode = 1;
} finally {
  if (snapshot) {
    try {
      rmSync(snapshot, { recursive: true });
    } catch {
      console.error(JSON.stringify({ error: 'OBSERVATION_STORAGE' }));
      process.exitCode = 1;
    }
  }
}
