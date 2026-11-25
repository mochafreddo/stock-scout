import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const open = '2026-11-24T12:00:00.000Z';
const closed = '2026-11-24T12:20:00.000Z';

function stateDirectory(t) {
  const state = mkdtempSync(join(tmpdir(), 'dot-startup-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  return state;
}

function invoke(state, time, status, code, exitCode) {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript,Date.now=()=>${Date.parse(time)}`,
      'scripts/run-dot-mcp.ts',
      '/unused',
      join(state, 'missing-tunnel'),
      state,
      '0',
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  if (result.error) throw result.error;
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { session: '2026-11-24', time, status, code });
  assert.equal(result.status, exitCode);
}

test('direct startup fails when the state directory is shared', (t) => {
  const state = stateDirectory(t);
  chmodSync(state, 0o770);
  invoke(state, open, 'error', 'SESSION_STORAGE_UNSAFE', 1);
});

test('direct startup retains the claim after tunnel failure and skips the next attempt', (t) => {
  const state = stateDirectory(t);
  invoke(state, open, 'error', 'TUNNEL_START_FAILED', 1);
  invoke(state, open, 'skipped', 'SESSION_CLAIMED', 0);
});

test('direct startup skips a closed window without claiming the session', (t) => {
  const state = stateDirectory(t);
  invoke(state, closed, 'skipped', 'WINDOW_CLOSED', 0);
  invoke(state, open, 'error', 'TUNNEL_START_FAILED', 1);
});

test('direct startup identifies a state path occupied by a file as unsafe', (t) => {
  const state = join(stateDirectory(t), 'state');
  writeFileSync(state, '');
  invoke(state, open, 'error', 'SESSION_STORAGE_UNSAFE', 1);
});
