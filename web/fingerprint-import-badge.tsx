import type { UiProfile } from "./api.ts";
import { FINGERPRINT_IMPORT_FIELD_LABELS, fingerprintImportCapturedAt, isFingerprintImportField,
  type FingerprintImportComparison, type FingerprintImportField } from "../fingerprint-import-comparison.ts";
import { useTranslation } from "./i18n.tsx";

type BadgeProfile = Pick<UiProfile, "fpImportComparison" | "fpVerdict">;
const HISTORY = "Historical comparison of stored imported expectations and saved measurements. Does not verify the current configuration, current process, or anonymity.";

/** Treat inconsistent/unknown DTOs as neutral history, without reflecting their raw data. */
function comparison(value: unknown): FingerprintImportComparison | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const { expectedCount, comparedCount, matchedCount, differenceFields, missingFields } = item;
  const count = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 9;
  const fields = (value: unknown): value is FingerprintImportField[] => Array.isArray(value) && value.every(isFingerprintImportField) && new Set(value).size === value.length;
  if (!count(expectedCount) || expectedCount === 0 || !count(comparedCount) || !count(matchedCount)
    || !fields(differenceFields) || !fields(missingFields) || comparedCount > expectedCount || matchedCount > comparedCount
    || differenceFields.length !== comparedCount - matchedCount || missingFields.length !== expectedCount - comparedCount
    || differenceFields.some(field => missingFields.includes(field))) return null;
  const capturedAt = fingerprintImportCapturedAt(item.capturedAt);
  return { expectedCount, comparedCount, matchedCount, differenceFields, missingFields, ...(capturedAt ? { capturedAt } : {}) };
}

/** This badge describes stored import evidence only; it never measures or checks a browser. */
export function FingerprintImportBadge({ p }: { p: BadgeProfile }) {
  const { t } = useTranslation();
  if (p.fpImportComparison === null || (p.fpImportComparison === undefined && !p.fpVerdict)) return null;
  const summary = comparison(p.fpImportComparison);
  const state = !summary ? "legacy" : summary.differenceFields.length ? "differences" : summary.missingFields.length ? "incomplete" : "match";
  const label = t(state === "match" ? "Stored import match" : state === "differences" ? "Import differences"
    : state === "incomplete" ? "Import not fully compared" : "Import comparison");
  const detail = [t(HISTORY)];
  if (summary) {
    detail.push(t("Compared {compared} of {expected} imported fields; {matched} matched.", {
      compared: summary.comparedCount, expected: summary.expectedCount, matched: summary.matchedCount,
    }));
    if (summary.differenceFields.length) detail.push(t("Different fields: {fields}.", {
      fields: summary.differenceFields.map(field => t(FINGERPRINT_IMPORT_FIELD_LABELS[field])).join(", "),
    }));
    if (summary.missingFields.length) detail.push(t("Unmeasured fields: {fields}.", {
      fields: summary.missingFields.map(field => t(FINGERPRINT_IMPORT_FIELD_LABELS[field])).join(", "),
    }));
    if (summary.capturedAt) detail.push(t("Measured: {time}.", { time: summary.capturedAt }));
  } else {
    detail.push(t("Detailed comparison is unavailable for this older record."));
  }
  return <span className={`fpbadge${state === "match" ? " ok" : state === "differences" ? " warn" : ""}`}
    data-import-comparison={state} title={detail.join("\n")} aria-label={label}>{label}</span>;
}
