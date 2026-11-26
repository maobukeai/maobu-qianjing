import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Launcher } from "../../launcher.ts";
import type { ProfileStore } from "../../store.ts";
import type { ProxySpec } from "../../types.ts";
import { defaultChromiumRuntime, hostChromiumRuntime } from "../../aliasmode-chromium.ts";
import { defaultProfileEngine } from "../../create.ts";
import { checkProxy as runProxyCheck } from "../../proxy-check.ts";
import { handleProxyToolsRequest } from "../../proxy-tools.ts";
import { handleTrashRequest } from "../../trash.ts";
import { normalizeProxySpec, type ProxyInput } from "../../proxy.ts";
import { runtimeDownloads } from "../../runtime-download.ts";
import {
  APPLICATION_ROOT,
  appVersion,
  LOW_DISK_SPACE_BYTES,
  msg,
  noStoreJson,
  proxyCheckView,
  readLatestDiagnose,
  readShellLanguage,
  rejectUntrustedJsonMutation,
  SHELL_LANGUAGE_PATTERN,
  writeShellLanguage,
  type UiRuntimeOptions,
} from "./shared.ts";

const LOG_TAIL_LIMIT = 64 * 1024;

async function readLogTail(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error("Invalid log file");
    // Three UTF-8 bytes per UTF-16 code unit covers the requested suffix.
    // The extra bytes allow decoding even when the read starts inside a character.
    const bytes = Buffer.alloc(Math.min(stats.size, LOG_TAIL_LIMIT * 3 + 3));
    const start = stats.size - bytes.length;
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, start + length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return bytes.subarray(0, length).toString("utf8").slice(-LOG_TAIL_LIMIT);
  } finally {
    await file.close();
  }
}

/** System, health, shell preferences, proxy tools, and trash UI API routes. */
export async function handleSystemUiRoutes(
  req: Request,
  pathname: string,
  launcher: Launcher,
  store: ProfileStore,
  options: UiRuntimeOptions,
): Promise<Response | null> {
  if (pathname === "/ui/api/health" && req.method === "GET") {
    const logDir = options.paths ? join(options.paths.root, "logs") : undefined;
    return Response.json(options.health
      ? { ok: true, ...options.health, ...(logDir ? { logDir } : {}) }
      : { ok: true, version: await appVersion(), root: APPLICATION_ROOT, ...(logDir ? { logDir } : {}) });
  }
  if (pathname === "/ui/api/disk-space" && req.method === "GET") {
    const freeBytes = launcher.dataDriveFreeBytes();
    return noStoreJson({ ok: true, freeBytes, low: freeBytes !== null && freeBytes < LOW_DISK_SPACE_BYTES });
  }
  if (pathname === "/ui/api/logs" && req.method === "GET") {
    if (!options.paths) return noStoreJson({ ok: false, error: "logs are unavailable" }, 503);
    try {
      const dir = join(options.paths.root, "logs");
      const names = await readdir(dir);
      const name = names.filter((f) => /^aliasmode-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().pop();
      if (!name) return noStoreJson({ ok: false, error: "no log file yet" });
      return noStoreJson({ ok: true, file: name, content: await readLogTail(join(dir, name)) });
    } catch {
      return noStoreJson({ ok: false, error: "log file could not be read" });
    }
  }
  if (pathname === "/ui/api/app-mode" && req.method === "GET") {
    const config = options.appConfig?.read() ?? { version: 1 as const, mode: "local" as const, localAnalytics: false };
    const forcedRuntime = hostChromiumRuntime(), defaultRuntime = defaultChromiumRuntime();
    return Response.json({
      ...config,
      mode: "local",
      localOnly: true,
      localAnalytics: false,
      restartRequired: false,
      ...(options.events ? { eventsStream: true } : {}),
      ...(options.appLock ? { appLockAvailable: true } : {}),
      ...(forcedRuntime ? { chromiumRuntime: forcedRuntime } : {}),
      ...(defaultRuntime ? { defaultChromiumRuntime: defaultRuntime } : {}),
      defaultEngine: defaultProfileEngine(),
    });
  }
  if (pathname === "/ui/api/app-mode" && req.method === "POST") {
    if (!options.appConfig) return Response.json({ ok: false, error: "app configuration is unavailable" }, { status: 503 });
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    try {
      const body = await req.json() as { mode?: unknown };
      if (body.mode !== "local") return noStoreJson({ ok: false, error: "This build supports local mode only" }, 400);
      const config = options.appConfig.setMode("local");
      return Response.json({ ok: true, config, restartRequired: false });
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 400 });
    }
  }
  if (pathname === "/ui/api/shell-language" && req.method === "GET") {
    return noStoreJson({ language: readShellLanguage(options.paths) });
  }
  if (pathname === "/ui/api/shell-language" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) {
      rejected.headers.set("Cache-Control", "no-store");
      return rejected;
    }
    const body = (await req.json().catch(() => ({}))) as { language?: unknown };
    const language = typeof body.language === "string" && SHELL_LANGUAGE_PATTERN.test(body.language)
      ? body.language
      : "en-US";
    try {
      writeShellLanguage(options.paths, language);
    } catch {
      return noStoreJson({ ok: false, error: "Could not save language preference" }, 500);
    }
    return noStoreJson({ ok: true, language });
  }
  if (pathname === "/ui/api/runtime-downloads" && req.method === "GET") {
    return noStoreJson({ downloads: runtimeDownloads() });
  }
  if (pathname === "/ui/api/proxy/check" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) {
      rejected.headers.set("Cache-Control", "no-store");
      return rejected;
    }
    let proxy: ProxySpec;
    try {
      const body = await req.json() as { proxy?: unknown };
      if (!body || typeof body !== "object" || !body.proxy || typeof body.proxy !== "object" || Array.isArray(body.proxy)) {
        throw new Error("invalid proxy input");
      }
      const normalized = normalizeProxySpec(body.proxy as ProxyInput);
      if (!normalized || (normalized.type !== "http" && normalized.type !== "socks5")) {
        throw new Error("unsupported proxy input");
      }
      proxy = normalized;
    } catch {
      return noStoreJson({ ok: false, error: "Invalid proxy settings" }, 400);
    }
    try {
      const result = await (options.proxyCheck ?? runProxyCheck)(proxy);
      return noStoreJson({ ok: true, ...proxyCheckView(result) });
    } catch {
      return noStoreJson({ ok: false, error: "Proxy check failed" }, 500);
    }
  }
  if (pathname.startsWith("/ui/api/proxies/")) {
    const operationRead = /^\/ui\/api\/proxies\/operations\/[^/]+$/.test(pathname) && req.method === "GET";
    if (!operationRead) {
      if (req.method !== "POST") return noStoreJson({ ok: false, error: "POST is required" }, 405);
      const rejected = rejectUntrustedJsonMutation(req);
      if (rejected) return rejected;
    }
    return handleProxyToolsRequest(req, launcher, store, options);
  }
  if (pathname === "/ui/api/trash" || pathname.startsWith("/ui/api/trash/")) {
    if (req.method !== "GET") {
      const rejected = rejectUntrustedJsonMutation(req);
      if (rejected) return rejected;
    }
    return handleTrashRequest(req, launcher, store, options);
  }
  if (pathname === "/ui/api/diagnose/latest" && req.method === "GET") {
    return Response.json({ report: await readLatestDiagnose(options.paths?.reports) });
  }
  return null;
}
