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
import type { Launcher } from "./launcher.ts";
import { callFirefoxOwner, type FirefoxOwner } from "./firefox-runtime.ts";
import type { ProfileStore } from "./store.ts";
import { normalizeProfileIds, type LifecycleAdmissionController, type LifecycleState, } from "./lifecycle-admission.ts";
import { harvestCookies, keepUnreadableOrigins, parseCapturedSessionBundle, sessionCaptureSeed, workerCaptureSeed } from "./session.ts";

function ok(data?: unknown) {
    return Response.json({ code: 0, msg: "success", data: data ?? {} });
}
function fail(msg: string) {
    return Response.json({ code: -1, msg, data: {} });
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
    return !!address && (address.startsWith("127.") || address === "::1" || address.startsWith("::ffff:127."));
}
/** Handle one request. Exposed so the dashboard server (web.ts) and tests can call it directly. */
export async function handleRequest(req: Request, launcher: Launcher, store: ProfileStore, lifecycle?: BrowserLifecycleContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname, searchParams } = url;
    const userId = searchParams.get("user_id") ?? "";
    if (pathname === "/api/xactions/health-snapshot") {
        return Response.json({ ok: false, error: "This endpoint was removed from the local edition" }, { status: 410 });
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
            return fail(err instanceof Error ? err.message : String(err));
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
            await launcher.captureLocalSession(userId);
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
