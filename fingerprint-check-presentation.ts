/** Browser-safe report vocabulary and coarse evidence. Never accepts a Profile or raw probe. */
export type FingerprintCheckStatus = "pass" | "warn" | "fail" | "unknown";
export const FINGERPRINT_SURFACES = ["ua", "platform", "languages", "hardwareConcurrency", "webglVendor", "webglRenderer", "canvas", "audio", "screen", "timezone"] as const;
export type FingerprintSurface = typeof FINGERPRINT_SURFACES[number];
export type FingerprintCheckMessage =
  | { kind: "probe-errors" | "import-matches" | "import-differences"; count: number }
  | { kind: "missing-surfaces"; surfaces: FingerprintSurface[] };
type System = "windows" | "macos" | "linux";
interface ScreenSize { width: number; height: number }
export type FingerprintCheckEvidence =
  | { kind: "processors"; expected: number | null; actual: number | null; saved: number | null; hostAvailable: number | null }
  | { kind: "platform"; expected: System | null; actual: System | null }
  | { kind: "platform-sources"; ua: System | null; clientHints: System | null; navigator: System | null }
  | { kind: "locale-config"; configured: string | null; detailsOmitted?: true }
  | { kind: "locale"; expected: string | null; actual: string | null; detailsOmitted?: true }
  | { kind: "screen"; expected: ScreenSize | null; actual: ScreenSize | null }
  | { kind: "timezone"; expected: string | null; actual: string | null };
export interface PresentableFingerprintCheck {
  id: string; label: string; status: FingerprintCheckStatus; detail: string; recommendation?: string;
  detailMessage?: FingerprintCheckMessage; evidence?: FingerprintCheckEvidence;
}
export type FingerprintTranslator = (source: string, values?: Record<string, string | number>) => string;
export interface FingerprintCheckView {
  id: string; status: FingerprintCheckStatus; label: string; detail: string; recommendation?: string;
  evidenceRows: Array<{ label: string; value: string }>;
  evidenceNote?: string;
}
const SURFACE_LABELS: Record<FingerprintSurface, string> = { ua: "User agent", platform: "System platform", languages: "Languages", hardwareConcurrency: "Processor count", webglVendor: "WebGL vendor", webglRenderer: "WebGL renderer", canvas: "Canvas", audio: "Audio", screen: "Screen", timezone: "Timezone" };
const MESSAGE_TEXT = { "probe-errors": "Probes reporting errors: {count}.", "import-matches": "Matching imported identity fields: {count}.", "import-differences": "Different imported identity fields: {count}." };
const listFormats = new Map<string, Intl.ListFormat>();
const english: FingerprintTranslator = (source, values) => source.replace(/\{(\w+)\}/g, (match, key: string) => values?.[key] === undefined ? match : String(values[key]));
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000; }
function processor(value: unknown): number | null { return count(value) && value > 0 ? value : null; }
function system(value: unknown): System | null { return value === "windows" || value === "macos" || value === "linux" ? value : null; }
function screen(value: unknown): ScreenSize | null {
  if (!object(value) || !exact(value, ["width", "height"]) || !count(value.width) || !count(value.height)) return null;
  return { width: value.width, height: value.height };
}
const localeCache = new Map<string, { tag: string | null; omitted: boolean }>();
function locale(value: unknown): { tag: string | null; omitted: boolean } {
  if (typeof value !== "string" || value.length > 128 || !value) return { tag: null, omitted: false };
  const cached = localeCache.get(value); if (cached) return cached;
  let result: { tag: string | null; omitted: boolean };
  try {
    const canonical = Intl.getCanonicalLocales(value)[0]!;
    const input = new Intl.Locale(canonical);
    const tag = [input.language, input.script, input.region].filter(Boolean).join("-");
    // Unknown primary subtags can carry arbitrary text; do not echo them.
    result = !Intl.DateTimeFormat.supportedLocalesOf([tag], { localeMatcher: "lookup" }).length ? { tag: null, omitted: true } : { tag, omitted: canonical !== tag };
  } catch { result = { tag: null, omitted: false }; }
  if (localeCache.size >= 256) localeCache.delete(localeCache.keys().next().value!);
  localeCache.set(value, result); return result;
}
const timezoneCache = new Map<string, boolean>();
function validTimezone(value: string): boolean {
  let valid = timezoneCache.get(value);
  if (valid !== undefined) return valid;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); valid = true; } catch { valid = false; }
  if (timezoneCache.size >= 256) timezoneCache.delete(timezoneCache.keys().next().value!);
  timezoneCache.set(value, valid); return valid;
}
function timezone(value: unknown, validate: (value: string) => boolean): string | null {
  return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){0,3}$/.test(value) && validate(value) ? value : null;
}

export function isFingerprintCheckMessage(value: unknown): value is FingerprintCheckMessage {
  if (!object(value)) return false;
  if (value.kind === "missing-surfaces") return exact(value, ["kind", "surfaces"]) && Array.isArray(value.surfaces) && value.surfaces.length > 0 && value.surfaces.length <= FINGERPRINT_SURFACES.length
    && value.surfaces.every(surface => FINGERPRINT_SURFACES.includes(surface)) && new Set(value.surfaces).size === value.surfaces.length;
  return ["probe-errors", "import-matches", "import-differences"].includes(value.kind as string) && exact(value, ["kind", "count"]) && count(value.count);
}
export function renderFingerprintMessage(value: FingerprintCheckMessage, t: FingerprintTranslator = english, language = "en-US"): string {
  if (value.kind !== "missing-surfaces") return t(MESSAGE_TEXT[value.kind], { count: value.count });
  const names = value.surfaces.map(surface => t(SURFACE_LABELS[surface]));
  let surfaces: string;
  try {
    let format = listFormats.get(language);
    if (!format) { format = new Intl.ListFormat(language, { style: "long", type: "conjunction" }); if (listFormats.size >= 16) listFormats.delete(listFormats.keys().next().value!); listFormats.set(language, format); }
    surfaces = format.format(names);
  } catch { surfaces = names.join(", "); }
  return t("Not measured: {surfaces}.", { surfaces });
}

/** Only branch-computed scalar inputs belong here; extra fields cause rejection. */
export function projectFingerprintEvidence(value: unknown, options: { validTimezone?: (value: string) => boolean } = {}): FingerprintCheckEvidence | null {
  if (!object(value)) return null;
  switch (value.kind) {
    case "processors": return exact(value, ["kind", "expected", "actual", "saved", "hostAvailable"])
      ? { kind: "processors", expected: processor(value.expected), actual: processor(value.actual), saved: processor(value.saved), hostAvailable: processor(value.hostAvailable) } : null;
    case "platform": return exact(value, ["kind", "expected", "actual"]) ? { kind: "platform", expected: system(value.expected), actual: system(value.actual) } : null;
    case "platform-sources": return exact(value, ["kind", "ua", "clientHints", "navigator"])
      ? { kind: "platform-sources", ua: system(value.ua), clientHints: system(value.clientHints), navigator: system(value.navigator) } : null;
    case "locale-config": {
      if (!exact(value, ["kind", "configured", "detailsOmitted"])) return null;
      const configured = locale(value.configured);
      return { kind: "locale-config", configured: configured.tag, ...(configured.omitted || value.detailsOmitted === true ? { detailsOmitted: true } : {}) };
    }
    case "locale": {
      if (!exact(value, ["kind", "expected", "actual", "detailsOmitted"])) return null;
      const expected = locale(value.expected), actual = locale(value.actual);
      return { kind: "locale", expected: expected.tag, actual: actual.tag, ...(expected.omitted || actual.omitted || value.detailsOmitted === true ? { detailsOmitted: true } : {}) };
    }
    case "screen": return exact(value, ["kind", "expected", "actual"]) ? { kind: "screen", expected: screen(value.expected), actual: screen(value.actual) } : null;
    case "timezone": return exact(value, ["kind", "expected", "actual"])
      ? { kind: "timezone", expected: timezone(value.expected, options.validTimezone ?? validTimezone), actual: timezone(value.actual, options.validTimezone ?? validTimezone) } : null;
    default: return null;
  }
}
/** Transport data must already be projected, rather than silently carrying hidden raw values. */
export function isFingerprintCheckEvidence(value: unknown): value is FingerprintCheckEvidence {
  const projected = projectFingerprintEvidence(value);
  if (!projected || !object(value)) return false;
  const canonical = (entry: unknown): unknown => object(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, canonical(entry[key])])) : entry;
  return JSON.stringify(canonical(projected)) === JSON.stringify(canonical(value));
}
export function presentFingerprintCheck(check: PresentableFingerprintCheck, t: FingerprintTranslator = english, language = "en-US"): FingerprintCheckView {
  const view: FingerprintCheckView = { id: check.id, status: check.status, label: t(check.label), detail: isFingerprintCheckMessage(check.detailMessage) ? renderFingerprintMessage(check.detailMessage, t, language) : t(check.detail),
    ...(check.recommendation ? { recommendation: t(check.recommendation) } : {}), evidenceRows: [] };
  const evidence = projectFingerprintEvidence(check.evidence);
  if (!evidence) return view;
  const unavailable = t("Not available");
  const number = (value: number | null) => value === null ? unavailable : String(value);
  const os = (value: System | null) => value ? t({ windows: "Windows", macos: "macOS", linux: "Linux" }[value]) : unavailable;
  const dimensions = (value: ScreenSize | null) => value ? `${value.width} × ${value.height}` : unavailable;
  const row = (label: string, value: string) => { view.evidenceRows.push({ label: t(label), value }); };
  switch (evidence.kind) {
    case "processors": row("Expected by launch policy", number(evidence.expected)); row("Observed processor count", number(evidence.actual)); row("Saved processor count", number(evidence.saved)); row("Host processors available", number(evidence.hostAvailable)); break;
    case "platform": row("Configured system", os(evidence.expected)); row("Observed system", os(evidence.actual)); break;
    case "platform-sources": row("User agent system", os(evidence.ua)); row("Client Hints system", os(evidence.clientHints)); row("Navigator system", os(evidence.navigator)); break;
    case "locale-config": row("Configured language", evidence.configured ?? unavailable); break;
    case "locale": row("Configured language", evidence.expected ?? unavailable); row("Observed preferred language", evidence.actual ?? unavailable); break;
    case "screen": row("Configured screen", dimensions(evidence.expected)); row("Observed screen", dimensions(evidence.actual)); break;
    case "timezone": row("Configured timezone", evidence.expected ?? unavailable); row("Observed timezone", evidence.actual ?? unavailable); break;
  }
  if ((evidence.kind === "locale" || evidence.kind === "locale-config") && evidence.detailsOmitted) view.evidenceNote = t("Locale extensions and variants are omitted from this evidence.");
  return view;
}
