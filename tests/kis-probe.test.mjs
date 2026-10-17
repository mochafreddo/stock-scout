import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const cli = new URL('../scripts/kis-probe.ts', import.meta.url);
const mock = new URL('./kis-http-mock.mjs', import.meta.url);
function run(scenario, args = ['volume', 'NAS'], credentials = {}) {
  return spawnSync(process.execPath, ['--import', mock.pathname, cli.pathname, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      KIS_APP_KEY: 'test-key',
      KIS_APP_SECRET: 'test-secret',
      KIS_ACCESS_TOKEN: 'test-token',
      SCENARIO: scenario,
      ...credentials,
    },
  });
}

test('CLI rejects missing credentials without printing values', () => {
  const result = run('ok', ['volume', 'NAS'], { KIS_ACCESS_TOKEN: '' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'CREDENTIALS_MISSING');
});

test('CLI records selected fields and request time without declaring a validated session', () => {
  const result = run('ok');
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.request.params.EXCD, 'NAS');
  assert.equal(record.request.params.NDAY, '0');
  assert.equal(record.rows[0].symb, 'AAPL');
  assert.equal(record.rows[0].tvol, '123');
  assert.equal(record.rows.length, 1);
  assert.equal(record.dataSession, null);
  assert.equal(record.validation, 'unverified');
  assert.ok(Number.isFinite(Date.parse(record.requestedAt)));
  assert.ok(Number.isFinite(Date.parse(record.receivedAt)));
  assert.doesNotMatch(result.stdout + result.stderr, /test-token|test-secret|account-secret/);
});

test('CLI rejects API errors, malformed responses, and transport failures without partial stdout', () => {
  for (const scenario of ['http-error', 'api-error', 'malformed', 'transport-error', 'bad-rows']) {
    const result = run(scenario);
    assert.equal(result.status, 1, scenario);
    assert.equal(result.stdout, '', scenario);
    assert.ok(JSON.parse(result.stderr).error, scenario);
    assert.doesNotMatch(result.stderr, /test-token|test-secret|account-secret/);
  }
});

test('CLI observes six rankings, daily prices and security identifiers without interpreting types', () => {
  for (const exchange of ['NAS', 'NYS', 'AMS']) {
    for (const kind of ['volume', 'amount', 'daily', 'info']) {
      const result = run('ok', [
        kind,
        exchange,
        ...(['daily', 'info'].includes(kind) ? ['AAPL'] : []),
      ]);
      assert.equal(result.status, 0, result.stderr);
      const record = JSON.parse(result.stdout);
      if (kind === 'daily') assert.equal(record.rows[0].xymd, '20261016');
      if (kind === 'info') assert.equal(record.rows[0].std_pdno, 'US0378331005');
      assert.equal(record.validation, 'unverified');
      assert.doesNotMatch(result.stdout + result.stderr, /test-token|test-secret|account-secret/);
    }
  }
});

test('CLI preserves empty and continuation observations as unverified, without fetching more pages', () => {
  const empty = run('empty');
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).rowCount, 0);
  assert.equal(JSON.parse(empty.stdout).validation, 'unverified');
  const continued = run('continued');
  assert.equal(continued.status, 0, continued.stderr);
  assert.equal(JSON.parse(continued.stdout).continuation, 'M');
});

test('CLI refuses unsupported modes, markets, extra arguments and missing symbols', () => {
  for (const args of [
    [],
    ['volume', 'OTC'],
    ['volume', 'NAS', 'AAPL'],
    ['daily', 'NAS'],
    ['info', 'NYS', 'bad?symbol'],
    ['other', 'NAS'],
  ]) {
    const result = run('ok', args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'USAGE');
  }
});
