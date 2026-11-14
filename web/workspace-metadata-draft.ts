import { WORKSPACE_COLORS, type WorkspaceMetadata, type WorkspaceRecord } from "./workspaces-api.ts";

export const WORKSPACE_METADATA_FIELDS = ["name", "color", "icon"] as const satisfies readonly (keyof WorkspaceMetadata)[];

export function workspaceMetadata(workspace: WorkspaceMetadata | null): WorkspaceMetadata {
  if (!workspace) return { name: "", color: WORKSPACE_COLORS[0], icon: "laptop" };
  const { name, color, icon } = workspace;
  return { name, color, icon };
}

export interface WorkspaceMetadataDraft {
  id: string | null;
  base: WorkspaceMetadata;
  draft: WorkspaceMetadata;
}

export function createWorkspaceMetadataDraft(workspace: WorkspaceRecord | null): WorkspaceMetadataDraft {
  const metadata = workspaceMetadata(workspace);
  return { id: workspace?.id ?? null, base: metadata, draft: metadata };
}

export function followWorkspaceMetadata(state: WorkspaceMetadataDraft, workspace: WorkspaceRecord): WorkspaceMetadataDraft {
  if (state.id !== workspace.id || changedWorkspaceFields(state.base, state.draft).length || !changedWorkspaceFields(state.base, workspace).length) return state;
  return createWorkspaceMetadataDraft(workspace);
}

export function changedWorkspaceFields(base: WorkspaceMetadata, other: WorkspaceMetadata) {
  return WORKSPACE_METADATA_FIELDS.filter(field => base[field] !== other[field]);
}

export function workspaceMetadataPatch(base: WorkspaceMetadata, draft: WorkspaceMetadata): Partial<WorkspaceMetadata> {
  return {
    ...(base.name !== draft.name && { name: draft.name }),
    ...(base.color !== draft.color && { color: draft.color }),
    ...(base.icon !== draft.icon && { icon: draft.icon }),
  };
}

export function reviewWorkspaceMetadata(base: WorkspaceMetadata, draft: WorkspaceMetadata, latest: WorkspaceMetadata) {
  const changedFields = changedWorkspaceFields(base, latest);
  const conflicts = changedFields.filter(field => draft[field] !== base[field] && draft[field] !== latest[field]);
  return { changedFields, conflicts, rebased: { ...latest, ...workspaceMetadataPatch(base, draft) } };
}
