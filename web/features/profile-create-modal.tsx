import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { checkProxy, createProfile, ProxyCheckError, type AppModeConfig, type ProxyCheckInput, type UiProfile } from "../api.ts";
import { useDesktopCloseDraft } from "../desktop-close.tsx";
import { MotionPresence } from "../desktop-motion.tsx";
import { EditorWindowControls } from "../editor-window-controls.tsx";
import { useTranslation } from "../i18n.tsx";
import type { LocalProxyDraftCandidate } from "../settings-center.tsx";
import { profileCreationRuntime, type FormChromiumRuntime } from "../profile-creation-runtime.ts";
import { ProfileEditorStatus } from "../profile-editor-status.tsx";
import { fetchReusableProfile, type ReusableProfileSettings } from "../profile-reuse-api.ts";
import { ProfileTemplates } from "../profile-templates.tsx";
import { parsePastedProxy } from "../proxy-input.ts";
import { AppIcon } from "../ui-primitives.tsx";
import { useUnsavedChangesGuard } from "../unsaved-changes-guard.tsx";
import type { useWindowChrome } from "../window-chrome.tsx";
import { ProfileEditorLayout, ProfileEditorPreviewCard, ProfileEditorSection } from "./profile-editor-layout.tsx";
import {
  BLANK_FORM,
  browserLabel,
  CLOAKBROWSER_NOTE,
  editorFieldAttributes,
  EMPTY_PROXY_CHECK,
  FingerprintSettings,
  focusEditorTarget,
  GroupPicker,
  MAX_CUSTOM_NO,
  PlatformPicker,
  ProxyCheckFeedback,
  useProfileEditorFocus,
  type CreateProfileForm,
  type EditorFieldFeedback,
  type ProxyCheckUiState,
} from "./profile-form-helpers.tsx";

const Icon = AppIcon;

export interface ReuseRequestState {
  id: string;
  name: string;
  status: "loading" | "failed";
  error?: string;
}

export interface UseProfileCreateModalOptions {
  appMode: AppModeConfig | null;
  group: string;
  profiles: UiProfile[];
  editorScroll: ScrollBehavior;
  isEditSessionOpen: () => boolean;
  onCreated: (createdGroup: string) => Promise<void>;
  t: (source: string, values?: Record<string, string | number>) => string;
}

export function useProfileCreateModal({
  appMode,
  group,
  profiles,
  editorScroll,
  isEditSessionOpen,
  onCreated,
  t,
}: UseProfileCreateModalOptions) {
  const [showCreate, setShowCreate] = useState(false);
  const [createReuseSource, setCreateReuseSource] = useState<ReusableProfileSettings | null>(null);
  const [reuseRequest, setReuseRequest] = useState<ReuseRequestState | null>(null);
  const reuseGeneration = useRef(0);
  const reuseRead = useRef<{ id: string; generation: number; controller: AbortController } | null>(null);
  const reuseCanOpenRef = useRef(false);
  const [createProxyOpen, setCreateProxyOpen] = useState(false);
  const [createProxySource, setCreateProxySource] = useState<LocalProxyDraftCandidate | null>(null);
  const [creating, setCreating] = useState(false);
  const createInFlight = useRef(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [form, setForm] = useState<CreateProfileForm>(BLANK_FORM);
  const initialCreateForm = useRef<CreateProfileForm>(BLANK_FORM);
  const [createProxyCheck, setCreateProxyCheck] = useState<ProxyCheckUiState>(EMPTY_PROXY_CHECK);
  const createProxyCheckGeneration = useRef(0);
  const [proxyPaste, setProxyPaste] = useState("");
  const [proxyPasteOk, setProxyPasteOk] = useState<string | null>(null);
  const [proxyPasteInvalid, setProxyPasteInvalid] = useState(false);
  const createReturnFocus = useRef<HTMLElement | null>(null);
  const createEditorRef = useProfileEditorFocus(showCreate, true, createReturnFocus);
  const createCloseGuard = useUnsavedChangesGuard({ label: "New Profile", returnFocus: () => createEditorRef.current });

  const createRuntimeInput = profileCreationRuntime(form.engine, form.chromiumRuntime, appMode?.chromiumRuntime);
  const createRuntimeLabel = createRuntimeInput ?? appMode?.defaultChromiumRuntime;
  const createFingerprintRuntime = createRuntimeLabel === "cloakbrowser" ? "" : createRuntimeLabel;

  const createHasProxy = !!(form.host.trim() || form.port.trim() || form.user.trim() || form.pass);
  const createProxyIssue = proxyPaste.trim()
    ? {
        field: "proxyPaste",
        message: proxyPasteInvalid
          ? "This proxy could not be filled in. Check the format and try again."
          : "Use Autofill to apply the pasted proxy, or clear it before creating this environment.",
      }
    : createHasProxy && !form.host.trim()
      ? { field: "host", message: "Enter the proxy host, or clear the proxy fields to create without a profile proxy." }
      : null;

  const createProxyFeedback = (field: string): EditorFieldFeedback => ({
    field,
    invalid: createProxyIssue?.field === field,
    describedBy: "profile-create-validation-error",
  });

  const locateCreateProblem = () => {
    const editor = createEditorRef.current;
    if (!editor) return;
    if (createProxyIssue) setCreateProxyOpen(true);
    const invalidField = editor.querySelector<HTMLElement>('[data-profile-field][aria-invalid="true"]');
    focusEditorTarget(invalidField ?? editor.querySelector<HTMLElement>(".profile-create-error"), editorScroll);
  };

  const createProxyHost = form.host.trim();
  const createProxyEndpoint = form.port
    ? `${createProxyHost.includes(":") && !createProxyHost.startsWith("[") ? `[${createProxyHost}]` : createProxyHost}:${form.port}`
    : createProxyHost;

  useEffect(() => () => {
    reuseGeneration.current++;
    reuseRead.current?.controller.abort();
    reuseRead.current = null;
  }, []);

  const resetCreateProxyCheck = () => {
    createProxyCheckGeneration.current++;
    setCreateProxyCheck(EMPTY_PROXY_CHECK);
  };

  const setF = (k: keyof CreateProfileForm, v: string) => {
    if (createInFlight.current) return;
    if (k === "proxyType" || k === "host" || k === "port" || k === "user" || k === "pass") {
      resetCreateProxyCheck();
    }
    if (k === "proxyType" || k === "host" || k === "port") setCreateProxySource(null);
    setForm((f) => ({ ...f, [k]: v }));
  };

  function cancelReuseRead() {
    reuseGeneration.current++;
    reuseRead.current?.controller.abort();
    reuseRead.current = null;
    setReuseRequest(null);
  }

  const syncReuseCanOpen = (canOpen: boolean) => {
    reuseCanOpenRef.current = canOpen;
  };

  const beginCreate = (proxy?: LocalProxyDraftCandidate, trigger?: HTMLButtonElement, reuse?: ReusableProfileSettings, initialGroup?: string) => {
    if (showCreate || createInFlight.current || isEditSessionOpen()) return false;
    createCloseGuard.reset();
    cancelReuseRead();
    createReturnFocus.current = trigger ?? null;
    resetCreateProxyCheck();
    const draft: typeof BLANK_FORM = {
      ...BLANK_FORM,
      engine: appMode?.defaultEngine ?? "chromium",
      chromiumRuntime: appMode?.defaultChromiumRuntime ?? "",
      group: initialGroup !== undefined ? initialGroup : group !== "all" ? group : "",
    };
    if (reuse) {
      Object.assign(draft, {
        name: t("{name} copy", { name: reuse.name || reuse.sourceId }),
        group: reuse.group,
        engine: reuse.engine,
        chromiumRuntime: reuse.engine === "chromium" && reuse.chromiumRuntime === "aliasmode" ? "aliasmode" : "",
        platformOs: reuse.platformOs,
        screen: reuse.screen,
        platform: reuse.platform,
      });
    } else if (proxy) {
      Object.assign(draft, { proxyType: proxy.type, host: proxy.host, port: String(proxy.port) });
    }
    initialCreateForm.current = draft;
    setForm(draft);
    setCreateReuseSource(reuse ?? null);
    setCreateProxySource(reuse ? null : proxy ?? null);
    setProxyPaste("");
    setProxyPasteOk(null);
    setProxyPasteInvalid(false);
    setCreateErr(null);
    // A first profile needs no proxy, so the section starts closed until profiles use one.
    setCreateProxyOpen(reuse ? false : !!proxy || profiles.some((profile) => !!profile.proxy));
    setShowCreate(true);
    return true;
  };

  const reuseProfileConfiguration = async (id: string, name: string) => {
    if (!reuseCanOpenRef.current || createInFlight.current || isEditSessionOpen() || reuseRead.current?.id === id) return;
    cancelReuseRead();
    const request = { id, generation: ++reuseGeneration.current, controller: new AbortController() };
    reuseRead.current = request;
    setReuseRequest({ id, name, status: "loading" });
    const owns = () => reuseRead.current === request && request.generation === reuseGeneration.current && !request.controller.signal.aborted;
    try {
      const source = await fetchReusableProfile(id, request.controller.signal);
      if (!owns() || !reuseCanOpenRef.current || createInFlight.current || isEditSessionOpen()) return;
      const row = [...document.querySelectorAll<HTMLTableRowElement>("tr[data-profile-id]")].find((item) => item.dataset.profileId === id);
      const trigger =
        row?.querySelector<HTMLButtonElement>(".profile-menu-trigger") ??
        document.querySelector<HTMLButtonElement>(".profiles-workspace .page-actions .btn.primary") ??
        undefined;
      beginCreate(undefined, trigger, source);
    } catch (error) {
      if (owns() && reuseCanOpenRef.current) {
        setReuseRequest({ id, name, status: "failed", error: error instanceof Error ? error.message : "The source configuration could not be loaded." });
      }
    } finally {
      if (owns()) {
        reuseRead.current = null;
        setReuseRequest((current) => (current?.status === "loading" ? null : current));
      }
    }
  };

  const openCreate = () => beginCreate();

  const finishCloseCreate = () => {
    if (createInFlight.current) return;
    cancelReuseRead();
    resetCreateProxyCheck();
    setShowCreate(false);
    setCreateProxySource(null);
    setCreateReuseSource(null);
    setForm(BLANK_FORM);
    setProxyPaste("");
    setProxyPasteOk(null);
    setProxyPasteInvalid(false);
    setCreateErr(null);
  };

  const closeCreate = () => {
    if (createInFlight.current || !showCreate) return;
    const dirty = (Object.keys(BLANK_FORM) as Array<keyof typeof BLANK_FORM>).some((key) => form[key] !== initialCreateForm.current[key]) || !!proxyPaste;
    createCloseGuard.requestClose({ dirty, onDiscard: finishCloseCreate });
  };

  const applyProxyPaste = (raw: string) => {
    if (!raw.trim()) return;
    try {
      const parsed = parsePastedProxy(raw, form.proxyType === "socks5" ? "socks5" : "http");
      resetCreateProxyCheck();
      setCreateProxySource(null);
      setForm((current) => ({
        ...current,
        proxyType: parsed.type,
        host: parsed.host,
        port: parsed.port,
        user: parsed.user,
        pass: parsed.pass,
      }));
      setProxyPaste("");
      setProxyPasteInvalid(false);
      setProxyPasteOk(`✓ ${parsed.type.toUpperCase()} proxy fields filled`);
      setCreateErr(null);
    } catch {
      setProxyPasteOk(null);
      setProxyPaste(raw);
      setProxyPasteInvalid(true);
    }
  };

  const checkCreateProxy = async () => {
    const generation = ++createProxyCheckGeneration.current;
    if (form.proxyType === "https") {
      setCreateProxyCheck({ checking: false, result: null, error: "unavailable" });
      return;
    }
    setCreateProxyCheck({ checking: true, result: null, error: null });
    const proxy: ProxyCheckInput = {
      type: form.proxyType,
      host: form.host,
      port: form.port,
      user: form.user,
      pass: form.pass,
    };
    try {
      const result = await checkProxy(proxy);
      if (generation === createProxyCheckGeneration.current) {
        setCreateProxyCheck({ checking: false, result, error: null });
      }
    } catch (error) {
      if (generation === createProxyCheckGeneration.current) {
        setCreateProxyCheck({
          checking: false,
          result: null,
          error: error instanceof ProxyCheckError ? error.kind : "unavailable",
        });
      }
    }
  };

  const submitCreate = async () => {
    if (createInFlight.current || createProxyIssue) return;
    createInFlight.current = true;
    setCreating(true);
    setCreateErr(null);
    try {
      const r = await createProfile({
        name: form.name,
        engine: form.engine,
        ...(createRuntimeInput ? { chromiumRuntime: createRuntimeInput } : {}),
        group: form.group,
        platform: form.platform,
        screen: form.screen,
        ...(form.platformOs ? { platformOs: form.platformOs } : {}),
        ...({ customNo: form.customNo }),
        username: form.username,
        password: form.password,
        email: form.email,
        emailPassword: form.emailPassword,
        twofa: form.twofa,
        proxy: form.host.trim() ? { type: form.proxyType, host: form.host, port: form.port, user: form.user, pass: form.pass } : null,
      });
      if (r.ok) {
        await onCreated(form.group);
        createInFlight.current = false;
        finishCloseCreate();
      } else {
        setCreateErr(r.error || "create failed"); // shown inside the modal
      }
    } catch (e) {
      setCreateErr(String(e));
    } finally {
      createInFlight.current = false;
      setCreating(false);
    }
  };

  useDesktopCloseDraft("profile-create", {
    dirty: showCreate && ((Object.keys(BLANK_FORM) as Array<keyof typeof BLANK_FORM>).some((key) => form[key] !== initialCreateForm.current[key]) || !!proxyPaste),
    busy: creating,
  });

  return {
    showCreate,
    form,
    setForm,
    creating,
    createErr,
    setCreateErr,
    createReuseSource,
    reuseRequest,
    createProxyOpen,
    setCreateProxyOpen,
    createProxySource,
    createProxyCheck,
    createHasProxy,
    createProxyIssue,
    createProxyEndpoint,
    createFingerprintRuntime,
    proxyPaste,
    setProxyPaste,
    proxyPasteOk,
    setProxyPasteOk,
    setProxyPasteInvalid,
    createEditorRef,
    createCloseGuard,
    createProxyFeedback,
    locateCreateProblem,
    setF,
    beginCreate,
    openCreate,
    closeCreate,
    finishCloseCreate,
    applyProxyPaste,
    checkCreateProxy,
    submitCreate,
    cancelReuseRead,
    reuseProfileConfiguration,
    syncReuseCanOpen,
  };
}

export type ProfileCreateController = ReturnType<typeof useProfileCreateModal>;

export function useSyncReuseCanOpen(controller: ProfileCreateController, reuseCanOpen: boolean) {
  controller.syncReuseCanOpen(reuseCanOpen);
  useLayoutEffect(() => {
    if (!reuseCanOpen) controller.cancelReuseRead();
  }, [reuseCanOpen]);
}

export function ReuseRequestBanner({
  request,
  onRetry,
  onCancel,
}: {
  request: ReuseRequestState | null;
  onRetry: (id: string, name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  if (!request) return null;
  return (
    <div
      className={`update-banner update-result${request.status === "failed" ? " warning" : ""}`}
      role={request.status === "failed" ? "alert" : "status"}
      aria-busy={request.status === "loading"}
    >
      <Icon name={request.status === "loading" ? "copy" : "alert"} className="sm" />
      <span>
        {request.status === "loading"
          ? t("Preparing a new draft from {profile}…", { profile: request.name || request.id })
          : t(request.error || "The source configuration could not be loaded.")}
      </span>
      {request.status === "failed" && (
        <button type="button" className="btn xs" onClick={() => onRetry(request.id, request.name)}>
          {t("Retry")}
        </button>
      )}
      <button type="button" className="btn xs ghost" onClick={onCancel}>
        {t(request.status === "loading" ? "Cancel" : "Dismiss")}
      </button>
    </div>
  );
}

export function ProfileCreateModal({
  controller,
  appMode,
  existingGroups,
  windowChrome,
  editorScroll,
}: {
  controller: ProfileCreateController;
  appMode: AppModeConfig | null;
  existingGroups: string[];
  windowChrome: ReturnType<typeof useWindowChrome>;
  editorScroll: ScrollBehavior;
}) {
  const { t } = useTranslation();
  const {
    showCreate,
    form,
    setForm,
    creating,
    createErr,
    setCreateErr,
    createReuseSource,
    createProxyOpen,
    setCreateProxyOpen,
    createProxySource,
    createProxyCheck,
    createHasProxy,
    createProxyIssue,
    createProxyEndpoint,
    createFingerprintRuntime,
    proxyPaste,
    setProxyPaste,
    proxyPasteOk,
    setProxyPasteOk,
    setProxyPasteInvalid,
    createEditorRef,
    createCloseGuard,
    createProxyFeedback,
    locateCreateProblem,
    setF,
    closeCreate,
    applyProxyPaste,
    checkCreateProxy,
    submitCreate,
  } = controller;

  return (
    <>
      {createCloseGuard.dialog}
      <MotionPresence present={showCreate}>{() => (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop profile-editor-backdrop">
          <div
            ref={createEditorRef}
            inert={createCloseGuard.pending || undefined}
            aria-hidden={createCloseGuard.pending || undefined}
            tabIndex={-1}
            className="modal profile-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-profile-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <Icon name="plus" /><span id="create-profile-title">{t("New profile")}</span>
              <EditorWindowControls chrome={windowChrome} disabled={creating} />
              <button type="button" className="modal-close" aria-label={t("Close")} disabled={creating} onClick={closeCreate}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body" aria-busy={creating}>
              <fieldset className="profile-create-fields" disabled={creating}>
                {createErr && <div className="modal-err profile-create-error" role="alert" tabIndex={-1}><Icon name="alert" className="sm" />{t(createErr)}</div>}
                {createReuseSource && (
                  <div
                    className={`update-banner update-result${createReuseSource.engine === "chromium" && form.engine === "chromium" && appMode?.chromiumRuntime && createReuseSource.chromiumRuntime !== appMode.chromiumRuntime ? " warning" : ""}`}
                    role="note"
                    aria-label={t("Reused configuration")}
                  >
                    <Icon name="copy" className="sm" />
                    <div className="update-copy">
                      <strong>{t("Configuration from {profile}", { profile: createReuseSource.name || createReuseSource.sourceId })}</strong>
                      <span>{t("Only setup was reused. Account details, proxy settings, cookies and the original fingerprint identity were not copied.")}</span>
                      <span>{t("Review this draft before creating. The new environment follows normal identity generation and starts without the source session.")}</span>
                      {createReuseSource.engine === "chromium" && form.engine === "chromium" && appMode?.chromiumRuntime && createReuseSource.chromiumRuntime !== appMode.chromiumRuntime && (
                        <span>{t("This computer requires {runtime}. The source uses {source}; the new environment will use {runtime}.", { runtime: "AliasMode Chromium", source: "CloakBrowser" })}</span>
                      )}
                    </div>
                  </div>
                )}
                <ProfileEditorLayout
                  label={t("Environment sections")}
                  sections={[
                    { id: "basic", label: t("Basic information"), icon: "profiles" },
                    { id: "proxy", label: t("Network & proxy"), icon: "activity" },
                    { id: "fingerprint", label: t("Fingerprint settings"), icon: "fingerprint" },
                  ]}
                  scrollBehavior={editorScroll}
                  preview={
                    <ProfileEditorPreviewCard
                      title={t("Live summary")}
                      heading={form.name.trim() || t("New profile")}
                      subheading={form.group.trim() || t("Ungrouped")}
                      badgeText={form.customNo.trim() ? `#${form.customNo.trim()}` : t("Automatic")}
                      avatarText={form.name.trim() || "MB"}
                      statusLabel={createProxyIssue || createErr ? t("Needs attention") : t("Ready")}
                      statusTone={createProxyIssue || createErr ? "warn" : "success"}
                      items={[
                        {
                          key: "browser",
                          label: t("Browser"),
                          value: browserLabel(form.engine, createFingerprintRuntime),
                        },
                        {
                          key: "platform",
                          label: t("Platform"),
                          value: form.platform.trim() || t("Not set"),
                          muted: !form.platform.trim(),
                        },
                        {
                          key: "proxy",
                          label: t("Proxy"),
                          value: createHasProxy
                            ? `${form.proxyType} · ${createProxyEndpoint}`
                            : t("Direct connection"),
                          muted: !createHasProxy,
                          mono: createHasProxy,
                        },
                        {
                          key: "os",
                          label: t("Operating system"),
                          value: form.platformOs || t("Automatic"),
                          muted: !form.platformOs,
                        },
                        {
                          key: "screen",
                          label: t("Screen"),
                          value: form.screen.trim() || t("Automatic"),
                          muted: !form.screen.trim(),
                          mono: !!form.screen.trim(),
                        },
                      ]}
                    />
                  }
                >
                  <ProfileEditorSection sectionId="basic">
                    <ProfileTemplates
                      disabled={creating}
                      draft={{
                        engine: form.engine,
                        chromiumRuntime: profileCreationRuntime(form.engine, form.chromiumRuntime) ?? "",
                        platformOs: form.platformOs as "" | "windows" | "macos" | "linux",
                        screen: form.screen,
                        platform: form.platform,
                      }}
                      onApply={(settings) => {
                        if (settings.engine === "chromium" && appMode?.chromiumRuntime && settings.chromiumRuntime && settings.chromiumRuntime !== appMode.chromiumRuntime)
                          throw new Error("This template uses a browser runtime that is unavailable on this computer.");
                        setForm((previous) => ({
                          ...previous,
                          engine: settings.engine,
                          chromiumRuntime: settings.engine === "firefox" || settings.chromiumRuntime === "cloakbrowser" ? "" : settings.chromiumRuntime || "auto",
                          platformOs: settings.platformOs,
                          screen: settings.screen,
                          platform: settings.platform,
                        }));
                        setCreateErr(null);
                      }}
                    />
                    <div className="fld-row">
                      <label className="fld grow">
                        <span>{t("Name")}</span>
                        <input value={form.name} placeholder={t("auto if blank")} onChange={(e) => setF("name", e.target.value)} />
                      </label>
                      <label className="fld no">
                        <span>{t("Custom NO.")}</span>
                        <input
                          value={form.customNo}
                          inputMode="numeric"
                          maxLength={MAX_CUSTOM_NO}
                          placeholder={t("Automatic")}
                          onChange={(e) => setF("customNo", e.target.value.replace(/\D/g, "").slice(0, MAX_CUSTOM_NO))}
                        />
                      </label>
                    </div>
                    <div className="fld-row">
                      <label className="fld grow">
                        <span>{t("Folder")}</span>
                        <GroupPicker value={form.group} onChange={(v) => setF("group", v)} groups={existingGroups} allowCreate />
                      </label>
                      <label className="fld grow">
                        <span>{t("Platform")}</span>
                        <PlatformPicker value={form.platform} onChange={(v) => setF("platform", v)} />
                      </label>
                    </div>
                    <div className="browser-options" role="radiogroup" aria-label={t("Browser")}>
                      {([
                        {
                          engine: "chromium", label: "Chrome",
                          path: "M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728Z",
                        },
                        {
                          engine: "firefox", label: "Firefox",
                          path: "M8.824 7.287c.008 0 .004 0 0 0zm-2.8-1.4c.006 0 .003 0 0 0zm16.754 2.161c-.505-1.215-1.53-2.528-2.333-2.943.654 1.283 1.033 2.57 1.177 3.53l.002.02c-1.314-3.278-3.544-4.6-5.366-7.477-.091-.147-.184-.292-.273-.446a3.545 3.545 0 01-.13-.24 2.118 2.118 0 01-.172-.46.03.03 0 00-.027-.03.038.038 0 00-.021 0l-.006.001a.037.037 0 00-.01.005L15.624 0c-2.585 1.515-3.657 4.168-3.932 5.856a6.197 6.197 0 00-2.305.587.297.297 0 00-.147.37c.057.162.24.24.396.17a5.622 5.622 0 012.008-.523l.067-.005a5.847 5.847 0 011.957.222l.095.03a5.816 5.816 0 01.616.228c.08.036.16.073.238.112l.107.055a5.835 5.835 0 01.368.211 5.953 5.953 0 012.034 2.104c-.62-.437-1.733-.868-2.803-.681 4.183 2.09 3.06 9.292-2.737 9.02a5.164 5.164 0 01-1.513-.292 4.42 4.42 0 01-.538-.232c-1.42-.735-2.593-2.121-2.74-3.806 0 0 .537-2 3.845-2 .357 0 1.38-.998 1.398-1.287-.005-.095-2.029-.9-2.817-1.677-.422-.416-.622-.616-.8-.767a3.47 3.47 0 00-.301-.227 5.388 5.388 0 01-.032-2.842c-1.195.544-2.124 1.403-2.8 2.163h-.006c-.46-.584-.428-2.51-.402-2.913-.006-.025-.343.176-.389.206-.406.29-.787.616-1.136.974-.397.403-.76.839-1.085 1.303a9.816 9.816 0 00-1.562 3.52c-.003.013-.11.487-.19 1.073-.013.09-.026.181-.037.272a7.8 7.8 0 00-.069.667l-.002.034-.023.387-.001.06C.386 18.795 5.593 24 12.016 24c5.752 0 10.527-4.176 11.463-9.661.02-.149.035-.298.052-.448.232-1.994-.025-4.09-.753-5.844z",
                        },
                      ] as const).map(({ engine, label, path }) => {
                        // The help text names the engine that this computer and this form create.
                        const selectedRuntime = profileCreationRuntime("chromium", form.chromiumRuntime, appMode?.chromiumRuntime) ?? appMode?.defaultChromiumRuntime;
                        const runtime = browserLabel(engine, selectedRuntime === "cloakbrowser" ? "" : selectedRuntime);
                        return (
                          <div className="browser-option" key={engine}>
                            <label className="browser-card">
                              <input type="radio" name="browser-engine" value={engine} checked={form.engine === engine} onChange={() => setF("engine", engine)} />
                              <svg className="browser-logo" viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>
                              <span>{label}</span>
                            </label>
                            <button type="button" className="browser-info tip" data-tip={runtime} aria-label={`${label}: ${runtime}`}><Icon name="help" className="sm" /></button>
                          </div>
                        );
                      })}
                    </div>
                    {form.engine === "chromium" && !appMode?.chromiumRuntime && (
                      <label className="fld">
                        <span>{t("Chrome version")}</span>
                        <select value={form.chromiumRuntime} onChange={(e) => setF("chromiumRuntime", e.target.value as FormChromiumRuntime)}>
                          <option value="auto">{t("Device default")}</option>
                          {appMode?.defaultChromiumRuntime
                            ? <><option value="aliasmode">{t("Chromium 155 (default)")}</option><option value="">{t("CloakBrowser 146")}</option></>
                            : <><option value="">{t("CloakBrowser 146 (default)")}</option><option value="aliasmode">{t("Chromium 155")}</option></>}
                        </select>
                        {form.chromiumRuntime !== "auto" && <small>{!form.chromiumRuntime
                          ? t(CLOAKBROWSER_NOTE)
                          : t("Downloads once (about 190 MB) on each computer that opens it.")}</small>}
                      </label>
                    )}
                  </ProfileEditorSection>
                  <ProfileEditorSection sectionId="proxy">
                    <details className="fingerprint-settings" open={createProxyOpen} onToggle={(event) => setCreateProxyOpen(event.currentTarget.open)}>
                      <summary>
                        <span>{t("Proxy")}</span>
                        <span className="profile-editor-proxy-summary">{createHasProxy ? createProxyEndpoint : t("Direct connection")}</span>
                      </summary>
                      <div className="proxy-settings">
                        {createProxySource && (
                          <p className="formnote local-proxy-draft-note" role="status">
                            {t(createProxySource.socks5AuthRequired
                              ? "SOCKS5 requires authentication. Enter credentials and verify the exit."
                              : createProxySource.evidence === "handshake"
                                ? "SOCKS5 handshake detected. Verify the exit before relying on it."
                                : "A local listener was found. Check the protocol and exit before relying on it.")}
                          </p>
                        )}
                        <div className="proxy-paste-row">
                          <label className="fld grow">
                            <span>{t("Paste proxy to autofill")} <span className="muted">{t("(select type first · host:port:username:password)")}</span></span>
                            <input
                              {...editorFieldAttributes(createProxyFeedback("proxyPaste"))}
                              type="password"
                              autoComplete="off"
                              value={proxyPaste}
                              placeholder={t("Paste here — credentials stay hidden")}
                              onChange={(e) => { setProxyPaste(e.target.value); setProxyPasteOk(null); setProxyPasteInvalid(false); }}
                              onPaste={(e) => {
                                const pasted = e.clipboardData.getData("text");
                                if (pasted) { e.preventDefault(); applyProxyPaste(pasted); }
                              }}
                              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyProxyPaste(proxyPaste); } }}
                            />
                          </label>
                          <button type="button" className="btn accent" disabled={!proxyPaste.trim()} onClick={() => applyProxyPaste(proxyPaste)}>{t("Autofill")}</button>
                        </div>
                        {proxyPasteOk && <div className="proxy-paste-ok"><Icon name="check" className="sm" />{proxyPasteOk}</div>}
                        <div className="fld-row">
                          <label className="fld type">
                            <span>{t("Proxy type")}</span>
                            <select value={form.proxyType} onChange={(e) => setF("proxyType", e.target.value)}>
                              <option value="http">http</option>
                              <option value="https">https</option>
                              <option value="socks5">socks5</option>
                            </select>
                          </label>
                          <label className="fld grow">
                            <span>{t("Host")}</span>
                            <input {...editorFieldAttributes(createProxyFeedback("host"))} value={form.host} placeholder={t("blank = no proxy")} onChange={(e) => setF("host", e.target.value)} />
                          </label>
                          <label className="fld port">
                            <span>{t("Port")}</span>
                            <input value={form.port} inputMode="numeric" placeholder="8080" onChange={(e) => setF("port", e.target.value)} />
                          </label>
                        </div>
                        <div className="fld-row">
                          <label className="fld grow"><span>{t("Proxy user")}</span><input value={form.user} onChange={(e) => setF("user", e.target.value)} /></label>
                          <label className="fld grow"><span>{t("Proxy pass")}</span><input type="password" value={form.pass} onChange={(e) => setF("pass", e.target.value)} /></label>
                        </div>
                        {createProxyIssue && <p id="profile-create-validation-error" className="modal-err">{t(createProxyIssue.message)}</p>}
                        <div className="proxy-check-actions">
                          <button type="button" className="btn proxy-check-btn" disabled={createProxyCheck.checking || !form.host.trim()} aria-busy={createProxyCheck.checking} onClick={checkCreateProxy}>
                            <Icon name="activity" className="sm" />
                            {createProxyCheck.checking ? t("Checking…") : t("Check proxy")}
                          </button>
                        </div>
                      </div>
                    </details>
                    <ProxyCheckFeedback hasProxy={createHasProxy} state={createProxyCheck} />
                  </ProfileEditorSection>
                  <ProfileEditorSection sectionId="fingerprint">
                    <FingerprintSettings engine={form.engine} chromiumRuntime={createFingerprintRuntime} screen={form.screen} onScreenChange={(value) => setF("screen", value)} platformOs={form.platformOs} onPlatformOsChange={(value) => setF("platformOs", value)} />
                  </ProfileEditorSection>
                </ProfileEditorLayout>
              </fieldset>
            </div>
            <div className="modal-foot profile-editor-status-footer">
              <ProfileEditorStatus
                kind="create"
                createSummary={{ browserLabel: browserLabel(form.engine, createFingerprintRuntime), hasProxy: !!form.host.trim(), manualFingerprint: !!(form.screen.trim() || form.platformOs) }}
                hasValidationError={!!createProxyIssue}
                hasSaveError={!!createErr}
                onLocateProblem={locateCreateProblem}
              />
              <button className="btn ghost" disabled={creating} onClick={closeCreate}>{t("Cancel")}</button>
              <button className="btn primary" disabled={creating || !!createProxyIssue} onClick={submitCreate}>{creating ? t("Creating…") : t("Create profile")}</button>
            </div>
          </div>
        </div>
      )}</MotionPresence>
    </>
  );
}
