import type { ProxySpec } from "../src/types.ts";

export type ScriptLanguage = "javascript" | "python";

export interface ScriptInput {
  name: string;
  description: string;
  language: ScriptLanguage;
  source: string;
}

export interface ScriptRecord extends ScriptInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type ScriptSummary = Omit<ScriptRecord, "source">;

export type RpaTemplateId =
  | "cookie-warmup"
  | "batch-status-check"
  | "page-health-snapshot"
  | "form-fill-skeleton";

export type RpaTemplateFieldType =
  | "string"
  | "number"
  | "boolean"
  | "string-list"
  | "url"
  | "url-list"
  | "select";

export interface RpaTemplateFieldOption {
  value: string;
  label: string;
}

export interface RpaTemplateField {
  key: string;
  label: string;
  description: string;
  type: RpaTemplateFieldType;
  required?: boolean;
  defaultValue: unknown;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: RpaTemplateFieldOption[];
}

export interface RpaTemplate {
  id: RpaTemplateId;
  name: string;
  description: string;
  category: "warmup" | "inspection" | "health" | "form";
  language: ScriptLanguage;
  useCredentialsDefault: boolean;
  safetyNote?: string;
  inputSchema: RpaTemplateField[];
  defaultInputs: Record<string, unknown>;
  source: string;
}

export type RpaSelectorStrategy =
  | "testid"
  | "id"
  | "role"
  | "aria-label"
  | "name"
  | "placeholder"
  | "text"
  | "css";

export type RpaCredentialRef = "password" | "twofa";

export type RpaRecordedActionKind = "goto" | "click" | "fill" | "select" | "press";

export interface RpaRecordedStep {
  id: string;
  index: number;
  kind: RpaRecordedActionKind;
  timestamp: number;
  url?: string;
  selector?: string;
  selectorStrategy?: RpaSelectorStrategy;
  role?: string;
  accessibleName?: string;
  label?: string;
  value?: string;
  key?: string;
  credentialRef?: RpaCredentialRef;
  masked?: boolean;
  inputParamName?: string;
  tagName?: string;
}

export interface RpaCodegenOptions {
  scriptName?: string;
  parameterizeInputs?: boolean;
  humanDelay?: boolean;
  defaultMinDelayMs?: number;
  defaultMaxDelayMs?: number;
}

export interface RpaCodegenResult {
  language: "javascript";
  source: string;
  suggestedInputs: Record<string, unknown>;
  usesCredentials: boolean;
  stepCount: number;
}

export type RpaRecorderState = "idle" | "starting" | "recording" | "stopping" | "error";

export interface RpaRecorderStatus {
  state: RpaRecorderState;
  sessionId: string | null;
  profileId: string | null;
  profileName: string | null;
  engine: "chromium" | "firefox" | null;
  ownedByConnection: boolean;
  startedAt: number | null;
  lastActivityAt: number | null;
  steps: RpaRecordedStep[];
  error: string | null;
}

export interface ScriptStepRecord {
  index: number;
  title: string;
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
}

export interface ScriptArtifactRecord {
  fileName: string;
  label: string;
  mimeType: "image/jpeg" | "image/png";
  sizeBytes: number;
  capturedAt: number;
  kind: "manual" | "error";
}

export type ProxyReplacementSelector =
  | { profileId: string; username?: never }
  | { username: string; profileId?: never };

export type ProxyReplacementRequestRow = ProxyReplacementSelector & { proxy: ProxySpec };

export interface ProxyReplacementsRequest {
  dryRun: boolean;
  replacements: ProxyReplacementRequestRow[];
}

export type ProxyReplacementStatus = "ready" | "updated" | "unchanged" | "missing" | "skipped";
export type ProxyReplacementCode =
  | "invalid_row" | "invalid_proxy" | "duplicate_selector" | "no_editable_match"
  | "ambiguous_username" | "duplicate_target" | "profile_trashed" | "profile_open" | "version_conflict";

export interface ProxyReplacementResult {
  index: number;
  status: ProxyReplacementStatus;
  code?: ProxyReplacementCode;
  profileId?: string;
}

export interface ProxyReplacementsResponse {
  ok: true;
  dryRun: boolean;
  counts: {
    received: number;
    matched: number;
    ready: number;
    updated: number;
    unchanged: number;
    missing: number;
    skipped: number;
  };
  results: ProxyReplacementResult[];
  missingUsernames: string[];
}
