/** Pure review/CAS state for extension assignments. No Store, filesystem, browser or request side effects. */
import { createHash } from "node:crypto";
import { isSafeProfileId } from "./profile-id.ts";

export interface ExtensionGroupSelection { group: string; extensions: string[] }
export interface ReviewedExtensionGroupSelection extends ExtensionGroupSelection { expectedFingerprint: string }
export interface ExtensionGroupRevisionMember {
  id: string;
  /** Private database incarnation: used in the hash, never returned in a review DTO. */
  incarnation: string;
  engine: "chromium" | "firefox";
  extensions: readonly string[];
  name: string;
  running: boolean;
}
export interface ExtensionGroupRevisionState {
  /** Process-local Store generation: a review cannot cross workspace instances/restarts. */
  scope: string;
  group: string;
  exists: boolean;
  defaults: readonly string[];
  /** Exactly the current non-Trash members of this group. */
  members: readonly ExtensionGroupRevisionMember[];
}
export interface ExtensionGroupReviewChange { id: string; name: string; added: string[]; removed: string[]; running: boolean }
export interface ExtensionGroupReview extends ReviewedExtensionGroupSelection {
  version: 1;
  count: number;
  defaultAdded: string[];
  defaultRemoved: string[];
  changes: ExtensionGroupReviewChange[];
  /** The server has the complete stored assignments, unlike legacy roster responses. */
  unknown: 0;
}
export type ExtensionGroupRevisionCode = "invalid-selection" | "invalid-fingerprint" | "group-missing" | "state-unavailable" | "preview-conflict";
const failures = {
  "invalid-selection": { status: 400, message: "Choose a group and a valid extension selection before reviewing." },
  "invalid-fingerprint": { status: 400, message: "The extension review is invalid. Review the group again before applying." },
  "group-missing": { status: 404, message: "This extension group is no longer available. Reload groups before reviewing." },
  "state-unavailable": { status: 503, message: "Extension assignments could not be reviewed safely. Reload this page and try again." },
  "preview-conflict": { status: 409, message: "Extension assignments changed after this review. Review the latest changes before applying. Your selection is kept." },
} as const;
export class ExtensionGroupRevisionError extends Error {
  override readonly name = "ExtensionGroupRevisionError";
  readonly status: number;
  constructor(readonly code: ExtensionGroupRevisionCode) { super(failures[code].message); this.status = failures[code].status; }
}
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const safeText = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
function groupName(value: unknown): string {
  if (typeof value !== "string" || !safeText(value.trim(), 4096)) throw new ExtensionGroupRevisionError("invalid-selection");
  return value.trim();
}
/** Assignments are sets. Keep missing-on-this-device IDs; they can belong to a portable workspace. */
export function canonicalExtensionSelection(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10_000 || value.some(id => typeof id !== "string" || !safeText(id.trim(), 1024))) throw new ExtensionGroupRevisionError("invalid-selection");
  return [...new Set(value.map(id => id.trim()))].sort();
}
export function parseExtensionGroupSelection(value: unknown): ExtensionGroupSelection {
  if (!plain(value)) throw new ExtensionGroupRevisionError("invalid-selection");
  return { group: groupName(value.group), extensions: canonicalExtensionSelection(value.extensions) };
}
export function validExtensionGroupFingerprint(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }

function canonicalState(state: ExtensionGroupRevisionState) {
  try {
    if (!safeText(state.scope, 256) || typeof state.exists !== "boolean" || !Array.isArray(state.members)) throw new Error("state");
    const group = groupName(state.group), defaults = canonicalExtensionSelection(state.defaults), ids = new Set<string>();
    const members = state.members.map(member => {
      if (!isSafeProfileId(member.id) || ids.has(member.id) || !safeText(member.incarnation, 256) || !["chromium", "firefox"].includes(member.engine)) throw new Error("member");
      ids.add(member.id);
      return { id: member.id, incarnation: member.incarnation, engine: member.engine, extensions: canonicalExtensionSelection(member.extensions) };
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { scope: state.scope, group, exists: state.exists, defaults, members };
  } catch { throw new ExtensionGroupRevisionError("state-unavailable"); }
}

/** Call again inside the SAME Store transaction immediately before any assignment/default write. */
export function extensionGroupExpectedFingerprint(state: ExtensionGroupRevisionState, target: readonly string[]): string {
  const snapshot = canonicalState(state), extensions = canonicalExtensionSelection(target);
  return createHash("sha256").update(JSON.stringify([
    "maobu.extension-group-review.v1", snapshot.scope, snapshot.group, snapshot.exists,
    snapshot.defaults, extensions, snapshot.members.map(member => [member.id, member.incarnation, member.engine, member.extensions]),
  ])).digest("hex");
}
export function assertExtensionGroupRevision(expected: unknown, state: ExtensionGroupRevisionState, target: readonly string[]): void {
  if (!validExtensionGroupFingerprint(expected)) throw new ExtensionGroupRevisionError("invalid-fingerprint");
  if (!state.exists || expected !== extensionGroupExpectedFingerprint(state, target)) throw new ExtensionGroupRevisionError("preview-conflict");
}

export function createExtensionGroupReview(state: ExtensionGroupRevisionState, target: readonly string[]): ExtensionGroupReview {
  const snapshot = canonicalState(state), extensions = canonicalExtensionSelection(target);
  if (!snapshot.exists) throw new ExtensionGroupRevisionError("group-missing");
  // Copy only presentation fields. Never spread a Profile or expose its incarnation/provenance/credentials.
  const presentation = new Map(state.members.map(member => [member.id, { name: typeof member.name === "string" && member.name ? member.name : member.id, running: member.running === true }]));
  const changes = snapshot.members.flatMap(member => {
    const next = member.engine === "firefox" ? [] : extensions;
    const added = next.filter(id => !member.extensions.includes(id)), removed = member.extensions.filter(id => !next.includes(id));
    return added.length || removed.length ? [{ id: member.id, ...presentation.get(member.id)!, added, removed }] : [];
  });
  return {
    version: 1, group: snapshot.group, extensions: [...extensions], expectedFingerprint: extensionGroupExpectedFingerprint(state, extensions), count: snapshot.members.length,
    defaultAdded: extensions.filter(id => !snapshot.defaults.includes(id)), defaultRemoved: snapshot.defaults.filter(id => !extensions.includes(id)), changes, unknown: 0,
  };
}
