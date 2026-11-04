import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recommendCandidates } from './buy-candidate-assessment.ts';
import { CandidateRuntime } from './candidate-runtime.ts';
import { CompletedDailyBars } from './completed-daily-bars.ts';
import { DiagnosticError } from './diagnostic-error.ts';
import type { ObservedOperation } from './execution-observation.ts';
import { AuthError } from './kis-auth.ts';
import { type KisExchange, queryKis } from './kis-query.ts';
import { ListedSecurities } from './listed-securities.ts';
import { marketCalendar } from './market-calendar.ts';
import { type AssessmentDiagnostics, assessSecurityTypes } from './security-type-assessment.ts';
import { readSiwcCredentials } from './siwc-auth.ts';

export async function candidateUniverse(
  directory: string,
  models: { calendar: string; types: string },
  runtime: CandidateRuntime,
  onStage: (stage: string, diagnostics?: AssessmentDiagnostics) => void,
) {
  const context = { runtime };
  onStage('calendar');
  const calendar = await marketCalendar({
    directory,
    model: models.calendar,
    history: 20,
    context,
  });
  if (!calendar.result.analysisEligible) throw new Error('MARKET_ACTIVE');
  runtime.targetOpen(calendar.result.targetSession.open);
  onStage('ranking');
  const listings = new ListedSecurities();
  for (const exchange of ['NAS', 'NYS', 'AMS'] as const)
    for (const kind of ['volume', 'amount'] as const) {
      const ranking = runtime.observation.start('ranking');
      let validation: ObservedOperation | undefined;
      try {
        const record = await queryKis(kind, exchange, '', { ...context, parentId: ranking?.id });
        validation = runtime.observation.start('ranking.validation', ranking?.id);
        listings.addRanking(
          {
            exchange,
            kind,
            requestedAt: record.requestedAt,
            receivedAt: record.receivedAt,
            source: record.source,
            request: record.request,
            rowCount: record.rowCount,
            selectedCount: 1,
            continuation: record.continuation,
            scope: 'discovery ranking at query time; not the data-session ranking',
          },
          (include) => {
            if (!record.rows.length) throw new Error('RANKING_INCOMPLETE');
            const ranks = new Set<number>();
            for (const row of record.rows) {
              const rank = Number(row.rank);
              if (
                !Number.isSafeInteger(rank) ||
                rank < 1 ||
                ranks.has(rank) ||
                !/^[A-Z0-9./^-]{1,20}$/.test(row.symb ?? '') ||
                (row.excd && row.excd !== exchange) ||
                !row.rsym
              )
                throw new Error('RANKING_FAILED');
              ranks.add(rank);
            }
            const row = record.rows.find((row) => Number(row.rank) === 1);
            if (!row) throw new Error('RANKING_INCOMPLETE');
            if (
              !(row.name?.trim() || row.ename?.trim()) ||
              ['tvol', 'tamt'].some(
                (field) =>
                  !/^\d+(?:\.\d+)?$/.test(row[field] ?? '') || !Number.isFinite(Number(row[field])),
              )
            )
              throw new Error('RANKING_FAILED');
            include({ symbol: row.symb, rsym: row.rsym, rank: Number(row.rank), row });
          },
        );
        runtime.observation.end(validation);
        runtime.observation.end(ranking);
      } catch (error) {
        if (validation?.status === 'in_progress') runtime.observation.fail(validation, error);
        runtime.observation.fail(ranking, error);
        throw error;
      }
    }
  onStage('authentication');
  const { securities, observations } = listings.snapshot();
  const credentials = await readSiwcCredentials(directory, undefined, context);
  const secrets = [...runtime.secrets];
  onStage('assessment');
  const assessment = await assessSecurityTypes({
    securities,
    model: models.types,
    accessToken: credentials.accessToken,
    secrets,
    inputMode: 'rankings',
    observations,
    topPerRanking: 1,
    onStage: (_next, _statistics, diagnostics) => onStage('assessment', diagnostics),
    context,
  });
  runtime.check();
  if (assessment.status === 'analysis_insufficient') throw new Error('ANALYSIS_INSUFFICIENT');
  onStage('daily');
  const included = [];
  for (const security of assessment.securities.filter((security) => security.included)) {
    const operation = runtime.observation.start('daily', undefined, 'operation', undefined, {
      securityCount: 1,
    });
    let validation: ObservedOperation | undefined;
    try {
      const daily = await queryKis('daily', security.exchange as KisExchange, security.symbol, {
        ...context,
        parentId: operation?.id,
      });
      validation = runtime.observation.start('daily.validation', operation?.id);
      included.push({
        ...security,
        daily: new CompletedDailyBars(
          daily,
          security,
          calendar.historyDates,
          calendar.result.dataSession.date,
        ),
      });
      runtime.observation.end(validation);
      runtime.observation.end(operation);
    } catch (error) {
      if (validation?.status === 'in_progress') runtime.observation.fail(validation, error);
      runtime.observation.fail(operation, error);
      throw error;
    }
  }
  onStage('output');
  return {
    status: included.length ? 'candidate_universe' : 'empty_candidate_universe',
    evaluatedAt: new Date(Date.now()).toISOString(),
    dataSession: calendar.result.dataSession,
    targetSession: calendar.result.targetSession,
    historyDates: calendar.historyDates,
    calendar: calendar.result,
    observations,
    securities: included,
    excluded: assessment.securities.filter((security) => !security.included),
    typeAssessment: assessment,
    limits: { ...runtime.limits, topPerRanking: 1, historySessions: 20, executionSeconds: 600 },
    usage: runtime.counts,
  };
}

export type CandidateUniverse = Awaited<ReturnType<typeof candidateUniverse>>;

export async function runCandidateCli(report = false) {
  const runtime = new CandidateRuntime();
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
  let stage = 'input';
  let outputOperation: ObservedOperation | undefined;
  const safeCodes = [
    'USAGE',
    'TARGET_OPEN',
    'EXECUTION_LIMIT',
    'REQUEST_LIMIT',
    'MARKET_ACTIVE',
    'RANKING_FAILED',
    'RANKING_INCOMPLETE',
    'IDENTITY_AMBIGUOUS',
    'DATA_NOT_READY',
    'ANALYSIS_INSUFFICIENT',
    'SENSITIVE_OUTPUT',
    'SOURCE_SHAPE',
    'SOURCE_HTTP_FAILURE',
    'CALENDAR_RANGE',
    'EXCHANGE_MISMATCH',
    'NOTICE_UNRESOLVED',
    'COLLECTION_LIMIT',
    'XML_PARSER_UNAVAILABLE',
    'PDF_PARSER_UNAVAILABLE',
    'MODEL_OUTPUT',
    'REPORT_UNSUPPORTED',
    'MODEL_INCOMPLETE',
    'MODEL_LIMIT',
    'MODEL_INPUT_LIMIT',
    'MODEL_FAILED',
    'MODEL_UNAVAILABLE',
    'AUTH_FAILED',
    'SUBSCRIPTION_LIMIT',
    'SEARCH_FAILED',
    'SEARCH_UNSUPPORTED',
    'QUERY_FAILED',
    'PAID_BUDGET_UNPROVABLE',
    'PAID_BUDGET_EXCEEDED',
    'PAID_CREDENTIALS_MISSING',
    'HTTP_FAILURE',
    'KIS_FAILURE',
    'RESPONSE_SHAPE',
    'CREDENTIALS_MISSING',
  ];
  try {
    const options = new Map<string, string>();
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 2) {
      if (
        !['--auth-dir', '--model', '--calendar-model', '--type-model'].includes(args[index]) ||
        !args[index + 1] ||
        args[index + 1].startsWith('--') ||
        options.has(args[index])
      )
        throw new Error('USAGE');
      options.set(args[index], args[index + 1]);
    }
    const directory = options.get('--auth-dir');
    const model = options.get('--model') ?? '';
    const models = {
      calendar: options.get('--calendar-model') ?? model,
      types: options.get('--type-model') ?? model,
    };
    if (
      !directory ||
      !isAbsolute(directory) ||
      [model, models.calendar, models.types].some((value) => !/^[a-zA-Z0-9._-]{1,100}$/.test(value))
    )
      throw new Error('USAGE');
    for (const secret of [
      process.env.KIS_APP_KEY,
      process.env.KIS_APP_SECRET,
      process.env.OPENAI_API_KEY,
    ])
      if (secret) runtime.secrets.add(secret);
    const universe = await candidateUniverse(directory, models, runtime, (next, diagnostics) => {
      stage = next;
      if (diagnostics) typeAssessment = diagnostics;
    });
    const output = report
      ? await recommendCandidates(universe, directory, model, runtime, (next) => {
          stage = next;
        })
      : universe;
    stage = 'output';
    outputOperation = runtime.observation.start('output');
    const serialized = runtime.safe(output);
    runtime.check();
    console.log(serialized);
    runtime.observation.end(outputOperation);
  } catch (error) {
    if (outputOperation?.status === 'in_progress') runtime.observation.fail(outputOperation, error);
    let failure = error;
    try {
      runtime.check();
    } catch (limit) {
      failure = limit;
    }
    const code =
      failure instanceof AuthError
        ? failure.message
        : failure instanceof Error &&
            (safeCodes.includes(failure.message) || /^siwc_[a-z_]+$/.test(failure.message))
          ? failure.message
          : 'REQUEST_FAILED';
    runtime.observation.finish(code, failure);
    console.error(
      JSON.stringify({
        error: code,
        stage,
        usage: runtime.counts,
        ...(runtime.paid ? { paid: runtime.paid.snapshot() } : {}),
        ...(code === 'PAID_CREDENTIALS_MISSING'
          ? {
              guidance:
                '승인된 저장소 밖 보관소의 OPENAI_API_KEY를 환경 변수로 제공한 뒤 다시 실행하세요.',
            }
          : {}),
        observation: runtime.observation.snapshot(),
        diagnostic: {
          stage,
          reason: failure instanceof DiagnosticError ? failure.reason : 'unknown',
          location: failure instanceof DiagnosticError ? failure.location : null,
          elapsedMs: Math.round(performance.now() - runtime.startedAt),
          typeAssessment,
        },
        ...(failure instanceof AuthError && failure.retryAfterSeconds
          ? { retryAfterSeconds: failure.retryAfterSeconds }
          : {}),
      }),
    );
    process.exitCode = code === 'ANALYSIS_INSUFFICIENT' ? 2 : 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runCandidateCli();
}
