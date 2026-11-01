import { AsyncLocalStorage } from 'node:async_hooks';
import { APICallError, type LanguageModelMiddleware } from 'ai';
import {
  type ExecutionObservation,
  type ObservedOperation,
  observeFetch,
  observeResponse,
} from './execution-observation.ts';

export type ModelRequestCause =
  | 'unknown'
  | 'missing_completion'
  | 'duplicate_completion'
  | 'deadline_exceeded'
  | 'provider_failed'
  | 'provider_incomplete'
  | 'provider_error'
  | 'transport_error'
  | 'http_error';
type RequestRecord = {
  index: number;
  elapsedMs: number;
  httpStatus: number | null;
  completionEvents: number | null;
  status: 'unknown' | 'completed' | 'failed' | 'cancelled';
  cause: ModelRequestCause;
};
export type ModelRequest = Readonly<RequestRecord>;
type RequestState = {
  record: RequestRecord;
  operation?: ObservedOperation;
  signal: AbortSignal;
  startedAt: number;
  failed: boolean;
  consumed: boolean;
};

export class ModelExecution {
  private scope = new AsyncLocalStorage<{ request?: RequestState }>();
  private states = new Map<ModelRequest, RequestState>();
  private currentFailure: Error | undefined;
  private observedFailure: unknown;

  private options: {
    policy: 'calendar' | 'types' | 'recommendation';
    observation?: ExecutionObservation;
    incomplete: () => Error;
    providerError?: (code: string | undefined) => Error;
    sdkError?: (error: unknown) => Error;
    expired?: () => boolean;
    onRequest?: (request: ModelRequest) => void;
    onRaw?: (value: unknown, request: ModelRequest) => void;
    onCause?: (cause: ModelRequestCause) => void;
  };

  constructor(options: ModelExecution['options']) {
    this.options = options;
  }

  get failure() {
    return this.currentFailure;
  }
  get observationFailure() {
    return this.observedFailure;
  }
  get completions() {
    return [...this.states.values()].reduce(
      (count, { record }) =>
        count +
        (this.options.policy === 'types'
          ? Number((record.completionEvents ?? 0) > 0)
          : (record.completionEvents ?? 0)),
      0,
    );
  }
  fail(error: Error, overwrite = true, request?: ModelRequest) {
    if (overwrite || !this.currentFailure) this.currentFailure = error;
    if (request) this.cause('unknown', this.states.get(request));
    return error;
  }
  resetFailure() {
    this.currentFailure = undefined;
  }
  operation(request: ModelRequest) {
    return this.states.get(request)?.operation;
  }
  private cause(cause: ModelRequestCause, state?: RequestState) {
    this.options.onCause?.(cause);
    if (state && !state.failed) {
      state.failed = true;
      state.record.cause = cause;
    }
  }
  private closeRequest(state: RequestState, status: RequestRecord['status']) {
    if (state.record.status !== 'unknown') return;
    state.record.elapsedMs = Math.round(performance.now() - state.startedAt);
    state.record.status = status;
    if (this.options.policy === 'types') {
      if (status === 'failed' || status === 'cancelled') {
        this.observedFailure = this.failure ?? this.options.incomplete();
        this.options.observation?.fail(state.operation, this.observedFailure);
      }
      this.options.observation?.end(state.operation);
    }
  }

  async fetch(
    url: Parameters<typeof fetch>[0],
    init: RequestInit,
    signal: AbortSignal,
    operation?: ObservedOperation,
    index = this.states.size + 1,
  ) {
    const state: RequestState = {
      record: {
        index,
        elapsedMs: 0,
        httpStatus: null,
        completionEvents: null,
        status: 'unknown',
        cause: 'unknown',
      },
      operation,
      signal,
      startedAt: performance.now(),
      failed: false,
      consumed: false,
    };
    this.states.set(state.record, state);
    const scope = this.scope.getStore();
    if (scope) scope.request = state;
    this.options.onRequest?.(state.record);
    const observation = this.options.observation;
    try {
      const response = observeResponse(
        await observeFetch(url, init, observation, operation),
        observation,
        operation,
        signal,
        true,
      );
      state.record.httpStatus = response.status;
      if (!response.ok) this.cause('http_error', state);
      if (!response.body || this.options.policy !== 'types') return response;
      const reader = response.body.getReader();
      return new Response(
        new ReadableStream({
          pull: async (controller) => {
            try {
              const next = await reader.read();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            } catch (error) {
              if (!signal.aborted) this.cause('transport_error', state);
              controller.error(error);
            }
          },
          cancel: (reason) => reader.cancel(reason),
        }),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
    } catch (error) {
      this.observedFailure = error;
      observation?.streamEnd(operation, 'read_error', signal);
      observation?.fail(operation, error);
      if (signal.aborted) {
        if (this.options.expired?.()) this.cause('deadline_exceeded', state);
        this.closeRequest(state, 'cancelled');
      } else {
        this.cause('transport_error', state);
        this.closeRequest(state, 'failed');
      }
      throw error;
    }
  }

  private raw(value: unknown, state: RequestState) {
    const { record, operation } = state;
    record.completionEvents ??= 0;
    this.options.onRaw?.(value, record);
    const raw = value as {
      type?: string;
      code?: string;
      error?: { code?: string };
      response?: { error?: { code?: string } };
    };
    if (raw.type === 'response.completed') {
      record.completionEvents++;
      if (record.completionEvents > 1) {
        this.cause('duplicate_completion', state);
        this.fail(this.options.incomplete());
      }
      if (this.failure && this.options.policy === 'types') {
        this.observedFailure = this.failure;
        this.options.observation?.fail(operation, this.failure, undefined, false);
      }
    }
    if (['response.failed', 'response.incomplete', 'error'].includes(raw.type ?? '')) {
      this.cause(
        raw.type === 'response.failed'
          ? 'provider_failed'
          : raw.type === 'response.incomplete'
            ? 'provider_incomplete'
            : 'provider_error',
        state,
      );
      const code = raw.response?.error?.code ?? raw.error?.code ?? raw.code;
      this.fail(this.options.providerError?.(code) ?? this.options.incomplete());
      if (this.options.policy === 'types') {
        this.observedFailure = this.failure;
        this.options.observation?.fail(operation, this.failure, undefined, false);
      }
    }
  }
  private sdkError(error: unknown, state?: RequestState) {
    if (this.options.policy === 'calendar') throw error;
    if (!this.failure) {
      const mapped = this.options.sdkError?.(error) ?? this.options.incomplete();
      this.fail(mapped, false);
      if (this.options.policy === 'recommendation')
        this.options.observation?.propagate(mapped, error);
    }
    if (state) this.cause('unknown', state);
  }

  private part(part: { type: string; rawValue?: unknown; error?: unknown }, state?: RequestState) {
    if (state && part.type === 'raw') this.raw(part.rawValue, state);
    if (state && part.type === 'error' && this.options.policy === 'types')
      this.cause('unknown', state);
    if (part.type === 'error' && this.options.policy === 'recommendation')
      this.sdkError(part.error, state);
    if (this.failure && this.options.policy === 'recommendation') {
      this.options.observation?.fail(state?.operation, this.failure, undefined, false);
      throw this.failure;
    }
  }
  private finish(state?: RequestState) {
    if (!state) return;
    state.consumed = true;
    if (state.signal.aborted) {
      if (this.options.expired?.()) this.cause('deadline_exceeded', state);
      this.closeRequest(state, 'cancelled');
    } else {
      state.record.completionEvents ??= 0;
      if (state.record.completionEvents === 0) {
        this.cause('missing_completion', state);
        if (this.options.policy === 'recommendation') {
          this.fail(this.options.incomplete());
          this.options.observation?.fail(state.operation, this.failure);
          throw this.failure;
        }
      }
      this.closeRequest(state, state.failed ? 'failed' : 'completed');
    }
  }

  readonly middleware: LanguageModelMiddleware = {
    wrapStream: async ({ doStream }) => {
      const scope: { request?: RequestState } = {};
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        result = await this.scope.run(scope, doStream);
      } catch (error) {
        if (scope.request) {
          if (this.options.policy === 'recommendation')
            this.options.observation?.fail(
              scope.request.operation,
              error,
              APICallError.isInstance(error) ? 'unknown' : undefined,
            );
          this.closeRequest(scope.request, 'failed');
        }
        throw error;
      }
      const state = scope.request;
      if (this.options.policy !== 'types') {
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform: (part, controller) => {
                this.part(part, state);
                controller.enqueue(part);
              },
              flush: () => this.finish(state),
            }),
          ),
        };
      }
      const reader = result.stream.getReader();
      return {
        ...result,
        stream: new ReadableStream({
          pull: async (controller) => {
            try {
              const next = await reader.read();
              if (next.done) {
                this.finish(state);
                controller.close();
              } else {
                this.part(next.value, state);
                controller.enqueue(next.value);
              }
            } catch (error) {
              if (state) this.closeRequest(state, state.signal.aborted ? 'cancelled' : 'failed');
              controller.error(error);
            }
          },
          cancel: async (reason) => {
            try {
              await reader.cancel(reason);
            } finally {
              if (state) this.closeRequest(state, 'cancelled');
            }
          },
        }),
      };
    },
  };

  async read<T, Part extends { type: string; error?: unknown }>(
    result: { output: PromiseLike<T>; stream: AsyncIterable<Part> },
    onPart?: (part: Part) => void,
  ) {
    const output = Promise.resolve(result.output).then(
      (value) => ({ value }),
      () => ({ value: undefined }),
    );
    for await (const part of result.stream) {
      if (part.type === 'error') this.sdkError(part.error);
      onPart?.(part);
    }
    return (await output).value;
  }
  assertComplete(expected: number) {
    if (
      expected < 1 ||
      this.completions !== expected ||
      (this.options.policy === 'calendar' && this.failure) ||
      [...this.states.values()].some((state) => !state.failed && !state.consumed)
    )
      throw this.options.incomplete();
  }
  observeOpenRequestFailures(error: unknown) {
    for (const state of this.states.values()) {
      if (state.record.status !== 'unknown') continue;
      this.options.observation?.streamEnd(
        state.operation,
        state.signal.aborted ? 'cancelled' : 'read_error',
        state.signal,
      );
      this.options.observation?.fail(state.operation, error);
    }
  }
  close() {
    for (const state of this.states.values()) {
      if (state.record.status !== 'unknown') continue;
      if (this.options.expired?.()) this.cause('deadline_exceeded', state);
      this.closeRequest(state, 'cancelled');
    }
    this.scope.disable();
  }
}
