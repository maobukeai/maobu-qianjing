/**
 * AdsPower-shaped HTTP facade over the CloakBrowser Launcher.
 *
 * Automation clients can use this exactly as they use AdsPower's local API — same
 * routes, same JSON envelope — so `startAdsPowerProfile(profileId, baseUrl)`
 * works unchanged when `baseUrl` points here. The shapes below are dictated by
 * what src/browser.ts parses:
 *   start  -> data.data.ws.puppeteer, data.data.debug_port
 *   active -> data.data.status === "Inactive"
 *   status -> data.code === 0 (health)
 */
import { BrowserLaunchError, CLOSE_SESSION_CAPTURE_OPTIONS, type Launcher } from "./launcher.ts";
import { callFirefoxOwner, type FirefoxOwner } from "./firefox-runtime.ts";
import type { ProfileStore } from "./store.ts";
import { normalizeProfileIds, type LifecycleAdmissionController, type LifecycleState, } from "./lifecycle-admission.ts";
import { harvestCookies, keepUnreadableOrigins, parseCapturedSessionBundle, sessionCaptureSeed, workerCaptureSeed } from "./session.ts";
import { canonicalIp } from "./ip.ts";

export const API_SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
} as const;

function ok(data?: unknown) {
    return Response.json({ code: 0, msg: "success", data: data ?? {} }, { headers: API_SECURITY_HEADERS });
}
function fail(msg: string) {
    return Response.json({ code: -1, msg, data: {} }, { headers: API_SECURITY_HEADERS });
}
const FIREFOX_CAPABILITIES = ["firefox-native", "cookies", "navigation", "sessions", "mcp", "scripts"] as const;
type FirefoxLaunch = {
    engine?: "chromium" | "firefox";
    firefoxOwner?: FirefoxOwner;
};
function isFirefoxEngine(launch: unknown): launch is FirefoxLaunch & {
    engine: "firefox";
} {
    return (launch as FirefoxLaunch | null)?.engine === "firefox";
}
function isFirefoxLaunch(launch: unknown): launch is FirefoxLaunch & {
    engine: "firefox";
    firefoxOwner: FirefoxOwner;
} {
    return isFirefoxEngine(launch) && !!launch.firefoxOwner;
}
function firefoxPublicFields() {
    return { engine: "firefox" as const, capabilities: FIREFOX_CAPABILITIES };
}
async function captureFirefoxSession(store: ProfileStore, profileId: string, owner: FirefoxOwner): Promise<void> {
    try {
        const captureSeed = sessionCaptureSeed(store.getSessionBundle(profileId) ?? "");
        const bundle = keepUnreadableOrigins(await callFirefoxOwner<string>(owner, "session-capture", {
            captureSeed: workerCaptureSeed(captureSeed),
        }), captureSeed.saved);
        parseCapturedSessionBundle(bundle);
        const current = store.getLaunch(profileId);
        if (isFirefoxLaunch(current) && current.firefoxOwner.generation === owner.generation) {
            store.saveSessionBundle(profileId, bundle);
        }
    }
    catch {
        // Preserve the last saved session when capture cannot be confirmed.
    }
}
export interface BrowserLifecycleContext {
    admission?: LifecycleAdmissionController;
}
function currentLifecycle(profileId: string, lifecycle?: BrowserLifecycleContext): LifecycleState | null { return lifecycle?.admission?.lifecycleState(profileId) ?? null; }
async function activeResponse(profileId: string, launcher: Launcher, store: ProfileStore, lifecycle?: BrowserLifecycleContext): Promise<Response> {
    const beforeState = currentLifecycle(profileId, lifecycle);
    if (beforeState)
        return ok({ status: "Active", lifecycle: beforeState });
    // Durable ownership is intentionally checked before certification. In the
    // confirmed-absence case there is nothing to probe or wait behind.
    if (!store.getLaunch(profileId))
        return ok({ status: "Inactive" });
    const alive = await launcher.certifiedActive(profileId).catch(() => false);
    const afterState = currentLifecycle(profileId, lifecycle);
    if (afterState)
        return ok({ status: "Active", lifecycle: afterState });
    const launch = store.getLaunch(profileId);
    if (alive && isFirefoxEngine(launch)) {
        return ok({ status: "Active", lifecycle: "running", ...firefoxPublicFields() });
    }
    if (alive && launch?.ws) {
        return ok({ status: "Active", lifecycle: "running", ws: { puppeteer: launch.ws, selenium: "" } });
    }
    // Certification can fail while ownership-safe teardown remains unconfirmed.
    // Keep that durable generation visible without exposing an uncertified CDP URL.
    if (launch)
        return ok({ status: "Active", lifecycle: "uncertain" });
    return ok({ status: "Inactive" });
}
function parseLaunchArgs(raw: string | null): string[] {
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    }
    catch {
        return [];
    }
}
export function isLoopbackAddress(address: string | null | undefined): boolean {
    const ip = address ? canonicalIp(address) : null;
    return !!ip && (ip.startsWith("127.") || ip === "::1");
}
export interface LocalHttpBoundaryOptions {
    port?: number;
    requireHost?: boolean;
    /** Provided by the actual TCP server; absent only for in-process dispatch. */
    clientAddress?: string | null;
}
function localBoundaryFailure(error: string): Response {
    return Response.json({ ok: false, error, code: -1, msg: error, data: {} }, { status: 403,
        headers: { ...API_SECURITY_HEADERS, "cache-control": "no-store", vary: "Origin, Sec-Fetch-Site" } });
}
function loopbackAuthority(authority: string, protocol: string): URL | null {
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[1-9]\d{0,4})?$/i.test(authority)) return null;
    try { return new URL(`${protocol}//${authority}`); } catch { return null; }
}
/** Guard before routing: local TCP alone does not prevent DNS rebinding or browser CSRF. */
export function rejectUntrustedLocalRequest(req: Request, options: LocalHttpBoundaryOptions = {}): Response | null {
    if ("clientAddress" in options && !isLoopbackAddress(options.clientAddress)) return localBoundaryFailure("Local API requires a loopback connection");
    let url: URL;
    try { url = new URL(req.url); } catch { return localBoundaryFailure("Local API requires a loopback URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !loopbackAuthority(url.host, url.protocol)) {
        return localBoundaryFailure("Local API requires a loopback URL");
    }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (options.port !== undefined && port !== options.port) return localBoundaryFailure("Local API port does not match this server");
    const host = req.headers.get("host");
    if (host === null) {
        if (options.requireHost) return localBoundaryFailure("Local API Host does not match this server");
    } else {
        const authority = loopbackAuthority(host, url.protocol);
        if (!authority || authority.host.toLowerCase() !== url.host.toLowerCase()) return localBoundaryFailure("Local API Host does not match this server");
    }
    // This permanently removed route has no state or payload processing. Keep
    // its existing 410 contract even for requests from the retired service.
    if (url.pathname === "/api/xactions/health-snapshot") return null;
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== url.origin) return localBoundaryFailure("Cross-origin local API requests are forbidden");
    const site = req.headers.get("sec-fetch-site");
    if (site !== null && !["same-origin", "none"].includes(site.toLowerCase())) return localBoundaryFailure("Cross-site local API requests are forbidden");
    const referer = req.headers.get("referer");
    if (referer !== null) {
        try { if (new URL(referer).origin !== url.origin) return localBoundaryFailure("Cross-origin local API requests are forbidden"); }
        catch { return localBoundaryFailure("Invalid local API request context"); }
    }
    return null;
}
/** Handle one request. Exposed so the dashboard server (web.ts) and tests can call it directly. */
export async function handleRequest(req: Request, launcher: Launcher, store: ProfileStore, lifecycle?: BrowserLifecycleContext): Promise<Response> {
    const boundary = rejectUntrustedLocalRequest(req);
    if (boundary) return boundary;
    const url = new URL(req.url);
    const { pathname, searchParams } = url;
    const userId = searchParams.get("user_id") ?? "";
    if (pathname === "/api/xactions/health-snapshot") {
        return Response.json({ ok: false, error: "This endpoint was removed from the local edition" }, { status: 410, headers: API_SECURITY_HEADERS });
    }
    // `/status` is the path AdsPower's own local API serves; `/api/v1/status`
    // is accepted for compatibility, so any AdsPower REST client is a base-URL flip.
    if (pathname === "/api/v1/status" || pathname === "/status") {
        return lifecycle?.admission
            ? ok({ admission: lifecycle.admission.stats() })
            : ok();
    }
    if (pathname === "/api/v1/browser/start") {
        if (!userId)
            return fail("missing user_id");
        if (!store.getProfile(userId))
            return fail(`no such profile: ${userId}`);
        try {
            const launchArgs = parseLaunchArgs(searchParams.get("launch_args"));
            const { ws, port } = await launcher.start(userId, launchArgs);
            if (isFirefoxEngine(store.getLaunch(userId)) || ws.startsWith("firefox://"))
                return ok(firefoxPublicFields());
            return ok({
                ws: { puppeteer: ws, selenium: "" },
                debug_port: String(port),
                webdriver: "",
            });
        }
        catch (err) {
            return fail(err instanceof BrowserLaunchError ? err.guidance ?? err.message : err instanceof Error ? err.message : String(err));
        }
    }
    if (pathname === "/api/v1/browser/stop") {
        if (!userId)
            return fail("missing user_id");
        const launch = store.getLaunch(userId);
        if (isFirefoxEngine(launch)) {
            if (isFirefoxLaunch(launch))
                await captureFirefoxSession(store, userId, launch.firefoxOwner);
        }
        else
            await launcher.captureLocalSession(userId, CLOSE_SESSION_CAPTURE_OPTIONS);
        return (await launcher.stop(userId, launch ?? undefined))
            ? ok()
            : fail(`browser teardown unconfirmed: ${userId}`);
    }
    // Cookie harvest is an AliasMode extension to the AdsPower API. The browser
    // can reject raw CDP cookie reads, so this route uses Playwright's
    // context.cookies() and returns the result as JSON.
    //   GET /api/v1/browser/cookies?user_id=<id>&urls=https://x.com,https://twitter.com
    //   -> { code:0, data:{ cookies:[{name,value,domain,path,httpOnly,secure,expires,sameSite}, ...] } }
    if (pathname === "/api/v1/browser/cookies") {
        if (!userId)
            return fail("missing user_id");
        if (!(await launcher.certifiedActive(userId)))
            return fail(`profile not safely running: ${userId}`);
        const launch = store.getLaunch(userId);
        if (!launch)
            return fail(`profile not running: ${userId}`);
        const urlsParam = searchParams.get("urls");
        const urls = urlsParam
            ? urlsParam.split(",").map((u) => u.trim()).filter(Boolean)
            : ["https://x.com", "https://twitter.com"];
        try {
            const cookies = isFirefoxEngine(launch)
                ? isFirefoxLaunch(launch)
                    ? await callFirefoxOwner(launch.firefoxOwner, "cookie-harvest", { urls })
                    : (() => { throw new Error("Firefox owner is unavailable"); })()
                : launch.ws ? await harvestCookies(launch.ws, urls) : (() => { throw new Error("profile not running"); })();
            return ok({ cookies });
        }
        catch (err) {
            return fail(err instanceof Error ? err.message : String(err));
        }
    }
    if (pathname === "/api/v1/browser/active") {
        if (!userId)
            return fail("missing user_id");
        return activeResponse(userId, launcher, store, lifecycle);
    }
    if (pathname === "/api/v2/browser-profile/delete-cache") {
        // Compatibility clients may fire-and-forget this after each session:
        //   POST { profile_id: [id], type: ["image_file"] }
        // Trim the profile's disk caches so user-data dirs don't grow unbounded.
        let ids: string[] = [];
        try {
            const body = (await req.json()) as {
                profile_id?: unknown;
            };
            ids = normalizeProfileIds(body?.profile_id);
        }
        catch {
            /* missing/invalid body → nothing to clear */
        }
        for (const id of ids)
            await launcher.clearCache(id);
        return ok();
    }
    return fail(`unknown route: ${pathname}`);
}
