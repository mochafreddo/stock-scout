import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, price, runCli } from './toss-cli-helper.mjs';

test('Toss CLI rejects an oversized issued token and preserves unknown issuance for the next execution', async () => {
  const f = fixture();
  const token = 'x'.repeat(17000);
  try {
    const first = await runCli(f, [], undefined, {
      TEST_AUTH_STEPS: JSON.stringify([
        { body: { access_token: token, token_type: 'Bearer', expires_in: 86400 } },
      ]),
    });
    assert.equal(first.status, 1);
    assert.equal(first.stderr, 'AUTH_RESPONSE_INVALID\n');
    assert.equal(JSON.parse(first.stdout).error.code, 'AUTH_RESPONSE_INVALID');
    assert.equal(first.requests.length, 1);
    assert.equal(first.requests[0].path, '/oauth2/token');
    const stored = readFileSync(join(f.directory, 'state.json'));
    assert.ok(stored.length <= 16384);
    assert.equal(JSON.parse(stored).pending, true);
    assert.equal(JSON.parse(stored).token, undefined);
    const second = await runCli(f);
    assert.equal(second.status, 1);
    assert.equal(second.stderr, 'AUTH_ISSUANCE_UNKNOWN\n');
    assert.equal(JSON.parse(second.stdout).error.code, 'AUTH_ISSUANCE_UNKNOWN');
    assert.equal(second.requests.length, 1);
    assert.doesNotMatch(first.stdout + first.stderr + second.stdout + second.stderr, /x{100}/);
  } finally {
    f.close();
  }
});

test('Toss CLI applies the 16384-byte limit to the whole UTF-8 state including metadata', async () => {
  for (const bytes of [16383, 16384, 16385]) {
    const f = fixture();
    const token = 'boundary-token';
    try {
      const initial = await runCli(f);
      assert.equal(initial.status, 0, initial.stdout + initial.stderr);
      const path = join(f.directory, 'state.json');
      const state = JSON.parse(readFileSync(path, 'utf8'));
      delete state.token;
      state.note = '';
      const candidate = {
        ...state,
        token: { value: token, expiresAt: Date.parse('2026-11-07T15:00:00Z') },
      };
      const padding = bytes - Buffer.byteLength(JSON.stringify(candidate));
      state.note = '한'.repeat(Math.floor(padding / 3)) + 'x'.repeat(padding % 3);
      const input = JSON.stringify(state);
      assert.ok(input.length < Buffer.byteLength(input));
      assert.ok(Buffer.byteLength(input) < 16384);
      writeFileSync(path, input);
      const issued = await runCli(
        f,
        [{ expectedToken: token, body: { result: [price] } }],
        undefined,
        {
          TEST_AUTH_STEPS: JSON.stringify([
            { body: { access_token: token, token_type: 'Bearer', expires_in: 86400 } },
          ]),
        },
      );
      const stored = readFileSync(path);
      assert.equal(issued.status, bytes <= 16384 ? 0 : 1, issued.stdout + issued.stderr);
      assert.equal(issued.stderr, bytes <= 16384 ? '' : 'AUTH_RESPONSE_INVALID\n');
      if (bytes <= 16384) {
        assert.equal(Buffer.byteLength(stored), bytes);
        assert.equal(JSON.parse(stored).token.value, token);
        const reused = await runCli(f, [{ expectedToken: token, body: { result: [price] } }]);
        assert.equal(reused.status, 0, reused.stdout + reused.stderr);
        assert.equal(reused.stderr, '');
        assert.equal(reused.requests.filter((request) => request.method === 'POST').length, 2);
      } else {
        assert.equal(JSON.parse(issued.stdout).error.code, 'AUTH_RESPONSE_INVALID');
        assert.ok(stored.length <= 16384);
        assert.equal(JSON.parse(stored).pending, true);
        assert.equal(JSON.parse(stored).token, undefined);
        const blocked = await runCli(f);
        assert.equal(JSON.parse(blocked.stdout).error.code, 'AUTH_ISSUANCE_UNKNOWN');
        assert.equal(blocked.status, 1);
        assert.equal(blocked.stderr, 'AUTH_ISSUANCE_UNKNOWN\n');
        assert.equal(blocked.requests.length, 3);
      }
      assert.doesNotMatch(issued.stdout + issued.stderr, /boundary-token/);
    } finally {
      f.close();
    }
  }
});
