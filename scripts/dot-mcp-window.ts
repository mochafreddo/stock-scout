export class DotWindow {
  private tail?: Promise<void>;
  private starts = 0;
  private closed = false;
  constructor(isOpen: () => boolean, report: (status: string, code?: string) => void) {
    this.isOpen = isOpen;
    this.report = report;
  }
  private readonly isOpen: () => boolean;
  readonly report: (status: string, code?: string) => void;
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const slot = Promise.withResolvers<void>();
    this.tail = slot.promise;
    try {
      if (previous) {
        this.report('queued');
        await previous;
      }
      return await operation();
    } finally {
      if (this.tail === slot.promise) this.tail = undefined;
      slot.resolve();
    }
  }
  close() {
    this.closed = true;
    return this.tail;
  }
  rejection() {
    if (this.closed || !this.isOpen()) return 'WINDOW_CLOSED';
    if (this.starts >= 16) return 'SESSION_BUDGET';
  }
  started = () => {
    this.starts++;
  };
}
