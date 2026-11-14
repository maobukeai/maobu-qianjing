/** One process-wide barrier shared by the dashboard, compatibility API and launcher. */
export class WorkspaceBusyError extends Error {
  readonly status = 423;
  constructor(message = "Workspace maintenance is in progress. Try again after it finishes.") { super(message); }
}

export class WorkspaceMaintenance {
  private reason: string | null = null;
  private writers = 0;
  private waiters = new Set<() => void>();
  private available = new Set<() => void>();

  busy(): boolean { return this.reason !== null; }
  label(): string | null { return this.reason; }
  assertWritable(): void { if (this.busy()) throw new WorkspaceBusyError(); }

  /** A response can return before its admitted streaming worker has finished. */
  acquireMutationLease(): () => void {
    this.assertWritable();
    this.writers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.writers--;
      if (!this.writers) for (const wake of [...this.waiters]) wake();
    };
  }

  async mutation<T>(work: () => T | Promise<T>): Promise<T> {
    const release = this.acquireMutationLease();
    try { return await work(); }
    finally { release(); }
  }

  /** Owned session teardown waits for a snapshot, but must finish during restart. */
  async cleanup<T>(work: () => T | Promise<T>): Promise<T> {
    while (this.busy() && this.reason !== "switch") await new Promise<void>((resolve) => this.available.add(resolve));
    this.writers++;
    try { return await work(); }
    finally { this.writers--; if (!this.writers) for (const wake of [...this.waiters]) wake(); }
  }

  async acquire(reason: string, timeoutMs = 120_000): Promise<() => void> {
    this.assertWritable();
    this.reason = reason;
    let released = false;
    const release = () => { if (!released) { released = true; this.reason = null; const waiting = [...this.available]; this.available.clear(); for (const wake of waiting) wake(); } };
    try {
      if (this.writers) await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = () => { clearTimeout(timer); this.waiters.delete(finish); resolve(); };
        timer = setTimeout(() => { this.waiters.delete(finish); reject(new WorkspaceBusyError("Existing workspace changes have not finished. Try again shortly.")); }, timeoutMs);
        this.waiters.add(finish);
        if (!this.writers) finish();
      });
      return release;
    } catch (error) { release(); throw error; }
  }

  async exclusive<T>(work: () => Promise<T>, reason = "backup"): Promise<T> {
    const release = await this.acquire(reason);
    try { return await work(); } finally { release(); }
  }
}

/** Legacy browser starts are GET requests, so protecting POST alone is insufficient. */
export function workspaceRequestMutates(request: Request): boolean {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/")) return true;
  return path.startsWith("/ui/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method);
}
