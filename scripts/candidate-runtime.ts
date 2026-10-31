import {
  type CancellationSource,
  cancellationSource,
  ExecutionObservation,
  tagSignal,
} from './execution-observation.ts';

export class CandidateRuntime {
  readonly startedAt = performance.now();
  readonly startedWall = Date.now();
  readonly observation = new ExecutionObservation(() => this.remaining());
  readonly counts = {
    kis: 0,
    issuance: 0,
    official: 0,
    calendarModel: 0,
    typeModel: 0,
    recommendationModel: 0,
    refresh: 0,
  };
  readonly limits = {
    kis: 90,
    issuance: 2,
    official: 100,
    calendarModel: 1,
    typeModel: 12,
    recommendationModel: 4,
    refresh: 2,
  };
  private target = Infinity;
  private failure?: Error;
  readonly secrets = new Set<string>();

  remaining() {
    return Math.min(
      600_000 - (performance.now() - this.startedAt),
      this.startedWall + 600_000 - Date.now(),
      this.target - Date.now(),
    );
  }
  check() {
    if (this.failure) throw this.failure;
    if (this.remaining() <= 0) {
      this.failure = new Error(Date.now() >= this.target ? 'TARGET_OPEN' : 'EXECUTION_LIMIT');
      throw this.failure;
    }
  }
  targetOpen(at: string) {
    this.target = Date.parse(at);
    this.check();
  }
  checkRequest(kind: keyof CandidateRuntime['counts']) {
    this.check();
    if (
      this.counts[kind] >= this.limits[kind] ||
      (kind === 'issuance' && this.counts.kis >= this.limits.kis)
    ) {
      this.failure = new Error('REQUEST_LIMIT');
      throw this.failure;
    }
  }
  take(kind: keyof CandidateRuntime['counts']) {
    this.checkRequest(kind);
    this.counts[kind]++;
    if (kind === 'issuance') this.counts.kis++;
  }
  signal(ms: number, parent?: AbortSignal | null, source: CancellationSource = 'request_limit') {
    this.check();
    const remaining = this.remaining();
    const owner =
      remaining <= ms
        ? this.target - Date.now() <=
          Math.min(
            600_000 - (performance.now() - this.startedAt),
            this.startedWall + 600_000 - Date.now(),
          )
          ? 'target_open'
          : 'execution_limit'
        : source;
    const timeout = tagSignal(
      AbortSignal.timeout(Math.max(1, Math.floor(Math.min(ms, remaining)))),
      () => owner,
    );
    return parent
      ? tagSignal(AbortSignal.any([timeout, parent]), () =>
          timeout.aborted ? owner : cancellationSource(parent),
        )
      : timeout;
  }
  safe(value: unknown) {
    this.check();
    const serialized = JSON.stringify(value);
    if ([...this.secrets].some((secret) => serialized.includes(secret)))
      throw new Error('SENSITIVE_OUTPUT');
    return serialized;
  }
}

export type ExecutionContext = {
  secrets?: readonly (string | undefined)[];
  runtime?: CandidateRuntime;
  signal?: AbortSignal;
  observation?: ExecutionObservation;
  parentId?: string;
};

export function requestSignal(
  context: ExecutionContext,
  ms: number,
  signal?: AbortSignal | null,
  source: CancellationSource = 'request_limit',
) {
  context.signal?.throwIfAborted();
  const parent =
    context.signal && signal
      ? tagSignal(AbortSignal.any([context.signal, signal]), () =>
          context.signal?.aborted ? cancellationSource(context.signal) : cancellationSource(signal),
        )
      : (context.signal ?? signal);
  return (
    context.runtime?.signal(ms, parent, source) ??
    (parent
      ? (() => {
          const timeout = tagSignal(AbortSignal.timeout(Math.max(1, Math.floor(ms))), () => source);
          return tagSignal(AbortSignal.any([parent, timeout]), () =>
            parent.aborted ? cancellationSource(parent) : source,
          );
        })()
      : tagSignal(AbortSignal.timeout(Math.max(1, Math.floor(ms))), () => source))
  );
}
