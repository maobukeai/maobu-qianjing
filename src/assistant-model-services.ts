import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLocalSecretProtector, isEncryptedSecret, type LocalSecretProtector } from "./dpapi.ts";
import { normalizeAssistantEndpoint } from "./local-assistant.ts";
import { isRemoteAssistantModelId, normalizeRemoteAssistantEndpoint, type RemoteModelProvider } from "./remote-assistant.ts";
import { plainDirectory, workspaceEntryExists, writeWorkspaceJson } from "./workspaces.ts";

export const ASSISTANT_MODEL_SERVICES_FILE = "assistant-model-services.json";
export const ASSISTANT_MODEL_CREDENTIALS_FILE = "assistant-model-credentials.enc.json";
export const ASSISTANT_MODEL_SERVICES_FILE_LIMIT = 128 * 1024;
const MAX_SERVICES = 32;
const PROVIDERS = ["ollama", "openai-compatible", "anthropic", "gemini"] as const;
const SERVICE_FIELDS = ["name", "provider", "endpoint", "model"] as const;
const INPUT_FIELDS = ["id", ...SERVICE_FIELDS, "apiKey"] as const;

export type AssistantServiceProvider = "ollama" | RemoteModelProvider;
interface StoredAssistantService {
  id: string;
  name: string;
  provider: AssistantServiceProvider;
  endpoint: string;
  model: string;
}
export interface AssistantServiceView extends StoredAssistantService { credentialConfigured: boolean }
export interface AssistantServicesCatalog { services: AssistantServiceView[]; defaultId: string | null }
interface StoredCatalog { version: 1; services: StoredAssistantService[]; defaultId: string | null }
interface SessionCredential { provider: AssistantServiceProvider; endpoint: string; apiKey: string }
interface StoredEncryptedCredential { provider: RemoteModelProvider; endpoint: string; encryptedApiKey: string }
interface StoredCredentialsFile { version: 1; credentials: Record<string, StoredEncryptedCredential> }

const ERRORS = {
  "invalid-input": { message: "The model service settings are invalid.", status: 400 },
  "invalid-endpoint": { message: "Enter a valid address for the selected model service.", status: 400 },
  "invalid-key": { message: "Enter a valid API key for this model service.", status: 400 },
  "not-found": { message: "The selected model service no longer exists.", status: 404 },
  "duplicate-name": { message: "A model service with this name already exists.", status: 409 },
  "catalog-full": { message: "The model service limit has been reached.", status: 409 },
  "invalid-catalog": { message: "The saved model service settings could not be read.", status: 500 },
  "storage-error": { message: "The model service settings could not be saved.", status: 500 },
} as const;

export class AssistantServicesError extends Error {
  readonly httpStatus: number;

  constructor(readonly code: keyof typeof ERRORS) {
    super(ERRORS[code].message);
    this.name = "AssistantServicesError";
    this.httpStatus = ERRORS[code].status;
  }
}

function fail(code: keyof typeof ERRORS = "invalid-input"): never {
  throw new AssistantServicesError(code);
}

function readObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) return fail();
  return value as Record<string, unknown>;
}

function serviceId(value: unknown): string {
  if (typeof value !== "string" || !/^model_[0-9a-f]{32}$/.test(value)) return fail();
  return value;
}

function serviceName(value: unknown, required: boolean): string {
  if (!required && value === undefined) return "";
  if (typeof value !== "string" || value.length > 512) return fail();
  const name = value.trim().normalize("NFC");
  if (!name && required || Array.from(name).length > 80 || Buffer.byteLength(name) > 256 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name)) return fail();
  return name;
}

function serviceModel(value: unknown, provider: AssistantServiceProvider, required: boolean): string {
  if (!required && value === undefined) return "";
  if (typeof value !== "string" || value.length > 256) return fail();
  const model = value.trim();
  if (!required && !model) return "";
  if (provider !== "ollama") return isRemoteAssistantModelId(model, provider) ? model : fail();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model) || model.includes("//") || model.includes("..") || /(?:^|[-:])cloud$/i.test(model)) return fail();
  return model;
}

function serviceFields(raw: Record<string, unknown>, required: boolean): Omit<StoredAssistantService, "id"> {
  if (!(PROVIDERS as readonly unknown[]).includes(raw.provider)) return fail();
  const provider = raw.provider as AssistantServiceProvider;
  if (typeof raw.endpoint !== "string" || !raw.endpoint.trim()) return fail("invalid-endpoint");
  let endpoint: string;
  try {
    endpoint = provider === "ollama" ? normalizeAssistantEndpoint(raw.endpoint) : normalizeRemoteAssistantEndpoint(raw.endpoint);
  } catch { return fail("invalid-endpoint"); }
  return { provider, endpoint, name: serviceName(raw.name, required), model: serviceModel(raw.model, provider, required) };
}

function inputKey(value: unknown, provider: AssistantServiceProvider): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 2048 || /[^\x21-\x7e]/.test(value) || provider === "ollama" && !!value) return fail("invalid-key");
  return value;
}

function emptyCatalog(): StoredCatalog { return { version: 1, defaultId: null, services: [] }; }

function parseCatalog(value: unknown): StoredCatalog {
  const raw = readObject(value, ["version", "defaultId", "services"]);
  if (raw.version !== 1 || !Array.isArray(raw.services) || raw.services.length > MAX_SERVICES) return fail("invalid-catalog");
  const ids = new Set<string>(), names = new Set<string>();
  const services = raw.services.map(value => {
    const service = readObject(value, ["id", ...SERVICE_FIELDS]);
    const id = serviceId(service.id), fields = serviceFields(service, true), name = fields.name.toLowerCase();
    if (ids.has(id) || names.has(name)) return fail("invalid-catalog");
    ids.add(id); names.add(name);
    return { id, ...fields };
  });
  const defaultId = raw.defaultId === null ? null : serviceId(raw.defaultId);
  if (defaultId !== null && !ids.has(defaultId)) return fail("invalid-catalog");
  return { version: 1, defaultId, services };
}

function readSafeJsonFile(path: string, limit: number): unknown {
  const named = lstatSync(path);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > limit) throw new Error("unsafe");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== 1 || opened.size > limit) throw new Error("unsafe");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) throw new Error("limit");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { closeSync(fd); }
}

/**
 * The catalog file stores workspace-local service metadata; API keys are stored
 * encrypted separately in the workspace using LocalSecretProtector and excluded from backups.
 */
export class AssistantModelServices {
  readonly root: string;
  readonly path: string;
  readonly credentialsPath: string;
  readonly #credentials = new Map<string, SessionCredential>();
  #credentialsLoaded = false;
  readonly #providedProtector?: LocalSecretProtector;
  #protector: LocalSecretProtector | null = null;

  constructor(workspaceRoot: string, options: { protector?: LocalSecretProtector } = {}) {
    this.root = resolve(workspaceRoot);
    this.path = join(this.root, ASSISTANT_MODEL_SERVICES_FILE);
    this.credentialsPath = join(this.root, ASSISTANT_MODEL_CREDENTIALS_FILE);
    this.#providedProtector = options.protector;
  }

  private protector(): LocalSecretProtector {
    return (this.#protector ??= this.#providedProtector ?? createLocalSecretProtector());
  }

  private read(): StoredCatalog {
    try {
      if (!workspaceEntryExists(this.root)) return emptyCatalog();
      plainDirectory(this.root);
      if (!workspaceEntryExists(this.path)) return emptyCatalog();
      return parseCatalog(readSafeJsonFile(this.path, ASSISTANT_MODEL_SERVICES_FILE_LIMIT));
    } catch { return fail("invalid-catalog"); }
  }

  private loadCredentials(): void {
    if (this.#credentialsLoaded) return;
    this.#credentialsLoaded = true;
    try {
      if (!workspaceEntryExists(this.root)) return;
      plainDirectory(this.root);
      if (!workspaceEntryExists(this.credentialsPath)) return;
      const parsed = readSafeJsonFile(this.credentialsPath, ASSISTANT_MODEL_SERVICES_FILE_LIMIT);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { version?: unknown }).version !== 1) return;
      const entries = (parsed as { credentials?: unknown }).credentials;
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) return;
      for (const [id, rawEntry] of Object.entries(entries)) {
        if (!/^model_[0-9a-f]{32}$/.test(id) || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
        const entry = rawEntry as Record<string, unknown>;
        if (!(PROVIDERS as readonly unknown[]).includes(entry.provider) || entry.provider === "ollama") continue;
        const provider = entry.provider as RemoteModelProvider;
        if (typeof entry.endpoint !== "string" || !isEncryptedSecret(entry.encryptedApiKey)) continue;
        try {
          const endpoint = normalizeRemoteAssistantEndpoint(entry.endpoint);
          const decrypted = this.protector().decrypt(entry.encryptedApiKey);
          const apiKey = inputKey(decrypted, provider);
          if (apiKey) this.#credentials.set(id, { provider, endpoint, apiKey });
        } catch { /* Ignore entries encrypted under a different user or key. */ }
      }
    } catch { /* Ignore unreadable credential store so metadata stays recoverable. */ }
  }

  private persistCredentials(): void {
    const credentials: Record<string, StoredEncryptedCredential> = {};
    if (this.#credentials.size > 0) {
      const protector = this.protector();
      for (const [id, cred] of this.#credentials) {
        if (cred.provider === "ollama" || !cred.apiKey) continue;
        credentials[id] = { provider: cred.provider, endpoint: cred.endpoint, encryptedApiKey: protector.encrypt(cred.apiKey) };
      }
    }
    if (Object.keys(credentials).length === 0) {
      if (workspaceEntryExists(this.credentialsPath)) {
        try {
          const stat = lstatSync(this.credentialsPath);
          if (!stat.isSymbolicLink() && stat.isFile()) unlinkSync(this.credentialsPath);
        } catch { return fail("storage-error"); }
      }
      return;
    }
    const payload: StoredCredentialsFile = { version: 1, credentials };
    if (Buffer.byteLength(JSON.stringify(payload, null, 2) + "\n") > ASSISTANT_MODEL_SERVICES_FILE_LIMIT) return fail("catalog-full");
    try {
      plainDirectory(this.root, true);
      writeWorkspaceJson(this.credentialsPath, payload);
    } catch { return fail("storage-error"); }
  }

  /** Copy validated metadata without reading or exposing any encrypted credentials. */
  backupMetadata(): StoredCatalog { return this.read(); }

  private write(catalog: StoredCatalog): void {
    if (Buffer.byteLength(JSON.stringify(catalog, null, 2) + "\n") > ASSISTANT_MODEL_SERVICES_FILE_LIMIT) return fail("catalog-full");
    try {
      plainDirectory(this.root, true);
      writeWorkspaceJson(this.path, catalog);
    } catch { return fail("storage-error"); }
  }

  private keyFor(service: StoredAssistantService): string | undefined {
    this.loadCredentials();
    const saved = this.#credentials.get(service.id);
    return saved?.provider === service.provider && saved.endpoint === service.endpoint ? saved.apiKey : undefined;
  }

  private view(catalog: StoredCatalog): AssistantServicesCatalog {
    this.loadCredentials();
    let pruned = false;
    for (const id of Array.from(this.#credentials.keys())) {
      const service = catalog.services.find(item => item.id === id);
      if (!service || !this.keyFor(service)) {
        this.#credentials.delete(id);
        pruned = true;
      }
    }
    if (pruned) this.persistCredentials();
    return { defaultId: catalog.defaultId, services: catalog.services.map(service => ({ ...service, credentialConfigured: !!this.keyFor(service) })) };
  }

  private requireService(catalog: StoredCatalog, id: string): StoredAssistantService {
    return catalog.services.find(service => service.id === id) ?? fail("not-found");
  }

  list(): AssistantServicesCatalog { return this.view(this.read()); }

  save(input: unknown): AssistantServicesCatalog {
    const raw = readObject(input, INPUT_FIELDS), fields = serviceFields(raw, true);
    const suppliedKey = inputKey(raw.apiKey, fields.provider), catalog = this.read();
    this.loadCredentials();
    const existing = raw.id === undefined ? undefined : this.requireService(catalog, serviceId(raw.id));
    const id = existing?.id ?? `model_${randomUUID().replaceAll("-", "")}`;
    const name = fields.name.toLowerCase();
    if (catalog.services.some(service => service.id !== id && service.name.toLowerCase() === name)) return fail("duplicate-name");
    if (!existing && catalog.services.length >= MAX_SERVICES) return fail("catalog-full");
    const service = { id, ...fields };
    const previousKey = existing?.provider === fields.provider && existing.endpoint === fields.endpoint ? this.keyFor(existing) : undefined;
    const apiKey = suppliedKey ?? previousKey;
    if (existing) catalog.services[catalog.services.indexOf(existing)] = service;
    else catalog.services.push(service);
    this.write(catalog);
    if (apiKey) this.#credentials.set(id, { provider: fields.provider, endpoint: fields.endpoint, apiKey });
    else this.#credentials.delete(id);
    this.persistCredentials();
    return this.view(catalog);
  }

  remove(input: unknown): AssistantServicesCatalog {
    const id = serviceId(readObject(input, ["id"]).id), catalog = this.read();
    const target = this.requireService(catalog, id);
    this.loadCredentials();
    catalog.services.splice(catalog.services.indexOf(target), 1);
    if (catalog.defaultId === id) catalog.defaultId = null;
    this.write(catalog);
    if (this.#credentials.delete(id)) this.persistCredentials();
    return this.view(catalog);
  }

  setDefault(input: unknown): AssistantServicesCatalog {
    const raw = readObject(input, ["id"]), id = raw.id === null ? null : serviceId(raw.id);
    const catalog = this.read();
    if (id !== null) this.requireService(catalog, id);
    if (catalog.defaultId !== id) {
      catalog.defaultId = id;
      this.write(catalog);
    }
    return this.view(catalog);
  }

  /** Server-only. Return a detached service view and the credential for that exact connection. */
  resolve(value: unknown): { service: AssistantServiceView; apiKey?: string } {
    const service = this.requireService(this.read(), serviceId(value)), apiKey = this.keyFor(service);
    return { service: { ...service, credentialConfigured: !!apiKey }, apiKey };
  }

  /** The probe accepts unsaved input and never changes a persisted connection or a session credential. */
  connectionDraft(input: unknown): { service: AssistantServiceView; apiKey?: string } {
    const raw = readObject(input, INPUT_FIELDS), fields = serviceFields(raw, false);
    const id = raw.id === undefined ? "" : serviceId(raw.id);
    const existing = id ? this.requireService(this.read(), id) : undefined;
    const service = { id, ...fields };
    const apiKey = inputKey(raw.apiKey, fields.provider) ?? (existing?.provider === fields.provider && existing.endpoint === fields.endpoint ? this.keyFor(service) : undefined);
    return { service: { ...service, credentialConfigured: !!apiKey }, apiKey: apiKey || undefined };
  }
}
