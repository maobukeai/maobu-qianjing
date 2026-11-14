import { isSafeProfileId } from "../profile-id.ts";

export type ImportReceiptReason = "proxy-repair" | "identifier" | "screen" | "timezone" | "operating-system" | "hardware" | "session" | "source-record";
export interface ImportReceiptIssue { readonly file: string | null; readonly id: string | null; readonly reason: ImportReceiptReason; readonly proxyRepairReported: boolean }
export interface ImportReceipt {
  readonly id: string;
  readonly completedAt: number;
  readonly files: number;
  /** Records reported as imported/updated, not a count of newly created environments. */
  readonly profiles: number;
  readonly cookiesStripped: number;
  readonly skipped: number;
  readonly issues: readonly ImportReceiptIssue[];
  readonly proxyRepairReports: number;
}
export class ImportReceiptError extends Error {
  constructor(readonly kind: "unconfirmed" | "invalid") {
    super(kind === "unconfirmed" ? "The import was not confirmed. Review the selected files before trying again."
      : "The import service returned incomplete results. Refresh environments before importing again.");
    this.name = "ImportReceiptError";
  }
}
let nextReceiptId = 1;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Basenames only. Reject suspicious/unsupported metadata instead of reflecting arbitrary input. */
function safeFile(value: string): string | null {
  const name = value.split(/[\\/]/).at(-1)?.normalize("NFC") ?? "";
  return name && Array.from(name).length <= 160 && /^[\p{L}\p{N} _().-]+$/u.test(name) && name !== "." && name !== ".." ? name : null;
}
function reason(error: string, quarantined: boolean): ImportReceiptReason {
  if (quarantined) return "proxy-repair";
  if (/^invalid profile id:/.test(error)) return "identifier";
  if (/^invalid resolution:/.test(error)) return "screen";
  if (/^invalid timezone(?::|$)/.test(error)) return "timezone";
  if (/^invalid operating system(?::|$)/.test(error)) return "operating-system";
  if (/^invalid (?:CPU cores|fingerprint seed):/.test(error)) return "hardware";
  if (/^(?:cookie JSON is invalid|cookies\.txt lines need 7 tab-separated fields|no valid cookies found)$/.test(error)) return "session";
  return "source-record";
}

/** Copy only safe receipt fields. Never retain errors, raw import rows, account fields, proxy details or cookies. */
export function createImportReceipt(value: unknown, completedAt = Date.now()): ImportReceipt {
  try {
    if (!object(value)) throw new ImportReceiptError("invalid");
    const { ok, files, profiles, cookiesStripped, skipped, errors } = value;
    if (typeof ok !== "boolean") throw new ImportReceiptError("invalid");
    if (ok !== true) throw new ImportReceiptError("unconfirmed");
    if (![files, profiles, cookiesStripped, skipped].every(count)
      || !Array.isArray(errors) || !Number.isFinite(completedAt) || completedAt < 0 || completedAt > 8_640_000_000_000_000) throw new ImportReceiptError("invalid");
    const issues = Array.from(errors, (entry: unknown): ImportReceiptIssue => {
      if (!object(entry)) throw new ImportReceiptError("invalid");
      const { file, id, error, quarantined } = entry;
      if (typeof file !== "string" || typeof id !== "string" || typeof error !== "string"
        || quarantined !== undefined && typeof quarantined !== "boolean") throw new ImportReceiptError("invalid");
      const proxyRepairReported = quarantined === true;
      return Object.freeze({ file: safeFile(file), id: isSafeProfileId(id) ? id : null, reason: reason(error, proxyRepairReported), proxyRepairReported });
    });
    return Object.freeze({ id: `import-receipt-${completedAt}-${nextReceiptId++}`, completedAt, files: files as number, profiles: profiles as number,
      cookiesStripped: cookiesStripped as number, skipped: skipped as number, issues: Object.freeze(issues), proxyRepairReports: issues.filter(item => item.proxyRepairReported).length });
  } catch (error) { if (error instanceof ImportReceiptError) throw error; throw new ImportReceiptError("invalid"); }
}

export const IMPORT_RECEIPT_REASONS: Record<ImportReceiptReason, string> = {
  "proxy-repair": "The service flagged proxy settings for repair. Check the saved environment before starting it.",
  identifier: "Review the record identifier in the source file.",
  screen: "Review the screen dimensions in the source file.",
  timezone: "Review the timezone in the source file.",
  "operating-system": "Review the operating system in the source file.",
  hardware: "Review the hardware or fingerprint fields in the source file.",
  session: "Review the session format in the source file.",
  "source-record": "The source record needs review. Check its required fields and export format.",
};
