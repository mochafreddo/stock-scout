export type CancellationSource =
  | 'execution_limit'
  | 'target_open'
  | 'stage_limit'
  | 'request_limit'
  | 'unknown';
type OperationName =
  | 'calendar'
  | 'calendar.collection'
  | 'calendar.official.http'
  | 'calendar.official.body'
  | 'calendar.official.cancel'
  | 'http.cancel'
  | 'http.release'
  | 'calendar.parse'
  | 'calendar.model'
  | 'calendar.model.http'
  | 'calendar.validation'
  | 'output'
  | 'ranking'
  | 'ranking.validation'
  | 'daily'
  | 'daily.validation'
  | 'auth'
  | 'auth.lock'
  | 'auth.load'
  | 'auth.reuse'
  | 'auth.refresh'
  | 'auth.refresh.http'
  | 'auth.validation'
  | 'auth.identity'
  | 'auth.identity.http'
  | 'auth.store'
  | 'auth.unlock'
  | 'types'
  | 'types.model'
  | 'types.model.http'
  | 'types.info_tool'
  | 'types.web_tool'
  | 'types.validation'
  | 'recommendation'
  | 'recommendation.model'
  | 'recommendation.model.http'
  | 'recommendation.tool'
  | 'recommendation.validation'
  | 'review'
  | 'review.model.http'
  | 'kis'
  | 'kis.auth'
  | 'kis.auth.lock'
  | 'kis.auth.load'
  | 'kis.auth.reuse'
  | 'kis.auth.invalidate'
  | 'kis.auth.issuance'
  | 'kis.auth.issuance.http'
  | 'kis.auth.validation'
  | 'kis.auth.store'
  | 'kis.auth.unlock'
  | 'kis.http'
  | 'kis.retry_wait'
  | 'kis.validation';
type OperationRecord = {
  id: string;
  parentId: string | null;
  relatedRequestId?: string;
  name: OperationName;
  kind: 'operation' | 'request' | 'tool';
  startedAt: number | null;
  endedAt: number | null;
  elapsedMs: number | null;
  executionRemainingMs: number | null;
  stageRemainingMs: number | null;
  requestRemainingMs: number | null;
  inputBytes: number | null;
  securityCount: number | null;
  rowCount: number | null;
  status: 'in_progress' | 'completed' | 'failed';
  httpStatus: number | null;
  responseFormat: 'event_stream' | 'json' | 'other' | 'missing' | null;
  headersAt: number | null;
  firstEventAt: number | null;
  lastEventAt: number | null;
  completionEvents: number | null;
  errorEvents: number | null;
  eventCounts: Record<'reasoning' | 'output_text' | 'lifecycle' | 'other', number> | null;
  bytes: number;
  streamEnd: 'eof' | 'read_error' | 'cancelled' | null;
  cancellationSource: CancellationSource;
  kis?: {
    kind: string;
    exchange: string;
    symbol: string | null;
    bodyParsed: boolean;
    providerCode: string | null;
  };
  failure: { code: string; recovered: boolean; propagated: boolean } | null;
};
type StartMeasurements = Partial<
  Pick<
    OperationRecord,
    'stageRemainingMs' | 'requestRemainingMs' | 'inputBytes' | 'securityCount' | 'rowCount'
  >
>;
export type ObservedOperation = Readonly<
  Omit<OperationRecord, 'failure' | 'eventCounts' | 'kis'>
> & {
  readonly kis?: Readonly<NonNullable<OperationRecord['kis']>>;
  readonly failure: Readonly<NonNullable<OperationRecord['failure']>> | null;
  readonly eventCounts: Readonly<NonNullable<OperationRecord['eventCounts']>> | null;
};

const codes = new Set([
  'USAGE',
  'TARGET_OPEN',
  'EXECUTION_LIMIT',
  'REQUEST_LIMIT',
  'MARKET_ACTIVE',
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
  'SENSITIVE_OUTPUT',
  'REQUEST_FAILED',
  'RANKING_FAILED',
  'RANKING_INCOMPLETE',
  'IDENTITY_AMBIGUOUS',
  'DATA_NOT_READY',
  'ANALYSIS_INSUFFICIENT',
  'REPORT_UNSUPPORTED',
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
  'AUTH_COOLDOWN',
  'AUTH_LOCKED',
  'AUTH_RECORD',
  'AUTH_STORAGE',
  'siwc_refresh_cancelled',
  'siwc_invalid_credentials',
  'siwc_relogin_required',
  'siwc_refresh_not_allowed',
  'siwc_invalid_refresh_time',
  'siwc_session_locked',
  'siwc_invalid_response',
  'siwc_invalid_identity',
  'siwc_account_mismatch',
  'siwc_credentials_expired',
  'siwc_refresh_failed',
  'siwc_authentication_failed',
  'siwc_client_configuration',
]);
export function observationCode(error: unknown) {
  try {
    return error instanceof Error && codes.has(error.message) ? error.message : 'unknown';
  } catch {
    return 'unknown';
  }
}
const sources = new WeakMap<AbortSignal, () => CancellationSource>();
export function tagSignal(signal: AbortSignal, source: () => CancellationSource) {
  let observed: CancellationSource = 'unknown';
  const capture = () => {
    observed = source();
  };
  if (signal.aborted) capture();
  else signal.addEventListener('abort', capture, { once: true });
  sources.set(signal, () => observed);
  return signal;
}
export function cancellationSource(signal?: AbortSignal | null): CancellationSource {
  return signal?.aborted ? (sources.get(signal)?.() ?? 'unknown') : 'unknown';
}

export class ExecutionObservation {
  private operations: OperationRecord[] = [];
  private sequence = 0;
  private origin: number | null = null;
  private errors = new WeakMap<object, { operationId: string | null; code: string }>();
  private firstFailure: OperationRecord | null = null;
  private finalError: { code: string; operationId: string | null } | null = null;
  private omittedOperations = 0;
  private degraded = false;
  private runId = 'unknown';
  private coverage = new Set<string>();
  private startedAt: string | null = null;
  private stages: OperationRecord[] = [];
  private modelRequests: OperationRecord[] = [];
  private executionRemaining?: () => number;

  constructor(executionRemaining?: () => number) {
    this.executionRemaining = executionRemaining;
    this.attempt(() => {
      this.runId = crypto.randomUUID();
      this.origin = performance.now();
      this.startedAt = new Date(Date.now()).toISOString();
    });
  }
  private attempt<T>(action: () => T): T | undefined {
    try {
      return action();
    } catch {
      this.degraded = true;
      return undefined;
    }
  }
  degrade(token?: ObservedOperation) {
    const operation = token as OperationRecord | undefined;
    this.degraded = true;
    if (operation) operation.completionEvents = null;
    if (operation) operation.errorEvents = null;
    if (operation) operation.eventCounts = null;
  }
  private now() {
    return (
      this.attempt(() =>
        this.origin === null ? null : Math.max(0, Math.round(performance.now() - this.origin)),
      ) ?? null
    );
  }
  start(
    name: OperationName,
    parentId?: string | null,
    kind: ObservedOperation['kind'] = 'operation',
    relatedRequestId?: string,
    measurements: StartMeasurements = {},
  ): ObservedOperation | undefined {
    return this.attempt(() => {
      const count = (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0
          ? Math.floor(value)
          : null;
      const remaining = (value: unknown, maximum: number | null) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
        return Math.max(0, Math.floor(Math.min(value, maximum ?? Infinity)));
      };
      const executionRemainingMs = remaining(this.executionRemaining?.(), null);
      const stageRemainingMs = remaining(measurements.stageRemainingMs, executionRemainingMs);
      this.coverage.add(name.startsWith('auth') ? 'siwc_auth' : name.split('.')[0]);
      const operation: OperationRecord = {
        id: `op-${++this.sequence}`,
        parentId: parentId ?? null,
        ...(relatedRequestId ? { relatedRequestId } : {}),
        name,
        kind,
        startedAt: this.now(),
        endedAt: null,
        elapsedMs: null,
        executionRemainingMs,
        stageRemainingMs,
        requestRemainingMs: remaining(
          measurements.requestRemainingMs,
          stageRemainingMs ?? executionRemainingMs,
        ),
        inputBytes: count(measurements.inputBytes),
        securityCount: count(measurements.securityCount),
        rowCount: count(measurements.rowCount),
        status: 'in_progress',
        httpStatus: null,
        responseFormat: null,
        headersAt: null,
        firstEventAt: null,
        lastEventAt: null,
        completionEvents: 0,
        errorEvents: 0,
        eventCounts: null,
        bytes: 0,
        streamEnd: null,
        cancellationSource: 'unknown',
        failure: null,
      };
      if (this.operations.length < 512) this.operations.push(operation);
      else this.omittedOperations++;
      if (
        [
          'auth',
          'calendar',
          'calendar.collection',
          'calendar.model',
          'ranking',
          'types',
          'types.model',
          'daily',
          'recommendation',
          'recommendation.model',
          'review',
          'output',
        ].includes(name)
      )
        this.stages.push(operation);
      if (kind === 'request' && name.endsWith('.model.http')) this.modelRequests.push(operation);
      return operation;
    });
  }
  end(token?: ObservedOperation) {
    this.attempt(() => {
      const operation = token as OperationRecord | undefined;
      if (!operation) return;
      operation.endedAt ??= this.now();
      operation.elapsedMs =
        operation.startedAt === null || operation.endedAt === null
          ? null
          : Math.max(0, operation.endedAt - operation.startedAt);
      if (!operation.failure) operation.status = 'completed';
    });
  }
  fail(token: ObservedOperation | undefined, error: unknown, code?: string, ended = true) {
    this.attempt(() => {
      const operation = token as OperationRecord | undefined;
      const previous = error && typeof error === 'object' ? this.errors.get(error) : undefined;
      const failureCode = previous?.code ?? code ?? observationCode(error);
      if (!operation) {
        if (error && typeof error === 'object' && !previous)
          this.errors.set(error, {
            operationId: null,
            code: codes.has(failureCode) ? failureCode : 'unknown',
          });
        return;
      }
      operation.status = 'failed';
      operation.failure ??= {
        code: codes.has(failureCode) ? failureCode : 'unknown',
        recovered: false,
        propagated: false,
      };
      if (!this.firstFailure) this.firstFailure = operation;
      if (error && typeof error === 'object' && !previous?.operationId)
        this.errors.set(error, { operationId: operation.id, code: operation.failure.code });
      if (!this.operations.includes(operation)) {
        let replace = this.operations.findIndex(
          (row) => !row.failure && row.id !== this.finalError?.operationId,
        );
        if (replace < 0)
          replace = this.operations.findIndex(
            (row) => row !== this.firstFailure && row.id !== this.finalError?.operationId,
          );
        if (replace >= 0) this.operations.splice(replace, 1, operation);
      }
      if (ended) this.end(operation);
    });
  }
  recover(token?: ObservedOperation) {
    this.attempt(() => {
      const operation = token as OperationRecord | undefined;
      if (operation?.failure) operation.failure.recovered = true;
    });
  }
  kisFailure(
    token: ObservedOperation | undefined,
    request: { kind: string; exchange: string; symbol: string },
    bodyParsed: boolean,
    providerCode: unknown,
    secrets: Iterable<string>,
  ) {
    this.attempt(() => {
      const operation = token as OperationRecord | undefined;
      if (operation?.name !== 'kis.http') return;
      if (!['volume', 'amount', 'daily', 'info'].includes(request.kind)) return;
      if (!['NAS', 'NYS', 'AMS'].includes(request.exchange)) return;
      const sensitive = [...secrets].filter(Boolean);
      const safe = (value: unknown, pattern: RegExp) =>
        typeof value === 'string' &&
        pattern.test(value) &&
        !sensitive.some((secret) => value.includes(secret))
          ? value
          : null;
      operation.kis = {
        kind: request.kind,
        exchange: request.exchange,
        symbol: safe(request.symbol, /^[A-Z0-9./^-]{1,20}$/),
        bodyParsed,
        providerCode: safe(providerCode, /^[A-Z0-9]{1,20}$/),
      };
    });
  }
  propagate(error: unknown, cause: unknown) {
    this.attempt(() => {
      if (!error || typeof error !== 'object' || !cause || typeof cause !== 'object') return;
      const failure = this.errors.get(cause);
      if (failure) this.errors.set(error, failure);
    });
  }
  headers(token: ObservedOperation | undefined, status: number, contentType?: string | null) {
    this.attempt(() => {
      const operation = token as OperationRecord | undefined;
      if (operation) {
        operation.headersAt = this.now();
        operation.httpStatus = status;
        if (contentType !== undefined) {
          const mediaType = contentType?.split(';')[0].trim().toLowerCase();
          operation.responseFormat =
            mediaType === 'text/event-stream'
              ? 'event_stream'
              : mediaType === 'application/json' || mediaType?.endsWith('+json')
                ? 'json'
                : mediaType
                  ? 'other'
                  : 'missing';
        }
      }
    });
  }
  event(
    token?: ObservedOperation,
    completed = false,
    failed = false,
    kind?: keyof NonNullable<OperationRecord['eventCounts']>,
  ) {
    this.attempt(() => {
      const operation = token as OperationRecord | undefined;
      if (!operation) return;
      const at = this.now();
      operation.firstEventAt ??= at;
      operation.lastEventAt = at;
      if (completed && operation.completionEvents !== null) operation.completionEvents++;
      if (failed && operation.errorEvents !== null) operation.errorEvents++;
      if (kind && operation.completionEvents !== null) {
        operation.eventCounts ??= { reasoning: 0, output_text: 0, lifecycle: 0, other: 0 };
        operation.eventCounts[kind]++;
      }
    });
  }
  bytes(token: ObservedOperation | undefined, bytes: number) {
    this.attempt(() => {
      const operation = token as OperationRecord | undefined;
      if (operation && Number.isSafeInteger(bytes) && bytes > 0) operation.bytes += bytes;
    });
  }
  streamEnd(
    token: ObservedOperation | undefined,
    end: ObservedOperation['streamEnd'],
    signal?: AbortSignal | null,
  ) {
    this.attempt(() => {
      const operation = token as OperationRecord | undefined;
      if (!operation) return;
      if (operation.streamEnd !== null) return;
      operation.streamEnd = signal?.aborted ? 'cancelled' : end;
      operation.cancellationSource = cancellationSource(signal);
      this.end(operation);
    });
  }
  finish(code: string, error?: unknown) {
    this.attempt(() => {
      const operationId =
        error && typeof error === 'object' ? (this.errors.get(error)?.operationId ?? null) : null;
      this.finalError = { code: codes.has(code) ? code : 'unknown', operationId };
      let operation = this.operations.find((row) => row.id === operationId);
      while (operation) {
        if (operation.failure && !operation.failure.recovered) operation.failure.propagated = true;
        operation = this.operations.find((row) => row.id === operation?.parentId);
      }
    });
  }
  snapshot() {
    const summarize = (row: OperationRecord) => ({
      id: row.id,
      parentId: row.parentId,
      name: row.name,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      elapsedMs: row.elapsedMs,
      executionRemainingMs: row.executionRemainingMs,
      stageRemainingMs: row.stageRemainingMs,
      requestRemainingMs: row.requestRemainingMs,
      inputBytes: row.inputBytes,
      securityCount: row.securityCount,
      rowCount: row.rowCount,
      status: row.status,
      failure: row.failure,
      ...(row.kind === 'request'
        ? {
            httpStatus: row.httpStatus,
            headersAt: row.headersAt,
            firstEventAt: row.firstEventAt,
            lastEventAt: row.lastEventAt,
            completionEvents: row.completionEvents,
            errorEvents: row.errorEvents,
            eventCounts: row.eventCounts,
            bytes: row.bytes,
            streamEnd: row.streamEnd,
            cancellationSource: row.cancellationSource,
          }
        : {}),
    });
    const summaries = () => ({
      stages: this.stages.map(summarize),
      modelRequests: this.modelRequests.map(summarize),
    });
    return (
      this.attempt(() => {
        const operations = [...this.operations];
        const elapsedMs = this.now();
        let omittedOperations = this.omittedOperations;
        const project = () => ({
          runId: this.runId,
          startedAt: this.startedAt,
          elapsedMs,
          degraded: this.degraded,
          truncated: omittedOperations > 0,
          omittedOperations,
          coverage: [...this.coverage],
          firstFailure: this.firstFailure
            ? {
                operationId: this.firstFailure.id,
                code: this.firstFailure.failure?.code ?? 'unknown',
                recovered: this.firstFailure.failure?.recovered ?? false,
                propagated: this.firstFailure.failure?.propagated ?? false,
              }
            : null,
          finalError: this.finalError,
          summaries: summaries(),
          operations,
        });
        while (Buffer.byteLength(JSON.stringify(project())) > 256 * 1024 && operations.length) {
          let index = operations.findIndex(
            (row) => !row.failure && row.id !== this.finalError?.operationId,
          );
          if (index < 0)
            index = operations.findIndex(
              (row) => row !== this.firstFailure && row.id !== this.finalError?.operationId,
            );
          if (index < 0) break;
          operations.splice(index, 1);
          omittedOperations++;
        }
        return project();
      }) ?? {
        degraded: true,
        truncated: true,
        omittedOperations:
          this.omittedOperations + this.operations.length - (this.firstFailure ? 1 : 0),
        firstFailure: this.firstFailure
          ? {
              operationId: this.firstFailure.id,
              code: this.firstFailure.failure?.code ?? 'unknown',
              recovered: this.firstFailure.failure?.recovered ?? false,
              propagated: this.firstFailure.failure?.propagated ?? false,
            }
          : null,
        finalError: this.finalError,
        summaries: summaries(),
        operations: this.firstFailure ? [this.firstFailure] : [],
      }
    );
  }
}

export async function observeFetch(
  input: string | URL | Request,
  init: RequestInit,
  observation?: ExecutionObservation,
  operation?: ObservedOperation,
) {
  try {
    return await fetch(input, init);
  } catch (error) {
    observation?.streamEnd(operation, 'read_error', init.signal);
    observation?.fail(operation, error, 'unknown');
    throw error;
  }
}

export function observeResponse(
  response: Response,
  observation?: ExecutionObservation,
  operation?: ObservedOperation,
  signal?: AbortSignal | null,
  modelEvents = false,
) {
  observation?.headers(operation, response.status, response.headers.get('content-type'));
  if (!observation || !response.body) return response;
  const reader = response.body.getReader();
  const releaseReader = () => {
    const cleanup = observation.start(
      'http.release',
      operation?.parentId,
      'operation',
      operation?.id,
    );
    try {
      reader.releaseLock();
      observation.end(cleanup);
    } catch (error) {
      observation.fail(cleanup, error, 'unknown');
      throw error;
    }
  };
  const decoder = new TextDecoder();
  let line = '';
  let data = '';
  let discarded = false;
  let skipLineFeed = false;
  const feed = (bytes: Uint8Array) => {
    if (!modelEvents || !response.ok) return;
    try {
      const text = decoder.decode(bytes, { stream: true });
      const lineEnd = /[\r\n]/g;
      let offset = 0;
      while (offset < text.length) {
        if (skipLineFeed) {
          skipLineFeed = false;
          if (text[offset] === '\n') {
            offset++;
            continue;
          }
        }
        lineEnd.lastIndex = offset;
        const newline = lineEnd.exec(text)?.index ?? -1;
        const fragment = text.slice(offset, newline < 0 ? text.length : newline);
        if (line.length + fragment.length > 256 * 1024) {
          observation.degrade(operation);
          discarded = true;
          line = '';
        } else if (!discarded) line += fragment;
        if (newline < 0) break;
        if (!discarded) {
          const complete = line;
          if (complete === '') {
            if (data && data.trim() !== '[DONE]') {
              const event = JSON.parse(data);
              const failed = ['response.failed', 'response.incomplete', 'error'].includes(
                event?.type,
              );
              const type = typeof event?.type === 'string' ? event.type : '';
              const kind =
                type.startsWith('response.reasoning') || event?.item?.type === 'reasoning'
                  ? 'reasoning'
                  : type.startsWith('response.output_text.')
                    ? 'output_text'
                    : [
                          'response.created',
                          'response.in_progress',
                          'response.output_item.added',
                          'response.output_item.done',
                          'response.content_part.added',
                          'response.content_part.done',
                          'response.completed',
                          'response.incomplete',
                          'response.failed',
                          'error',
                        ].includes(type)
                      ? 'lifecycle'
                      : 'other';
              observation.event(operation, type === 'response.completed', failed, kind);
              if (failed)
                observation.fail(
                  operation,
                  new Error('MODEL_INCOMPLETE'),
                  'MODEL_INCOMPLETE',
                  false,
                );
            }
            data = '';
          } else if (complete.startsWith('data:')) {
            if (data.length + complete.length > 256 * 1024) {
              observation.degrade(operation);
              data = '';
              discarded = true;
            } else data += `${complete.slice(5).replace(/^ /, '')}\n`;
          }
        } else if (line === '' && fragment.replace(/\r$/, '') === '') {
          discarded = false;
          data = '';
        }
        skipLineFeed = text[newline] === '\r';
        line = '';
        offset = newline + 1;
      }
    } catch {
      observation.degrade(operation);
      line = '';
      data = '';
    }
  };
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) {
            observation.streamEnd(operation, 'eof', signal);
            releaseReader();
            controller.close();
          } else {
            feed(part.value);
            observation.bytes(operation, part.value.byteLength);
            controller.enqueue(part.value);
          }
        } catch (error) {
          observation.streamEnd(operation, 'read_error', signal);
          observation.fail(operation, error, 'unknown');
          releaseReader();
          controller.error(error);
        }
      },
      async cancel(reason) {
        observation.streamEnd(operation, 'cancelled', signal);
        const cleanup = observation.start(
          'http.cancel',
          operation?.parentId,
          'operation',
          operation?.id,
        );
        try {
          await reader.cancel(reason);
          observation.end(cleanup);
        } catch (error) {
          observation.fail(cleanup, error, 'unknown');
          throw error;
        } finally {
          releaseReader();
        }
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
