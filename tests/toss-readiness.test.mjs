import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, runCli } from './toss-cli-helper.mjs';

function writeState(f, changes = {}) {
  writeFileSync(
    join(f.directory, 'account.json'),
    JSON.stringify({
      alias: 'private-synthetic-account',
      accountSeq: '987654321012345678',
      accountNo: '998877665544',
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(f.directory, 'state.json'),
    JSON.stringify({
      fingerprint: createHash('sha256')
        .update(JSON.stringify(['synthetic-client', 'synthetic-secret']))
        .digest('hex'),
      version: 2,
      nextAt: null,
      clock: {
        id: 'darwin-mach-continuous:11111111-1111-4111-8111-111111111111',
        nextNs: '000000000000000000000000000000',
      },
      pending: false,
      token: { value: 'synthetic-token', expiresAt: Date.parse('2026-11-07T15:00:00Z') },
      ...changes,
    }),
    { mode: 0o600 },
  );
}

function snapshot(directory) {
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

async function inspect(f, extra = {}, args = ['readiness']) {
  const before = snapshot(f.directory);
  const result = await runCli(f, [], args, { TEST_PLATFORM: 'darwin', ...extra });
  assert.equal(result.requests.length, 0, 'readiness must not transmit HTTP');
  assert.deepEqual(snapshot(f.directory), before, 'readiness must not change protected files');
  const output = result.stdout + result.stderr;
  for (const value of [
    'synthetic-client',
    'synthetic-secret',
    'synthetic-token',
    createHash('sha256')
      .update(JSON.stringify(['synthetic-client', 'synthetic-secret']))
      .digest('hex'),
    'private-synthetic-account',
    '987654321012345678',
    '998877665544',
    f.directory,
  ])
    assert.ok(!output.includes(value), 'readiness must not expose protected values');
  for (const name of ['credentials.json', 'state.json', 'account.json']) {
    const content = before.entries[name]?.content?.toString();
    if (content)
      assert.ok(!output.includes(content), 'readiness must not expose raw protected files');
  }
  return { ...result, out: JSON.parse(result.stdout) };
}

test('readiness reports locally ready without HTTP or protected-directory changes', async () => {
  const f = fixture();
  try {
    writeState(f);
    const result = await inspect(f);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.out.version, 1);
    assert.equal(result.out.status, 'success');
    assert.deepEqual(result.out.data, [{ readiness: 'ready', token: 'valid', reasons: [] }]);
    assert.equal(result.out.source.endpoint, 'local:readiness');
    assert.equal(typeof result.out.retrievedAt, 'string');
  } finally {
    f.close();
  }
});

test('readiness reports missing and expired cached tokens without issuing them', async () => {
  for (const [changes, token] of [
    [null, 'missing'],
    [{ token: undefined }, 'missing'],
    [
      { token: { value: 'synthetic-token', expiresAt: Date.parse('2026-11-06T15:00:00Z') } },
      'expired',
    ],
    [
      { token: { value: 'synthetic-token', expiresAt: Date.parse('2026-11-06T15:00:10Z') } },
      'refresh_required',
    ],
  ]) {
    const f = fixture();
    try {
      if (changes) writeState(f, changes);
      const result = await inspect(f);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(result.out.data, [{ readiness: 'ready', token, reasons: [] }]);
    } finally {
      f.close();
    }
  }
});

test('readiness exposes each lock, pending issuance and active reservation independently', async () => {
  for (const kind of ['client.lock', 'issuance.lock', 'account.lock', 'pending', 'reservation']) {
    const f = fixture();
    try {
      writeState(f, {
        ...(kind === 'pending' ? { pending: true, token: undefined } : {}),
        ...(kind === 'reservation'
          ? {
              clock: {
                id: 'darwin-mach-continuous:11111111-1111-4111-8111-111111111111',
                nextNs: '000000000001793977260000000000',
              },
            }
          : {}),
      });
      if (kind.endsWith('.lock')) mkdirSync(join(f.directory, kind), { mode: 0o700 });
      const result = await inspect(f);
      const code =
        kind === 'pending'
          ? 'AUTH_ISSUANCE_UNKNOWN'
          : kind === 'reservation'
            ? 'WAIT_REQUIRED'
            : 'LOCK_PRESENT';
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.out.data[0].readiness, 'blocked');
      assert.deepEqual(result.out.data[0].reasons, [code]);
      assert.equal(result.out.error.code, code);
      assert.equal(result.stderr.trim(), code);
    } finally {
      f.close();
    }
  }
});

test('readiness validates cooldown records before reporting locks and retains expired records', async () => {
  for (const kind of ['malformed', 'clock', 'expired']) {
    const f = fixture();
    try {
      writeState(f);
      const state = JSON.parse(readFileSync(join(f.directory, 'state.json')));
      mkdirSync(join(f.directory, 'client.lock'), { mode: 0o700 });
      writeFileSync(
        join(f.directory, 'cooldown-11111111-1111-4111-8111-111111111111.json'),
        JSON.stringify({
          fingerprint: state.fingerprint,
          clock:
            kind === 'malformed'
              ? { id: state.clock.id, nextNs: 'invalid' }
              : { id: kind === 'clock' ? 'another-boot' : state.clock.id, nextNs: '0'.repeat(30) },
        }),
        { mode: 0o600 },
      );
      const result = await inspect(f);
      const code =
        kind === 'malformed'
          ? 'AUTH_STORAGE'
          : kind === 'clock'
            ? 'CLOCK_UNCERTAIN'
            : 'LOCK_PRESENT';
      assert.equal(result.status, 1);
      assert.equal(result.out.error.code, code);
      assert.equal(result.out.data[0].readiness, kind === 'expired' ? 'blocked' : 'unavailable');
    } finally {
      f.close();
    }
  }
});

test('readiness safely reports missing configuration, unsafe protection and unavailable clock', async () => {
  for (const kind of [
    'missing-directory-config',
    'missing-directory',
    'missing-credentials',
    'invalid-credentials',
    'unsafe-directory',
    'unsafe-credentials',
    'unsafe-state',
    'unsafe-lock',
    'clock-unavailable',
    'unsupported-platform',
  ]) {
    const f = fixture();
    try {
      writeState(f);
      const extra = {};
      let code = 'AUTH_STORAGE';
      if (kind === 'missing-directory-config') extra.TOSS_STATE_DIR = undefined;
      if (kind === 'missing-directory') extra.TOSS_STATE_DIR = join(f.directory, 'absent');
      if (kind === 'missing-credentials') unlinkSync(join(f.directory, 'credentials.json'));
      if (kind === 'invalid-credentials') {
        writeFileSync(
          join(f.directory, 'credentials.json'),
          JSON.stringify({ clientId: 'synthetic-client' }),
        );
        code = 'AUTH_CONFIG';
      }
      if (kind === 'unsafe-directory') chmodSync(f.directory, 0o755);
      if (kind === 'unsafe-credentials') chmodSync(join(f.directory, 'credentials.json'), 0o644);
      if (kind === 'unsafe-state') chmodSync(join(f.directory, 'state.json'), 0o644);
      if (kind === 'unsafe-lock') {
        mkdirSync(join(f.directory, 'client.lock'), { mode: 0o700 });
        chmodSync(join(f.directory, 'client.lock'), 0o755);
      }
      if (kind === 'clock-unavailable') extra.TEST_CLOCK_UNAVAILABLE = '1';
      if (kind === 'unsupported-platform') extra.TEST_PLATFORM = 'win32';
      if (kind === 'clock-unavailable' || kind === 'unsupported-platform') code = 'CLOCK_UNCERTAIN';
      const result = await inspect(f, extra);
      assert.equal(result.status, 1, kind);
      assert.equal(result.out.error.code, code, kind);
      assert.equal(result.stderr.trim(), code);
      assert.deepEqual(result.out.data, [
        { readiness: 'unavailable', token: 'unknown', reasons: [code] },
      ]);
    } finally {
      f.close();
    }
  }
});

test('help discovers readiness and extra arguments are rejected without effects', async () => {
  const f = fixture();
  try {
    const help = await inspect(f, {}, ['--help']);
    assert.equal(help.status, 0);
    assert.equal(
      help.out.data.commands.find((entry) => entry.name === 'readiness').usage,
      'node scripts/toss.ts readiness',
    );
    const invalid = await inspect(f, {}, ['readiness', 'unexpected']);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.out.error.code, 'INPUT_INVALID');
  } finally {
    f.close();
  }
});

test('query after readiness still issues missing tokens and revalidates changed state', async () => {
  const f = fixture();
  try {
    const readiness = await inspect(f);
    assert.equal(readiness.status, 0);
    const query = await runCli(f, [], ['prices', 'AAPL'], { TEST_PLATFORM: 'darwin' });
    assert.equal(query.status, 0, query.stdout + query.stderr);
    assert.deepEqual(
      query.requests.map((request) => request.method),
      ['POST', 'GET'],
    );
    writeState(f, { version: undefined, clock: undefined, nextAt: 0 });
    const before = snapshot(f.directory);
    const blocked = await runCli(f, [], ['prices', 'AAPL'], { TEST_PLATFORM: 'darwin' });
    assert.equal(blocked.status, 1);
    assert.equal(JSON.parse(blocked.stdout).error.code, 'AUTH_STATE_TRANSITION_REQUIRED');
    assert.equal(blocked.requests.length, 2);
    // Queries acquire and release locks, so their directory timestamps may change.
    assert.deepEqual(snapshot(f.directory).entries, before.entries);
  } finally {
    f.close();
  }
});

test('readiness distinguishes legacy, corrupt and incompatible-clock states without changing them', async () => {
  for (const [changes, code, readiness] of [
    [
      { version: undefined, clock: undefined, nextAt: 0 },
      'AUTH_STATE_TRANSITION_REQUIRED',
      'blocked',
    ],
    [{ pending: 'false' }, 'AUTH_STORAGE', 'unavailable'],
    [
      { clock: { id: 'another-boot', nextNs: '000000000000000000000000000000' } },
      'CLOCK_UNCERTAIN',
      'unavailable',
    ],
  ]) {
    const f = fixture();
    try {
      writeState(f, changes);
      mkdirSync(join(f.directory, 'client.lock'), { mode: 0o700 });
      const result = await inspect(f);
      assert.equal(result.status, 1);
      assert.equal(result.out.status, 'error');
      assert.equal(result.out.error.code, code);
      assert.equal(result.stderr.trim(), code);
      assert.deepEqual(result.out.data, [{ readiness, token: 'unknown', reasons: [code] }]);
    } finally {
      f.close();
    }
  }
});

test('readiness reports pending issuance, waits and locks together without merging or taking them', async () => {
  const f = fixture();
  try {
    writeState(f, { pending: true });
    const state = JSON.parse(readFileSync(join(f.directory, 'state.json')));
    writeFileSync(
      join(f.directory, 'cooldown-11111111-1111-4111-8111-111111111111.json'),
      JSON.stringify({
        fingerprint: state.fingerprint,
        clock: {
          id: state.clock.id,
          nextNs: (BigInt(Date.parse('2026-11-06T15:01:00Z')) * 1000000n)
            .toString()
            .padStart(30, '0'),
        },
      }),
      { mode: 0o600 },
    );
    mkdirSync(join(f.directory, 'client.lock'), { mode: 0o700 });
    const result = await inspect(f);
    assert.equal(result.status, 1);
    assert.equal(result.out.error.code, 'AUTH_ISSUANCE_UNKNOWN');
    assert.equal(result.stderr.trim(), 'AUTH_ISSUANCE_UNKNOWN');
    assert.deepEqual(result.out.data, [
      {
        readiness: 'blocked',
        token: 'valid',
        reasons: ['AUTH_ISSUANCE_UNKNOWN', 'WAIT_REQUIRED', 'LOCK_PRESENT'],
      },
    ]);
  } finally {
    f.close();
  }
});
