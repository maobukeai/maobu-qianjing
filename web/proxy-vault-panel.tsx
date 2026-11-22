import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import { AppIcon as Icon, ConfirmDialog, ModalDialog } from "./ui-primitives.tsx";
import {
  applyProxyVaultImport,
  bindProxyVaultEntries,
  checkProxyVaultStream,
  createProxyVaultEntry,
  deleteProxyVaultBatch,
  deleteProxyVaultEntry,
  fetchProxyVault,
  fetchProxyVaultEdit,
  formatVaultEndpoint,
  ingestProxyVaultFromProfiles,
  previewProxyVaultImport,
  ProxyVaultError,
  refreshProxyVaultIp,
  syncProxyVaultBoundProfiles,
  updateProxyVaultEntry,
  type ProxyVaultBindMode,
  type ProxyVaultEntry,
  type ProxyVaultImportPreview,
  type ProxyVaultImportStrategy,
  type ProxyVaultProtocol,
  type ProxyVaultRiskCode,
  type ProxyVaultStatus,
} from "./proxy-vault-api.ts";
import "./proxy-vault.css";

export interface VaultTargetProfile {
  id: string;
  name?: string;
  group: string;
  platform?: string;
  running: boolean;
  proxy?: string | null;
}

export interface ProxyVaultPanelProps {
  active: boolean;
  profiles?: readonly VaultTargetProfile[];
  onChanged: () => Promise<void>;
}

const VAULT_STATUS_LABELS: Record<ProxyVaultStatus, string> = {
  unchecked: "Unchecked",
  working: "Reachable",
  unstable: "Unstable",
  failed: "Connection failed",
  unavailable: "Not verified",
  unsupported: "Unsupported",
};

const RISK_CODE_LABELS: Record<ProxyVaultRiskCode, string> = {
  same_platform_binding: "Multiple environments on the same platform share this proxy",
  duplicate_exit_ip_same_platform: "Same exit IP shared across environments on the same platform",
  same_host_exit: "Exit IP matches this computer's direct network",
  shared_binding: "Shared across multiple environments",
  duplicate_proxy: "Duplicate proxy endpoint exists in the vault",
  duplicate_exit_ip: "Another vault proxy uses the same exit IP",
};

function rttTone(latencyMs: number): "fast" | "medium" | "slow" {
  if (latencyMs <= 120) return "fast";
  if (latencyMs <= 400) return "medium";
  return "slow";
}

function exitLocation(entry: ProxyVaultEntry): string {
  return [entry.lastExitCountry, entry.lastExitRegion, entry.lastExitCity].filter(Boolean).join(" · ");
}

interface EditorFormState {
  id: string | null;
  name: string;
  group: string;
  type: ProxyVaultProtocol;
  host: string;
  port: string;
  user: string;
  pass: string;
  refreshUrl: string;
  notes: string;
  hadAuth: boolean;
  hadRefreshUrl: boolean;
}

const EMPTY_EDITOR: EditorFormState = {
  id: null,
  name: "",
  group: "",
  type: "http",
  host: "",
  port: "8080",
  user: "",
  pass: "",
  refreshUrl: "",
  notes: "",
  hadAuth: false,
  hadRefreshUrl: false,
};

/** Estimate anti-association risk before binding so operators explicitly confirm risky assignments. */
export function assessBindRisk(
  selectedProxies: readonly ProxyVaultEntry[],
  selectedProfiles: readonly VaultTargetProfile[],
  mode: ProxyVaultBindMode,
  profilesPerProxy: number,
): { level: "none" | "medium" | "high"; reasons: string[] } {
  if (!selectedProxies.length || !selectedProfiles.length) return { level: "none", reasons: [] };
  const reasons: string[] = [];
  let level: "none" | "medium" | "high" = "none";
  const elevate = (next: "medium" | "high", reason: string) => {
    if (next === "high" || level === "none") level = next;
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  // Build simulated per-proxy assignments.
  const assignments = new Map<string, VaultTargetProfile[]>();
  const capacity = Math.max(1, profilesPerProxy);
  if (mode === "single") {
    assignments.set(selectedProxies[0]!.id, [...selectedProfiles]);
  } else {
    selectedProfiles.forEach((profile, idx) => {
      const proxyIdx = Math.floor(idx / capacity) % selectedProxies.length;
      const proxy = selectedProxies[proxyIdx]!;
      const bucket = assignments.get(proxy.id) ?? [];
      bucket.push(profile);
      assignments.set(proxy.id, bucket);
    });
  }

  for (const proxy of selectedProxies) {
    const incoming = assignments.get(proxy.id) ?? [];
    if (!incoming.length) continue;
    if (proxy.lastExitComparison === "same") {
      elevate("high", RISK_CODE_LABELS.same_host_exit);
    }
    const combinedIds = new Map<string, { platform: string }>();
    for (const existing of proxy.boundProfiles) {
      combinedIds.set(existing.profileId, { platform: (existing.platform || "").toLowerCase() });
    }
    for (const target of incoming) {
      combinedIds.set(target.id, { platform: (target.platform || "").toLowerCase() });
    }
    const platformCounts = new Map<string, number>();
    for (const { platform } of combinedIds.values()) {
      if (!platform) continue;
      platformCounts.set(platform, (platformCounts.get(platform) ?? 0) + 1);
    }
    if ([...platformCounts.values()].some((c) => c >= 2)) {
      elevate("high", RISK_CODE_LABELS.same_platform_binding);
    } else if (combinedIds.size >= 2) {
      elevate("medium", RISK_CODE_LABELS.shared_binding);
    }
  }
  return { level, reasons };
}

export function ProxyVaultPanel({ active, profiles = [], onChanged }: ProxyVaultPanelProps) {
  const { t, language } = useTranslation();
  const [entries, setEntries] = useState<ProxyVaultEntry[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [riskFilter, setRiskFilter] = useState<"all" | "high" | "medium" | "any">("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [checking, setChecking] = useState(false);
  const [checkProgress, setCheckProgress] = useState<{ completed: number; total: number } | null>(null);
  const checkController = useRef<AbortController | null>(null);

  const [refreshingIds, setRefreshingIds] = useState<Record<string, boolean>>({});
  const [cooldownUntil, setCooldownUntil] = useState<Record<string, number>>({});
  const [ingesting, setIngesting] = useState(false);
  const [syncPrompt, setSyncPrompt] = useState<{ id: string; name: string; count: number } | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  // Add / Edit modal state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorFormState>(EMPTY_EDITOR);

  // Batch import modal state
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importGroup, setImportGroup] = useState("");
  const [importStrategy, setImportStrategy] = useState<ProxyVaultImportStrategy>("skip_duplicates");
  const [importPreview, setImportPreview] = useState<ProxyVaultImportPreview | null>(null);
  const [importBusy, setImportBusy] = useState<"preview" | "apply" | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Bind modal state
  const [bindOpen, setBindOpen] = useState(false);
  const [bindProxyIds, setBindProxyIds] = useState<string[]>([]);
  const [bindMode, setBindMode] = useState<ProxyVaultBindMode>("round_robin");
  const [bindPerProxy, setBindPerProxy] = useState("1");
  const [bindProfileSearch, setBindProfileSearch] = useState("");
  const [bindProfileIds, setBindProfileIds] = useState<Set<string>>(new Set());
  const [bindRiskConfirmed, setBindRiskConfirmed] = useState(false);
  const [bindBusy, setBindBusy] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<{ ids: string[]; label: string } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const loadVault = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchProxyVault({}, signal);
      if (signal?.aborted) return;
      setEntries(result.entries);
      setGroups(result.groups);
      setUnavailable(false);
      setLoadedOnce(true);
      setSelectedIds((prev) => {
        const valid = new Set(result.entries.map((e) => e.id));
        const next = new Set([...prev].filter((id) => valid.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch (failure) {
      if (signal?.aborted) return;
      if (failure instanceof ProxyVaultError && (failure.status === 404 || failure.status === 501 || failure.status === 503)) {
        setUnavailable(true);
        setError(failure.message);
      } else {
        setError(failure instanceof Error ? failure.message : t("Could not load proxy vault."));
      }
      setLoadedOnce(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void loadVault(controller.signal);
    return () => controller.abort();
  }, [active, loadVault]);

  useEffect(() => () => {
    checkController.current?.abort();
    checkController.current = null;
  }, []);

  const filteredEntries = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      if (groupFilter !== "all") {
        if (groupFilter === "__ungrouped__" ? entry.group !== "" : entry.group !== groupFilter) {
          return false;
        }
      }
      if (riskFilter === "high" && entry.riskLevel !== "high") return false;
      if (riskFilter === "medium" && entry.riskLevel !== "medium") return false;
      if (riskFilter === "any" && entry.riskLevel === "none") return false;
      if (needle) {
        const haystack = [
          entry.name,
          entry.group,
          formatVaultEndpoint(entry),
          entry.lastExitIp,
          entry.lastExitCountry,
          entry.notes,
          ...entry.boundProfiles.map((p) => `${p.name} ${p.platform} ${p.group}`),
        ]
          .join(" ")
          .toLocaleLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [entries, groupFilter, riskFilter, search]);

  const stats = useMemo(() => {
    let working = 0;
    let highRisk = 0;
    let mediumRisk = 0;
    let boundProfiles = 0;
    for (const item of entries) {
      if (item.lastStatus === "working") working++;
      if (item.riskLevel === "high") highRisk++;
      else if (item.riskLevel === "medium") mediumRisk++;
      boundProfiles += item.boundProfiles.length;
    }
    return { total: entries.length, working, highRisk, mediumRisk, boundProfiles };
  }, [entries]);

  const allVisibleSelected =
    filteredEntries.length > 0 && filteredEntries.every((item) => selectedIds.has(item.id));

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const item of filteredEntries) next.delete(item.id);
      } else {
        for (const item of filteredEntries) next.add(item.id);
      }
      return next;
    });
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runVaultCheck = async (ids?: string[]) => {
    if (checking) return;
    const scopeIds = ids ?? (selectedIds.size > 0 ? [...selectedIds] : undefined);
    const controller = new AbortController();
    checkController.current = controller;
    setChecking(true);
    setCheckProgress(null);
    setError(null);
    setNotice(null);
    try {
      await checkProxyVaultStream(
        scopeIds ? { ids: scopeIds } : { all: true },
        (event) => {
          if (checkController.current !== controller) return;
          if (event.type === "progress") {
            setCheckProgress({ completed: event.completed, total: event.total });
          } else if (event.type === "result") {
            setEntries((current) =>
              current.map((item) => (item.id === event.entry.id ? event.entry : item)),
            );
          }
        },
        controller.signal,
      );
      if (checkController.current === controller) {
        setNotice(t("Vault connection check completed."));
        await loadVault();
      }
    } catch (failure) {
      if (checkController.current !== controller) return;
      if (controller.signal.aborted) {
        setNotice(t("Stopped vault check. Completed results remain saved."));
      } else {
        setError(failure instanceof Error ? failure.message : t("Vault check failed."));
      }
    } finally {
      if (checkController.current === controller) {
        checkController.current = null;
        setChecking(false);
        setCheckProgress(null);
      }
    }
  };

  const handleRefreshIp = async (entry: ProxyVaultEntry) => {
    if (!entry.hasRefreshUrl || refreshingIds[entry.id]) return;
    const now = Date.now();
    if ((cooldownUntil[entry.id] ?? 0) > now) return;
    setRefreshingIds((prev) => ({ ...prev, [entry.id]: true }));
    setError(null);
    setNotice(null);
    try {
      const result = await refreshProxyVaultIp(entry.id, { recheck: true });
      if (result.entry) {
        setEntries((current) =>
          current.map((item) => (item.id === entry.id ? result.entry! : item)),
        );
      } else {
        await loadVault();
      }
      setCooldownUntil((prev) => ({ ...prev, [entry.id]: Date.now() + 5_000 }));
      setNotice(
        result.exitIp
          ? t("Refreshed dynamic IP for {proxy} · new exit {ip}", {
              proxy: entry.name || `${entry.host}:${entry.port}`,
              ip: result.exitIp,
            })
          : t("Triggered IP refresh for {proxy}.", {
              proxy: entry.name || `${entry.host}:${entry.port}`,
            }),
      );
    } catch (failure) {
      if (failure instanceof ProxyVaultError && failure.cooldownRemainingMs) {
        setCooldownUntil((prev) => ({
          ...prev,
          [entry.id]: Date.now() + failure.cooldownRemainingMs!,
        }));
      }
      setError(failure instanceof Error ? failure.message : t("Could not refresh proxy IP."));
    } finally {
      setRefreshingIds((prev) => {
        const next = { ...prev };
        delete next[entry.id];
        return next;
      });
    }
  };

  const handleIngest = async () => {
    if (ingesting) return;
    setIngesting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await ingestProxyVaultFromProfiles();
      setNotice(
        t("Ingested {ingested} proxies from environments ({skipped} duplicates skipped, {bound} linked).", {
          ingested: result.ingested,
          skipped: result.skippedDuplicates,
          bound: result.bound,
        }),
      );
      await loadVault();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Could not ingest proxies from environments."));
    } finally {
      setIngesting(false);
    }
  };

  const handleSyncBound = async (id: string, label?: string) => {
    if (syncingId) return;
    setSyncingId(id);
    setError(null);
    setNotice(null);
    try {
      const result = await syncProxyVaultBoundProfiles(id);
      setSyncPrompt((current) => (current?.id === id ? null : current));
      setNotice(
        t("Synced {proxy} to {updated} stopped environments ({skipped} running skipped).", {
          proxy: label || id,
          updated: result.updated,
          skipped: result.skippedRunning,
        }),
      );
      await Promise.all([loadVault(), onChanged()]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Could not sync proxy to bound environments."));
    } finally {
      setSyncingId(null);
    }
  };

  // ---- Add / Edit modal ----
  const openCreateModal = () => {
    setEditor(EMPTY_EDITOR);
    setEditorError(null);
    setEditorLoading(false);
    setEditorOpen(true);
  };

  const openEditModal = async (entry: ProxyVaultEntry) => {
    setEditor({
      id: entry.id,
      name: entry.name,
      group: entry.group,
      type: entry.type,
      host: entry.host,
      port: String(entry.port),
      user: "",
      pass: "",
      refreshUrl: "",
      notes: entry.notes,
      hadAuth: entry.hasAuth,
      hadRefreshUrl: entry.hasRefreshUrl,
    });
    setEditorError(null);
    setEditorLoading(true);
    setEditorOpen(true);
    try {
      const full = await fetchProxyVaultEdit(entry.id);
      setEditor({
        id: full.id,
        name: full.name,
        group: full.group,
        type: full.type,
        host: full.host,
        port: String(full.port),
        user: full.user,
        pass: full.pass,
        refreshUrl: full.refreshUrl,
        notes: full.notes,
        hadAuth: full.hasAuth,
        hadRefreshUrl: full.hasRefreshUrl,
      });
    } catch (failure) {
      setEditorError(failure instanceof Error ? failure.message : t("Could not load proxy details."));
    } finally {
      setEditorLoading(false);
    }
  };

  const saveEditor = async () => {
    if (editorSaving || editorLoading) return;
    const host = editor.host.trim();
    const portNum = Number(editor.port.trim());
    if (!host || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setEditorError(t("Enter a valid proxy host and port (1–65535)."));
      return;
    }
    setEditorSaving(true);
    setEditorError(null);
    try {
      const payload = {
        name: editor.name.trim(),
        group: editor.group.trim(),
        type: editor.type,
        host,
        port: portNum,
        user: editor.user,
        pass: editor.pass,
        clearAuth: editor.hadAuth && !editor.user && !editor.pass,
        refreshUrl: editor.refreshUrl.trim(),
        clearRefreshUrl: editor.hadRefreshUrl && !editor.refreshUrl.trim(),
        notes: editor.notes.trim(),
      };
      if (editor.id) {
        const result = await updateProxyVaultEntry(editor.id, payload);
        setEditorOpen(false);
        setNotice(t("Proxy updated in vault."));
        if (result.boundCount > 0) {
          setSyncPrompt({
            id: result.entry.id,
            name: result.entry.name || formatVaultEndpoint(result.entry),
            count: result.boundCount,
          });
        }
      } else {
        await createProxyVaultEntry(payload);
        setEditorOpen(false);
        setNotice(t("Proxy added to vault."));
      }
      await loadVault();
    } catch (failure) {
      setEditorError(failure instanceof Error ? failure.message : t("Could not save proxy."));
    } finally {
      setEditorSaving(false);
    }
  };

  // ---- Batch import modal ----
  const openImportModal = () => {
    setImportText("");
    setImportGroup("");
    setImportStrategy("skip_duplicates");
    setImportPreview(null);
    setImportError(null);
    setImportOpen(true);
  };

  const runImportPreview = async () => {
    if (!importText.trim() || importBusy) return;
    setImportBusy("preview");
    setImportError(null);
    try {
      const preview = await previewProxyVaultImport({
        text: importText,
        defaultGroup: importGroup.trim() || undefined,
        strategy: importStrategy,
      });
      setImportPreview(preview);
    } catch (failure) {
      setImportError(failure instanceof Error ? failure.message : t("Could not preview batch import."));
    } finally {
      setImportBusy(null);
    }
  };

  const runImportApply = async () => {
    if (!importPreview || importPreview.valid === 0 || importBusy) return;
    setImportBusy("apply");
    setImportError(null);
    try {
      const result = await applyProxyVaultImport({
        text: importText,
        defaultGroup: importGroup.trim() || undefined,
        strategy: importStrategy,
      });
      setImportOpen(false);
      setNotice(
        t("Imported {inserted} new proxies ({updated} updated, {skipped} skipped).", {
          inserted: result.inserted,
          updated: result.updated,
          skipped: result.skipped,
        }),
      );
      await loadVault();
    } catch (failure) {
      setImportError(failure instanceof Error ? failure.message : t("Could not apply batch import."));
    } finally {
      setImportBusy(null);
    }
  };

  // ---- Bind modal ----
  const openBindModal = (ids: string[]) => {
    if (!ids.length) return;
    setBindProxyIds(ids);
    setBindMode(ids.length === 1 ? "single" : "round_robin");
    setBindPerProxy("1");
    setBindProfileSearch("");
    setBindProfileIds(new Set());
    setBindRiskConfirmed(false);
    setBindError(null);
    setBindOpen(true);
  };

  const bindProxies = useMemo(
    () => bindProxyIds.map((id) => entries.find((e) => e.id === id)).filter((e): e is ProxyVaultEntry => !!e),
    [bindProxyIds, entries],
  );

  const filteredBindProfiles = useMemo(() => {
    const needle = bindProfileSearch.trim().toLocaleLowerCase();
    return profiles.filter((profile) => {
      if (!needle) return true;
      return `${profile.name || profile.id} ${profile.group} ${profile.platform || ""}`
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [profiles, bindProfileSearch]);

  const selectedBindProfiles = useMemo(
    () => profiles.filter((p) => bindProfileIds.has(p.id)),
    [profiles, bindProfileIds],
  );

  const bindPerProxyNum = Math.max(1, Number.parseInt(bindPerProxy, 10) || 1);
  const bindRisk = useMemo(
    () => assessBindRisk(bindProxies, selectedBindProfiles, bindMode, bindPerProxyNum),
    [bindProxies, selectedBindProfiles, bindMode, bindPerProxyNum],
  );

  const submitBind = async () => {
    if (!bindProxyIds.length || !bindProfileIds.size || bindBusy) return;
    if (bindRisk.level !== "none" && !bindRiskConfirmed) return;
    setBindBusy(true);
    setBindError(null);
    try {
      const result = await bindProxyVaultEntries({
        proxyIds: bindProxyIds,
        profileIds: [...bindProfileIds],
        mode: bindMode,
        ...(bindMode === "round_robin" ? { profilesPerProxy: bindPerProxyNum } : {}),
        confirmRisk: bindRisk.level === "none" ? undefined : bindRiskConfirmed,
      });
      setBindOpen(false);
      setNotice(
        t("Bound proxies to {updated} environments ({skipped} running skipped).", {
          updated: result.updated,
          skipped: result.skippedRunning,
        }),
      );
      await Promise.all([loadVault(), onChanged()]);
    } catch (failure) {
      setBindError(failure instanceof Error ? failure.message : t("Could not bind proxies."));
    } finally {
      setBindBusy(false);
    }
  };

  // ---- Delete confirmation ----
  const confirmDelete = async () => {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    setError(null);
    try {
      if (deleteTarget.ids.length === 1) {
        await deleteProxyVaultEntry(deleteTarget.ids[0]!);
      } else {
        await deleteProxyVaultBatch(deleteTarget.ids);
      }
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of deleteTarget.ids) next.delete(id);
        return next;
      });
      setDeleteTarget(null);
      setNotice(t("Deleted {count} proxy entries from vault.", { count: deleteTarget.ids.length }));
      await loadVault();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Could not delete proxy entries."));
    } finally {
      setDeleteBusy(false);
    }
  };

  if (!active) return null;

  return (
    <div className="proxy-vault-panel" data-proxy-vault-panel>
      <section className="tools-panel">
        <div className="tools-panel-head">
          <div>
            <h3>{t("Proxy vault")}</h3>
            <p>{t("Store reusable proxies with encrypted credentials, anti-association alerts, and one-click environment binding.")}</p>
          </div>
          <div className="proxy-actions">
            <button type="button" className="btn" disabled={loading || checking || ingesting} onClick={() => void handleIngest()}>
              <Icon name="import" className="sm" />
              {ingesting ? t("Ingesting…") : t("Ingest from environments")}
            </button>
            <button type="button" className="btn" disabled={unavailable || checking} onClick={openImportModal}>
              <Icon name="fileImport" className="sm" />
              {t("Batch import")}
            </button>
            <button
              type="button"
              className="btn"
              disabled={unavailable || checking || entries.length === 0}
              onClick={() => void runVaultCheck()}
            >
              <Icon name="activity" className="sm" />
              {checking
                ? t("Checking…")
                : selectedIds.size > 0
                  ? t("Check selected ({count})", { count: selectedIds.size })
                  : t("Check all")}
            </button>
            <button type="button" className="btn primary" disabled={unavailable} onClick={openCreateModal}>
              <Icon name="plus" className="sm" />
              {t("Add proxy")}
            </button>
          </div>
        </div>

        <div className="vault-summary-grid" aria-label={t("Proxy vault overview")}>
          <div>
            <strong>{stats.total.toLocaleString()}</strong>
            <span>{t("Saved proxies")}</span>
          </div>
          <div>
            <strong className={stats.working > 0 ? "tone-good" : ""}>{stats.working.toLocaleString()}</strong>
            <span>{t("Reachable")}</span>
          </div>
          <div>
            <strong className={stats.highRisk > 0 ? "tone-danger" : stats.mediumRisk > 0 ? "tone-warn" : ""}>
              {stats.highRisk > 0
                ? t("{high} high · {medium} med", { high: stats.highRisk, medium: stats.mediumRisk })
                : stats.mediumRisk.toLocaleString()}
            </strong>
            <span>{t("Association risks")}</span>
          </div>
          <div>
            <strong>{stats.boundProfiles.toLocaleString()}</strong>
            <span>{t("Bound environments")}</span>
          </div>
        </div>

        {syncPrompt && (
          <div className="vault-sync-banner" role="status">
            <span>
              {t("“{proxy}” is bound to {count} environments. Sync updated endpoint & credentials to stopped environments now?", {
                proxy: syncPrompt.name,
                count: syncPrompt.count,
              })}
            </span>
            <div className="proxy-actions">
              <button
                type="button"
                className="btn xs primary"
                disabled={syncingId === syncPrompt.id}
                onClick={() => void handleSyncBound(syncPrompt.id, syncPrompt.name)}
              >
                {syncingId === syncPrompt.id ? t("Syncing…") : t("Sync to bound environments")}
              </button>
              <button type="button" className="btn xs ghost" onClick={() => setSyncPrompt(null)}>
                {t("Later")}
              </button>
            </div>
          </div>
        )}

        {error && <div className="tools-alert" role="alert">{error}</div>}
        {notice && <div className="tools-notice" role="status">{notice}</div>}

        {checking && (
          <div className="tools-progress" role="status">
            <div className="proxy-actions">
              <strong>
                {checkProgress
                  ? t("Checking vault proxies: {completed} / {total}", {
                      completed: checkProgress.completed,
                      total: checkProgress.total,
                    })
                  : t("Starting vault connection check…")}
              </strong>
              <button type="button" className="btn xs" onClick={() => checkController.current?.abort()}>
                {t("Cancel")}
              </button>
            </div>
            <progress
              aria-label={t("Vault proxy check progress")}
              {...(checkProgress && checkProgress.total > 0
                ? { value: checkProgress.completed, max: checkProgress.total }
                : {})}
            />
          </div>
        )}

        <div className="vault-toolbar">
          <div className="vault-search-wrap">
            <label>
              <span className="sr-only">{t("Search vault proxies")}</span>
              <input
                className="input"
                type="search"
                value={search}
                placeholder={t("Search name, host, exit IP, notes or environment…")}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>
          <select
            className="select vault-filter-select"
            aria-label={t("Filter by proxy group")}
            value={groupFilter}
            onChange={(event) => setGroupFilter(event.target.value)}
          >
            <option value="all">{t("All proxy groups")}</option>
            <option value="__ungrouped__">{t("Ungrouped")}</option>
            {groups.map((grp) => (
              <option key={grp} value={grp}>{grp}</option>
            ))}
          </select>
          <div className="vault-risk-pills" role="group" aria-label={t("Filter by risk level")}>
            {(
              [
                { key: "all", label: "All", cls: "" },
                { key: "high", label: "High risk", cls: "risk-high" },
                { key: "medium", label: "Medium risk", cls: "risk-medium" },
                { key: "any", label: "Any risk", cls: "" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.key}
                type="button"
                className={opt.cls}
                aria-pressed={riskFilter === opt.key}
                onClick={() => setRiskFilter(opt.key)}
              >
                {t(opt.label)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn xs ghost"
            disabled={loading}
            aria-label={t("Refresh proxy vault")}
            onClick={() => void loadVault()}
          >
            <Icon name="refresh" className="sm" />
          </button>
        </div>

        {selectedIds.size > 0 && (
          <div className="vault-selection-bar">
            <span>{t("{count} proxies selected", { count: selectedIds.size })}</span>
            <div className="vault-selection-actions">
              <button type="button" className="btn xs primary" onClick={() => openBindModal([...selectedIds])}>
                {t("Bind to environments")}
              </button>
              <button type="button" className="btn xs" disabled={checking} onClick={() => void runVaultCheck([...selectedIds])}>
                {t("Check selected")}
              </button>
              <button
                type="button"
                className="btn xs danger"
                onClick={() =>
                  setDeleteTarget({
                    ids: [...selectedIds],
                    label: t("{count} selected proxies", { count: selectedIds.size }),
                  })
                }
              >
                {t("Delete selected")}
              </button>
              <button type="button" className="btn xs ghost" onClick={() => setSelectedIds(new Set())}>
                {t("Clear selection")}
              </button>
            </div>
          </div>
        )}

        {loading && !loadedOnce ? (
          <div className="tools-empty compact">
            <p role="status">{t("Loading proxy vault…")}</p>
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="tools-empty">
            <span className="tools-empty-symbol" aria-hidden="true">⇄</span>
            <h3>{entries.length === 0 ? t("Your proxy vault is empty") : t("No proxies match these filters")}</h3>
            <p>
              {entries.length === 0
                ? t("Add proxies manually, batch-import a list/CSV, or ingest proxies already saved on your environments.")
                : t("Adjust the search query, proxy group, or risk filter to see more entries.")}
            </p>
          </div>
        ) : (
          <div className="vault-table-wrap">
            <table className="profile-table proxy-table vault-table">
              <thead>
                <tr>
                  <th className="col-chk">
                    <input
                      type="checkbox"
                      aria-label={t("Select all visible vault proxies")}
                      checked={allVisibleSelected}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th className="col-endpoint">{t("Proxy")}</th>
                  <th className="col-status">{t("Health & RTT")}</th>
                  <th className="col-exit">{t("Exit IP")}</th>
                  <th className="col-risk">{t("Risk & bindings")}</th>
                  <th className="col-actions">{t("Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredEntries.map((entry) => {
                  const isSelected = selectedIds.has(entry.id);
                  const isRefreshing = !!refreshingIds[entry.id];
                  const inCooldown = (cooldownUntil[entry.id] ?? 0) > Date.now();
                  const hasDrifted = entry.boundProfiles.some((bp) => bp.drifted);
                  const location = exitLocation(entry);
                  return (
                    <tr key={entry.id} data-vault-id={entry.id} className={isSelected ? "is-selected" : ""}>
                      <td className="col-chk">
                        <input
                          type="checkbox"
                          aria-label={t("Select proxy {proxy}", { proxy: entry.name || `${entry.host}:${entry.port}` })}
                          checked={isSelected}
                          onChange={() => toggleSelectOne(entry.id)}
                        />
                      </td>
                      <td className="col-endpoint">
                        <div className="vault-endpoint-cell">
                          <div className="vault-name-row">
                            <strong>{entry.name || `${entry.host}:${entry.port}`}</strong>
                            {entry.group && <span className="vault-tag">{entry.group}</span>}
                          </div>
                          <span className="vault-endpoint-addr">{formatVaultEndpoint(entry)}</span>
                          <div className="vault-meta-chips">
                            {entry.hasAuth && <span className="vault-tag auth">{t("Auth")}</span>}
                            {entry.hasRefreshUrl && (
                              <span className="vault-tag rotating" title={entry.refreshUrlHost || t("Dynamic IP refresh URL configured")}>
                                {entry.refreshUrlHost ? t("Refresh · {host}", { host: entry.refreshUrlHost }) : t("Dynamic IP")}
                              </span>
                            )}
                            {entry.notes && <span className="vault-tag" title={entry.notes}>{entry.notes.slice(0, 28)}{entry.notes.length > 28 ? "…" : ""}</span>}
                          </div>
                        </div>
                      </td>
                      <td className="col-status">
                        <div className="vault-status-stack">
                          <span className={`tools-status ${entry.lastStatus}`}>
                            {t(VAULT_STATUS_LABELS[entry.lastStatus])}
                          </span>
                          {entry.lastLatencyMs !== null && (
                            <span className={`vault-rtt-pill ${rttTone(entry.lastLatencyMs)}`}>
                              {entry.lastLatencyMs} ms
                            </span>
                          )}
                          {entry.lastCheckedAt > 0 && (
                            <small>
                              {new Date(entry.lastCheckedAt).toLocaleString(language, {
                                month: "2-digit",
                                day: "2-digit",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </small>
                          )}
                        </div>
                      </td>
                      <td className="col-exit">
                        <span className="tools-mono">{entry.lastExitIp || "—"}</span>
                        {location && <small>{location}</small>}
                        {entry.lastExitRotating && <small>{t("Rotating exit")}</small>}
                      </td>
                      <td className="col-risk">
                        <span className={`vault-risk-badge ${entry.riskLevel}`}>
                          {entry.riskLevel === "high"
                            ? t("High risk")
                            : entry.riskLevel === "medium"
                              ? t("Medium risk")
                              : t("No risk")}
                        </span>
                        {(entry.risks.length > 0 || entry.boundProfiles.length > 0) && (
                          <details className="vault-risk-details">
                            <summary>
                              {t("{bound} bound · {risks} alerts", {
                                bound: entry.boundProfiles.length,
                                risks: entry.risks.length,
                              })}
                            </summary>
                            {entry.risks.length > 0 && (
                              <ul className="vault-risk-list">
                                {entry.risks.map((risk, idx) => (
                                  <li key={`${risk.code}-${idx}`} className={risk.level}>
                                    {t(RISK_CODE_LABELS[risk.code])}
                                    {risk.platform ? ` (${risk.platform})` : ""}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {entry.boundProfiles.length > 0 && (
                              <ul className="vault-bound-list">
                                {entry.boundProfiles.map((bp) => (
                                  <li key={bp.profileId}>
                                    {bp.name}
                                    {bp.platform ? ` · ${bp.platform}` : ""}
                                    {bp.running ? ` · ${t("Running")}` : ""}
                                    {bp.drifted && (
                                      <span className="vault-bound-drifted"> · {t("Out of sync")}</span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </details>
                        )}
                      </td>
                      <td className="col-actions">
                        <div className="vault-row-actions">
                          <button
                            type="button"
                            className="btn xs"
                            disabled={checking}
                            onClick={() => void runVaultCheck([entry.id])}
                          >
                            {t("Check")}
                          </button>
                          {entry.hasRefreshUrl && (
                            <button
                              type="button"
                              className="btn xs"
                              disabled={isRefreshing || inCooldown}
                              title={t("Request a new exit IP from the configured refresh URL")}
                              onClick={() => void handleRefreshIp(entry)}
                            >
                              {isRefreshing ? t("Refreshing…") : t("Refresh IP")}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn xs"
                            onClick={() => openBindModal([entry.id])}
                          >
                            {t("Bind")}
                          </button>
                          {hasDrifted && (
                            <button
                              type="button"
                              className="btn xs warn"
                              disabled={syncingId === entry.id}
                              onClick={() => void handleSyncBound(entry.id, entry.name || `${entry.host}:${entry.port}`)}
                            >
                              {t("Sync")}
                            </button>
                          )}
                          <button type="button" className="btn xs ghost" onClick={() => void openEditModal(entry)}>
                            {t("Edit")}
                          </button>
                          <button
                            type="button"
                            className="btn xs ghost"
                            aria-label={t("Delete proxy {proxy}", { proxy: entry.name || `${entry.host}:${entry.port}` })}
                            onClick={() =>
                              setDeleteTarget({
                                ids: [entry.id],
                                label: entry.name || formatVaultEndpoint(entry),
                              })
                            }
                          >
                            <Icon name="trash" className="sm" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Add / Edit Proxy Modal */}
      <ModalDialog
        open={editorOpen}
        onClose={() => { if (!editorSaving) setEditorOpen(false); }}
        title={editor.id ? t("Edit vault proxy") : t("Add proxy to vault")}
        size="md"
        busy={editorSaving}
        footer={
          <>
            <button type="button" className="btn ghost" disabled={editorSaving} onClick={() => setEditorOpen(false)}>
              {t("Cancel")}
            </button>
            <button type="button" className="btn primary" disabled={editorSaving || editorLoading} onClick={() => void saveEditor()}>
              {editorSaving ? t("Saving…") : t("Save proxy")}
            </button>
          </>
        }
      >
        {editorLoading ? (
          <p className="tools-hint" role="status">{t("Loading proxy details…")}</p>
        ) : (
          <div className="vault-modal-grid">
            {editorError && <div className="tools-alert full" role="alert">{editorError}</div>}
            <label className="fld">
              <span>{t("Name")}</span>
              <input
                type="text"
                value={editor.name}
                placeholder={t("e.g. US Residential #1")}
                onChange={(e) => setEditor((cur) => ({ ...cur, name: e.target.value }))}
              />
            </label>
            <label className="fld">
              <span>{t("Proxy group")}</span>
              <input
                type="text"
                value={editor.group}
                placeholder={t("Optional group")}
                onChange={(e) => setEditor((cur) => ({ ...cur, group: e.target.value }))}
              />
            </label>
            <label className="fld">
              <span>{t("Protocol")}</span>
              <select
                value={editor.type}
                onChange={(e) => setEditor((cur) => ({ ...cur, type: e.target.value as ProxyVaultProtocol }))}
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </label>
            <label className="fld">
              <span>{t("Port")}</span>
              <input
                type="text"
                inputMode="numeric"
                value={editor.port}
                placeholder="8080"
                onChange={(e) => setEditor((cur) => ({ ...cur, port: e.target.value.replace(/\D/g, "").slice(0, 5) }))}
              />
            </label>
            <label className="fld full">
              <span>{t("Host")}</span>
              <input
                type="text"
                value={editor.host}
                spellCheck={false}
                placeholder="proxy.example.com"
                onChange={(e) => setEditor((cur) => ({ ...cur, host: e.target.value }))}
              />
            </label>
            <label className="fld">
              <span>{t("Proxy user")}</span>
              <input
                type="text"
                value={editor.user}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setEditor((cur) => ({ ...cur, user: e.target.value }))}
              />
            </label>
            <label className="fld">
              <span>{t("Proxy pass")}</span>
              <input
                type="password"
                value={editor.pass}
                autoComplete="off"
                onChange={(e) => setEditor((cur) => ({ ...cur, pass: e.target.value }))}
              />
            </label>
            <label className="fld full">
              <span>{t("Dynamic IP refresh URL (optional)")}</span>
              <input
                type="url"
                value={editor.refreshUrl}
                spellCheck={false}
                autoComplete="off"
                placeholder="https://provider.example/rotate?token=…"
                onChange={(e) => setEditor((cur) => ({ ...cur, refreshUrl: e.target.value }))}
              />
              <small>{t("Stored encrypted. Only triggered when you explicitly click Refresh IP; private/loopback targets are blocked.")}</small>
            </label>
            <label className="fld full">
              <span>{t("Notes")}</span>
              <textarea
                rows={2}
                value={editor.notes}
                maxLength={2000}
                onChange={(e) => setEditor((cur) => ({ ...cur, notes: e.target.value }))}
              />
            </label>
          </div>
        )}
      </ModalDialog>

      {/* Batch Import Modal */}
      <ModalDialog
        open={importOpen}
        onClose={() => { if (!importBusy) setImportOpen(false); }}
        title={t("Batch import proxies to vault")}
        size="lg"
        busy={!!importBusy}
        footer={
          <>
            <button type="button" className="btn ghost" disabled={!!importBusy} onClick={() => setImportOpen(false)}>
              {t("Cancel")}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!!importBusy || !importText.trim()}
              onClick={() => void runImportPreview()}
            >
              {importBusy === "preview" ? t("Previewing…") : t("Preview import")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!!importBusy || !importPreview || importPreview.valid === 0}
              onClick={() => void runImportApply()}
            >
              {importBusy === "apply"
                ? t("Importing…")
                : t("Import {count} valid proxies", { count: importPreview?.valid ?? 0 })}
            </button>
          </>
        }
      >
        <div className="vault-modal-grid">
          {importError && <div className="tools-alert full" role="alert">{importError}</div>}
          <label className="fld">
            <span>{t("Default proxy group")}</span>
            <input
              type="text"
              value={importGroup}
              placeholder={t("Optional group for imported rows")}
              onChange={(e) => { setImportGroup(e.target.value); setImportPreview(null); }}
            />
          </label>
          <label className="fld">
            <span>{t("Duplicate handling")}</span>
            <select
              value={importStrategy}
              onChange={(e) => { setImportStrategy(e.target.value as ProxyVaultImportStrategy); setImportPreview(null); }}
            >
              <option value="skip_duplicates">{t("Skip existing duplicates")}</option>
              <option value="update_existing">{t("Update existing matching entries")}</option>
            </select>
          </label>
          <label className="fld full">
            <span>{t("Proxy list or CSV (up to 2,000 lines)")}</span>
            <textarea
              rows={6}
              spellCheck={false}
              autoComplete="off"
              value={importText}
              placeholder={"socks5://user:pass@proxy.example.com:1080\nname,group,type,host,port,user,pass,refreshUrl,notes"}
              onChange={(e) => { setImportText(e.target.value); setImportPreview(null); }}
            />
          </label>
          {importPreview && (
            <div className="full">
              <div className="tools-stats">
                <div><strong>{importPreview.newCount}</strong><span>{t("New")}</span></div>
                <div><strong>{importPreview.duplicateCount}</strong><span>{t("Duplicates")}</span></div>
                <div><strong>{importPreview.invalidCount}</strong><span>{t("Invalid")}</span></div>
                <div><strong>{importPreview.total}</strong><span>{t("Total lines")}</span></div>
              </div>
              {importPreview.rows.length > 0 && (
                <div className="vault-import-scroll">
                  <table className="vault-import-preview-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>{t("Status")}</th>
                        <th>{t("Endpoint")}</th>
                        <th>{t("Group")}</th>
                        <th>{t("Details")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.slice(0, 100).map((row) => (
                        <tr key={`${row.line}-${row.host ?? ""}`}>
                          <td>{row.line}</td>
                          <td><span className={`tools-status ${row.status === "new" ? "working" : row.status === "duplicate" ? "skipped" : "invalid"}`}>{t(row.status === "new" ? "New" : row.status === "duplicate" ? "Duplicate" : "Invalid")}</span></td>
                          <td className="tools-mono">{row.type && row.host && row.port ? `${row.type}://${row.host}:${row.port}` : "—"}</td>
                          <td>{row.group || "—"}</td>
                          <td>{row.reason || (row.hasAuth ? t("With auth") : "—")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </ModalDialog>

      {/* Bind to Environments Modal */}
      <ModalDialog
        open={bindOpen}
        onClose={() => { if (!bindBusy) setBindOpen(false); }}
        title={t("Bind vault proxies to environments")}
        size="lg"
        busy={bindBusy}
        footer={
          <>
            <button type="button" className="btn ghost" disabled={bindBusy} onClick={() => setBindOpen(false)}>
              {t("Cancel")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={bindBusy || bindProfileIds.size === 0 || (bindRisk.level !== "none" && !bindRiskConfirmed)}
              onClick={() => void submitBind()}
            >
              {bindBusy ? t("Binding…") : t("Bind to {count} environments", { count: bindProfileIds.size })}
            </button>
          </>
        }
      >
        <div className="vault-modal-grid">
          {bindError && <div className="tools-alert full" role="alert">{bindError}</div>}
          <label className="fld">
            <span>{t("Distribution mode")}</span>
            <select
              value={bindMode}
              onChange={(e) => { setBindMode(e.target.value as ProxyVaultBindMode); setBindRiskConfirmed(false); }}
            >
              <option value="single">{t("Single proxy for all selected environments")}</option>
              <option value="round_robin">{t("Round-robin across selected proxies")}</option>
            </select>
          </label>
          {bindMode === "round_robin" && (
            <label className="fld">
              <span>{t("Profiles per proxy")}</span>
              <input
                type="number"
                min={1}
                step={1}
                value={bindPerProxy}
                onChange={(e) => { setBindPerProxy(e.target.value); setBindRiskConfirmed(false); }}
              />
            </label>
          )}
          <div className="full">
            <label className="fld">
              <span>{t("Target environments ({count} selected)", { count: bindProfileIds.size })}</span>
              <input
                type="search"
                value={bindProfileSearch}
                placeholder={t("Search environments by name, folder, or platform…")}
                onChange={(e) => setBindProfileSearch(e.target.value)}
              />
            </label>
            <div className="vault-bind-profiles">
              {filteredBindProfiles.length === 0 ? (
                <p className="tools-hint" style={{ padding: "12px" }}>{t("No environments match your search.")}</p>
              ) : (
                filteredBindProfiles.map((profile) => {
                  const checked = bindProfileIds.has(profile.id);
                  return (
                    <label key={profile.id} className="vault-bind-profile-row">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setBindProfileIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(profile.id)) next.delete(profile.id);
                            else next.add(profile.id);
                            return next;
                          });
                          setBindRiskConfirmed(false);
                        }}
                      />
                      <span>{profile.name || profile.id}</span>
                      <span className="vault-bind-profile-meta">
                        {profile.platform && <span>{profile.platform}</span>}
                        {profile.group && <span>{profile.group}</span>}
                        {profile.running && <span>{t("Running (skipped)")}</span>}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </div>

          {bindRisk.level !== "none" && (
            <div className={`vault-risk-confirm-box full${bindRisk.level === "high" ? " high" : ""}`} role="alert">
              <strong>
                {bindRisk.level === "high"
                  ? t("High anti-association risk detected")
                  : t("Shared proxy risk notice")}
              </strong>
              <ul>
                {bindRisk.reasons.map((reason) => (
                  <li key={reason}>{t(reason)}</li>
                ))}
              </ul>
              <label className="proxy-choice">
                <input
                  type="checkbox"
                  checked={bindRiskConfirmed}
                  onChange={(e) => setBindRiskConfirmed(e.target.checked)}
                />
                {t("I understand the association risk and want to bind anyway")}
              </label>
            </div>
          )}
        </div>
      </ModalDialog>

      <ConfirmDialog
        open={!!deleteTarget}
        title={t("Delete vault proxies")}
        message={t("Remove {target} from the proxy vault? Existing environment proxy settings are not deleted, only unlinked.", {
          target: deleteTarget?.label ?? "",
        })}
        confirmLabel={t("Delete")}
        cancelLabel={t("Cancel")}
        tone="danger"
        busy={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => { if (!deleteBusy) setDeleteTarget(null); }}
      />
    </div>
  );
}

/** Lightweight picker modal for selecting vault proxies directly from the Replace proxies tab. */
export function ProxyVaultPickerModal({
  open,
  onClose,
  onInsertEndpoints,
}: {
  open: boolean;
  onClose: () => void;
  onInsertEndpoints: (lines: string) => void;
}) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ProxyVaultEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPicked(new Set());
    void fetchProxyVault({}, controller.signal)
      .then((res) => { if (!controller.signal.aborted) setEntries(res.entries); })
      .catch((err) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : t("Could not load proxy vault.")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, t]);

  const confirmPick = () => {
    const chosen = entries.filter((entry) => picked.has(entry.id));
    if (!chosen.length) return;
    onInsertEndpoints(chosen.map((entry) => formatVaultEndpoint(entry)).join("\n"));
    onClose();
  };

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title={t("Pick from proxy vault")}
      size="md"
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>{t("Cancel")}</button>
          <button type="button" className="btn primary" disabled={picked.size === 0} onClick={confirmPick}>
            {t("Insert {count} proxies", { count: picked.size })}
          </button>
        </>
      }
    >
      {error && <div className="tools-alert" role="alert">{error}</div>}
      {loading ? (
        <p className="tools-hint" role="status">{t("Loading proxy vault…")}</p>
      ) : entries.length === 0 ? (
        <p className="tools-hint">{t("No proxies saved in the vault yet.")}</p>
      ) : (
        <div className="vault-bind-profiles">
          {entries.map((entry) => (
            <label key={entry.id} className="vault-bind-profile-row">
              <input
                type="checkbox"
                checked={picked.has(entry.id)}
                onChange={() =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (next.has(entry.id)) next.delete(entry.id);
                    else next.add(entry.id);
                    return next;
                  })
                }
              />
              <span>
                <strong>{entry.name || `${entry.host}:${entry.port}`}</strong>{" "}
                <span className="tools-mono">{formatVaultEndpoint(entry)}</span>
              </span>
              <span className="vault-bind-profile-meta">
                {entry.lastLatencyMs !== null && <span>{entry.lastLatencyMs} ms</span>}
                {entry.riskLevel !== "none" && (
                  <span className={`vault-risk-badge ${entry.riskLevel}`}>
                    {entry.riskLevel === "high" ? t("High risk") : t("Medium risk")}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}
      <p className="tools-hint" style={{ marginTop: "8px" }}>
        {t("Note: inserting addresses uses desensitized endpoints. To apply stored credentials directly, bind from the Proxy vault tab.")}
      </p>
    </ModalDialog>
  );
}
