import { type ChildProcess, execFile } from 'node:child_process';
import { record } from './toss-values.ts';

type CliResponse = Record<string, unknown> & { data: unknown[] };

function isCliResponse(response: unknown, status: string | undefined): response is CliResponse {
  return (
    status !== undefined &&
    record(response) &&
    response.version === 1 &&
    Array.isArray(response.data) &&
    response.status === status
  );
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
  async query(args: string[]) {
    const previous = this.tail;
    const slot = Promise.withResolvers<void>();
    this.tail = slot.promise;
    try {
      if (previous) {
        this.report('queued');
        await previous;
      }
      return await this.executeQuery(args);
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
              !isCliResponse(response, ['success', 'error', 'partial'][exitCode])
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
  private rejection() {
    if (this.closed || !this.isOpen()) return 'WINDOW_CLOSED';
    if (this.starts >= 16) return 'SESSION_BUDGET';
  }
  private rejected(code: string) {
    this.report('rejected', code);
    return queryResult({ stage: 'admission', error: { code } }, true);
  }
  private async executeQuery(args: string[]) {
    let stage = 'readiness';
    try {
      const beforeReadiness = this.rejection();
      if (beforeReadiness) return this.rejected(beforeReadiness);
      const ready = await this.execute(['readiness']);
      const rows = ready.response.data;
      const readiness = record(rows[0]) ? rows[0].readiness : undefined;
      if (ready.exitCode !== 0) {
        this.report(
          'ready_blocked',
          readiness === 'unavailable' ? 'READINESS_UNAVAILABLE' : 'READINESS_BLOCKED',
        );
        return queryResult({ stage, ...ready }, true);
      }
      if (rows.length !== 1 || readiness !== 'ready') throw new Error('Invalid readiness result');
      stage = 'query';
      const beforeStart = this.rejection();
      if (beforeStart) return this.rejected(beforeStart);
      const output = await this.execute(args, () => {
        this.starts++;
      });
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
