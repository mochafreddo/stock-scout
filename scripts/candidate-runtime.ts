export class CandidateRuntime {
  readonly startedAt = performance.now();
  readonly startedWall = Date.now();
  readonly counts = {
    kis: 0,
    issuance: 0,
    official: 0,
    calendarModel: 0,
    typeModel: 0,
    refresh: 0,
  };
  readonly limits = {
    kis: 90,
    issuance: 2,
    official: 100,
    calendarModel: 1,
    typeModel: 12,
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
  signal(ms: number, parent?: AbortSignal | null) {
    this.check();
    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(ms, this.remaining()))));
    return parent ? AbortSignal.any([timeout, parent]) : timeout;
  }
  safe(value: unknown) {
    this.check();
    const serialized = JSON.stringify(value);
    if ([...this.secrets].some((secret) => serialized.includes(secret)))
      throw new Error('SENSITIVE_OUTPUT');
    return serialized;
  }
}

export type ExecutionContext = { runtime?: CandidateRuntime; signal?: AbortSignal };

export function requestSignal(context: ExecutionContext, ms: number, signal?: AbortSignal | null) {
  context.signal?.throwIfAborted();
  const parent =
    context.signal && signal
      ? AbortSignal.any([context.signal, signal])
      : (context.signal ?? signal);
  return (
    context.runtime?.signal(ms, parent) ??
    (parent
      ? AbortSignal.any([parent, AbortSignal.timeout(Math.max(1, Math.floor(ms)))])
      : AbortSignal.timeout(Math.max(1, Math.floor(ms))))
  );
}
