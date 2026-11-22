/**
 * Reversible Chromium memory-saver & data-saver preferences and launch flags.
 *
 * Follows the same write-ahead, symlink-safe, atomic preference discipline as
 * `chromium-preloading-preferences.ts`: never modifies a live browser directory,
 * never creates Preferences when no policy is active, and restores prior values
 * cleanly once a policy is turned back off unless the user changed them manually.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DataSaverSettings } from "../../app-settings.ts";

export const CHROMIUM_RESOURCE_POLICY_RECORD = ".maobu-resource-policy-override.json";
export const CHROMIUM_MEMORY_SAVER_RENDERER_LIMIT = 4;
export const CHROMIUM_MEMORY_SAVER_DISK_CACHE_BYTES = 10_485_760;

export interface ChromiumResourcePolicyInput {
  memorySaver: boolean;
  dataSaver: DataSaverSettings;
}

export interface ApplyChromiumResourcePreferencesInput {
  profilesRoot: string;
  userDataDir: string;
  memorySaver: boolean;
  muteSound: boolean;
}

export type ChromiumResourcePreferencesResult =
  | { status: "unchanged" | "applied" | "restored" | "user-change-preserved" }
  | {
      status: "blocked";
      reason:
        | "unsafe-path"
        | "profile-directory-missing"
        | "preferences-invalid"
        | "management-record-invalid"
        | "file-changed"
        | "io-failed";
    };

interface LeafSnapshot {
  present: boolean;
  value?: unknown;
  parentCreated: boolean[];
}

interface ManagedLeafRecord {
  managedValue: number;
  previous: LeafSnapshot;
}

interface ResourcePolicyRecordFile {
  version: 1;
  phase: "prepared" | "applied";
  leaves: {
    highEfficiencyMode?: ManagedLeafRecord;
    muteSound?: ManagedLeafRecord;
  };
}

type LeafName = "highEfficiencyMode" | "muteSound";

const LEAF_SPECS: Record<LeafName, { path: readonly [string, string, string]; managedValue: number }> = {
  highEfficiencyMode: {
    path: ["performance_tuning", "high_efficiency_mode", "state"],
    managedValue: 1,
  },
  muteSound: {
    path: ["profile", "default_content_setting_values", "sound"],
    managedValue: 2,
  },
};

class Refusal extends Error {
  constructor(readonly reason: Extract<ChromiumResourcePreferencesResult, { status: "blocked" }>["reason"]) {
    super(reason);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function statEntry(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function resolvePaths(profilesRoot: string, userDataDir: string) {
  const root = resolve(profilesRoot);
  const directory = resolve(userDataDir);
  const child = relative(root, directory);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Refusal("unsafe-path");
  }
  const checkDirectories = () => {
    let current = root;
    for (const segment of ["", ...child.split(sep)]) {
      if (segment) current = join(current, segment);
      const info = statEntry(current);
      if (info && (info.isSymbolicLink() || !info.isDirectory())) {
        throw new Refusal("unsafe-path");
      }
    }
  };
  checkDirectories();
  return {
    directory,
    preferences: join(directory, "Default", "Preferences"),
    record: join(directory, CHROMIUM_RESOURCE_POLICY_RECORD),
    check: () => {
      checkDirectories();
      const defaultDir = join(directory, "Default");
      const info = statEntry(defaultDir);
      if (info && (info.isSymbolicLink() || !info.isDirectory())) {
        throw new Refusal("unsafe-path");
      }
    },
  };
}

function readBoundedText(path: string, maximumBytes: number, isRecordFile: boolean): string | null {
  const info = statEntry(path);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Refusal("unsafe-path");
  if (info.size > maximumBytes) {
    throw new Refusal(isRecordFile ? "management-record-invalid" : "preferences-invalid");
  }
  return readFileSync(path, "utf8");
}

function parseJsonObject(text: string, isRecordFile: boolean): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return parsed;
  } catch {}
  throw new Refusal(isRecordFile ? "management-record-invalid" : "preferences-invalid");
}

function validateLeafRecord(raw: unknown, expectedValue: number): ManagedLeafRecord {
  if (!isRecord(raw) || raw.managedValue !== expectedValue || !isRecord(raw.previous)) {
    throw new Refusal("management-record-invalid");
  }
  const prev = raw.previous;
  if (
    typeof prev.present !== "boolean" ||
    prev.present !== hasOwn(prev, "value") ||
    !Array.isArray(prev.parentCreated) ||
    prev.parentCreated.length !== 2 ||
    !prev.parentCreated.every((item) => typeof item === "boolean")
  ) {
    throw new Refusal("management-record-invalid");
  }
  return {
    managedValue: expectedValue,
    previous: {
      present: prev.present,
      ...(prev.present ? { value: prev.value } : {}),
      parentCreated: prev.parentCreated as boolean[],
    },
  };
}

function parseRecordFile(text: string): ResourcePolicyRecordFile {
  const parsed = parseJsonObject(text, true);
  if (
    parsed.version !== 1 ||
    (parsed.phase !== "prepared" && parsed.phase !== "applied") ||
    !isRecord(parsed.leaves)
  ) {
    throw new Refusal("management-record-invalid");
  }
  const leaves: ResourcePolicyRecordFile["leaves"] = {};
  for (const key of Object.keys(parsed.leaves)) {
    if (key !== "highEfficiencyMode" && key !== "muteSound") {
      throw new Refusal("management-record-invalid");
    }
    const spec = LEAF_SPECS[key];
    leaves[key] = validateLeafRecord(parsed.leaves[key], spec.managedValue);
  }
  return { version: 1, phase: parsed.phase, leaves };
}

function atomicWriteJson(
  path: string,
  value: unknown,
  expected: string | null,
  check: () => void,
  isRecordFile: boolean,
): void {
  const maxBytes = isRecordFile ? 64 * 1024 : 16 * 1024 * 1024;
  const output = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(output) > maxBytes) {
    throw new Refusal(isRecordFile ? "management-record-invalid" : "preferences-invalid");
  }
  check();
  if (!existsSync(dirname(path))) mkdirSync(dirname(path));
  check();
  const tempPath = `${path}.maobu-${randomUUID()}.tmp`;
  let fd: number | null = null;
  let created = false;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    created = true;
    writeFileSync(fd, output);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    check();
    if (readBoundedText(path, maxBytes, isRecordFile) !== expected) {
      throw new Refusal("file-changed");
    }
    renameSync(tempPath, path);
    created = false;
  } finally {
    if (fd !== null) closeSync(fd);
    if (created) unlinkSync(tempPath);
  }
}

function readLeaf(prefs: Record<string, unknown>, path: readonly [string, string, string]): {
  present: boolean;
  value?: unknown;
  parentCreated: [boolean, boolean];
} {
  const [k0, k1, k2] = path;
  const has0 = hasOwn(prefs, k0);
  if (has0 && !isRecord(prefs[k0])) throw new Refusal("preferences-invalid");
  const obj0 = has0 ? (prefs[k0] as Record<string, unknown>) : undefined;
  const has1 = !!obj0 && hasOwn(obj0, k1);
  if (has1 && !isRecord(obj0![k1])) throw new Refusal("preferences-invalid");
  const obj1 = has1 ? (obj0![k1] as Record<string, unknown>) : undefined;
  const has2 = !!obj1 && hasOwn(obj1, k2);
  return {
    present: has2,
    ...(has2 ? { value: obj1![k2] } : {}),
    parentCreated: [!has0, !has1],
  };
}

function writeLeaf(prefs: Record<string, unknown>, path: readonly [string, string, string], value: unknown): void {
  const [k0, k1, k2] = path;
  if (!hasOwn(prefs, k0)) prefs[k0] = {};
  const obj0 = prefs[k0] as Record<string, unknown>;
  if (!hasOwn(obj0, k1)) obj0[k1] = {};
  const obj1 = obj0[k1] as Record<string, unknown>;
  obj1[k2] = value;
}

function restoreLeaf(
  prefs: Record<string, unknown>,
  path: readonly [string, string, string],
  previous: LeafSnapshot,
): void {
  const [k0, k1, k2] = path;
  const obj0 = isRecord(prefs[k0]) ? (prefs[k0] as Record<string, unknown>) : undefined;
  const obj1 = obj0 && isRecord(obj0[k1]) ? (obj0[k1] as Record<string, unknown>) : undefined;
  if (previous.present) {
    writeLeaf(prefs, path, previous.value);
    return;
  }
  if (obj1) {
    delete obj1[k2];
    if (previous.parentCreated[1] && Object.keys(obj1).length === 0 && obj0) {
      delete obj0[k1];
    }
  }
  if (obj0 && previous.parentCreated[0] && Object.keys(obj0).length === 0) {
    delete prefs[k0];
  }
}

/**
 * Reversibly apply or restore Chromium resource-saving preferences in `Default/Preferences`.
 * - `memorySaver`: `performance_tuning.high_efficiency_mode.state = 1`
 * - `muteSound`: `profile.default_content_setting_values.sound = 2`
 */
export function applyChromiumResourcePreferences(
  input: ApplyChromiumResourcePreferencesInput,
): ChromiumResourcePreferencesResult {
  try {
    const location = resolvePaths(input.profilesRoot, input.userDataDir);
    const recordText = readBoundedText(location.record, 64 * 1024, true);
    const desired: Record<LeafName, boolean> = {
      highEfficiencyMode: input.memorySaver === true,
      muteSound: input.muteSound === true,
    };

    if (!desired.highEfficiencyMode && !desired.muteSound && recordText === null) {
      return { status: "unchanged" };
    }
    if (!existsSync(location.directory)) throw new Refusal("profile-directory-missing");
    location.check();

    const originalPrefsText = readBoundedText(location.preferences, 16 * 1024 * 1024, false);
    const preferences = originalPrefsText === null ? {} : parseJsonObject(originalPrefsText, false);
    const existingRecord = recordText === null ? null : parseRecordFile(recordText);

    const nextLeaves: ResourcePolicyRecordFile["leaves"] = {};
    let prefsDirty = false;
    let appliedAny = false;
    let restoredAny = false;
    let preservedUserEdit = false;

    for (const name of ["highEfficiencyMode", "muteSound"] as const) {
      const spec = LEAF_SPECS[name];
      const current = readLeaf(preferences, spec.path);
      const prevRecord = existingRecord?.leaves[name];

      if (desired[name]) {
        if (prevRecord) {
          if (current.present && isDeepStrictEqual(current.value, prevRecord.managedValue)) {
            nextLeaves[name] = prevRecord;
          } else if (
            existingRecord?.phase === "prepared" &&
            current.present === prevRecord.previous.present &&
            (!current.present || isDeepStrictEqual(current.value, prevRecord.previous.value))
          ) {
            writeLeaf(preferences, spec.path, spec.managedValue);
            nextLeaves[name] = prevRecord;
            prefsDirty = true;
            appliedAny = true;
          } else {
            // User manually changed this preference while we were managing it; preserve their edit.
            preservedUserEdit = true;
          }
        } else if (current.present && isDeepStrictEqual(current.value, spec.managedValue)) {
          // Already set to the desired value by the user; do not claim ownership.
        } else {
          const leafRecord: ManagedLeafRecord = {
            managedValue: spec.managedValue,
            previous: {
              present: current.present,
              ...(current.present ? { value: current.value } : {}),
              parentCreated: current.parentCreated,
            },
          };
          writeLeaf(preferences, spec.path, spec.managedValue);
          nextLeaves[name] = leafRecord;
          prefsDirty = true;
          appliedAny = true;
        }
      } else if (prevRecord) {
        if (current.present && isDeepStrictEqual(current.value, prevRecord.managedValue)) {
          restoreLeaf(preferences, spec.path, prevRecord.previous);
          prefsDirty = true;
          restoredAny = true;
        } else if (
          current.present === prevRecord.previous.present &&
          (!current.present || isDeepStrictEqual(current.value, prevRecord.previous.value))
        ) {
          restoredAny = true;
        } else {
          preservedUserEdit = true;
        }
      }
    }

    const hasManagedLeaves = Object.keys(nextLeaves).length > 0;

    if (!hasManagedLeaves) {
      if (prefsDirty) {
        atomicWriteJson(location.preferences, preferences, originalPrefsText, location.check, false);
      }
      if (recordText !== null) {
        location.check();
        if (readBoundedText(location.record, 64 * 1024, true) !== recordText) {
          throw new Refusal("file-changed");
        }
        unlinkSync(location.record);
      }
      if (restoredAny) return { status: "restored" };
      if (preservedUserEdit) return { status: "user-change-preserved" };
      return { status: "unchanged" };
    }

    const preparedRecord: ResourcePolicyRecordFile = {
      version: 1,
      phase: "prepared",
      leaves: nextLeaves,
    };
    const finalRecord: ResourcePolicyRecordFile = {
      version: 1,
      phase: "applied",
      leaves: nextLeaves,
    };

    const recordChanged =
      !existingRecord ||
      existingRecord.phase !== "applied" ||
      !isDeepStrictEqual(existingRecord.leaves, nextLeaves);

    if (prefsDirty) {
      let currentRecordText = recordText;
      if (recordChanged) {
        atomicWriteJson(location.record, preparedRecord, currentRecordText, location.check, true);
        currentRecordText = readBoundedText(location.record, 64 * 1024, true);
      }
      atomicWriteJson(location.preferences, preferences, originalPrefsText, location.check, false);
      atomicWriteJson(location.record, finalRecord, currentRecordText, location.check, true);
      if (appliedAny) return { status: "applied" };
      if (restoredAny) return { status: "restored" };
      return { status: "applied" };
    }

    if (recordChanged) {
      atomicWriteJson(location.record, finalRecord, recordText, location.check, true);
    }
    if (preservedUserEdit) return { status: "user-change-preserved" };
    return { status: "unchanged" };
  } catch (error) {
    return {
      status: "blocked",
      reason: error instanceof Refusal ? error.reason : "io-failed",
    };
  }
}

/** Build Chromium CLI flags for memory-saver and data-saver modes (zero MITM / zero extensions). */
export function buildChromiumResourceArgs(policy: ChromiumResourcePolicyInput): string[] {
  const args: string[] = [];
  if (policy.memorySaver) {
    args.push(
      `--renderer-process-limit=${CHROMIUM_MEMORY_SAVER_RENDERER_LIMIT}`,
      "--enable-features=HighEfficiencyModeAvailable",
      `--disk-cache-size=${CHROMIUM_MEMORY_SAVER_DISK_CACHE_BYTES}`,
    );
  }
  if (policy.dataSaver.enabled) {
    if (policy.dataSaver.blockImages) {
      args.push("--blink-settings=imagesEnabled=false");
    }
    if (policy.dataSaver.blockFonts) {
      args.push("--disable-remote-fonts");
    }
    if (policy.dataSaver.blockMedia) {
      args.push(
        "--autoplay-policy=document-user-activation-required",
        "--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies",
      );
    }
  }
  return args;
}
