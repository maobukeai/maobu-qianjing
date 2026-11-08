import type { ProxySpec } from "../types.ts";

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
