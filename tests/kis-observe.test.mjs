import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from './kis-cli-helper.mjs';

const source = new URL('../', import.meta.url);
const files = [
  'kis-observe.ts',
  'kis-probe.ts',
  'kis-query.ts',
  'kis-auth.ts',
  'candidate-runtime.ts',
  'execution-observation.ts',
];
const digest = (value) => createHash('sha256').update(value).digest('hex');
function setup(t) {
  const f = fixture();
  t.after(f.close);
  const root = join(f.home, 'source');
  mkdirSync(join(root, 'scripts'), { recursive: true, mode: 0o700 });
  for (const name of files)
    if (existsSync(new URL(`scripts/${name}`, source)))
      copyFileSync(new URL(`scripts/${name}`, source), join(root, 'scripts', name));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}', { mode: 0o600 });
  for (const args of [
    ['init', '--quiet'],
    ['add', 'scripts', 'package.json'],
    [
      '-c',
      'user.name=Observation Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
  ]) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: f.home },
    });
    assert.equal(result.status, 0, result.stderr);
  }
  return { ...f, root };
}
function run(f, directory, args = ['volume', 'NAS'], env = {}) {
  const trace = join(f.home, 'requests');
  const launches = join(f.home, 'launches');
  writeFileSync(trace, '', { mode: 0o600 });
  writeFileSync(launches, '', { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [join(f.root, 'scripts/kis-observe.ts'), directory, ...args],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        HOME: f.home,
        KIS_APP_KEY: 'test-key',
        KIS_APP_SECRET: 'test-secret',
        NODE_OPTIONS: `--import=${new URL('./kis-observe-mock.mjs', import.meta.url).pathname}`,
        TEST_NOW: '1792281600000',
        TEST_TRACE: trace,
        TEST_LAUNCH_TRACE: launches,
        TEST_CHILD_PID: join(f.home, 'child-pid'),
        TEST_SOURCE_ROOT: f.root,
        ...env,
      },
    },
  );
  return {
    ...result,
    requests: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean),
    launches: readFileSync(launches, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
  };
}

test('observer collects one invocation per mode with linked private response and receipt', (t) => {
  const f = setup(t);
  for (const mode of ['volume', 'amount', 'daily', 'info']) {
    const directory = join(f.home, mode);
    const args = [mode, 'NAS', ...(['daily', 'info'].includes(mode) ? ['AAPL'] : [])];
    const result = run(f, directory, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output, {
      receipt: join(directory, 'receipt.json'),
      response: join(directory, 'response.json'),
    });
    const response = readFileSync(output.response);
    const receipt = JSON.parse(readFileSync(output.receipt));
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.status, 'success');
    assert.deepEqual(receipt.args, args);
    assert.deepEqual(receipt.child, { exitCode: 0, signal: null });
    assert.equal(receipt.runtime.node, process.version);
    assert.equal(
      receipt.source.revision,
      spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).stdout.trim(),
    );
    for (const name of files)
      assert.equal(
        receipt.source.files[`scripts/${name}`],
        digest(readFileSync(join(f.root, 'scripts', name))),
      );
    assert.deepEqual(receipt.response, { path: 'response.json', sha256: digest(response) });
    assert.ok(Number.isFinite(Date.parse(receipt.startedAt)));
    assert.ok(Date.parse(receipt.endedAt) >= Date.parse(receipt.startedAt));
    assert.equal(JSON.parse(response).validation, 'unverified');
    assert.equal(JSON.parse(response).dataSession, null);
    assert.equal(result.requests.filter((path) => path.startsWith('/uapi/')).length, 1);
    assert.equal(result.launches.length, 1);
    assert.equal(result.launches[0].timeout, 90_000);
    assert.equal(result.launches[0].killSignal, 'SIGKILL');
    assert.equal(result.launches[0].snapshotMode, 0o700);
    for (const name of [
      'kis-probe.ts',
      'kis-query.ts',
      'kis-auth.ts',
      'candidate-runtime.ts',
      'execution-observation.ts',
    ])
      assert.deepEqual(result.launches[0].snapshotFiles[name], {
        sha256: receipt.source.files[`scripts/${name}`],
        mode: 0o600,
      });
    assert.notEqual(result.launches[0].args[0], join(f.root, 'scripts/kis-probe.ts'));
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    for (const name of ['response.json', 'receipt.json'])
      assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(directory).sort(), ['receipt.json', 'response.json']);
    assert.doesNotMatch(
      result.stdout + result.stderr + response + readFileSync(output.receipt),
      /test-key|test-secret|test-token|account-secret/,
    );
  }
});

function assertSafeFailure(result, directory, code, recorded = true) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), {
    error: code,
    ...(recorded ? { receipt: join(directory, 'receipt.json') } : {}),
  });
  let stored = '';
  if (recorded) {
    stored = readFileSync(join(directory, 'receipt.json'), 'utf8');
    const receipt = JSON.parse(stored);
    assert.equal(receipt.status, 'failure');
    assert.equal(receipt.error, code);
    assert.equal(receipt.response, null);
    assert.equal(statSync(join(directory, 'receipt.json')).mode & 0o777, 0o600);
    assert.ok(!readdirSync(directory).some((name) => name.startsWith('.source-')));
  }
  assert.doesNotMatch(
    result.stdout + result.stderr + stored,
    /test-key|test-secret|test-token|account-secret/,
  );
}

test('observer records only allowlisted errors and never raw child failures', (t) => {
  const f = setup(t);
  for (const [scenario, env, code] of [
    ['api-error', { SCENARIO: 'api-error' }, 'KIS_FAILURE'],
    ['missing', { KIS_APP_KEY: '' }, 'CREDENTIALS_MISSING'],
    ['cooldown', {}, 'AUTH_COOLDOWN'],
    ['raw', { TEST_OBSERVE_CASE: 'raw-error' }, 'CHILD_FAILED'],
    ['malformed', { TEST_OBSERVE_CASE: 'malformed-output' }, 'CHILD_OUTPUT'],
    ['signal', { TEST_OBSERVE_CASE: 'signal' }, 'CHILD_FAILED'],
  ]) {
    if (scenario === 'cooldown') rmSync(join(f.cache, 'issuance.json'));
    const directory = join(f.home, scenario);
    const result = run(f, directory, ['volume', 'NAS'], env);
    assertSafeFailure(result, directory, code);
    assert.equal(result.launches.length, 1);
    assert.deepEqual(readdirSync(directory), ['receipt.json']);
    if (scenario === 'signal')
      assert.equal(
        JSON.parse(readFileSync(join(directory, 'receipt.json'))).child.signal,
        'SIGTERM',
      );
  }
});

test('observer rejects unsafe arguments before launching or creating output', (t) => {
  const f = setup(t);
  for (const args of [
    [],
    ['volume', 'OTC'],
    ['daily', 'NAS'],
    ['info', 'NYS', 'bad?'],
    ['amount', 'AMS', 'AAPL'],
    ['volume', 'NAS', '', 'extra'],
    ['other', 'NAS'],
  ]) {
    const directory = join(f.home, 'invalid');
    const result = run(f, directory, args);
    assertSafeFailure(result, directory, 'USAGE', false);
    assert.equal(result.launches.length, 0);
    assert.equal(existsSync(directory), false);
  }
});

test('observer does not persist or print inherited credentials through paths or request arguments', (t) => {
  const f = setup(t);
  for (const [directory, args, env] of [
    [join(f.home, 'test-key'), ['volume', 'NAS'], {}],
    [join(f.home, 'argument-secret'), ['info', 'NAS', 'PRIVATE'], { KIS_APP_KEY: 'PRIVATE' }],
  ]) {
    const result = run(f, directory, args, env);
    assertSafeFailure(result, directory, 'USAGE', false);
    assert.equal(result.launches.length, 0);
    assert.equal(existsSync(directory), false);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE/);
  }
});

test('observer preserves existing paths and refuses symbolic-link parents', (t) => {
  const f = setup(t);
  const existing = join(f.home, 'existing');
  mkdirSync(existing, { mode: 0o700 });
  writeFileSync(join(existing, 'receipt.json'), 'preserve-existing', { mode: 0o600 });
  const file = join(f.home, 'existing-file');
  writeFileSync(file, 'preserve-file', { mode: 0o600 });
  const link = join(f.home, 'link');
  symlinkSync(existing, link);
  for (const directory of [existing, file, link, join(link, 'new')]) {
    const result = run(f, directory);
    assertSafeFailure(result, directory, 'OBSERVATION_STORAGE', false);
    assert.equal(result.launches.length, 0);
  }
  assert.equal(readFileSync(join(existing, 'receipt.json'), 'utf8'), 'preserve-existing');
  assert.equal(readFileSync(file, 'utf8'), 'preserve-file');
  assert.deepEqual(readdirSync(existing), ['receipt.json']);
});

test('observer kills a timed-out child and preserves authentication state and lock', (t) => {
  const f = setup(t);
  const token = join(f.cache, 'token.json');
  writeFileSync(token, 'preserve-token', { mode: 0o600 });
  const issuance = readFileSync(join(f.cache, 'issuance.json'));
  const directory = join(f.home, 'timeout');
  const result = run(f, directory, ['volume', 'NAS'], { TEST_OBSERVE_CASE: 'timeout' });
  assertSafeFailure(result, directory, 'CHILD_TIMEOUT');
  const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json')));
  assert.equal(receipt.child.signal, 'SIGKILL');
  assert.equal(receipt.child.exitCode, null);
  assert.equal(result.launches[0].timeout, 90_000);
  const pid = Number(readFileSync(join(f.home, 'child-pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(readFileSync(token, 'utf8'), 'preserve-token');
  assert.deepEqual(readFileSync(join(f.cache, 'issuance.json')), issuance);
  assert.equal(statSync(join(f.cache, 'issuance.lock')).isDirectory(), true);
  assert.deepEqual(readdirSync(directory), ['receipt.json']);
});

test('observer fails collection when either artifact cannot be stored', (t) => {
  const f = setup(t);
  for (const scenario of ['response-storage', 'receipt-storage', 'receipt-directory-storage']) {
    const directory = join(f.home, scenario);
    const result = run(f, directory, ['volume', 'NAS'], { TEST_OBSERVE_CASE: scenario });
    assertSafeFailure(result, directory, 'OBSERVATION_STORAGE', scenario === 'response-storage');
    assert.equal(result.requests.filter((path) => path.startsWith('/uapi/')).length, 1);
    if (scenario !== 'response-storage') {
      assert.equal(existsSync(join(directory, 'receipt.json')), false);
      assert.equal(
        JSON.parse(readFileSync(join(directory, 'response.json'))).validation,
        'unverified',
      );
    }
  }
});

test('observer refuses changed source and does not claim a success response', (t) => {
  const f = setup(t);
  const directory = join(f.home, 'drift');
  const result = run(f, directory, ['volume', 'NAS'], { TEST_OBSERVE_CASE: 'source-drift' });
  assertSafeFailure(result, directory, 'SOURCE_FAILED');
  assert.deepEqual(readdirSync(directory), ['receipt.json']);
});
