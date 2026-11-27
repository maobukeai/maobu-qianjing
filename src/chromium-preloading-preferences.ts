/**
 * One-leaf, reversible Chromium preference override. No runtime/identity authority lives here.
 * Caller MUST hold the existing profile lifecycle lock, finish managed Chromium155 verification,
 * and prove the profile has no live browser before calling. Never call this against a live session.
 */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

export type ChromiumPreloadingMode = "browser-default" | "disabled";
export type ChromiumPreloadingResult = { status: "unchanged" | "applied" | "restored" | "user-change-preserved" }
  | { status: "blocked"; reason: "unsafe-path" | "profile-directory-missing" | "preferences-invalid" | "management-record-invalid" | "file-changed" | "io-failed" };
export const CHROMIUM_PRELOADING_RECORD = ".maobu-preloading-override.json";
const KEY = "network_prediction_options";
interface Leaf { present: boolean; value?: unknown }
interface RecordFile { version: 1; preference: "net.network_prediction_options"; managedValue: 2; phase: "prepared" | "applied"; previous: Leaf; netPreviouslyPresent: boolean }
class Refusal extends Error { constructor(readonly reason: Extract<ChromiumPreloadingResult, { status: "blocked" }>["reason"]) { super(reason); } }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const equal = isDeepStrictEqual;
function entry(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function paths(profilesRoot: string, userDataDir: string) {
  const root = resolve(profilesRoot), directory = resolve(userDataDir), child = relative(root, directory);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Refusal("unsafe-path");
  function checkDirectories() {
    let current = root;
    for (const segment of ["", ...child.split(sep)]) {
      if (segment) current = join(current, segment);
      const info = entry(current);
      if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Refusal("unsafe-path");
    }
  }
  checkDirectories();
  return { directory, preferences: join(directory, "Default", "Preferences"), record: join(directory, CHROMIUM_PRELOADING_RECORD),
    check: () => {
      checkDirectories();
      const defaultDir = join(directory, "Default");
      const info = entry(defaultDir);
      if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Refusal("unsafe-path");
    } };
}
function textFile(path: string, maximumBytes: number): string | null {
  const info = entry(path);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Refusal("unsafe-path");
  if (info.size > maximumBytes) throw new Refusal(path.endsWith(CHROMIUM_PRELOADING_RECORD) ? "management-record-invalid" : "preferences-invalid");
  return readFileSync(path, "utf8");
}
function parse(text: string, record: boolean): Record<string, unknown> {
  try { const value: unknown = JSON.parse(text); if (object(value)) return value; } catch { /* Refuse corrupt data instead of resetting it. */ }
  throw new Refusal(record ? "management-record-invalid" : "preferences-invalid");
}
function readRecord(text: string): RecordFile {
  const value = parse(text, true);
  if (value.version !== 1 || value.preference !== "net.network_prediction_options" || value.managedValue !== 2
    || value.phase !== "prepared" && value.phase !== "applied" || typeof value.netPreviouslyPresent !== "boolean"
    || !object(value.previous) || typeof value.previous.present !== "boolean"
    || value.previous.present !== own(value.previous, "value") || value.previous.present && !value.netPreviouslyPresent
    || !equal(JSON.parse(JSON.stringify(value)), value)) throw new Refusal("management-record-invalid");
  return value as unknown as RecordFile;
}
function leaf(net: Record<string, unknown>): Leaf { return own(net, KEY) ? { present: true, value: net[KEY] } : { present: false }; }

/** No recursive deletion; temp cleanup only touches the exact file this call exclusively created. */
function atomicJson(path: string, value: unknown, expected: string | null, check: () => void) {
  const output = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(output) > (path.endsWith(CHROMIUM_PRELOADING_RECORD) ? 64 * 1024 : 16 * 1024 * 1024)) throw new Refusal(path.endsWith(CHROMIUM_PRELOADING_RECORD) ? "management-record-invalid" : "preferences-invalid");
  check();
  if (!existsSync(dirname(path))) mkdirSync(dirname(path));
  check();
  const temporary = `${path}.maobu-${randomUUID()}.tmp`;
  let descriptor: number | null = null, created = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600); created = true;
    writeFileSync(descriptor, output); fsyncSync(descriptor); closeSync(descriptor); descriptor = null;
    check();
    if (textFile(path, path.endsWith(CHROMIUM_PRELOADING_RECORD) ? 64 * 1024 : 16 * 1024 * 1024) !== expected) throw new Refusal("file-changed");
    renameSync(temporary, path); created = false;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (created) unlinkSync(temporary);
  }
}

export function applyChromiumPreloadingPreference(input: { profilesRoot: string; userDataDir: string; mode: ChromiumPreloadingMode }): ChromiumPreloadingResult {
  try {
    if (input.mode !== "browser-default" && input.mode !== "disabled") throw new Refusal("preferences-invalid");
    const location = paths(input.profilesRoot, input.userDataDir);
    const recordText = textFile(location.record, 64 * 1024);
    // No product override: do not even open legacy Preferences or create a directory.
    if (input.mode === "browser-default" && recordText === null) return { status: "unchanged" };
    if (!existsSync(location.directory)) throw new Refusal("profile-directory-missing");
    location.check();
    const originalText = textFile(location.preferences, 16 * 1024 * 1024);
    const preferences = originalText === null ? {} : parse(originalText, false);
    const netPreviouslyPresent = own(preferences, "net");
    if (netPreviouslyPresent && !object(preferences.net)) throw new Refusal("preferences-invalid");
    const net = (preferences.net ?? {}) as Record<string, unknown>, current = leaf(net);
    const record = recordText === null ? null : readRecord(recordText);
    const forget = () => {
      location.check();
      if (textFile(location.record, 64 * 1024) !== recordText) throw new Refusal("file-changed");
      unlinkSync(location.record);
    };
    if (input.mode === "browser-default") {
      if (!record) return { status: "unchanged" };
      if (current.present && current.value === record.managedValue) {
        if (record.previous.present) net[KEY] = record.previous.value; else delete net[KEY];
        if (!record.netPreviouslyPresent && !Object.keys(net).length) delete preferences.net; else preferences.net = net;
        atomicJson(location.preferences, preferences, originalText, location.check);
        forget();
        return { status: "restored" };
      }
      // Covers an external edit and a crash after restoration but before record removal.
      forget();
      return { status: equal(current, record.previous) ? "restored" : "user-change-preserved" };
    }
    if (record && current.present && current.value === record.managedValue) return { status: "unchanged" };
    if (record && !(record.phase === "prepared" && equal(current, record.previous))) return { status: "user-change-preserved" };
    if (!record && current.present && current.value === 2) return { status: "unchanged" }; // The user's existing value stays theirs.
    const prepared: RecordFile = record ?? { version: 1, preference: "net.network_prediction_options", managedValue: 2, phase: "prepared", previous: current, netPreviouslyPresent };
    // Reject values that cannot be preserved exactly in the bounded write-ahead record.
    const encodedRecord = `${JSON.stringify(prepared, null, 2)}\n`;
    if (Buffer.byteLength(encodedRecord) > 64 * 1024 || !equal(JSON.parse(encodedRecord).previous, current)) throw new Refusal("preferences-invalid");
    let preparedText = recordText;
    if (!record) { atomicJson(location.record, prepared, null, location.check); preparedText = textFile(location.record, 64 * 1024); }
    net[KEY] = 2; preferences.net = net;
    atomicJson(location.preferences, preferences, originalText, location.check);
    // If this last write fails, the prepared record already contains everything needed for safe recovery.
    atomicJson(location.record, { ...prepared, phase: "applied" }, preparedText, location.check);
    return { status: "applied" };
  } catch (error) { return { status: "blocked", reason: error instanceof Refusal ? error.reason : "io-failed" }; }
}
