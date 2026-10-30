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
  | 'kis.validation';
type OperationRecord = {
  id: string;
  parentId: string | null;
  name: OperationName;
  kind: 'operation' | 'request' | 'tool';
  startedAt: number | null;
  endedAt: number | null;
  elapsedMs: number | null;
  status: 'in_progress' | 'completed' | 'failed';
  httpStatus: number | null;
  headersAt: number | null;
  firstEventAt: number | null;
  lastEventAt: number | null;
  completionEvents: number | null;
  errorEvents: number | null;
  bytes: number;
  streamEnd: 'eof' | 'read_error' | 'cancelled' | null;
  cancellationSource: CancellationSource;
  failure: { code: string; recovered: boolean; propagated: boolean } | null;
};
export type ObservedOperation = Readonly<Omit<OperationRecord, 'failure'>> & {
  readonly failure: Readonly<NonNullable<OperationRecord['failure']>> | null;
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

  constructor() {
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
  ): ObservedOperation | undefined {
    return this.attempt(() => {
      this.coverage.add(name.startsWith('auth') ? 'siwc_auth' : name.split('.')[0]);
      const operation: OperationRecord = {
        id: `op-${++this.sequence}`,
        parentId: parentId ?? null,
        name,
        kind,
        startedAt: this.now(),
        endedAt: null,
        elapsedMs: null,
        status: 'in_progress',
        httpStatus: null,
        headersAt: null,
        firstEventAt: null,
        lastEventAt: null,
        completionEvents: 0,
        errorEvents: 0,
        bytes: 0,
        streamEnd: null,
        cancellationSource: 'unknown',
        failure: null,
      };
      if (this.operations.length < 512) this.operations.push(operation);
      else this.omittedOperations++;
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
  propagate(error: unknown, cause: unknown) {
    this.attempt(() => {
      if (!error || typeof error !== 'object' || !cause || typeof cause !== 'object') return;
      const failure = this.errors.get(cause);
      if (failure) this.errors.set(error, failure);
    });
  }
  headers(token: ObservedOperation | undefined, status: number) {
    this.attempt(() => {
      const operation = token as OperationRecord | undefined;
      if (operation) {
        operation.headersAt = this.now();
        operation.httpStatus = status;
      }
    });
  }
  event(token?: ObservedOperation, completed = false, failed = false) {
    this.attempt(() => {
      const operation = token as OperationRecord | undefined;
      if (!operation) return;
      const at = this.now();
      operation.firstEventAt ??= at;
      operation.lastEventAt = at;
      if (completed && operation.completionEvents !== null) operation.completionEvents++;
      if (failed && operation.errorEvents !== null) operation.errorEvents++;
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
  observation?.headers(operation, response.status);
  if (!observation || !response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let line = '';
  let data = '';
  let discarded = false;
  const feed = (bytes: Uint8Array) => {
    if (!modelEvents) return;
    try {
      const text = decoder.decode(bytes, { stream: true });
      let offset = 0;
      while (offset < text.length) {
        const newline = text.indexOf('\n', offset);
        const fragment = text.slice(offset, newline < 0 ? text.length : newline);
        if (line.length + fragment.length > 256 * 1024) {
          observation.degrade(operation);
          discarded = true;
          line = '';
        } else if (!discarded) line += fragment;
        if (newline < 0) break;
        if (!discarded) {
          const complete = line.replace(/\r$/, '');
          if (complete === '') {
            if (data && data.trim() !== '[DONE]') {
              const event = JSON.parse(data);
              const failed = ['response.failed', 'response.incomplete', 'error'].includes(
                event?.type,
              );
              observation.event(operation, event?.type === 'response.completed', failed);
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
            reader.releaseLock();
            controller.close();
          } else {
            feed(part.value);
            observation.bytes(operation, part.value.byteLength);
            controller.enqueue(part.value);
          }
        } catch (error) {
          observation.streamEnd(operation, 'read_error', signal);
          observation.fail(operation, error, 'unknown');
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        observation.streamEnd(operation, 'cancelled', signal);
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
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
