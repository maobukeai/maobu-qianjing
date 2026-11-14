import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CookieRecord } from "../../types.ts";
import { canonicalUserPageUrl } from "../../session.ts";

export const FIREFOX_SESSION_FILES = [
  "sessionstore.jsonlz4",
  "sessionstore-backups/recovery.jsonlz4",
  "sessionstore-backups/recovery.baklz4",
  "sessionstore-backups/previous.jsonlz4",
];

export function writeFirefoxStartupPage(userDataDir: string, restoreLastSession: boolean): void {
  const path = join(userDataDir, "user.js");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const preserved = existing
    .replace(/^user_pref\("browser\.(?:startup\.page|sessionstore\.privacy_level)",\s*\d+\);\s*$/gm, "")
    .trimEnd();
  // The engine default (2) never saves session cookies, so a restored session came back
  // without them. Stock Firefox (0) keeps them, as Chromium does with --restore-last-session.
  writeFileSync(
    path,
    `${preserved}${preserved ? "\n" : ""}user_pref("browser.sessionstore.privacy_level", 0);\n` +
      `user_pref("browser.startup.page", ${restoreLastSession ? 3 : 0});\n`,
  );
}

/** Firefox's mozLz4 file: "mozLz40\0", the decoded size, then one LZ4 block. */
export function decodeMozLz4(file: Buffer): Buffer {
  if (file.length < 12 || file.toString("latin1", 0, 8) !== "mozLz40\0") throw new Error("not a mozLz4 file");
  const out = Buffer.alloc(file.readUInt32LE(8));
  let input = 12;
  let output = 0;
  const length = (value: number) => {
    if (value < 15) return value;
    let byte: number;
    do { byte = file[input++]!; value += byte; } while (byte === 255);
    return value;
  };
  while (input < file.length) {
    const token = file[input++]!;
    const literals = length(token >> 4);
    if (input + literals > file.length || output + literals > out.length) throw new Error("corrupt mozLz4 block");
    file.copy(out, output, input, input + literals);
    input += literals;
    output += literals;
    if (input >= file.length) break;
    const offset = file.readUInt16LE(input);
    input += 2;
    const match = length(token & 15) + 4;
    if (offset === 0 || offset > output || output + match > out.length) throw new Error("corrupt mozLz4 block");
    for (const end = output + match; output < end; output++) out[output] = out[output - offset]!;
  }
  return out.subarray(0, output);
}

/**
 * Whether Firefox's native restore would reopen a web page, read from the first session file in
 * Firefox's own order; null when none is readable. A window that ended because its last tab closed
 * (a script closing every page does this) comes back only as an empty new-tab page. The Playwright
 * launch never sees that page, so every later open waited for the owner until it timed out.
 */
export function firefoxSessionRestoresPage(userDataDir: string): boolean | null {
  for (const file of FIREFOX_SESSION_FILES) {
    let session: any;
    try { session = JSON.parse(decodeMozLz4(readFileSync(join(userDataDir, file))).toString("utf8")); } catch { continue; }
    const windows: any[] = Array.isArray(session?.windows) ? session.windows : [];
    return windows.some((window) => !window?._maybeDontRestoreTabs && Array.isArray(window.tabs) && window.tabs.some((tab: any) => {
      const entries: any[] = Array.isArray(tab?.entries) ? tab.entries : [];
      return !!canonicalUserPageUrl(entries[(Number(tab.index) || entries.length) - 1]?.url);
    }));
  }
  return null;
}

/**
 * Session cookies (no expiry) from the newest session file. Firefox keeps them only there and
 * restores them only with startup page 3, so a launch with page 0 opened logged out of every
 * site that uses them. Container, private and partitioned cookies are left out.
 */
export function firefoxSessionCookies(userDataDir: string): CookieRecord[] {
  const files = FIREFOX_SESSION_FILES
    .flatMap((file) => { try { return [{ path: join(userDataDir, file), mtime: statSync(join(userDataDir, file)).mtimeMs }]; } catch { return []; } })
    .sort((a, b) => b.mtime - a.mtime);
  for (const { path } of files) {
    let session: any;
    try { session = JSON.parse(decodeMozLz4(readFileSync(path)).toString("utf8")); } catch { continue; }
    const cookies: any[] = Array.isArray(session?.cookies) ? session.cookies : [];
    return cookies.flatMap((cookie): CookieRecord[] => {
      const origin = cookie?.originAttributes ?? {};
      if (typeof cookie?.name !== "string" || !cookie.name || typeof cookie.value !== "string" || typeof cookie.host !== "string"
        || origin.userContextId || origin.privateBrowsingId || origin.partitionKey || origin.firstPartyDomain) return [];
      return [{
        name: cookie.name, value: cookie.value, domain: cookie.host,
        path: typeof cookie.path === "string" && cookie.path ? cookie.path : "/",
        ...(cookie.secure ? { secure: true } : {}),
        ...(cookie.httponly ? { httpOnly: true } : {}),
        ...(cookie.sameSite === 1 ? { sameSite: "Lax" as const } : cookie.sameSite === 2 ? { sameSite: "Strict" as const } : {}),
      }];
    });
  }
  return [];
}
