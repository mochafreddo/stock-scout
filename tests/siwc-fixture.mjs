import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeSiwcFixture(directory, expiresAt, changes = {}) {
  mkdirSync(directory, { mode: 0o700 });
  const hostId = 'urn:uuid:859484d1-d773-489f-a0dd-a3021048bb7f';
  writeFileSync(join(directory, 'host.json'), JSON.stringify({ hostId }), { mode: 0o600 });
  const path = join(directory, 'credentials.json');
  writeFileSync(
    path,
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
      expiresAt,
      ...changes,
    }),
    { mode: 0o600 },
  );
  return path;
}
