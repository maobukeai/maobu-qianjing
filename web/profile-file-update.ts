import { isSafeProfileId } from "../profile-id.ts";

export type ProfileFileUpdateFormat = "csv" | "txt" | "xlsx";
export type ProfileFileUpdateReason = "file-format" | "identifier" | "proxy" | "screen" | "language" | "serial" | "validation";
export interface ProfileFileUpdateInput { readonly revision: number; readonly format: ProfileFileUpdateFormat; readonly bytes: number; readonly matchBy: "file-id" }
export interface ProfileFileUpdateIssue { readonly id: string | null; readonly reason: ProfileFileUpdateReason }
export interface ProfileFileUpdateReceipt {
  readonly id: number;
  readonly input: ProfileFileUpdateInput;
  readonly status: "saved" | "partial" | "no-changes" | "rejected" | "unconfirmed";
  readonly updated: number | null;
  readonly skipped: number | null;
  /** These are unmatched file rows, not a count of unique environments. */
  readonly notFoundRows: number | null;
  readonly notFoundIds: readonly string[];
  readonly issues: readonly ProfileFileUpdateIssue[];
  readonly completedAt: number;
  readonly refreshFailed: boolean;
}
export interface ProfileFileUpdateSnapshot {
  readonly phase: "idle" | "sending" | "refreshing" | "settled";
  readonly input: ProfileFileUpdateInput | null;
  readonly canSubmit: boolean;
  readonly activeAttempt: Readonly<{ id: number; input: ProfileFileUpdateInput }> | null;
  readonly receipts: readonly ProfileFileUpdateReceipt[];
  readonly latest: ProfileFileUpdateReceipt | null;
  readonly blockedReason: string | null;
}
export interface ProfileFileUpdateLease { refreshing?(): void; release(): void }
export interface ProfileFileUpdateOptions {
  post?: (file: File) => Promise<Response>;
  workspaceId?: () => string | null;
  acquire?: (workspaceId: string | null) => ProfileFileUpdateLease | null;
  onSettled?: (receipt: ProfileFileUpdateReceipt) => void | Promise<void>;
  now?: () => number;
}
export const PROFILE_FILE_UPDATE_REASONS: Record<ProfileFileUpdateReason, string> = {
  "file-format": "The file could not be parsed. Choose a valid CSV, TXT or XLSX file with an id column. No environment was saved.",
  identifier: "The row has an invalid environment ID. Keep the original exported id column.",
  proxy: "The row contains an invalid proxy configuration. Correct or remove the affected proxy columns.",
  screen: "The row contains an invalid screen configuration. Use a supported desktop resolution.",
  language: "The row contains an invalid language configuration. Use a valid language tag.",
  serial: "The row contains an invalid custom number. Review the custom_no column.",
  validation: "The row could not be validated. Review the editable columns in the source file.",
};
const MIME: Record<ProfileFileUpdateFormat, string> = { csv: "text/csv", txt: "text/plain", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
const INVALID_FILE = "Choose one non-empty CSV, TXT or XLSX file with the original id column.";
const BLOCKED = "A workspace task is in progress. Wait for it to finish before updating profiles from a file.";
const WORKSPACE_CHANGED = "The selected file belongs to an earlier workspace context. Return there or select the intended file again in this workspace.";
const RESELECT = "This file selection was already submitted. Review the result, correct the file if needed, and explicitly select it again to start a new update.";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** The upload never forwards a local filename or follows redirects with private account data. */
export function postProfileFileUpdate(file: File): Promise<Response> {
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  const format = extension && Object.hasOwn(MIME, extension) ? extension : "txt";
  const form = new FormData(); form.append("files", file, `profile-update.${format}`);
  return fetch("/ui/api/profiles/update-file", { method: "POST", body: form, redirect: "error", credentials: "same-origin", cache: "no-store" });
}
function reason(id: string, error: string): ProfileFileUpdateReason {
  if (id === "" && error === "update file could not be parsed") return "file-format";
  if (!isSafeProfileId(id) || /^invalid profile id:/.test(error)) return "identifier";
  if (/^invalid resolution:/.test(error)) return "screen";
  if (/^(?:invalid (?:language|locale)|language tag|locale must)/i.test(error)) return "language";
  if (/^(?:invalid custom|custom (?:no|number))/i.test(error)) return "serial";
  if (/^(?:proxy (?:must|type|port|host)|invalid proxy|unsupported proxy)/i.test(error)) return "proxy";
  return "validation";
}
async function receiptFor(response: Response, id: number, input: ProfileFileUpdateInput, now: () => number): Promise<ProfileFileUpdateReceipt> {
  const body: unknown = await response.json();
  if (!object(body) || typeof body.ok !== "boolean" || !count(body.updated) || !count(body.skipped)
    || !Array.isArray(body.notFound) || !body.notFound.every(isSafeProfileId) || !Array.isArray(body.errors)
    || Object.keys(body).some(key => !["ok", "updated", "skipped", "notFound", "errors"].includes(key))) throw new Error("Unconfirmed file update");
  const issues: ProfileFileUpdateIssue[] = [];
  for (const item of body.errors) {
    if (!object(item) || typeof item.id !== "string" || typeof item.error !== "string" || Object.keys(item).some(key => key !== "id" && key !== "error")) throw new Error("Unconfirmed file update");
    issues.push(Object.freeze({ id: isSafeProfileId(item.id) ? item.id : null, reason: reason(item.id, item.error) }));
  }
  // Row validation is atomic: the real service returns HTTP400 with updated:0 and at least one error before writing.
  const rejected = response.status === 400 && body.ok === false && body.updated === 0 && issues.length > 0;
  const saved = response.status === 200 && response.ok && body.ok === true && issues.length === 0;
  if (!rejected && !saved) throw new Error("Unconfirmed file update");
  const status = rejected ? "rejected" : body.updated === 0 ? "no-changes" : body.skipped > 0 || body.notFound.length > 0 ? "partial" : "saved";
  return Object.freeze({ id, input, status, updated: body.updated, skipped: body.skipped, notFoundRows: body.notFound.length,
    notFoundIds: Object.freeze([...new Set(body.notFound)]), issues: Object.freeze(issues), completedAt: now(), refreshFailed: false });
}

/** One private, immutable selection at a time; no automatic retry or invented successful-ID list. */
export function createProfileFileUpdate(options: ProfileFileUpdateOptions = {}) {
  let file: File | null = null, input: ProfileFileUpdateInput | null = null, inputWorkspace: string | null = null;
  let revision = 0, submittedRevision = 0, sequence = 0, busy = false;
  let phase: ProfileFileUpdateSnapshot["phase"] = "idle", activeAttempt: ProfileFileUpdateSnapshot["activeAttempt"] = null;
  let receipts: readonly ProfileFileUpdateReceipt[] = [], blockedReason: string | null = null;
  const now = options.now ?? Date.now, listeners = new Set<() => void>();
  function snapshot(): ProfileFileUpdateSnapshot { return Object.freeze({ phase, input, canSubmit: !!input && input.revision !== submittedRevision && !busy,
    activeAttempt, receipts: Object.freeze([...receipts]), latest: receipts.at(-1) ?? null, blockedReason }); }
  let published = snapshot();
  function publish() { published = snapshot(); for (const listener of [...listeners]) { try { listener(); } catch { /* View errors cannot interrupt an issued write. */ } } return published; }
  function block(message: string) { blockedReason = message; publish(); return null; }
  function clearInput() { file = null; input = null; inputWorkspace = null; }
  function rejectInput() {
    clearInput();
    block(INVALID_FILE);
    return false;
  }
  return {
    getSnapshot: () => published,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    isBusy: () => busy,
    selectFile(value: File): boolean {
      if (busy) return false;
      try {
        const format = /\.([a-z0-9]+)$/i.exec(value.name)?.[1]?.toLowerCase();
        if (!(value instanceof File) || !count(value.size) || value.size === 0 || !format || !Object.hasOwn(MIME, format)) return rejectInput();
        const workspace = options.workspaceId?.() ?? null;
        // Blob/File bytes are immutable. Capture a new File with fixed public metadata and never expose it in state.
        const captured = new File([value.slice(0, value.size)], `profile-update.${format}`, { type: MIME[format as ProfileFileUpdateFormat], lastModified: 0 });
        input = Object.freeze({ revision: ++revision, format: format as ProfileFileUpdateFormat, bytes: captured.size, matchBy: "file-id" });
        file = captured; inputWorkspace = workspace; blockedReason = null; publish(); return true;
      } catch { return rejectInput(); }
    },
    clearFile() { if (busy) return false; clearInput(); blockedReason = null; publish(); return true; },
    rejectSelection() { if (!busy) rejectInput(); },
    submit(): Promise<ProfileFileUpdateSnapshot | null> {
      if (busy) return Promise.resolve(null);
      if (!file || !input) return Promise.resolve(block(INVALID_FILE));
      if (submittedRevision === input.revision) return Promise.resolve(block(RESELECT));
      let workspace: string | null;
      try { workspace = options.workspaceId?.() ?? null; } catch { return Promise.resolve(block(WORKSPACE_CHANGED)); }
      if (workspace !== inputWorkspace) return Promise.resolve(block(WORKSPACE_CHANGED));
      // Guard acquisition and subscribers synchronously, before the first async operation.
      busy = true;
      let lease: ProfileFileUpdateLease | null | undefined;
      try { lease = options.acquire?.(workspace); }
      catch { busy = false; return Promise.resolve(block(BLOCKED)); }
      if (options.acquire && !lease) { busy = false; return Promise.resolve(block(BLOCKED)); }
      const attemptFile = file, attemptInput = input, id = ++sequence;
      submittedRevision = attemptInput.revision; activeAttempt = Object.freeze({ id, input: attemptInput }); phase = "sending"; blockedReason = null;
      const operation = Promise.resolve().then(async () => {
        let receipt: ProfileFileUpdateReceipt;
        try {
          // Some native Blob implementations retain a source File's name when wrapping or slicing it.
          // Materialize private bytes before constructing the transport File, so only our fixed name can leave the page.
          const upload = new File([await attemptFile.arrayBuffer()], `profile-update.${attemptInput.format}`, { type: MIME[attemptInput.format], lastModified: 0 });
          receipt = await receiptFor(await (options.post ?? postProfileFileUpdate)(upload), id, attemptInput, now);
        }
        catch { receipt = Object.freeze({ id, input: attemptInput, status: "unconfirmed", updated: null, skipped: null, notFoundRows: null,
          notFoundIds: Object.freeze([]), issues: Object.freeze([]), completedAt: now(), refreshFailed: false }); }
        receipts = Object.freeze([...receipts, receipt]);
        if (options.onSettled) {
          phase = "refreshing"; publish();
          try { lease?.refreshing?.(); await options.onSettled(receipt); }
          catch { receipt = Object.freeze({ ...receipt, refreshFailed: true }); receipts = Object.freeze([...receipts.slice(0, -1), receipt]); }
        }
        try { lease?.release(); } catch { /* Settle the receipt even when a host lease fails. */ }
        busy = false; phase = "settled"; activeAttempt = null; return publish();
      });
      publish(); return operation;
    },
    /** Explicitly clear safe results; the private selection still requires reselection before another submission. */
    dismissResults() { if (busy) return false; receipts = []; phase = "idle"; blockedReason = null; publish(); return true; },
  };
}
export type ProfileFileUpdateTask = ReturnType<typeof createProfileFileUpdate>;
