import { expect, test } from "bun:test";
import { createScriptDetailsDrafts, scriptDetailsWithDraft } from "./script-details-drafts.ts";

const saved = { id: "script_a", name: "Saved title", description: "Saved description", revision: 1, source: "// private source" };

test("session drafts keep actual metadata edits across multiple scripts without retaining source", () => {
  const session = createScriptDetailsDrafts();
  expect(session.edit(saved, "name", " Saved title ")).toBeUndefined();
  expect(session.count()).toBe(0);
  const first = session.edit(saved, "description", "Saved description ");
  session.edit({ ...saved, id: "script_b" }, "name", "Second draft");
  expect(session.ids()).toEqual(["script_a", "script_b"]);
  expect(first?.changes).toEqual({ description: "Saved description " });
  expect(JSON.stringify(first)).not.toContain("private source");
  expect(createScriptDetailsDrafts().count()).toBe(0);
});

test("a concurrent change requires review while untouched fields follow the newest saved record", () => {
  const session = createScriptDetailsDrafts();
  const draft = session.edit(saved, "description", "My description")!;
  const latest = { ...saved, name: "New external title", revision: 2 };
  expect(session.observe(latest)).toBe(draft);
  expect(scriptDetailsWithDraft(latest, draft)).toMatchObject({ name: "New external title", description: "My description", revision: 2 });
  expect(draft.baseline.revision).toBe(1);
  expect(session.rebase(latest, draft)).toBe(true);
  expect(session.get(saved.id)).toMatchObject({ baseline: { revision: 2, name: "New external title" }, changes: { description: "My description" } });
  expect(session.rebase(saved, draft)).toBe(false);
});

test("discarded or externally confirmed values do not leave false dirty state", () => {
  const session = createScriptDetailsDrafts();
  session.edit(saved, "name", "My title");
  expect(session.discard(saved.id)).toBe(true);
  expect(session.count()).toBe(0);
  expect(session.canUndo(saved.id)).toBe(true);
  const latest = { ...saved, name: "My title", revision: 2 };
  expect(session.undo(latest)).toBeUndefined();
  expect(session.count()).toBe(0);
  session.edit(latest, "description", "My description");
  expect(session.observe({ ...latest, description: "My description", revision: 3 })).toBeUndefined();
  expect(session.count()).toBe(0);
});

test("a late save acknowledgement never erases newer edits or another script", () => {
  const session = createScriptDetailsDrafts();
  const sent = session.edit(saved, "name", "First attempt")!;
  session.edit(saved, "name", "Later edit");
  session.edit({ ...saved, id: "script_b" }, "description", "Other draft");
  const latest = { ...saved, name: "First attempt", revision: 2 };
  session.acknowledgeSave(latest, sent);
  expect(session.get(saved.id)).toMatchObject({ baseline: { revision: 1 }, changes: { name: "Later edit" } });
  expect(session.count()).toBe(2);
  const review = session.get(saved.id)!;
  expect(session.rebase(latest, review)).toBe(true);
  session.acknowledgeSave({ ...latest, name: "Later edit", revision: 3 }, session.get(saved.id)!);
  expect(session.ids()).toEqual(["script_b"]);
});

test("an inconsistent save acknowledgement cannot discard the captured edit", () => {
  const session = createScriptDetailsDrafts();
  const sent = session.edit(saved, "name", "My title")!;
  expect(session.acknowledgeSave({ ...saved, revision: 2 }, sent)).toBe(false);
  expect(session.acknowledgeSave({ ...saved, id: "different", name: "My title", revision: 2 }, sent)).toBe(false);
  expect(session.acknowledgeSave({ ...saved, name: "My title" }, sent)).toBe(false);
  expect(session.get(saved.id)).toBe(sent);
});

test("replacing source advances a current metadata baseline without rebasing an older conflict", () => {
  const session = createScriptDetailsDrafts();
  session.edit(saved, "name", "My title");
  const next = { ...saved, revision: 2, source: "// different source" };
  session.acknowledgeSourceReplacement(saved, next);
  expect(session.get(saved.id)).toMatchObject({ baseline: { revision: 2 }, changes: { name: "My title" } });
  const external = { ...next, name: "External title", revision: 3 };
  session.acknowledgeSourceReplacement(external, { ...external, revision: 4 });
  expect(session.get(saved.id)).toMatchObject({ baseline: { revision: 2 }, changes: { name: "My title" } });
});
