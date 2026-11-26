import { afterEach, expect, spyOn, test } from "bun:test";
import { addProfileCookies, extractSessionTokenInput, fetchAppMode, fetchRuntimeDownloads, fetchGroupExtensionDefaults, getStandaloneSessionToken, isUnauthorizedError, setGroupExtensionDefaults, setStandaloneSessionToken, subscribeUnauthorized, UnauthorizedError, checkProxy, exportProfiles, fetchProfiles, fetchExtensions, fetchScripts, openProfile, scriptsDesktopAvailable, startScriptRun, serialLoader, updateProfile } from "./api.ts";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; setStandaloneSessionToken(null); });
test("dashboard API reports an HTML/version mismatch instead of a JSON SyntaxError", async () => {
    globalThis.fetch = (async () => new Response("<!doctype html><title>猫步·千境</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
    await expect(fetchProfiles()).rejects.toThrow("dashboard and local server may be on different versions");
    await expect(openProfile("profile1")).rejects.toThrow("returned non-JSON");
});
test("dashboard API distinguishes an HTML server crash from a version mismatch", async () => {
    globalThis.fetch = (async () => new Response("<!doctype html><title>Internal Server Error</title>", {
        status: 500,
        headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
    await expect(fetchProfiles()).rejects.toThrow("local server failed before it could return JSON");
});
test("dashboard profile roster rejects malformed JSON shape explicitly", async () => {
    globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
    await expect(fetchProfiles()).rejects.toThrow("no profile roster");
});
test("profile export reports the server error", async () => {
    globalThis.fetch = (async () => Response.json({ ok: false, error: "Cloud profile could not be downloaded" }, { status: 502 })) as unknown as typeof fetch;
    await expect(exportProfiles(["profile1"], "txt")).rejects.toThrow("Cloud profile could not be downloaded");
});
test("profile export reads split progress records and downloads the exact file bytes", async () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const records = [
        { type: "progress", completed: 0, total: 2 },
        { type: "progress", completed: 2, total: 2 },
        { type: "file", mime: "application/octet-stream", data: Buffer.from(bytes).toString("base64") },
    ].map((record) => JSON.stringify(record) + "\n").join("");
    let request: any;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        request = JSON.parse(String(init?.body));
        return new Response(new ReadableStream({ start(controller) {
                const encoded = new TextEncoder().encode(records);
                for (let i = 0; i < encoded.length; i += 7)
                    controller.enqueue(encoded.slice(i, i + 7));
                controller.close();
            } }), { headers: { "content-type": "application/x-ndjson" } });
    }) as typeof fetch;
    const progress: unknown[] = [];
    let downloaded: Blob | undefined;
    let clicks = 0;
    const anchor = { href: "", download: "", click() { clicks++; }, remove() { } };
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
            createElement: () => anchor, body: { appendChild() { } },
        } });
    const create = spyOn(URL, "createObjectURL").mockImplementation((blob) => {
        downloaded = blob as Blob;
        return "blob:synthetic";
    });
    const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => { });
    try {
        await exportProfiles(["p1", "p2"], "xlsx", (value) => progress.push(value));
        expect(request).toEqual({ ids: ["p1", "p2"], format: "xlsx", stream: true });
        expect(progress).toEqual([{ completed: 0, total: 2 }, { completed: 2, total: 2 }]);
        expect(new Uint8Array(await downloaded!.arrayBuffer())).toEqual(bytes);
        expect(anchor.download).toBe("maobu-qianjing-export.xlsx");
        expect(clicks).toBe(1);
    }
    finally {
        create.mockRestore();
        revoke.mockRestore();
        if (documentDescriptor)
            Object.defineProperty(globalThis, "document", documentDescriptor);
        else
            Reflect.deleteProperty(globalThis, "document");
    }
});
test("profile export rejects streamed errors and incomplete files", async () => {
    for (const body of [
        '{"type":"progress","completed":1,"total":2}\n',
        '{"type":"file","mime":"text/plain","data":"YWJj"}',
        '{"type":"error","error":"Cloud export failed"}\n',
    ]) {
        globalThis.fetch = (async () => new Response(body, {
            headers: { "content-type": "application/x-ndjson" },
        })) as unknown as typeof fetch;
        await expect(exportProfiles(["p1", "p2"], "txt")).rejects.toThrow(body.includes('"error"') ? "Cloud export failed" : "Export interrupted");
    }
});
test("dashboard roster reads local groups and defaults missing optional metadata", async()=>{globalThis.fetch=(async()=>Response.json({profiles:[{id:"p1"}],groups:["Empty group"]})) as unknown as typeof fetch;const roster=await fetchProfiles();expect(roster.profiles[0]).toMatchObject({id:"p1"});expect(roster.groups).toEqual(["Empty group"]);globalThis.fetch=(async()=>Response.json({profiles:[{id:"legacy"}]})) as unknown as typeof fetch;expect((await fetchProfiles()).groups).toEqual([]);});
test("dashboard adds cookies to selected profiles through a same-origin JSON request", async () => {
    let input: RequestInfo | URL | undefined;
    let init: RequestInit | undefined;
    globalThis.fetch = (async (nextInput: RequestInfo | URL, nextInit?: RequestInit) => {
        input = nextInput;
        init = nextInit;
        return Response.json({ ok: true, live: 1, nextStart: 1 });
    }) as unknown as typeof fetch;
    const cookie = { name: "session", value: "private", domain: "example.com", path: "/" };
    await expect(addProfileCookies(["profile/id", "b"], cookie)).resolves.toEqual({ ok: true, live: 1, nextStart: 1 });
    expect(input).toBe("/ui/api/profiles/cookies");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ ids: ["profile/id", "b"], ...cookie });
    await addProfileCookies(["a"], { text: "[]" });
    expect(JSON.parse(String(init?.body))).toEqual({ ids: ["a"], text: "[]" });
});
test("dashboard checks an unsaved proxy through same-origin JSON", async () => {
    let input: RequestInfo | URL | undefined;
    let init: RequestInit | undefined;
    globalThis.fetch = (async (nextInput: RequestInfo | URL, nextInit?: RequestInit) => {
        input = nextInput;
        init = nextInit;
        return Response.json({
            ok: true,
            status: "working",
            attempts: 3,
            successes: 3,
            ip: "203.0.113.20",
            country: "US",
            rotating: false,
            ignored: "server-only field",
        });
    }) as unknown as typeof fetch;
    const proxy = {
        type: "socks5",
        host: "proxy.example",
        port: "1080",
        user: "proxy-user",
        pass: "private-password",
    };
    await expect(checkProxy(proxy)).resolves.toEqual({
        status: "working",
        attempts: 3,
        successes: 3,
        ip: "203.0.113.20",
        country: "US",
        rotating: false,
    });
    expect(input).toBe("/ui/api/proxy/check");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ proxy });
});
test("proxy check client rejects errors and malformed results without exposing credentials", async () => {
    globalThis.fetch = (async () => Response.json({ ok: false, error: "private-password was rejected" }, { status: 400 })) as unknown as typeof fetch;
    const invalid = await checkProxy({ host: "proxy.example", port: "8080", pass: "private-password" })
        .catch((error) => error);
    expect(invalid).toMatchObject({
        name: "ProxyCheckError",
        message: "Proxy check failed",
        kind: "invalid",
    });
    globalThis.fetch = (async () => Response.json({ ok: false, error: "private-password reached an unavailable checker" }, { status: 503 })) as unknown as typeof fetch;
    const unavailable = await checkProxy({ host: "proxy.example", port: "8080" }).catch((error) => error);
    expect(unavailable).toMatchObject({
        name: "ProxyCheckError",
        message: "Proxy check failed",
        kind: "unavailable",
    });
    globalThis.fetch = (async () => Response.json({
        ok: true,
        status: "unknown",
        attempts: 3,
        successes: 3,
        password: "private-password",
    })) as unknown as typeof fetch;
    await expect(checkProxy({ host: "proxy.example", port: "8080" }))
        .rejects.toThrow("Proxy check returned invalid data");
});
test("proxy check preserves reachability and exit comparison as separate evidence", async () => {
    for (const exitComparison of ["same", "different", "unknown"] as const) {
        globalThis.fetch = (async () => Response.json({ ok: true, status: "working", attempts: 3, successes: 3,
            exitComparison, ...(exitComparison === "same" ? { reason: "same_exit" } : {}), ip: "203.0.113.20" })) as unknown as typeof fetch;
        expect(await checkProxy({ host: "127.0.0.1", port: "7890" })).toMatchObject({ status: "working", exitComparison, ip: "203.0.113.20" });
    }
    globalThis.fetch = (async () => Response.json({ ok: true, status: "working", attempts: 3, successes: 3, exitComparison: "verified-private-ip" })) as unknown as typeof fetch;
    await expect(checkProxy({ host: "127.0.0.1", port: "7890" })).rejects.toThrow("Proxy check returned invalid data");
});
test("app mode client reads first-launch state", async () => {
    globalThis.fetch = (async () => Response.json({
        version: 1,
        mode: "local",
        localOnly: true,
        localAnalytics: false,
    })) as unknown as typeof fetch;
    expect(await fetchAppMode()).toEqual({ version: 1, mode: "local", localOnly: true, localAnalytics: false });
});
test("app mode rejects a failed response even when its payload contains local mode", async () => {
    globalThis.fetch = (async () => Response.json({ mode: "local", localOnly: true }, { status: 503 })) as unknown as typeof fetch;
    await expect(fetchAppMode()).rejects.toThrow();
});
test("app mode passes cancellation through to the local request", async () => {
    const caller = new AbortController();
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal;
        return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
        });
    }) as unknown as typeof fetch;
    const pending = fetchAppMode(caller.signal);
    expect(signal?.aborted).toBe(false);
    const stopped = new Error("Synthetic startup cancelled");
    caller.abort(stopped);
    await expect(pending).rejects.toBe(stopped);
});
test("runtime downloads client reads the downloads in progress", async () => {
    let requested: RequestInfo | URL | undefined;
    const downloads = [{ runtime: "aliasmode" as const, receivedBytes: 42, totalBytes: 100 }, { runtime: "firefox" as const, receivedBytes: 12, totalBytes: 0 }];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        requested = input;
        return Response.json({ downloads });
    }) as unknown as typeof fetch;
    expect(await fetchRuntimeDownloads()).toEqual(downloads);
    expect(requested).toBe("/ui/api/runtime-downloads");
    for (const item of [null, { runtime: "external", receivedBytes: 0, totalBytes: 1 }, { ...downloads[0], receivedBytes: 101 }, { ...downloads[0], receivedBytes: -1 }]) {
        globalThis.fetch = (async () => Response.json({ downloads: [item] })) as unknown as typeof fetch;
        await expect(fetchRuntimeDownloads()).rejects.toThrow("invalid data");
    }
    globalThis.fetch = (async () => Response.json({ ok: false, error: "not found" }, { status: 404 })) as unknown as typeof fetch;
    await expect(fetchRuntimeDownloads()).rejects.toThrow("invalid data");
});
test("local profile update forwards edits and response status", async () => {
    let body: unknown;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ ok: false, error: "reload required" }, { status: 409 });
    }) as unknown as typeof fetch;
    const result = await updateProfile("profile1", { name: "Changed" });
    expect(body).toEqual({ set: { name: "Changed" } });
    expect(result).toMatchObject({ ok: false, error: "reload required", status: 409 });
});
test("group extension defaults client reads and replaces exact selections", async () => {
    const requests: Array<{
        input: RequestInfo | URL;
        init?: RequestInit;
    }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input, init });
        return init?.method === "POST"
            ? Response.json({ ok: true, updatedCount: 2 })
            : Response.json({
                ok: true,
                groups: [{ name: "Sales", extensions: ["ext-1"] }],
            });
    }) as unknown as typeof fetch;
    expect(await fetchGroupExtensionDefaults()).toEqual([
        { name: "Sales", extensions: ["ext-1"] },
    ]);
    expect(await setGroupExtensionDefaults("Sales", ["ext-2"])).toEqual({ ok: true, updatedCount: 2 });
    expect(requests.map((request) => request.input)).toEqual([
        "/ui/api/groups/extensions",
        "/ui/api/groups/extensions",
    ]);
    expect(requests[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ group: "Sales", extensions: ["ext-2"] });
});
test("scripts require the desktop capability and send it on every request", async () => {
    const originalWindow = (globalThis as any).window;
    const calls: string[] = [];
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { __TAURI_INTERNALS__: { invoke: async (command: string) => { calls.push(command); return "test-capability"; } } },
    });
    const requests: Array<{
        path: RequestInfo | URL;
        init?: RequestInit;
    }> = [];
    globalThis.fetch = (async (path: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ path, init });
        return Response.json(init?.method === "POST"
            ? { ok: true, run: { id: "run-1", scriptName: "Check", status: "running", profiles: [] } }
            : { ok: true, scripts: [] });
    }) as unknown as typeof fetch;
    try {
        expect(scriptsDesktopAvailable()).toBe(true);
        await fetchScripts();
        await startScriptRun({ scriptId: "script-1", profileIds: ["profile-1"], inputs: {}, useCredentials: false, concurrency: 30 });
        expect(calls).toEqual(["script_capability", "script_capability"]);
        expect(requests.map((request) => request.path)).toEqual(["/ui/api/scripts", "/ui/api/scripts/run"]);
        expect(requests.map((request) => new Headers(request.init?.headers).get("Authorization"))).toEqual([
            "Bearer test-capability", "Bearer test-capability",
        ]);
        expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
            scriptId: "script-1", profileIds: ["profile-1"], inputs: {}, useCredentials: false, concurrency: 30,
        });
    }
    finally {
        if (originalWindow === undefined)
            Reflect.deleteProperty(globalThis, "window");
        else
            Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    }
});
test("roster loads run one at a time and polls never stack on a slow fetch", async () => {
    const releases: Array<() => void> = [];
    let runs = 0;
    const { load, poll } = serialLoader(() => {
        runs++;
        return new Promise<void>((resolve) => releases.push(resolve));
    });
    const first = load();
    poll();
    poll();
    const afterAction = load();
    expect(load()).toBe(afterAction);
    expect(runs).toBe(1);
    releases.shift()!();
    await first;
    await Promise.resolve();
    // A load asked for during a fetch waits for a fetch that starts after it.
    expect(runs).toBe(2);
    releases.shift()!();
    await afterAction;
    poll();
    expect(runs).toBe(3);
    releases.shift()!();
});


test("extension registry rejects failed and malformed reads instead of pretending the library is empty", async () => {
  globalThis.fetch = (async () => Response.json({ ok: false, error: "Registry unavailable" }, { status: 503 })) as unknown as typeof fetch;
  await expect(fetchExtensions()).rejects.toThrow("Registry unavailable");
  globalThis.fetch = (async () => Response.json({ ok: true, extensions: [{ id: "broken" }] })) as unknown as typeof fetch;
  await expect(fetchExtensions()).rejects.toThrow("Extension registry is unavailable.");
  globalThis.fetch = (async () => Response.json({ ok: true, extensions: [{ id: "one", name: "Installed tool" }] })) as unknown as typeof fetch;
  expect(await fetchExtensions()).toEqual([{ id: "one", name: "Installed tool" }]);
});

test("standalone session token extracts URLs/raw tokens, attaches X-Maobu-Session without clobbering Authorization, and surfaces 401 guidance", async () => {
  expect(extractSessionTokenInput("  http://127.0.0.1:50400/?token=abc123def  ")).toBe("abc123def");
  expect(extractSessionTokenInput("  raw-hex-token  ")).toBe("raw-hex-token");
  expect(extractSessionTokenInput("   ")).toBe("");

  expect(setStandaloneSessionToken("http://127.0.0.1:50400/?token=tok_standalone")).toBe("tok_standalone");
  expect(getStandaloneSessionToken()).toBe("tok_standalone");

  const capturedHeaders: Headers[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedHeaders.push(new Headers(init?.headers));
    return Response.json({ ok: true, extensions: [] });
  }) as unknown as typeof fetch;
  await fetchExtensions();
  expect(capturedHeaders[0]?.get("X-Maobu-Session")).toBe("tok_standalone");

  const events: UnauthorizedError[] = [];
  const unsubscribe = subscribeUnauthorized((err) => events.push(err));
  try {
    globalThis.fetch = (async () => Response.json({ ok: false, error: "Invalid session token" }, { status: 401 })) as unknown as typeof fetch;
    const rejected = await fetchAppMode().catch((err) => err);
    expect(isUnauthorizedError(rejected)).toBe(true);
    expect(rejected.message).toContain("/?token=");
    expect(rejected.message).toContain("X-Maobu-Session");
    expect(getStandaloneSessionToken()).toBeNull();
    expect(events).toHaveLength(1);
  } finally {
    unsubscribe();
  }
});
