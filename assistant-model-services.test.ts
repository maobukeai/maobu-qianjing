import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AssistantModelServices, AssistantServicesError } from "./assistant-model-services.ts";

const parent = realpathSync(tmpdir()), roots: string[] = [];
const remote = { name: "Work API", provider: "openai-compatible" as const, endpoint: "https://api.example.com/v1", model: "example-chat" };
const local = { name: "Local model", provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "llama3.2:latest" };
const key = "synthetic-session-key";

function store(): AssistantModelServices {
  const root = mkdtempSync(join(parent, "maobu-assistant-catalog-"));
  roots.push(root);
  return new AssistantModelServices(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    const actual = realpathSync(root);
    if (dirname(actual) !== parent || actual !== root) throw new Error("Unsafe test cleanup path");
    rmSync(actual, { recursive: true, force: true });
  }
});

describe("workspace model service catalog", () => {
  test("persists explicit model selections and defaults without persisting or returning credentials", () => {
    const owner = store();
    expect(owner.list()).toEqual({ services: [], defaultId: null });
    expect(existsSync(owner.path)).toBe(false);
    const added = owner.save({ ...remote, apiKey: key });
    const service = added.services[0]!;
    expect(service).toEqual({ id: expect.stringMatching(/^model_[0-9a-f]{32}$/), ...remote, credentialConfigured: true });
    expect(added.defaultId).toBeNull();
    expect(owner.resolve(service.id)).toEqual({ service, apiKey: key });
    expect(owner.setDefault({ id: service.id }).defaultId).toBe(service.id);
    const raw = readFileSync(owner.path, "utf8");
    expect(raw).not.toContain(key);
    expect(raw).not.toContain("apiKey");
    expect(raw).not.toContain("credentialConfigured");
    expect(JSON.stringify(added)).not.toContain(key);
    expect(JSON.stringify(owner)).not.toContain(key);

    const restarted = new AssistantModelServices(owner.root);
    expect(restarted.list()).toEqual({ services: [{ ...service, credentialConfigured: false }], defaultId: service.id });
    expect(restarted.resolve(service.id).apiKey).toBeUndefined();
    expect(restarted.setDefault({ id: null }).defaultId).toBeNull();
  });

  test("retains the session credential only for the same provider and normalized endpoint", () => {
    const owner = store();
    const id = owner.save({ ...remote, apiKey: key }).services[0]!.id;
    owner.save({ ...remote, id, name: "Renamed", model: "other-model", endpoint: "https://API.EXAMPLE.COM/v1/" });
    expect(owner.resolve(id).apiKey).toBe(key);
    expect(owner.resolve(id).service.name).toBe("Renamed");
    owner.save({ ...remote, id, endpoint: "https://other.example.com/v1" });
    expect(owner.resolve(id).apiKey).toBeUndefined();
    owner.save({ ...remote, id });
    expect(owner.resolve(id).apiKey).toBeUndefined();
    owner.save({ ...remote, id, apiKey: key });
    owner.save({ ...remote, id, provider: "anthropic" });
    expect(owner.resolve(id).apiKey).toBeUndefined();
    owner.save({ ...remote, id, apiKey: key });
    owner.save({ ...remote, id, apiKey: "" });
    expect(owner.resolve(id).service.credentialConfigured).toBe(false);
  });

  test("builds an unsaved test draft without changing the saved catalog or stored credential", () => {
    const owner = store();
    const id = owner.save({ ...remote, apiKey: key }).services[0]!.id;
    const before = readFileSync(owner.path, "utf8");
    const fields = { id, provider: remote.provider, endpoint: remote.endpoint };
    const draft = owner.connectionDraft(fields);
    expect(draft.service.model).toBe("");
    expect(draft.apiKey).toBe(key);
    expect(owner.connectionDraft({ ...fields, endpoint: "https://other.example.com/v1" }).apiKey).toBeUndefined();
    expect(owner.connectionDraft({ ...fields, provider: "anthropic" }).apiKey).toBeUndefined();
    expect(owner.connectionDraft({ ...fields, apiKey: "" }).apiKey).toBeUndefined();
    expect(owner.connectionDraft({ ...fields, apiKey: "other-key" }).apiKey).toBe("other-key");
    expect(owner.connectionDraft({ provider: "ollama", endpoint: "http://localhost" })).toEqual({
      service: { id: "", name: "", provider: "ollama", endpoint: "http://localhost:11434", model: "", credentialConfigured: false }, apiKey: undefined,
    });
    expect(readFileSync(owner.path, "utf8")).toBe(before);
    expect(owner.resolve(id).apiKey).toBe(key);
  });

  test("keeps workspaces independent and clears a removed default and its credential", () => {
    const first = store(), second = store();
    const id = first.save({ ...remote, apiKey: key }).services[0]!.id;
    first.setDefault({ id });
    const other = second.save(local).services[0]!;
    expect(other.id).not.toBe(id);
    expect(second.list()).toEqual({ services: [other], defaultId: null });
    expect(() => second.resolve(id)).toThrow("The selected model service no longer exists.");
    expect(first.remove({ id })).toEqual({ services: [], defaultId: null });
    expect(() => first.resolve(id)).toThrow("The selected model service no longer exists.");
    expect(second.resolve(other.id).apiKey).toBeUndefined();
  });

  test("rejects malformed inputs without reflecting credentials or replacing metadata", () => {
    const owner = store();
    const id = owner.save({ ...remote, apiKey: key }).services[0]!.id;
    const before = readFileSync(owner.path, "utf8");
    const invalid = [
      { ...remote, name: "" }, { ...remote, model: "" }, { ...remote, unexpected: key },
      { ...remote, model: "../../other" }, { ...local, model: "anything-cloud" },
      { ...remote, provider: "gemini", model: "other/segment" },
      { ...remote, apiKey: `${key}\r\nInjected: header` }, { ...local, apiKey: key },
      { ...remote, endpoint: `https://api.example.com/v1?key=${key}` },
      { ...remote, name: "work API" }, { ...remote, id: `model_${"0".repeat(32)}` },
    ];
    for (const value of invalid) {
      try { owner.save(value); throw new Error("Unexpected accepted input"); }
      catch (error) {
        expect(error).toBeInstanceOf(AssistantServicesError);
        expect(String(error)).not.toContain(key);
      }
    }
    expect(() => owner.setDefault({ id: "invalid" })).toThrow("The model service settings are invalid.");
    expect(readFileSync(owner.path, "utf8")).toBe(before);
    expect(owner.resolve(id).apiKey).toBe(key);
  });

  test("rejects a damaged or linked catalog without following it", () => {
    const damaged = store();
    writeFileSync(damaged.path, JSON.stringify({ version: 1, services: [{ ...remote, apiKey: key }], defaultId: null }));
    expect(() => damaged.list()).toThrow("The saved model service settings could not be read.");
    expect(() => damaged.save(remote)).toThrow("The saved model service settings could not be read.");
    const original = store(), linked = store();
    original.save(remote);
    linkSync(original.path, linked.path);
    expect(() => linked.list()).toThrow("The saved model service settings could not be read.");
    expect(() => original.list()).toThrow("The saved model service settings could not be read.");
  });
});
