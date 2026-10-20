import { AuthError } from './kis-auth.ts';
import { type KisExchange, type KisQueryKind, queryKis } from './kis-query.ts';

try {
  const [kind, exchange, symbol = '', ...extra] = process.argv.slice(2);
  if (!kind || !exchange || extra.length) throw new Error('USAGE');
  const record = await queryKis(kind as KisQueryKind, exchange as KisExchange, symbol);
  console.log(JSON.stringify(record));
} catch (error) {
  if (error instanceof AuthError) {
    console.error(
      JSON.stringify({
        error: error.message,
        retryAfterSeconds: error.retryAfterSeconds,
        guidance: error.guidance,
      }),
    );
    process.exitCode = 1;
  } else {
    const safeCodes = [
      'USAGE',
      'RESPONSE_SHAPE',
      'CREDENTIALS_MISSING',
      'HTTP_FAILURE',
      'KIS_FAILURE',
    ];
    const code =
      error instanceof Error && safeCodes.includes(error.message)
        ? error.message
        : 'REQUEST_FAILED';
    console.error(JSON.stringify({ error: code }));
    process.exitCode = 1;
  }
}
