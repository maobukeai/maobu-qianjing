import assert from "node:assert/strict";
import { act } from "react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { defaultAppSettings } from "../src/app-settings.ts";
import { I18nProvider } from "../web/i18n.tsx";
import type { SignedUpdateStatus } from "../web/signed-update-api.ts";
import { SignedUpdateCard, useSignedUpdateStartup } from "../web/signed-updates.tsx";
import { createWebDomHarness } from "./web-dom.ts";

const idle: SignedUpdateStatus = { configured: true, status: "idle", currentVersion: "1.0.0", endpoint: "https://publisher.invalid/latest.json", message: "Fixture channel ready", update: null };
const available: SignedUpdateStatus = { ...idle, status: "available", message: "Fixture release available", update: { version: "1.2.3", currentVersion: "1.0.0", notes: "Fixture notes", publishedAt: null } };
const upToDate: SignedUpdateStatus = { ...idle, status: "up-to-date", message: "Fixture channel current" };

function Harness({ workspaceId, showCard }: { workspaceId: string; showCard: boolean }) {
  const startup = useSignedUpdateStartup(workspaceId);
  return <>
    {showCard && <SignedUpdateCard startup={startup} />}
    <output data-notice>{startup.noticeVersion}</output>
    <output data-preference-error>{startup.preferenceError}</output>
    <button type="button" onClick={startup.dismissNotice}>Dismiss fixture notice</button>
  </>;
}

async function run(scenario: string) {
  const settings = defaultAppSettings();
  let preference: unknown = scenario === "preference" || scenario === "guards" ? undefined : { checkOnStartup: true };
  let preferenceReads = 0, failSave = scenario === "preference", rejectStatus = false, statusReads = 0;
  let current = idle;
  let completeStartup: ((value: SignedUpdateStatus) => void) | undefined;
  const checks: string[] = [];
  const patches: unknown[] = [];
  const fetchFixture = async (input: RequestInfo | URL, options?: RequestInit) => {
    if (input === "/ui/api/shell-language") return Response.json({ language: "en-US" });
    assert.equal(input, "/ui/api/settings");
    assert.equal(new Headers(options?.headers).get("X-Maobu-Settings"), "1");
    if (options?.method === "GET") {
      preferenceReads++;
      assert.ok(options.signal);
    } else {
      assert.equal(options?.method, "PATCH");
      const patch = JSON.parse(String(options?.body));
      patches.push(patch);
      assert.deepEqual(Object.keys(patch), ["signedUpdates"]);
      if (failSave) { failSave = false; return Response.json({ ok: false, error: "PRIVATE_FIXTURE_FAILURE" }, { status: 503 }); }
      preference = patch.signedUpdates;
    }
    return Response.json({ ok: true, settings: { ...settings, signedUpdates: preference } });
  };
  const dom = await createWebDomHarness({ desktop: scenario !== "guards", fetch: Object.assign(fetchFixture, { preconnect: globalThis.fetch.preconnect }) as typeof fetch });
  const render = async (id: string, card = true) => {
    await dom.render(<I18nProvider><Harness workspaceId={id} showCard={card} /></I18nProvider>);
    await dom.flush();
  };
  const waitStartup = () => act(async () => { await Bun.sleep(1100); });
  const notice = () => dom.container.querySelector("[data-notice]")?.textContent;
  const text = () => dom.container.textContent ?? "";
  const button = (label: string) => {
    const item = [...dom.container.querySelectorAll("button")].find(button => button.textContent === label);
    assert.ok(item, `Missing fixture button ${label}`);
    return item;
  };
  const toggle = () => {
    const item = dom.container.querySelector('input[role="switch"]');
    assert.ok(item);
    return item as unknown as HTMLInputElement;
  };
  try {
    if (scenario === "guards") {
      await render("source-browser", false);
      await waitStartup();
      assert.equal(preferenceReads, 0);
      (globalThis as typeof globalThis & { isTauri: boolean }).isTauri = true;
    }
    mockIPC((command, payload) => {
      if (command === "signed_update_status") {
        statusReads++;
        if (rejectStatus) throw new Error("PRIVATE_BRIDGE_FAILURE");
        return current;
      }
      assert.equal(command, "signed_update_check", "Automatic flows must never invoke install");
      const startup = (payload as { startup?: boolean } | undefined)?.startup === true;
      checks.push(startup ? "startup" : "manual");
      if (!startup) return current = scenario === "manual" ? available : upToDate;
      if (scenario === "failure") {
        current = { ...idle, status: "error", message: "Fixture publisher check failed" };
        throw new Error("PRIVATE_UPDATER_FAILURE");
      }
      current = { ...idle, status: "checking" };
      return new Promise<SignedUpdateStatus>(resolve => { completeStartup = resolve; });
    });
    if (scenario === "guards") {
      await render("legacy-off", false); await waitStartup();
      assert.equal(statusReads, 0);
      preference = { checkOnStartup: "true" };
      await render("invalid-preference", false); await waitStartup();
      assert.equal(statusReads, 0);
      assert.ok(text().includes("Could not load the signed update startup preference."));
      preference = { checkOnStartup: true };
      current = { ...idle, configured: false, status: "disabled" };
      await render("unsigned-build", false); await waitStartup();
      assert.equal(statusReads, 1);
      rejectStatus = true;
      await render("failed-status", false); await waitStartup();
      assert.equal(statusReads, 2);
      rejectStatus = false;
      current = available;
      await render("manual-result-already-available", false); await waitStartup();
      assert.equal(statusReads, 3);
      assert.deepEqual(checks, []);
      assert.equal(notice(), "");
      return;
    }
    await render("workspace-one");
    if (scenario === "manual") {
      await act(async () => button("Check trusted channel").click());
      await waitStartup();
      assert.deepEqual(checks, ["manual"]);
      assert.equal(notice(), "");
      assert.ok(text().includes(available.message));
      return;
    }
    if (scenario === "preference") {
      assert.equal(toggle().checked, false);
      await act(async () => toggle().click());
      assert.equal(toggle().checked, false);
      assert.ok(text().includes("Could not save the signed update startup preference."));
      assert.ok(!text().includes("PRIVATE_FIXTURE_FAILURE"));
      await act(async () => toggle().click());
      assert.equal(toggle().checked, true);
      await waitStartup();
      assert.deepEqual(checks, []);
      await render("next-workspace");
    }
    await waitStartup();
    assert.deepEqual(checks, ["startup"]);
    assert.equal(notice(), "");
    if (scenario === "failure") {
      assert.ok(text().includes("Fixture publisher check failed"));
      assert.ok(!text().includes("PRIVATE_UPDATER_FAILURE"));
      await act(async () => button("Check trusted channel").click());
      assert.deepEqual(checks, ["startup", "manual"]);
      assert.ok(text().includes(upToDate.message));
      assert.equal(notice(), "");
      return;
    }
    assert.ok(button("Checking…").disabled);
    assert.ok(completeStartup);
    if (scenario === "stale") {
      preference = { checkOnStartup: false };
      await render("workspace-two", false);
    } else if (scenario === "preference") {
      await act(async () => toggle().click());
      assert.deepEqual(patches, [{ signedUpdates: { checkOnStartup: true } }, { signedUpdates: { checkOnStartup: true } }, { signedUpdates: { checkOnStartup: false } }]);
      assert.equal(toggle().checked, false);
    }
    current = available;
    await act(async () => completeStartup!(available));
    assert.equal(notice(), scenario === "available" ? "1.2.3" : "");
    assert.deepEqual(checks, ["startup"]);
    if (scenario === "available") {
      assert.ok(text().includes(available.message));
      assert.equal(button("Install verified update").disabled, false);
      await act(async () => button("Dismiss fixture notice").click());
      await render("workspace-one");
      assert.equal(notice(), "");
      assert.deepEqual(checks, ["startup"]);
    }
  } finally { await dom.cleanup(); }
}

if (import.meta.main) {
  try { await run(process.argv[2] ?? "available"); console.log("signed startup fixture passed"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
