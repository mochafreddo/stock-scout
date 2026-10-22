import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DiagnosticError } from './diagnostic-error.ts';
import { AuthError } from './kis-auth.ts';
import { type KisExchange, queryKis } from './kis-query.ts';
import {
  type AssessmentStage,
  type AssessmentStatistics,
  assessSecurityTypes,
  type Security,
} from './security-type-assessment.ts';

const exchanges: KisExchange[] = ['NAS', 'NYS', 'AMS'];
const safeCodes = [
  'USAGE',
  'SENSITIVE_OUTPUT',
  'RANKING_FAILED',
  'RANKING_INCOMPLETE',
  'IDENTITY_AMBIGUOUS',
  'MODEL_FAILED',
  'MODEL_INCOMPLETE',
  'MODEL_OUTPUT',
  'MODEL_UNAVAILABLE',
  'MODEL_LIMIT',
  'SEARCH_UNSUPPORTED',
  'SEARCH_FAILED',
  'AUTH_FAILED',
  'PAID_BUDGET_UNPROVABLE',
  'SUBSCRIPTION_LIMIT',
  'QUERY_FAILED',
  'ANALYSIS_INSUFFICIENT',
];
const keyOf = (exchange: string, symbol: string) => `${exchange}:${symbol}`;
let statistics: AssessmentStatistics | undefined;
let inputSnapshot: Record<string, unknown> | undefined;
let snapshotSecrets: (string | undefined)[] = [];
let stage: 'input' | 'authentication' | 'ranking' | 'unknown' | AssessmentStage = 'input';
try {
  const [directory, model, top, ...extra] = process.argv.slice(2);
  const evaluation = top === '--evaluation-input';
  if (
    !directory ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(model ?? '') ||
    (evaluation
      ? extra.length !== 1 || !isAbsolute(extra[0])
      : !/^[1-9]$|^10$/.test(top ?? '') || extra.length)
  )
    throw new Error('USAGE');
  const securities = new Map<string, Security>();
  const identities = new Map<string, string>();
  const observations: unknown[] = [];
  if (evaluation) {
    let input: unknown;
    try {
      input = JSON.parse(readFileSync(extra[0], 'utf8'));
    } catch {
      throw new Error('USAGE');
    }
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      !('securities' in input) ||
      !Array.isArray(input.securities) ||
      input.securities.length < 1 ||
      input.securities.length > 60
    )
      throw new Error('USAGE');
    for (const row of input.securities) {
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        Object.keys(row).length !== 2 ||
        !exchanges.includes(row.exchange) ||
        typeof row.symbol !== 'string' ||
        !/^[A-Z0-9./^-]{1,20}$/.test(row.symbol) ||
        securities.has(keyOf(row.exchange, row.symbol))
      )
        throw new Error('USAGE');
      securities.set(keyOf(row.exchange, row.symbol), {
        exchange: row.exchange,
        symbol: row.symbol,
      });
    }
  }
  stage = 'authentication';
  const { readSiwcCredentials } = await import('./siwc-auth.ts');
  const credentials = await readSiwcCredentials(directory);
  stage = 'unknown';
  const secrets = [
    credentials.accessToken,
    credentials.idToken,
    credentials.refreshToken,
    process.env.KIS_APP_KEY,
    process.env.KIS_APP_SECRET,
    process.env.OPENAI_API_KEY,
  ];
  snapshotSecrets = secrets;
  inputSnapshot = {
    inputMode: evaluation ? 'evaluation' : 'rankings',
    model,
    ...(evaluation ? {} : { topPerRanking: Number(top) }),
    securities: [...securities.values()],
    observations,
  };
  if (!evaluation) {
    stage = 'ranking';
    for (const exchange of exchanges)
      for (const kind of ['volume', 'amount'] as const) {
        let record: Awaited<ReturnType<typeof queryKis>>;
        try {
          record = await queryKis(kind, exchange);
        } catch (error) {
          if (error instanceof AuthError)
            throw new DiagnosticError('AUTH_FAILED', 'RANKING_FAILED');
          throw new Error('RANKING_FAILED');
        }
        const ranks = new Set<number>();
        for (const row of record.rows) {
          const rank = Number(row.rank);
          if (
            !Number.isSafeInteger(rank) ||
            rank < 1 ||
            ranks.has(rank) ||
            typeof row.symb !== 'string' ||
            !/^[A-Z0-9./^-]{1,20}$/.test(row.symb) ||
            (row.excd && row.excd !== exchange) ||
            typeof row.rsym !== 'string' ||
            !row.rsym
          )
            throw new Error('RANKING_FAILED');
          ranks.add(rank);
          if (rank > Number(top)) continue;
          const key = keyOf(exchange, row.symb);
          const existing = securities.get(key);
          if (
            (existing && existing.rsym !== row.rsym) ||
            (identities.has(row.rsym) && identities.get(row.rsym) !== key)
          )
            throw new DiagnosticError('IDENTITY_AMBIGUOUS');
          identities.set(row.rsym, key);
          const security: Security = existing ?? {
            exchange,
            symbol: row.symb,
            rsym: row.rsym,
            rankings: [],
          };
          security.rankings?.push({
            kind,
            rank,
            requestedAt: record.requestedAt,
            source: record.source,
          });
          securities.set(key, security);
        }
        const selected = [...ranks].filter((rank) => rank <= Number(top));
        if (selected.length < Number(top) && ['F', 'M'].includes(record.continuation))
          throw new DiagnosticError('RANKING_INCOMPLETE');
        inputSnapshot.securities = structuredClone([...securities.values()]);
        observations.push({
          exchange,
          kind,
          requestedAt: record.requestedAt,
          receivedAt: record.receivedAt,
          continuation: record.continuation,
          rowCount: record.rowCount,
          request: record.request,
          source: record.source,
        });
      }
  }
  if (!securities.size) throw new Error('ANALYSIS_INSUFFICIENT');
  if (secrets.some((secret) => secret && JSON.stringify(inputSnapshot).includes(secret)))
    throw new DiagnosticError('SENSITIVE_OUTPUT');
  const result = await assessSecurityTypes({
    securities: [...securities.values()],
    model,
    accessToken: credentials.accessToken,
    secrets,
    onStage: (next, measured) => {
      stage = next;
      statistics = measured;
    },
    inputMode: evaluation ? 'evaluation' : 'rankings',
    observations,
    ...(evaluation ? {} : { topPerRanking: Number(top) }),
  });
  console.log(JSON.stringify(result));
  if (result.status === 'analysis_insufficient') process.exitCode = 2;
} catch (error) {
  const code =
    error instanceof Error &&
    (safeCodes.includes(error.message) || error.message.startsWith('siwc_'))
      ? error.message
      : 'MODEL_FAILED';
  console.error(
    JSON.stringify({
      error: code,
      diagnostic: {
        stage,
        reason: error instanceof DiagnosticError ? error.reason : 'unknown',
        location: error instanceof DiagnosticError ? error.location : null,
        ...(['retrieval', 'judgment'].includes(stage) && statistics ? { statistics } : {}),
        ...(inputSnapshot &&
        !snapshotSecrets.some((secret) => secret && JSON.stringify(inputSnapshot).includes(secret))
          ? { inputSnapshot }
          : {}),
      },
      ...(code === 'siwc_refresh_not_allowed' && error instanceof Error && 'retryAt' in error
        ? { retryAt: error.retryAt }
        : {}),
      ...(code === 'siwc_relogin_required' ? { action: 'login' } : {}),
    }),
  );
  process.exitCode = 1;
}
