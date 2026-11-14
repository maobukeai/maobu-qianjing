import assert from "node:assert/strict";
import { act, useRef, useState } from "react";
import type { HTMLButtonElement as DomButton, HTMLInputElement as DomInput } from "happy-dom";
import { ProfileStore } from "../store.ts";
import { buildNewProfile } from "../create.ts";
import { handleUiRequest, listUiProfiles } from "../ui.ts";
import type { Launcher } from "../launcher.ts";
import { fetchProfiles } from "../web/api.ts";
import { I18nProvider } from "../web/i18n.tsx";
import { ProfileMoveFeedback, useProfileMove, type ProfileMoveResult } from "../web/profile-move.tsx";
import { createWorkspaceOperationCoordinator, WorkspaceOperationsProvider } from "../web/workspace-operations.tsx";
import { createWebDomHarness } from "./web-dom.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function run(scenario: string) {
  const store = new ProfileStore(":memory:"), coordinator = createWorkspaceOperationCoordinator({ currentId: "one", activeId: "one" });
  const launcher = { reconcileOrphans: async () => {} } as unknown as Launcher;
  for (const [id, group] of [["env_a", "Old"], ["env_b", "Destination"], ["env_c", "Other"]]) store.upsertProfile({ ...buildNewProfile({ name: id!, group: group!, engine: "chromium", chromiumRuntime: "aliasmode" }, () => false), id: id! });
  store.registerGroup("Destination"); store.setGroupExtensionDefaults("Destination", ["destination_extension"]);
  // Keep the already-present member distinct from newly moved environments.
  store.upsertProfile({ ...store.getProfile("env_b")!, extensions: [] });
  const requests: Array<{ path: string; method: string; body: any; request: Request }> = [];
  const post = deferred<Response>();
  let holdPost = scenario === "snapshot-dupe" || scenario === "coordinator-unmount", failPost = scenario === "failure-retry", malformed = scenario === "malformed-recheck" || scenario === "workspace-change-recheck", failRead = scenario === "refresh-recheck", concurrentChange = scenario === "retry-unresolved";
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const path = String(input), method = options?.method ?? "GET";
    if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
    assert.ok(path === "/ui/api/profiles/move" || path === "/ui/api/profiles", `Non-fixture request ${path}`);
    const request = new Request(`http://127.0.0.1:47865${path}`, options), body = options?.body ? JSON.parse(String(options.body)) : null;
    requests.push({ path, method, body, request });
    if (path.endsWith("/move")) {
      if (holdPost) return post.promise;
      if (failPost) return Response.json({ ok: false, error: "Inert move refused" }, { status: 500 });
      const response = await handleUiRequest(request, launcher, store); assert.ok(response);
      return malformed ? Response.json({ group: body.group }) : response;
    }
    if (failRead) return Response.json({ ok: false, error: "Inert read unavailable" }, { status: 503 });
    if (concurrentChange) { concurrentChange = false; store.setGroup(["env_c"], "Changed elsewhere"); }
    const response = await handleUiRequest(request, launcher, store); assert.ok(response); return response;
  }, { preconnect: globalThis.fetch.preconnect });
  const dom = await createWebDomHarness({ fetch: fakeFetch });
  const initial = scenario === "partial" ? ["env_a", "env_b", "missing"] : scenario === "pagination" ? Array.from({ length: 151 }, (_, index) => `missing_${index}`) : ["env_a", "env_c"];
  let latestResult!: ProfileMoveResult;
  function Harness() {
    const [selected, setSelected] = useState(new Set(initial)), [group, setGroup] = useState("Destination"), [roster, setRoster] = useState<readonly { id: string; group: string }[]>(() => listUiProfiles(store));
    const currentGroup = useRef(group); currentGroup.current = group;
    const move = useProfileMove({ readRoster: async () => { const value = await fetchProfiles(); setRoster(value.profiles); return value; } });
    async function accept(task: Promise<ProfileMoveResult | null>) {
      const result = await task; if (!result) return; latestResult = result;
      setSelected(current => { const next = new Set(current); result.confirmedIds.forEach(id => next.delete(id)); return next; });
      if (result.status === "confirmed" && currentGroup.current === result.attempt.group) setGroup("");
    }
    return <><label>Destination<input aria-label="Destination" value={group} onChange={event => setGroup(event.target.value)} /></label><button onClick={() => void accept(move.submit({ ids: [...selected], group }))}>Move selected</button><button onClick={() => setSelected(new Set(["new_selection"]))}>Choose a new selection</button>
      <output aria-label="Selected IDs">{[...selected].join(",")}</output><output aria-label="Roster groups">{roster.map(profile => `${profile.id}:${profile.group}`).join(",")}</output>
      <ProfileMoveFeedback state={move.state} onRetry={() => void accept(move.retry())} onRecheck={() => void accept(move.recheck())} onDismiss={move.dismiss} />
    </>;
  }
  const posts = () => requests.filter(request => request.method === "POST");
  const reads = () => requests.filter(request => request.method === "GET");
  const button = (label: string) => { const value = [...dom.container.querySelectorAll<DomButton>("button")].find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label); assert.ok(value, `Missing ${label}`); return value; };
  const click = async (label: string, twice = false) => act(async () => { const target = button(label); target.click(); if (twice) target.click(); });
  const selected = () => dom.container.querySelector('output[aria-label="Selected IDs"]')?.textContent;
  const group = () => dom.container.querySelector<DomInput>('input[aria-label="Destination"]')!;
  const typeGroup = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(group(), value); group().dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const releasePost = async () => act(async () => { const response = await handleUiRequest(posts()[0]!.request, launcher, store); assert.ok(response); holdPost = false; post.resolve(response); });
  try {
    await dom.render(<I18nProvider><WorkspaceOperationsProvider coordinator={coordinator}><Harness /></WorkspaceOperationsProvider></I18nProvider>);
    if (scenario === "coordinator-unmount") {
      let blocked!: NonNullable<ReturnType<typeof coordinator.acquire>>;
      await act(async () => { blocked = coordinator.acquire("workspace-switch")!; });
      await click("Move selected"); assert.equal(posts().length, 0); assert.ok(dom.container.querySelector('[role="alert"]'));
      await act(async () => { coordinator.release(blocked); });
      await click("Move selected", true); assert.equal(posts().length, 1); assert.equal(coordinator.acquire("app-restart"), null);
      await dom.unmount(); assert.equal(coordinator.acquire("workspace-switch"), null, "Leaving the owner cannot unlock an issued move request");
      await releasePost(); assert.equal(reads().length, 0); assert.equal(coordinator.getSnapshot().blocked, false); assert.equal(store.getProfile("env_a")!.group, "Destination"); return;
    }
    await click("Move selected", true); assert.equal(posts().length, 1);
    if (scenario === "snapshot-dupe") {
      assert.deepEqual(posts()[0]!.body, { ids: initial, group: "Destination" }); assert.equal(coordinator.getSnapshot().operation?.kind, "profile-move");
      assert.ok(dom.container.querySelector('[role="status"]')?.textContent?.includes("fixed for this attempt")); assert.ok(button("Dismiss move result").disabled);
      await typeGroup("New destination"); await click("Choose a new selection"); await releasePost();
      assert.equal(selected(), "new_selection", "A move completion only clears IDs confirmed for its captured attempt"); assert.equal(group().value, "New destination", "A new destination draft must survive an old completion");
      assert.deepEqual(latestResult?.attempt.ids, initial); assert.equal(latestResult?.attempt.group, "Destination"); assert.equal(latestResult?.status, "confirmed"); assert.equal(reads().length, 1); assert.equal(coordinator.getSnapshot().blocked, false); return;
    }
    if (scenario === "failure-retry") {
      assert.equal(latestResult?.status, "failed"); assert.equal(selected(), initial.join(",")); assert.equal(group().value, "Destination"); assert.equal(reads().length, 0);
      failPost = false; button("Retry 2 unconfirmed destinations").focus(); await click("Retry 2 unconfirmed destinations", true);
      assert.equal(posts().length, 2); assert.deepEqual(posts()[1]!.body, posts()[0]!.body); assert.equal(selected(), ""); assert.equal(group().value, ""); assert.equal(latestResult?.status, "confirmed"); assert.equal(dom.window.document.activeElement, button("Dismiss move result"), "A completed retry must leave a useful focus target"); return;
    }
    if (scenario === "workspace-change-recheck") {
      assert.equal(latestResult.status, "unconfirmed"); await act(async () => { coordinator.setWorkspace("two", "two"); });
      await click("Check result without moving again"); assert.equal(reads().length, 0); assert.equal(posts().length, 1); assert.equal(selected(), initial.join(","));
      assert.ok(dom.container.querySelector('[role="alert"]')?.textContent?.includes("Return to the original workspace"));
      await act(async () => { coordinator.setWorkspace("one", "one"); }); await click("Check result without moving again");
      assert.equal(reads().length, 1); assert.equal(posts().length, 1); assert.equal(latestResult.status, "confirmed"); return;
    }
    if (scenario === "malformed-recheck" || scenario === "refresh-recheck") {
      assert.equal(latestResult?.status, "unconfirmed"); assert.equal(selected(), initial.join(",")); assert.equal(group().value, "Destination");
      assert.equal([...dom.container.querySelectorAll("button")].some(node => node.textContent?.includes("Retry")), false, "Uncertain writes must not offer another POST before a readback");
      const readsBefore = reads().length; malformed = false; failRead = false; await click("Check result without moving again", true);
      assert.equal(posts().length, 1); assert.equal(reads().length, readsBefore + 1); assert.equal(latestResult?.status, "confirmed"); assert.equal(selected(), "");
      assert.equal(store.getProfile("env_a")!.group, "Destination"); return;
    }
    if (scenario === "partial") {
      assert.equal(latestResult?.reportedMoved, 1); assert.deepEqual(latestResult?.confirmedIds, ["env_a", "env_b"]); assert.deepEqual(latestResult?.missingIds, ["missing"]); assert.deepEqual(latestResult?.retryIds, []); assert.equal(selected(), "missing");
      assert.ok(dom.container.textContent?.includes("Server reported 1 group changes")); assert.ok(dom.container.textContent?.includes("2 confirmed in the destination")); assert.ok(dom.container.textContent?.includes("No longer listed"));
      assert.deepEqual(store.getProfile("env_a")!.extensions, ["destination_extension"]); assert.deepEqual(store.getProfile("env_b")!.extensions, []); return;
    }
    if (scenario === "retry-unresolved") {
      assert.equal(latestResult?.status, "partial"); assert.deepEqual(latestResult?.retryIds, ["env_c"]); assert.equal(selected(), "env_c");
      await typeGroup("A new draft destination"); group().focus(); await click("Retry 1 unconfirmed destinations", true);
      assert.equal(posts().length, 2); assert.deepEqual(posts()[1]!.body, { ids: ["env_c"], group: "Destination" }); assert.equal(selected(), ""); assert.equal(group().value, "A new draft destination"); assert.equal(dom.window.document.activeElement, group(), "Async results must not steal a newer focus choice"); return;
    }
    assert.equal(scenario, "pagination"); assert.equal(latestResult?.missingIds.length, 151); assert.equal(dom.container.querySelectorAll(".profile-move-details li").length, 50);
    await click("Next"); assert.equal(dom.container.querySelector(".profile-move-details li code")?.textContent, "missing_50"); await click("Next"); await click("Next"); assert.equal(dom.container.querySelectorAll(".profile-move-details li").length, 1);
    assert.equal(posts().length, 1); assert.equal(selected()?.split(",").length, 151);
  } finally { post.resolve(Response.json({ ok: false, error: "Fixture teardown" }, { status: 503 })); await dom.cleanup(); store.close(); }
}
await run(process.argv[2] ?? "snapshot-dupe"); console.log("profile move fixture passed");
