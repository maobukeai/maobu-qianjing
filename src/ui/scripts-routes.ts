import { validAgentAuthorization } from "../../agent-control.ts";
import { ScriptError } from "../../scripts.ts";
import { msg, noStoreJson, rejectUntrustedJsonMutation, type UiRuntimeOptions } from "./shared.ts";

/** Routes under `/ui/api/scripts*` protected by agent bearer token and JSON mutation checks. */
export async function handleScriptsUiRoutes(
  req: Request,
  pathname: string,
  options: UiRuntimeOptions,
): Promise<Response | null> {
  if (pathname !== "/ui/api/scripts" && !pathname.startsWith("/ui/api/scripts/")) {
    return null;
  }
  const scripts = options.scripts;
  if (!scripts) return noStoreJson({ ok: false, error: "Scripts require the desktop app" }, 503);
  if (!validAgentAuthorization(req.headers.get("authorization"), scripts.nonce)) {
    return noStoreJson({ ok: false, error: "Script authorization failed" }, 401);
  }
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) {
    return noStoreJson({ ok: false, error: "Cross-origin requests are forbidden" }, 403);
  }
  if (req.method !== "GET") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
  }
  try {
    if (pathname === "/ui/api/scripts/run") {
      if (req.method === "GET") return noStoreJson({ ok: true, run: scripts.runner.status() });
      if (req.method === "POST") return noStoreJson({ ok: true, run: scripts.runner.start(await req.json()) });
    }
    if (pathname === "/ui/api/scripts/stop" && req.method === "POST") {
      return noStoreJson({ ok: true, run: await scripts.runner.stop() });
    }
    if (pathname === "/ui/api/scripts/python-runtime") {
      if (req.method === "POST") scripts.python?.ensure().catch(() => {});
      if (req.method === "GET" || req.method === "POST") {
        return noStoreJson({ ok: true, python: scripts.python?.status() ?? null });
      }
    }
    if (pathname === "/ui/api/scripts/log" && req.method === "GET") {
      const params = new URL(req.url).searchParams;
      return noStoreJson({
        ok: true,
        ...scripts.runner.log(params.get("runId") ?? "", Number(params.get("offset") ?? 0)),
      });
    }
    if (pathname === "/ui/api/scripts") {
      if (req.method === "GET") {
        const info = await scripts.library.info();
        return noStoreJson({ ok: true, ...info });
      }
      if (req.method === "POST") {
        const script = await scripts.library.save(await req.json());
        return noStoreJson({ ok: true, script });
      }
    }
    const match = pathname.match(/^\/ui\/api\/scripts\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      if (req.method === "GET") return noStoreJson({ ok: true, script: await scripts.library.get(id) });
      if (req.method === "PATCH") {
        const body = await req.json();
        const script = await scripts.library.save(body, id, body?.expectedRevision);
        return noStoreJson({ ok: true, script });
      }
      if (req.method === "DELETE") {
        const body = await req.json();
        await scripts.library.delete(id, body?.expectedRevision);
        return noStoreJson({ ok: true });
      }
    }
    return noStoreJson({ ok: false, error: "Unknown script operation" }, 404);
  } catch (error) {
    const status = error instanceof ScriptError
      ? error.status
      : error instanceof SyntaxError || error instanceof URIError ? 400 : 500;
    return noStoreJson(
      { ok: false, error: error instanceof SyntaxError ? "Invalid JSON request" : msg(error) },
      status,
    );
  }
}
