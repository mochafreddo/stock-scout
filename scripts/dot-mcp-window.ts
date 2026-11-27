import { type ChildProcess, execFile } from 'node:child_process';
import { candleQuery } from './toss-candles.ts';
import { discoveryQuery } from './toss-discovery.ts';
import { priceQuery } from './toss-prices.ts';
import { isinPattern, marketPattern, usMarkets } from './toss-stock.ts';
import { laterThan, record, symbolPattern, validTime } from './toss-values.ts';

type CliResponse = Record<string, unknown> & {
  data: Record<string, unknown>[];
  omissions?: Record<string, unknown>[];
  source: Record<string, unknown>;
};

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function matchesListing(row: Record<string, unknown>, [command, symbol, market, isin]: string[]) {
  return (
    row.symbol === symbol &&
    (command !== 'stock' ||
      ((market === undefined || row.market === market) &&
        (isin === undefined || row.isinCode === (isin === '-' ? null : isin))))
  );
}

function validCliError(error: unknown, args: string[]) {
  if (!record(error)) return false;
  const { code, choices, providerCode, requestId } = error;
  return (
    Object.keys(error).every((key) =>
      ['code', 'choices', 'providerCode', 'requestId'].includes(key),
    ) &&
    typeof code === 'string' &&
    /^[A-Z][A-Z0-9_]*$/.test(code) &&
    (providerCode === undefined ||
      (typeof providerCode === 'string' && /^[a-z][a-z0-9_-]{0,79}$/.test(providerCode))) &&
    (requestId === undefined ||
      (typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(requestId))) &&
    (choices === undefined ||
      (code === 'IDENTITY_AMBIGUOUS' &&
        (args[0] === 'stock' ||
          (args[0] === 'candles' && candleQuery(args[1], args.slice(2)).date !== null)) &&
        Array.isArray(choices) &&
        choices.length > 1 &&
        choices.every(
          (choice) =>
            record(choice) &&
            matchesListing(choice, args) &&
            Object.keys(choice).length === 4 &&
            typeof choice.symbol === 'string' &&
            symbolPattern.test(choice.symbol) &&
            typeof choice.market === 'string' &&
            marketPattern.test(choice.market) &&
            (choice.name === null ||
              (typeof choice.name === 'string' && choice.name.trim().length > 0)) &&
            (choice.isinCode === null ||
              (typeof choice.isinCode === 'string' && isinPattern.test(choice.isinCode))),
        )))
  );
}

function isCliResponse(
  response: unknown,
  status: string | undefined,
  args: string[],
): response is CliResponse {
  if (
    status === undefined ||
    !record(response) ||
    response.version !== 1 ||
    response.status !== status ||
    !Array.isArray(response.data) ||
    !response.data.every(record) ||
    !record(response.source) ||
    response.source.provider !== 'tossinvest' ||
    !validTime(response.retrievedAt)
  )
    return false;
  const { omissions, error } = response;
  if (status === 'error')
    return (
      validCliError(error, args) &&
      (omissions === undefined || (Array.isArray(omissions) && !omissions.length))
    );
  return (
    error === undefined &&
    Array.isArray(omissions) &&
    omissions.every((item) => record(item) && nonempty(item.reason)) &&
    (status === 'partial' ? omissions.length > 0 : omissions.length === 0)
  );
}

function readinessState({ source, data, error }: CliResponse, exitCode: number) {
  const row = data[0];
  if (
    !(
      source.endpoint === 'local:readiness' ||
      (exitCode === 1 && Object.keys(source).length === 1)
    ) ||
    data.length !== 1 ||
    !Array.isArray(row.reasons) ||
    !row.reasons.every(nonempty)
  )
    return;
  const observedToken = ['missing', 'expired', 'refresh_required', 'valid'].some(
    (v) => v === row.token,
  );
  const { reasons, readiness } = row;
  if (exitCode === 0 && readiness === 'ready' && observedToken && !reasons.length) return readiness;
  if (exitCode !== 1 || !reasons.length || !record(error) || reasons[0] !== error.code) return;
  const observedReasons = ['AUTH_ISSUANCE_UNKNOWN', 'WAIT_REQUIRED', 'LOCK_PRESENT'];
  if (
    row.token === 'unknown' &&
    reasons.length === 1 &&
    !observedReasons.includes(reasons[0]) &&
    readiness === (error.code === 'AUTH_STATE_TRANSITION_REQUIRED' ? 'blocked' : 'unavailable')
  )
    return readiness;
  if (
    observedToken &&
    readiness === 'blocked' &&
    reasons.every((reason) => observedReasons.includes(reason))
  )
    return readiness;
}

function matchesCandlePage(response: CliResponse, before: string | null) {
  const { page, omissions = [], status } = response;
  if (!record(page)) return false;
  const hasNext = omissions.some(({ reason }) => reason === 'next_page');
  const unknown = omissions.some(({ reason }) => reason === 'pagination_unknown');
  const { nextBefore } = page;
  if (nextBefore === null) return !hasNext && !unknown;
  if (status !== 'partial') return false;
  if (nextBefore === undefined) return unknown && !hasNext;
  return (
    typeof nextBefore === 'string' &&
    validTime(nextBefore) &&
    (before === null || !laterThan(nextBefore, before)) &&
    hasNext &&
    !unknown
  );
}

function matchesMarketQuery(response: CliResponse, args: string[]) {
  const { source, data, status, omissions = [] } = response;
  const [command, target] = args;
  if (status === 'error') {
    if (data.length) return false;
    if (Object.keys(source).length === 1) return true;
  }
  switch (command) {
    case 'prices': {
      if (source.endpoint !== '/api/v1/prices') return false;
      if (!data.length && !omissions.length) return true;
      const { symbols, staleAfterSeconds } = priceQuery(target, args.slice(2));
      const remaining = new Set(symbols.split(','));
      for (const { symbol, priceAge } of data) {
        if (
          typeof symbol !== 'string' ||
          !remaining.delete(symbol) ||
          !record(priceAge) ||
          priceAge.thresholdSeconds !== staleAfterSeconds
        )
          return false;
      }
      for (const { reason, symbol } of omissions) {
        if (reason === 'missing_item' && (typeof symbol !== 'string' || !remaining.delete(symbol)))
          return false;
      }
      return remaining.size === 0;
    }
    case 'stock':
      return (
        source.endpoint === '/api/v1/stocks' &&
        (status === 'error' || (data.length === 1 && matchesListing(data[0], args)))
      );
    case 'rankings': {
      const expected = discoveryQuery(command, target, args.slice(2)).source;
      return (
        source.endpoint === '/api/v1/rankings' &&
        Object.entries(expected).every(([key, value]) => source[key] === value)
      );
    }
    case 'candles': {
      const request = candleQuery(target, args.slice(2));
      const expected: Record<string, unknown> = request.source;
      return (
        source.endpoint === '/api/v1/candles' &&
        ['symbol', 'interval', 'count', 'adjusted', 'date', 'dateTimeZone', 'before'].every(
          (key) => source[key] === expected[key],
        ) &&
        (status === 'error' ||
          ((request.date === null ||
            (typeof source.market === 'string' && usMarkets.has(source.market))) &&
            matchesCandlePage(response, request.query.get('before'))))
      );
    }
    case 'sessions':
      return (
        source.endpoint === '/api/v1/market-calendar/US' &&
        source.date === target &&
        !Object.hasOwn(source, 'symbol')
      );
    default:
      return false;
  }
}

function queryResult(payload: object, isError: boolean) {
  return { payload, isError, text: JSON.stringify(payload) };
}

export class DotWindow {
  private tail?: Promise<void>;
  private child?: ChildProcess;
  private starts = 0;
  private closed = false;
  private readonly launcher: string;
  private readonly isOpen: () => boolean;
  private readonly report: (status: string, code?: string) => void;
  private readonly onCleanupDeadline: () => void;
  constructor(
    launcher: string,
    isOpen: () => boolean,
    report: (status: string, code?: string) => void,
    onCleanupDeadline: () => void,
  ) {
    this.launcher = launcher;
    this.isOpen = isOpen;
    this.report = report;
    this.onCleanupDeadline = onCleanupDeadline;
  }
  async query(args: string[], isConnected: () => boolean) {
    const previous = this.tail;
    const slot = Promise.withResolvers<void>();
    this.tail = slot.promise;
    try {
      if (previous) {
        this.report('queued');
        await previous;
      }
      return await this.executeQuery(args, isConnected);
    } finally {
      if (this.tail === slot.promise) this.tail = undefined;
      slot.resolve();
    }
  }
  private execute(
    args: string[],
    onStart?: () => void,
  ): Promise<{ exitCode: number; response: CliResponse }> {
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const child = execFile(
        this.launcher,
        args,
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          clearTimeout(timeout);
          clearTimeout(deadline);
          this.child = undefined;
          if (timedOut) return reject(new Error('CLI_RESULT_UNAVAILABLE'));
          const exitCode = error ? error.code : 0;
          try {
            const response: unknown = JSON.parse(stdout);
            if (
              typeof exitCode !== 'number' ||
              !isCliResponse(response, ['success', 'error', 'partial'][exitCode], args)
            )
              throw new Error();
            resolve({ exitCode, response });
          } catch {
            reject(new Error('CLI_RESULT_UNAVAILABLE'));
          }
        },
      );
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, 70000).unref();
      const deadline = setTimeout(() => {
        this.onCleanupDeadline();
        this.terminate('SIGKILL');
      }, 75000).unref();
      this.child = child;
      if (onStart) child.once('spawn', onStart);
    });
  }
  terminate(signal: NodeJS.Signals) {
    const child = this.child;
    if (!child) return;
    child.kill(signal);
    if (signal === 'SIGKILL') {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
  }
  close() {
    this.closed = true;
    return this.tail;
  }
  private rejection(isConnected: () => boolean) {
    if (!isConnected()) return 'CONNECTION_CLOSED';
    if (this.closed || !this.isOpen()) return 'WINDOW_CLOSED';
    if (this.starts >= 16) return 'SESSION_BUDGET';
  }
  private rejected(code: string) {
    this.report('rejected', code);
    return queryResult({ stage: 'admission', error: { code } }, true);
  }
  private async executeQuery(args: string[], isConnected: () => boolean) {
    let stage = 'readiness';
    try {
      const beforeReadiness = this.rejection(isConnected);
      if (beforeReadiness) return this.rejected(beforeReadiness);
      const ready = await this.execute(['readiness']);
      const readiness = readinessState(ready.response, ready.exitCode);
      if (!readiness) throw new Error('Invalid readiness result');
      if (ready.exitCode !== 0) {
        this.report(
          'ready_blocked',
          readiness === 'unavailable' ? 'READINESS_UNAVAILABLE' : 'READINESS_BLOCKED',
        );
        return queryResult({ stage, ...ready }, true);
      }
      stage = 'query';
      const beforeStart = this.rejection(isConnected);
      if (beforeStart) return this.rejected(beforeStart);
      const output = await this.execute(args, () => {
        this.starts++;
      });
      if (!matchesMarketQuery(output.response, args)) throw new Error('Invalid market result');
      this.report(
        ['success', 'query_error', 'partial'][output.exitCode],
        output.exitCode === 1 ? 'QUERY_ERROR' : undefined,
      );
      return queryResult({ stage, ...output }, output.exitCode === 1);
    } catch {
      this.report('result_unavailable', 'CLI_RESULT_UNAVAILABLE');
      return queryResult({ stage, error: { code: 'CLI_RESULT_UNAVAILABLE' } }, true);
    }
  }
}
