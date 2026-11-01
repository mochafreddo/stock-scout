import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DiagnosticError } from './diagnostic-error.ts';
import { ExecutionObservation, type ObservedOperation } from './execution-observation.ts';
import { AuthError } from './kis-auth.ts';
import { type KisExchange, queryKis } from './kis-query.ts';
import { ListedSecurities } from './listed-securities.ts';
import {
  type AssessmentDiagnostics,
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
const startedAt = performance.now();
const observation = new ExecutionObservation();
const context = { observation };
let outputOperation: ObservedOperation | undefined;
let typeAssessment: AssessmentDiagnostics = {
  statistics: {
    status: 'not_started',
    elapsedMs: null,
    modelRequests: 0,
    infoToolCalls: 0,
    observedWebToolCalls: 0,
  },
  cause: 'unknown',
  lastProgress: 'not_started',
  requests: [],
};
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
  let securities: Security[] = [];
  let observations: unknown[] = [];
  if (evaluation) {
    const inputs = new Map<string, Security>();
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
        inputs.has(keyOf(row.exchange, row.symbol))
      )
        throw new Error('USAGE');
      inputs.set(keyOf(row.exchange, row.symbol), {
        exchange: row.exchange,
        symbol: row.symbol,
      });
    }
    securities = [...inputs.values()];
  }
  stage = 'authentication';
  const { readSiwcCredentials } = await import('./siwc-auth.ts');
  const credentials = await readSiwcCredentials(directory, undefined, context);
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
    securities,
    observations,
  };
  if (!evaluation) {
    const listings = new ListedSecurities();
    stage = 'ranking';
    for (const exchange of exchanges)
      for (const kind of ['volume', 'amount'] as const) {
        const ranking = observation.start('ranking');
        let validation: ObservedOperation | undefined;
        try {
          let record: Awaited<ReturnType<typeof queryKis>>;
          try {
            record = await queryKis(kind, exchange, '', {
              ...context,
              secrets,
              parentId: ranking?.id,
            });
          } catch (error) {
            const mapped =
              error instanceof AuthError
                ? new DiagnosticError('AUTH_FAILED', 'RANKING_FAILED')
                : new Error('RANKING_FAILED');
            observation.propagate(mapped, error);
            throw mapped;
          }
          validation = observation.start('ranking.validation', ranking?.id);
          listings.addRanking(
            {
              exchange,
              kind,
              requestedAt: record.requestedAt,
              receivedAt: record.receivedAt,
              continuation: record.continuation,
              rowCount: record.rowCount,
              request: record.request,
              source: record.source,
            },
            (include) => {
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
                include({ symbol: row.symb, rsym: row.rsym, rank });
              }
              const selected = [...ranks].filter((rank) => rank <= Number(top));
              if (selected.length < Number(top) && ['F', 'M'].includes(record.continuation))
                throw new DiagnosticError('RANKING_INCOMPLETE');
            },
          );
          ({ securities, observations } = listings.snapshot());
          Object.assign(inputSnapshot, { securities, observations });
          observation.end(validation);
          observation.end(ranking);
        } catch (error) {
          const failure =
            error instanceof Error && error.message === 'IDENTITY_AMBIGUOUS'
              ? new DiagnosticError('IDENTITY_AMBIGUOUS')
              : error;
          if (validation?.status === 'in_progress') observation.fail(validation, failure);
          observation.fail(ranking, failure);
          throw failure;
        }
      }
  }
  if (!securities.length) throw new Error('ANALYSIS_INSUFFICIENT');
  if (secrets.some((secret) => secret && JSON.stringify(inputSnapshot).includes(secret)))
    throw new DiagnosticError('SENSITIVE_OUTPUT');
  const result = await assessSecurityTypes({
    context,
    securities,
    model,
    accessToken: credentials.accessToken,
    secrets,
    onStage: (next, measured, diagnostics) => {
      stage = next;
      statistics = measured;
      typeAssessment = diagnostics;
    },
    inputMode: evaluation ? 'evaluation' : 'rankings',
    observations,
    ...(evaluation ? {} : { topPerRanking: Number(top) }),
  });
  outputOperation = observation.start('output');
  console.log(JSON.stringify(result));
  observation.end(outputOperation);
  if (result.status === 'analysis_insufficient') process.exitCode = 2;
} catch (error) {
  if (outputOperation?.status === 'in_progress') observation.fail(outputOperation, error);
  const code =
    error instanceof Error &&
    (safeCodes.includes(error.message) || error.message.startsWith('siwc_'))
      ? error.message
      : 'MODEL_FAILED';
  observation.finish(code, error);
  console.error(
    JSON.stringify({
      error: code,
      observation: observation.snapshot(),
      diagnostic: {
        elapsedMs: Math.round(performance.now() - startedAt),
        typeAssessment,
        stage,
        reason: error instanceof DiagnosticError ? error.reason : 'unknown',
        location: error instanceof DiagnosticError ? error.location : null,
        ...(['assessment'].includes(stage) && statistics ? { statistics } : {}),
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
