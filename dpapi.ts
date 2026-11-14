/**
 * Windows DPAPI checks for Chromium's cookie key. Chromium stores the key in the
 * profile's root Local State, protected for the Windows account that wrote it;
 * another account cannot decrypt it, so that profile's saved cookies are lost.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface LocalProtectionOptions {
  /** Explicit 32-byte key (primarily for deterministic unit tests). */
  key?: Buffer;
  /** Override path for the persisted per-user master key file. */
  keyPath?: string;
  /** Keep an ephemeral 32-byte key in memory only (used for :memory: DBs). */
  inMemory?: boolean;
}

export interface LocalSecretProtector {
  encrypt(plaintext: string): string;
  decrypt(stored: string): string;
  isEncrypted(stored: unknown): stored is string;
}

const cachedKeys = new Map<string, Buffer>();

export function clearLocalSecretKeyCacheForTests(): void {
  cachedKeys.clear();
}

export function isEncryptedSecret(stored: unknown): stored is string {
  return typeof stored === "string" && stored.startsWith(ENCRYPTED_VALUE_PREFIX);
}

export function encryptSecretWithKey(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error(`local protection key must be ${KEY_BYTES} bytes`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENCRYPTED_VALUE_PREFIX + Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptSecretWithKey(stored: string, key: Buffer): string {
  if (!isEncryptedSecret(stored)) return stored;
  if (key.length !== KEY_BYTES) throw new Error(`local protection key must be ${KEY_BYTES} bytes`);
  const payload = Buffer.from(stored.slice(ENCRYPTED_VALUE_PREFIX.length), "base64");
  if (payload.length < IV_BYTES + TAG_BYTES) {
    throw new Error("corrupt encrypted secret payload");
  }
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function defaultLocalSecretKeyPath(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, "com.maobu.desktop", "local-store.key.dpapi");
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "maobu", "local-store.key");
}

const PROTECT_KEY_SCRIPT =
  "Add-Type -AssemblyName System.Security;" +
  "$raw=[Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim());" +
  "$enc=[Security.Cryptography.ProtectedData]::Protect($raw,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
  "[Convert]::ToBase64String($enc)";

const UNPROTECT_KEY_SCRIPT =
  "Add-Type -AssemblyName System.Security;" +
  "$enc=[Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim());" +
  "$raw=[Security.Cryptography.ProtectedData]::Unprotect($enc,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
  "[Convert]::ToBase64String($raw)";

function resolveWindowsPowerShell(): string {
  const winRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const systemPwsh = join(winRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(systemPwsh) ? systemPwsh : "powershell.exe";
}

function runDpapiKeyCommand(script: string, base64Input: string): Buffer {
  const res = Bun.spawnSync([resolveWindowsPowerShell(), "-NoProfile", "-NonInteractive", "-Command", script], {
    stdin: new TextEncoder().encode(base64Input),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) {
    const err = new TextDecoder().decode(res.stderr).trim();
    throw new Error(`Windows DPAPI key operation failed (${res.exitCode})${err ? `: ${err}` : ""}`);
  }
  const out = new TextDecoder().decode(res.stdout).trim();
  if (!out) throw new Error("Windows DPAPI returned empty output");
  return Buffer.from(out, "base64");
}

function loadPersistedKey(keyPath: string): Buffer {
  const raw = readFileSync(keyPath, "utf8").trim();
  if (process.platform === "win32") {
    if (!raw.startsWith("DPAPI:")) throw new Error("invalid DPAPI protected key format");
    const key = runDpapiKeyCommand(UNPROTECT_KEY_SCRIPT, raw.slice("DPAPI:".length));
    if (key.length !== KEY_BYTES) throw new Error("unprotected DPAPI key has invalid length");
    return key;
  }
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error("invalid persisted local protection key format");
  try { chmodSync(keyPath, 0o600); } catch {}
  return Buffer.from(raw, "hex");
}

function createOrLoadPersistedKey(keyPath: string): Buffer {
  const cached = cachedKeys.get(keyPath);
  if (cached) return cached;

  try {
    const existing = loadPersistedKey(keyPath);
    cachedKeys.set(keyPath, existing);
    return existing;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") throw err;
  }

  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  const fresh = randomBytes(KEY_BYTES);
  const encoded = process.platform === "win32"
    ? "DPAPI:" + runDpapiKeyCommand(PROTECT_KEY_SCRIPT, fresh.toString("base64")).toString("base64")
    : fresh.toString("hex");
  try {
    writeFileSync(keyPath, encoded + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    try { chmodSync(keyPath, 0o600); } catch {}
    cachedKeys.set(keyPath, fresh);
    return fresh;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") {
      const existing = loadPersistedKey(keyPath);
      cachedKeys.set(keyPath, existing);
      return existing;
    }
    throw err;
  }
}

function resolveEnvDataKey(): Buffer | null {
  const raw = process.env.MAOBU_DATA_KEY?.trim();
  if (!raw) return null;
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === KEY_BYTES) return decoded;
  throw new Error("MAOBU_DATA_KEY must be 32 bytes (64 hex chars or base64)");
}

export function createLocalSecretProtector(options: LocalProtectionOptions = {}): LocalSecretProtector {
  let key: Buffer;
  if (options.key) {
    if (options.key.length !== KEY_BYTES) throw new Error(`local protection key must be ${KEY_BYTES} bytes`);
    key = Buffer.from(options.key);
  } else if (options.inMemory) {
    key = randomBytes(KEY_BYTES);
  } else {
    const envKey = !options.keyPath ? resolveEnvDataKey() : null;
    key = envKey ?? createOrLoadPersistedKey(options.keyPath ?? defaultLocalSecretKeyPath());
  }
  return {
    encrypt: (plaintext: string) => encryptSecretWithKey(plaintext, key),
    decrypt: (stored: string) => decryptSecretWithKey(stored, key),
    isEncrypted: isEncryptedSecret,
  };
}

/** Base64 DPAPI blob (without the "DPAPI" prefix) from a Local State file, or null. */
export function localStateDpapiKey(path: string): string | null {
  let encoded: unknown;
  try { encoded = JSON.parse(readFileSync(path, "utf8"))?.os_crypt?.encrypted_key; } catch {}
  const bytes = typeof encoded === "string" ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
  if (bytes.length <= 5 || bytes.subarray(0, 5).toString() !== "DPAPI") return null;
  return bytes.subarray(5).toString("base64");
}

// One line per key: 1 = decrypted, 0 = DPAPI refused it, e = the check itself failed.
const UNPROTECT_SCRIPT = "Add-Type -AssemblyName System.Security;" +
  "$k=ConvertFrom-Json ([Console]::In.ReadToEnd());foreach($v in $k){try{" +
  "[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)|Out-Null;'1'" +
  "}catch{if($_.Exception -is [Security.Cryptography.CryptographicException] -or $_.Exception.InnerException -is [Security.Cryptography.CryptographicException]){'0'}else{'e'}}}";

/**
 * Per key, whether this Windows account can decrypt it. Null when the check
 * cannot answer (not Windows, PowerShell failure, or timeout).
 */
export async function dpapiKeysReadable(keys: string[], timeoutMs = 60_000): Promise<boolean[] | null> {
  if (process.platform !== "win32") return null;
  if (!keys.length) return [];
  try {
    const child = Bun.spawn([resolveWindowsPowerShell(), "-NoProfile", "-NonInteractive", "-Command", UNPROTECT_SCRIPT], {
      stdin: new Blob([JSON.stringify(keys)]), stdout: "pipe", stderr: "ignore",
    });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, Math.max(1, timeoutMs));
    const [raw, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
      .finally(() => clearTimeout(timer));
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (exitCode !== 0 || lines.length !== keys.length || lines.some((line) => line !== "0" && line !== "1")) return null;
    return lines.map((line) => line === "1");
  } catch {
    return null;
  }
}
