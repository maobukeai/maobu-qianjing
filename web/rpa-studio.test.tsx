import { expect, test } from "bun:test";
import { act } from "react";
import type { HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement } from "happy-dom";
import type { ScriptRecord } from "../contracts/local.ts";
import { listRpaTemplates } from "../rpa-templates.ts";
import type { ScriptRun } from "../scripts.ts";
import { createWebDomHarness } from "../test-fixtures/web-dom.ts";
import { I18nProvider } from "./i18n.tsx";
import { RpaRecorderPanel } from "./rpa-recorder-panel.tsx";
import { RpaProfileReceipt, RpaRunsQueuePanel } from "./rpa-run-receipt.tsx";
import { RpaTemplatesPanel } from "./rpa-templates-panel.tsx";
import { ScriptsPage } from "./scripts.tsx";

function installDesktopCapability(dom: Awaited<ReturnType<typeof createWebDomHarness>>) {
  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (cmd: string) => {
        if (cmd === "script_capability") return "test-rpa-nonce";
        throw new Error(`unexpected command: ${cmd}`);
      },
    },
  });
}

async function waitFor(
  dom: Awaited<ReturnType<typeof createWebDomHarness>>,
  predicate: () => boolean,
  label: string,
) {
  const deadline = Date.now() + 2500;
  while (!predicate() && Date.now() < deadline) {
    await dom.flush();
  }
  expect(predicate(), label).toBe(true);
}

test("RpaTemplatesPanel renders all 4 built-in templates, schema-driven form with dryRun default, and copies/runs cleanly", async () => {
  const templates = listRpaTemplates();
  const createdScripts: unknown[] = [];
  const startedRuns: unknown[] = [];

  const fakeFetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    if (path === "/ui/api/profiles") {
      return Response.json({
        ok: true,
        profiles: [{ id: "prof_1", name: "Alpha Profile", engine: "chromium", group: "", platform: "", tags: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, running: false }],
        groups: [],
      });
    }
    if (path === "/ui/api/scripts/templates" && method === "GET") {
      return Response.json({ ok: true, templates });
    }
    if (path === "/ui/api/scripts" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      createdScripts.push(body);
      return Response.json({
        ok: true,
        script: { ...body, id: "copied-1", revision: 1, createdAt: "2026-11-22T00:00:00Z", updatedAt: "2026-11-22T00:00:00Z" },
      });
    }
    if (path === "/ui/api/scripts/run" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      startedRuns.push(body);
      return Response.json({
        ok: true,
        run: { id: "run-tpl-1", scriptName: "Safe Form Fill Skeleton", status: "running", profiles: [{ id: "prof_1", name: "Alpha Profile", status: "running" }] },
      });
    }
    return Response.json({ ok: false, error: `unhandled ${method} ${path}` }, { status: 404 });
  }, { preconnect: globalThis.fetch.preconnect });

  const dom = await createWebDomHarness({ fetch: fakeFetch });
  installDesktopCapability(dom);
  let copiedRecord: ScriptRecord | null = null;
  let observedRun: ScriptRun | null = null;

  try {
    await dom.render(
      <I18nProvider>
        <RpaTemplatesPanel
          onScriptCopied={(rec) => { copiedRecord = rec; }}
          onRunStarted={(run) => { observedRun = run; }}
        />
      </I18nProvider>,
    );

    await waitFor(dom, () => dom.container.querySelectorAll(".rpa-template-card").length === 4, "4 templates rendered");

    // Select form-fill-skeleton and confirm dryRun checkbox defaults to checked.
    const formCard = dom.container.querySelector<HTMLButtonElement>('[data-template-id="form-fill-skeleton"]')!;
    await act(async () => { formCard.click(); });
    await waitFor(dom, () => dom.container.textContent?.includes("Dry run is enabled by default") ?? false, "safety note shown");
    const dryRunCheckbox = [...dom.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][0]!;
    expect(dryRunCheckbox.checked).toBe(true);

    // Copy to my scripts.
    const copyBtn = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Copy to my scripts")!;
    await act(async () => { copyBtn.click(); });
    await waitFor(dom, () => copiedRecord !== null, "template copied");
    expect(createdScripts).toHaveLength(1);

    // Select target profile chip and run directly.
    const profileChip = dom.container.querySelector<HTMLButtonElement>(".rpa-profile-chip")!;
    await act(async () => { profileChip.click(); });
    const runBtn = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Run template")!;
    await act(async () => { runBtn.click(); });
    await waitFor(dom, () => observedRun !== null, "template run started");
    expect(startedRuns[0]).toMatchObject({ scriptId: "template:form-fill-skeleton", profileIds: ["prof_1"], useCredentials: true, queueIfBusy: true });
  } finally {
    await dom.cleanup();
  }
});

test("RpaRecorderPanel starts, displays masked password/2FA steps without plaintext, generates code, and saves", async () => {
  let recState: "idle" | "recording" = "idle";
  const recordedSteps = [
    { id: "step-1", index: 1, kind: "goto", timestamp: 1, url: "https://example.test/login" },
    { id: "step-2", index: 2, kind: "fill", timestamp: 2, selector: 'input[type="password"]', selectorStrategy: "css", credentialRef: "password", masked: true },
    { id: "step-3", index: 3, kind: "fill", timestamp: 3, selector: 'input[autocomplete="one-time-code"]', selectorStrategy: "css", credentialRef: "twofa", masked: true },
  ];

  const fakeFetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    if (path === "/ui/api/profiles") {
      return Response.json({
        ok: true,
        profiles: [{ id: "prof_rec", name: "Recorder Profile", engine: "chromium", group: "", platform: "", tags: [], proxy: null, timezone: "UTC", cookieCount: 0, seeded: true, screen: "1920x1080", has2fa: false, running: false }],
        groups: [],
      });
    }
    if (path === "/ui/api/scripts/recorder/status") {
      return Response.json({
        ok: true,
        recorder: {
          state: recState,
          sessionId: recState === "recording" ? "sess-1" : null,
          profileId: recState === "recording" ? "prof_rec" : null,
          profileName: recState === "recording" ? "Recorder Profile" : null,
          engine: recState === "recording" ? "chromium" : null,
          ownedByConnection: true,
          startedAt: 1000,
          lastActivityAt: 2000,
          steps: recState === "recording" ? recordedSteps : [],
          error: null,
        },
      });
    }
    if (path === "/ui/api/scripts/recorder/start" && method === "POST") {
      recState = "recording";
      return Response.json({
        ok: true,
        recorder: {
          state: "recording",
          sessionId: "sess-1",
          profileId: "prof_rec",
          profileName: "Recorder Profile",
          engine: "chromium",
          ownedByConnection: true,
          startedAt: 1000,
          lastActivityAt: 2000,
          steps: recordedSteps,
          error: null,
        },
      });
    }
    if (path === "/ui/api/scripts/recorder/stop" && method === "POST") {
      recState = "idle";
      return Response.json({
        ok: true,
        recorder: {
          state: "idle",
          sessionId: null,
          profileId: null,
          profileName: null,
          engine: null,
          ownedByConnection: false,
          startedAt: null,
          lastActivityAt: null,
          steps: recordedSteps,
          error: null,
        },
      });
    }
    if (path === "/ui/api/scripts/recorder/codegen" && method === "POST") {
      return Response.json({
        ok: true,
        language: "javascript",
        source: 'export default async ({ credentials }) => { void credentials?.password; };',
        suggestedInputs: {},
        usesCredentials: true,
        stepCount: 3,
      });
    }
    if (path === "/ui/api/scripts" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        ok: true,
        script: { ...body, id: "saved-rec-1", revision: 1, createdAt: "2026-11-22T00:00:00Z", updatedAt: "2026-11-22T00:00:00Z" },
      });
    }
    return Response.json({ ok: false, error: `unhandled ${method} ${path}` }, { status: 404 });
  }, { preconnect: globalThis.fetch.preconnect });

  const dom = await createWebDomHarness({ fetch: fakeFetch });
  installDesktopCapability(dom);
  let savedRecord: ScriptRecord | null = null;

  try {
    await dom.render(
      <I18nProvider>
        <RpaRecorderPanel onSavedScript={(rec) => { savedRecord = rec; }} />
      </I18nProvider>,
    );

    await waitFor(
      dom,
      () => (dom.container.querySelector<HTMLSelectElement>("select")?.options.length ?? 0) >= 2,
      "profile loaded",
    );

    const startBtn = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Start recording")!;
    await act(async () => { startBtn.click(); });
    await waitFor(dom, () => dom.container.textContent?.includes("Masked password (credentials.password)") ?? false, "password mask badge rendered");
    expect(dom.container.textContent).toContain("Masked 2FA (credentials.twofa)");

    const stopBtn = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Stop recording")!;
    await act(async () => { stopBtn.click(); });
    await waitFor(dom, () => (dom.container.querySelector<HTMLTextAreaElement>("textarea.script-source-editor")?.value ?? "").includes("credentials?.password"), "generated code filled");

    const saveBtn = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Save to my scripts")!;
    await act(async () => { saveBtn.click(); });
    await waitFor(dom, () => savedRecord !== null, "recorded script saved");
    expect(savedRecord!.id).toBe("saved-rec-1");
  } finally {
    await dom.cleanup();
  }
});

test("RpaProfileReceipt fetches screenshots via authenticated Blob -> ObjectURL and revokes on unmount", async () => {
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  const authHeadersSeen: Array<string | null> = [];

  const fakeFetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    if (path === "/ui/api/scripts/runs/run-42/artifacts/p1/error-final.jpg") {
      authHeadersSeen.push(new Headers(init?.headers).get("authorization"));
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
        status: 200,
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
      });
    }
    return Response.json({ ok: false }, { status: 404 });
  }, { preconnect: globalThis.fetch.preconnect });

  const dom = await createWebDomHarness({ fetch: fakeFetch });
  installDesktopCapability(dom);
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => {
    const url = `blob:maobu-test-${createdUrls.length + 1}`;
    createdUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };

  try {
    await dom.render(
      <I18nProvider>
        <RpaProfileReceipt
          runId="run-42"
          profile={{
            id: "p1",
            name: "Profile 1",
            status: "failed",
            durationMs: 850,
            steps: [{ index: 1, title: "Submit order", status: "failed", startedAt: 1, finishedAt: 851, durationMs: 850, error: "timeout" }],
            screenshots: [{ fileName: "error-final.jpg", label: "Error snapshot", mimeType: "image/jpeg", sizeBytes: 4096, capturedAt: 851, kind: "error" }],
          }}
        />
      </I18nProvider>,
    );

    await waitFor(dom, () => !!dom.container.querySelector("img[src='blob:maobu-test-1']"), "blob image rendered");
    expect(authHeadersSeen).toEqual(["Bearer test-rpa-nonce"]);
    expect(dom.container.textContent).toContain("Submit order");
    expect(dom.container.textContent).toContain("850ms");
    expect(dom.container.textContent).toContain("Error snapshot");

    await dom.cleanup();
    expect(revokedUrls).toEqual(["blob:maobu-test-1"]);
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});

test("RpaRunsQueuePanel lists queued/finished batches and cancels a queued batch by runId", async () => {
  const stoppedIds: string[] = [];
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    if (path === "/ui/api/scripts/runs" && method === "GET") {
      return Response.json({
        ok: true,
        runs: [
          {
            id: "queued-1",
            scriptName: "Cookie Warmup Bot",
            status: "queued",
            queuePosition: 1,
            profiles: [{ id: "p1", name: "P1", status: "queued" }],
          },
        ],
      });
    }
    if (path === "/ui/api/scripts/runs/queued-1/stop" && method === "POST") {
      stoppedIds.push("queued-1");
      return Response.json({
        ok: true,
        run: {
          id: "queued-1",
          scriptName: "Cookie Warmup Bot",
          status: "finished",
          profiles: [{ id: "p1", name: "P1", status: "cancelled" }],
        },
      });
    }
    return Response.json({ ok: false }, { status: 404 });
  }, { preconnect: globalThis.fetch.preconnect });

  const dom = await createWebDomHarness({ fetch: fakeFetch });
  installDesktopCapability(dom);
  try {
    await dom.render(
      <I18nProvider>
        <RpaRunsQueuePanel />
      </I18nProvider>,
    );
    await waitFor(dom, () => dom.container.textContent?.includes("Queued (#1)") ?? false, "queued run displayed");
    const cancelBtn = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Cancel queued batch")!;
    await act(async () => { cancelBtn.click(); });
    await waitFor(dom, () => stoppedIds.length === 1, "cancel sent");
    expect(dom.container.textContent).toContain("Cancelled");
  } finally {
    await dom.cleanup();
  }
});

test("ScriptsPage online source editor saves with expectedRevision and handles 409 revision conflict", async () => {
  let stored: ScriptRecord = {
    id: "script-edit-1",
    name: "Editable Script",
    description: "Desc",
    language: "javascript",
    source: "export default async () => { /* v1 */ };",
    revision: 1,
    createdAt: "2026-11-22T00:00:00Z",
    updatedAt: "2026-11-22T00:00:00Z",
  };
  let failNextPatchWith409 = true;
  const patches: Array<Record<string, unknown>> = [];

  const fakeFetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    if (path === "/ui/api/scripts" && method === "GET") {
      const { source: _s, ...summary } = stored;
      return Response.json({ ok: true, scripts: [summary] });
    }
    if (path === "/ui/api/scripts/run" && method === "GET") {
      return Response.json({ ok: true, run: null });
    }
    if (path === `/ui/api/scripts/${stored.id}` && method === "GET") {
      return Response.json({ ok: true, script: stored });
    }
    if (path === `/ui/api/scripts/${stored.id}` && method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      patches.push(body);
      if (failNextPatchWith409) {
        failNextPatchWith409 = false;
        stored = { ...stored, revision: 2, source: "export default async () => { /* remote v2 */ };" };
        return Response.json({ ok: false, error: "Script changed; reload before saving" }, { status: 409 });
      }
      stored = { ...stored, source: body.source, revision: stored.revision + 1 };
      return Response.json({ ok: true, script: stored });
    }
    return Response.json({ ok: false }, { status: 404 });
  }, { preconnect: globalThis.fetch.preconnect });

  const dom = await createWebDomHarness({ fetch: fakeFetch });
  installDesktopCapability(dom);
  try {
    await dom.render(
      <I18nProvider>
        <ScriptsPage onViewRun={() => {}} />
      </I18nProvider>,
    );
    await waitFor(dom, () => dom.container.querySelectorAll(".script-row").length === 1, "script row loaded");
    await act(async () => {
      dom.container.querySelector<HTMLButtonElement>(".script-row")!.click();
    });
    await waitFor(dom, () => !!dom.container.querySelector(".script-detail"), "script detail loaded");

    const editBtn = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Edit source")!;
    await act(async () => { editBtn.click(); });
    const textarea = dom.container.querySelector<HTMLTextAreaElement>(".script-source-editor")!;
    expect(textarea.value).toBe("export default async () => { /* v1 */ };");

    await act(async () => {
      textarea.focus();
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        "export default async () => { /* local v3 */ };",
      );
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      textarea.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      textarea.dispatchEvent(new dom.window.KeyboardEvent("keyup", { bubbles: true }));
    });

    // First save hits 409 conflict.
    const saveBtn = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Save source")!;
    await act(async () => { saveBtn.click(); });
    await waitFor(dom, () => dom.container.textContent?.includes("Reload the saved script before making another change.") ?? false, "409 conflict banner shown");
    expect(patches[0]!.expectedRevision).toBe(1);

    // Reload saved script -> shows stale source conflict banner -> rebase -> save succeeds at expectedRevision 2!
    const reloadBtn = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Reload saved script")!;
    await act(async () => { reloadBtn.click(); });
    await waitFor(dom, () => dom.container.textContent?.includes("Source revision conflict detected.") ?? false, "source rebase prompt shown");

    const keepBtn = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Keep my source edits on this version")!;
    await act(async () => { keepBtn.click(); });

    const saveBtn2 = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Save source")!;
    await act(async () => { saveBtn2.click(); });
    await waitFor(dom, () => patches.length === 2 && stored.revision === 3, "rebased source saved");
    expect(patches[1]!.expectedRevision).toBe(2);
    expect(stored.source).toBe("export default async () => { /* local v3 */ };");
  } finally {
    await dom.cleanup();
  }
});
