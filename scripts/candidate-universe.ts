import { isAbsolute } from 'node:path';
import { CandidateRuntime } from './candidate-runtime.ts';
import { AuthError } from './kis-auth.ts';
import { type KisExchange, queryKis } from './kis-query.ts';
import { marketCalendar } from './market-calendar.ts';
import { assessSecurityTypes, type Security } from './security-type-assessment.ts';
import { readSiwcCredentials } from './siwc-auth.ts';

const runtime = new CandidateRuntime();
const context = { runtime };
let stage = 'input';
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
      !['--auth-dir', '--model'].includes(args[index]) ||
      !args[index + 1] ||
      options.has(args[index])
    )
      throw new Error('USAGE');
    options.set(args[index], args[index + 1]);
  }
  const directory = options.get('--auth-dir');
  const model = options.get('--model');
  if (!directory || !isAbsolute(directory) || !/^[a-zA-Z0-9._-]{1,100}$/.test(model ?? ''))
    throw new Error('USAGE');
  for (const secret of [
    process.env.KIS_APP_KEY,
    process.env.KIS_APP_SECRET,
    process.env.OPENAI_API_KEY,
  ])
    if (secret) runtime.secrets.add(secret);
  stage = 'calendar';
  const calendar = await marketCalendar({
    directory,
    model: model as string,
    history: 20,
    context,
  });
  if (!calendar.result.analysisEligible) throw new Error('MARKET_ACTIVE');
  runtime.targetOpen(calendar.result.targetSession.open);
  stage = 'ranking';
  const securities = new Map<string, Security>();
  const identities = new Map<string, string>();
  const observations: unknown[] = [];
  for (const exchange of ['NAS', 'NYS', 'AMS'] as const)
    for (const kind of ['volume', 'amount'] as const) {
      const record = await queryKis(kind, exchange, '', context);
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
      const key = `${exchange}:${row.symb}`;
      const existing = securities.get(key);
      if (
        (existing && existing.rsym !== row.rsym) ||
        (identities.has(row.rsym) && identities.get(row.rsym) !== key)
      )
        throw new Error('IDENTITY_AMBIGUOUS');
      identities.set(row.rsym, key);
      const security: Security = existing ?? {
        exchange,
        symbol: row.symb,
        rsym: row.rsym,
        rankings: [],
      };
      security.rankings?.push({
        kind,
        rank: Number(row.rank),
        requestedAt: record.requestedAt,
        source: record.source,
        row,
      });
      securities.set(key, security);
      observations.push({
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
      });
    }
  stage = 'authentication';
  const credentials = await readSiwcCredentials(directory, undefined, context);
  const secrets = [...runtime.secrets];
  stage = 'assessment';
  const assessment = await assessSecurityTypes({
    securities: [...securities.values()],
    model: model as string,
    accessToken: credentials.accessToken,
    secrets,
    inputMode: 'rankings',
    observations,
    topPerRanking: 1,
    onStage: () => {},
    context,
  });
  runtime.check();
  if (assessment.status === 'analysis_insufficient') throw new Error('ANALYSIS_INSUFFICIENT');
  stage = 'daily';
  const included = [];
  for (const security of assessment.securities.filter((security) => security.included)) {
    const daily = await queryKis(
      'daily',
      security.exchange as KisExchange,
      security.symbol,
      context,
    );
    if (daily.summary.rsym !== undefined && daily.summary.rsym !== security.rsym)
      throw new Error('IDENTITY_AMBIGUOUS');
    const rows = new Map<string, Record<string, string>>();
    for (const row of daily.rows) {
      if (!/^\d{8}$/.test(row.xymd ?? '')) throw new Error('DATA_NOT_READY');
      const date = `${row.xymd.slice(0, 4)}-${row.xymd.slice(4, 6)}-${row.xymd.slice(6, 8)}`;
      if (
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date ||
        rows.has(date)
      )
        throw new Error('DATA_NOT_READY');
      rows.set(date, row);
    }
    const requiredRows = calendar.historyDates.map((date) => {
      const row = rows.get(date);
      if (!row) throw new Error('DATA_NOT_READY');
      const number = (field: string) => {
        if (!/^\d+(?:\.\d+)?$/.test(row[field] ?? '') || !Number.isFinite(Number(row[field])))
          throw new Error('DATA_NOT_READY');
        return Number(row[field]);
      };
      const [open, high, low, close] = ['open', 'high', 'low', 'clos'].map(number);
      if (
        Math.min(open, high, low, close) <= 0 ||
        low > Math.min(open, close) ||
        high < Math.max(open, close) ||
        low > high ||
        number('tvol') < 0
      )
        throw new Error('DATA_NOT_READY');
      return row;
    });
    included.push({
      ...security,
      daily: {
        ...daily,
        rows: requiredRows,
        rowCount: requiredRows.length,
        dataSession: calendar.result.dataSession.date,
        validation: 'runtime-required-dates-and-fields',
        adjustment: 'unadjusted (MODP=0); KIS field definitions used as an operating assumption',
        units: 'provider values preserved; unverified unit or scale conversion not applied',
      },
    });
  }
  stage = 'output';
  const output = {
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
  const serialized = runtime.safe(output);
  runtime.check();
  console.log(serialized);
} catch (error) {
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
  console.error(
    JSON.stringify({
      error: code,
      stage,
      usage: runtime.counts,
      ...(failure instanceof AuthError && failure.retryAfterSeconds
        ? { retryAfterSeconds: failure.retryAfterSeconds }
        : {}),
    }),
  );
  process.exitCode = code === 'ANALYSIS_INSUFFICIENT' ? 2 : 1;
}
