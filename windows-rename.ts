import { renameSync } from "node:fs";

const RETRY_DELAYS_MS = [10, 20, 40, 80] as const;
const waitGate = new Int32Array(new SharedArrayBuffer(4));
interface RenameDependencies {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => void;
}
export interface SyncRenameDependencies extends RenameDependencies { sleep?: (milliseconds: number) => void }
export interface AsyncRenameDependencies extends RenameDependencies { sleep?: (milliseconds: number) => Promise<void> }

function retryDelay(error: unknown, attempt: number, platform: NodeJS.Platform): number | undefined {
  if (platform !== "win32" || !error || typeof error !== "object" || !("code" in error)
    || error.code !== "EPERM" && error.code !== "EBUSY") return undefined;
  return RETRY_DELAYS_MS[attempt];
}

/**
 * Windows can briefly deny an otherwise valid atomic rename after a file has
 * been flushed and closed. Retry only that operation on the original paths;
 * never remove the destination, fall back to copying, or ignore a lasting lock.
 * Callers remain responsible for validating their source/destination paths.
 */
export function renameWithWindowsRetrySync(from: string, to: string, dependencies: SyncRenameDependencies = {}): void {
  const rename = dependencies.rename ?? renameSync;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => { Atomics.wait(waitGate, 0, 0, milliseconds); });
  const platform = dependencies.platform ?? process.platform;
  for (let attempt = 0; ; attempt++) {
    try { rename(from, to); return; }
    catch (error) {
      const delay = retryDelay(error, attempt, platform);
      if (delay === undefined) throw error;
      sleep(delay);
    }
  }
}

/** The migration path can yield during the same bounded Windows sharing wait. */
export async function renameWithWindowsRetry(from: string, to: string, dependencies: AsyncRenameDependencies = {}): Promise<void> {
  const rename = dependencies.rename ?? renameSync;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const platform = dependencies.platform ?? process.platform;
  for (let attempt = 0; ; attempt++) {
    try { rename(from, to); return; }
    catch (error) {
      const delay = retryDelay(error, attempt, platform);
      if (delay === undefined) throw error;
      await sleep(delay);
    }
  }
}
