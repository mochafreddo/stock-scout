import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, now, putToken } from './kis-cli-helper.mjs';

export function run(t, scenario = 'ok', env = {}, args, script = 'candidate-universe') {
  const f = fixture();
  t.after(f.close);
  const initialNow = Date.parse(env.TEST_NOW || new Date(now).toISOString());
  const token = putToken(f, 'test-token');
  token.access_token_token_expired = new Date(initialNow + 10 * 3600_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  writeFileSync(join(f.cache, 'token.json'), JSON.stringify(token), { mode: 0o600 });
  const directory = join(f.home, 'siwc');
  mkdirSync(directory, { mode: 0o700 });
  const hostId = 'urn:uuid:859484d1-d773-489f-a0dd-a3021048bb7f';
  writeFileSync(join(directory, 'host.json'), JSON.stringify({ hostId }), { mode: 0o600 });
  writeFileSync(
    join(directory, 'credentials.json'),
    JSON.stringify({
      schemaVersion: 1,
      issuer: 'https://auth.openai.com',
      subject: 'synthetic-user',
      clientId: 'oaiapp_synthetic',
      hostId,
      accessToken: 'synthetic-subscription',
      idToken: 'synthetic-identity',
      refreshToken: 'synthetic-refresh',
      tokenType: 'Bearer',
      scopes: ['openid', 'resource.invoke', 'chatgpt.tokens.use.direct'],
      expiresAt: env.AUTH_EXPIRES ? Date.parse(env.AUTH_EXPIRES) : initialNow + 3600_000,
    }),
    { mode: 0o600 },
  );
  const trace = join(f.home, 'trace');
  writeFileSync(trace, '', { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      new URL(
        `./${script === 'buy-candidates' ? 'buy-candidates' : 'candidate-universe'}-http-mock.mjs`,
        import.meta.url,
      ).pathname,
      `scripts/${script}.ts`,
      ...(args ?? ['--auth-dir', directory, '--model', 'gpt-6-luna']),
    ],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        PATH: process.env.PATH,
        HOME: f.home,
        KIS_APP_KEY: 'test-key',
        KIS_APP_SECRET: 'test-secret',
        TEST_NOW: new Date(now).toISOString(),
        TEST_TRACE: trace,
        SCENARIO: scenario,
        ...env,
      },
    },
  );
  return {
    ...result,
    requests: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
  };
}
