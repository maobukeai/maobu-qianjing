import { useEffect, useMemo, useRef, useState } from "react";
import { localeTimezoneMismatch } from "../../profile-locale.ts";
import {
  checkProxy,
  clearProfileCache,
  convertMobileProfile,
  fetchProfileEdit,
  fetchTotp,
  ProxyCheckError,
  refreshProfileTimezone,
  updateProfile,
  type EditProfile,
  type Extension,
  type ProxyCheckInput,
  type UiProfile,
} from "../api.ts";
import {
  fetchProfileResourcePolicy,
  updateProfileResourcePolicy,
  type EffectiveProfileResourcePolicy,
  type ProfileResourcePolicyMode,
} from "../resource-monitor-api.ts";
import { useDesktopCloseDraft } from "../desktop-close.tsx";
import { MotionPresence } from "../desktop-motion.tsx";
import { EditChangesSummary } from "../edit-changes-summary.tsx";
import { EditorWindowControls } from "../editor-window-controls.tsx";
import type { InspectionEditField } from "../environment-inspection.tsx";
import { useTranslation } from "../i18n.tsx";
import {
  buildProfileEditPatch,
  captureProfileEditSnapshot,
  PROFILE_EDIT_FORM_FIELDS,
  ProfileEditPatchError,
  type ProfileEditSnapshot,
  type ProfileEditSummary,
} from "../profile-edit-patch.ts";
import { ProfileEditorStatus } from "../profile-editor-status.tsx";
import { parsePastedProxy } from "../proxy-input.ts";
import { AppIcon, type useConfirmDialog } from "../ui-primitives.tsx";
import { useUnsavedChangesGuard } from "../unsaved-changes-guard.tsx";
import type { useWindowChrome } from "../window-chrome.tsx";
import { CopyField, copyPlainText } from "./copy-field.tsx";
import { ProfileEditorLayout, ProfileEditorPreviewCard, ProfileEditorSection } from "./profile-editor-layout.tsx";
import {
  browserLabel,
  CLOAKBROWSER_NOTE,
  editorFieldAttributes,
  EMPTY_PROXY_CHECK,
  FINGERPRINT_EDIT_WARNING,
  FingerprintSettings,
  focusEditorTarget,
  GroupPicker,
  MAX_CUSTOM_NO,
  PlatformPicker,
  ProxyCheckFeedback,
  sameExtensionSelection,
  useProfileEditorFocus,
  validEditDetail,
  type EditorFieldFeedback,
  type ProxyCheckUiState,
} from "./profile-form-helpers.tsx";

const Icon = AppIcon;
const CONNECTION_TIMEZONE_SAVE_NOTE = "Saves the detected timezone and language now for the next launch. Unsaved edits stay in this editor.";

export interface UseProfileEditModalOptions {
  busy: Readonly<Record<string, boolean>>;
  profilesById: ReadonlyMap<string, UiProfile>;
  extensions: Extension[];
  editorScroll: ScrollBehavior;
  requestConfirm: ReturnType<typeof useConfirmDialog>["requestConfirm"];
  onLoadRoster: () => Promise<unknown>;
  onRefreshQualityAfterEdit: () => void;
  onFlash: (message: string) => void;
  onActionError: (message: string | null) => void;
  onCancelReuseRead: () => void;
  t: (source: string, values?: Record<string, string | number>) => string;
}

export function useProfileEditModal({
  busy,
  profilesById,
  extensions,
  editorScroll,
  requestConfirm,
  onLoadRoster,
  onRefreshQualityAfterEdit,
  onFlash,
  onActionError,
  onCancelReuseRead,
  t,
}: UseProfileEditModalOptions) {
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editSnapshot, setEditSnapshot] = useState<ProfileEditSnapshot | null>(null);
  const [editClearQuarantinedProxy, setEditClearQuarantinedProxy] = useState(false);
  const [editInitialFingerprint, setEditInitialFingerprint] = useState<Record<string, string>>({});
  const [editInitialProxy, setEditInitialProxy] = useState({ proxy: "", proxyType: "http" });
  const [editProxyCheck, setEditProxyCheck] = useState<ProxyCheckUiState>(EMPTY_PROXY_CHECK);
  const editProxyCheckGeneration = useRef(0);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const editSessionSequence = useRef(0);
  const editSessionRef = useRef<{ id: string; generation: number; loading: boolean; ready: boolean } | null>(null);
  const editSaveInFlight = useRef(false);
  const [editLoadedGeneration, setEditLoadedGeneration] = useState<number | null>(null);
  const editReady = editLoadedGeneration !== null && editSessionRef.current?.generation === editLoadedGeneration && editSessionRef.current.ready;

  useEffect(() => () => {
    editSessionRef.current = null;
    editSaveInFlight.current = false;
  }, []);

  const editReturnFocus = useRef<HTMLElement | null>(null);
  const editFieldOnOpen = useRef<InspectionEditField | null>(null);
  const editEditorRef = useProfileEditorFocus(!!editId, editReady, editReturnFocus, editFieldOnOpen);
  const editCloseGuard = useUnsavedChangesGuard({ label: "Edit profile", returnFocus: () => editEditorRef.current });

  // Null until the profile detail loads, so a failed load never names a browser.
  const [editEngine, setEditEngine] = useState<"chromium" | "firefox" | null>(null);
  const [editChromiumRuntime, setEditChromiumRuntime] = useState("");
  const [editHardware, setEditHardware] = useState<{ gpu?: string; cores?: number } | undefined>();
  const [timezoneBusy, setTimezoneBusy] = useState(false);
  const [editMobile, setEditMobile] = useState<NonNullable<EditProfile["desktopConversion"]> | null>(null);
  const [editTotp, setEditTotp] = useState<{ code: string; secs: number } | null>(null);
  const editTotpSecsRef = useRef<number | null>(null);
  const [editExts, setEditExts] = useState<string[]>([]);
  const [editInitialExts, setEditInitialExts] = useState<string[]>([]);

  const editProfileRow = editId ? profilesById.get(editId) : undefined;
  const editSerial = editProfileRow?.serial ?? null;
  const editRunning = editProfileRow?.running === true;

  const editReview = useMemo<{ summary: ProfileEditSummary | null; error: string | null; field: string | null }>(() => {
    if (!editReady || !editSnapshot) return { summary: null, error: null, field: null };
    try {
      return {
        summary: buildProfileEditPatch(editSnapshot, { form: editForm, extensions: editExts, clearQuarantinedProxy: editClearQuarantinedProxy }).summary,
        error: null,
        field: null,
      };
    } catch (error) {
      return {
        summary: null,
        error: error instanceof ProfileEditPatchError ? error.message : "Edited fields could not be validated. Reload this editor before saving.",
        field: error instanceof ProfileEditPatchError ? error.field : null,
      };
    }
  }, [editReady, editSnapshot, editForm, editExts, editClearQuarantinedProxy]);

  const editFieldFeedback = (field: string): EditorFieldFeedback => ({
    field,
    invalid: editReview.field === field,
    describedBy: "profile-edit-validation-error",
  });

  const locateEditProblem = () => {
    const editor = editEditorRef.current;
    if (!editor) return;
    const invalidField = editor.querySelector<HTMLElement>('[data-profile-field][aria-invalid="true"]');
    focusEditorTarget(invalidField ?? editor.querySelector<HTMLElement>("#profile-edit-validation-error, .profile-edit-save-error"), editorScroll);
  };

  const editHasProxy = !!(editForm.proxy ?? "").trim();
  const editProxyChanged =
    (editForm.proxy ?? "") !== editInitialProxy.proxy ||
    (editHasProxy && editForm.proxyType !== editInitialProxy.proxyType) ||
    editClearQuarantinedProxy;

  const installedExtensionIds = new Set(extensions.map((item) => item.id));
  const editExtensionChoices = [
    ...extensions.map((item) => ({ ...item, missing: false })),
    ...[...new Set([...editInitialExts, ...editExts])]
      .filter((id) => !installedExtensionIds.has(id))
      .map((id) => ({ id, name: id, missing: true })),
  ];

  // Live 2FA code in the Edit modal: fetch the current TOTP, count it down
  // locally, and refetch when the window rolls over.
  useEffect(() => {
    const session = editSessionRef.current;
    if (!editId || !editReady || !session?.ready) {
      editTotpSecsRef.current = null;
      setEditTotp(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetchTotp(editId);
        if (alive && editSessionRef.current === session) {
          if (r.code) {
            const secs = r.secondsRemaining ?? 30;
            editTotpSecsRef.current = secs;
            setEditTotp({ code: r.code, secs });
          } else {
            editTotpSecsRef.current = null;
            setEditTotp(null);
          }
        }
      } catch {
        if (alive && editSessionRef.current === session) {
          editTotpSecsRef.current = null;
          setEditTotp(null);
        }
      }
    };
    void tick();
    const timer = setInterval(() => {
      if (!alive || editSessionRef.current !== session) return;
      const secs = editTotpSecsRef.current;
      if (secs === null) return;
      if (secs <= 1) {
        editTotpSecsRef.current = null;
        void tick();
        return;
      }
      const nextSecs = secs - 1;
      editTotpSecsRef.current = nextSecs;
      setEditTotp((prev) => (prev ? { ...prev, secs: nextSecs } : prev));
    }, 1000);
    return () => {
      alive = false;
      editTotpSecsRef.current = null;
      clearInterval(timer);
    };
  }, [editId, editLoadedGeneration]);

  const resetEditProxyCheck = () => {
    editProxyCheckGeneration.current++;
    setEditProxyCheck(EMPTY_PROXY_CHECK);
  };

  const setEF = (k: string, v: string) => {
    if (editSaveInFlight.current || !editSessionRef.current?.ready) return;
    if (k === "proxy" || k === "proxyType") {
      resetEditProxyCheck();
      setTimezoneBusy(false);
    }
    setEditForm((f) => ({ ...f, [k]: v }));
  };

  // A retry and a reopened copy of the same profile each receive a new token.
  const loadEditedProfile = async (id: string) => {
    if (editSaveInFlight.current || editSessionRef.current?.loading) return;
    const session = { id, generation: ++editSessionSequence.current, loading: true, ready: false };
    editSessionRef.current = session;
    setEditLoadedGeneration(null);
    setEditErr(null);
    setEditLoading(true);
    try {
      const p: EditProfile = await fetchProfileEdit(id);
      if (editSessionRef.current !== session) return;
      if (!validEditDetail(p, id)) throw new Error("The local service returned incomplete profile details. Retry before editing.");
      const loadedForm = {
        name: p.name,
        group: p.group,
        platform: p.platform,
        proxyType: p.proxyType || "http",
        proxy: p.proxy,
        proxyError: p.proxyError ?? "",
        username: p.username,
        password: p.password,
        email: p.email,
        emailPassword: p.emailPassword,
        twofa: p.twofa,
        resolution: p.resolution,
        tags: p.tags,
        customNo: p.customNo ?? "",
        platformOs: p.platformOs ?? "",
        timezone: p.timezone,
        locale: p.locale ?? "",
        cores: p.cores ?? "",
        fingerprintSeed: p.fingerprintSeed ?? "",
      };
      setEditForm(loadedForm);
      setEditSnapshot(
        captureProfileEditSnapshot({
          form: loadedForm,
          extensions: p.extensions ?? [],
          engine: p.engine === "firefox" ? "firefox" : "chromium",
          timezoneManual: !!p.timezoneManual,
          proxyQuarantined: !!p.proxyError,
        }),
      );
      setEditClearQuarantinedProxy(false);
      setEditInitialProxy({ proxy: p.proxy, proxyType: p.proxyType || "http" });
      setEditInitialFingerprint({
        resolution: p.resolution,
        platformOs: p.platformOs ?? "",
        timezone: p.timezone ?? "",
        locale: p.locale ?? "",
        cores: p.cores ?? "",
        fingerprintSeed: p.fingerprintSeed ?? "",
      });
      setEditEngine(p.engine === "firefox" ? "firefox" : "chromium");
      setEditChromiumRuntime(p.chromiumRuntime ?? "");
      setEditHardware(p.hardware);
      setEditExts(p.extensions ?? []);
      setEditInitialExts(p.extensions ?? []);
      setEditMobile(p.desktopConversion ?? null);
      session.ready = true;
      setEditLoadedGeneration(session.generation);
    } catch (e) {
      if (editSessionRef.current === session) setEditErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (editSessionRef.current === session) {
        session.loading = false;
        setEditLoading(false);
      }
    }
  };

  // The dialog opens immediately, but can save only validated details from this session.
  const openEdit = (id: string, field?: InspectionEditField, trigger?: HTMLButtonElement) => {
    if (busy[id]) {
      onActionError(t("Wait for the current environment action to finish before editing it."));
      return;
    }
    if (editSaveInFlight.current) return;
    onCancelReuseRead();
    editReturnFocus.current = trigger ?? null;
    editFieldOnOpen.current = field ?? null;
    editCloseGuard.reset();
    resetEditProxyCheck();
    onActionError(null);
    editSessionRef.current = null;
    setEditLoadedGeneration(null);
    setEditId(id);
    setEditForm({});
    setEditSnapshot(null);
    setEditClearQuarantinedProxy(false);
    setEditInitialFingerprint({});
    setEditExts([]);
    setEditInitialExts([]);
    setEditMobile(null);
    setEditTotp(null);
    setEditEngine(null);
    setEditChromiumRuntime("");
    setEditHardware(undefined);
    setTimezoneBusy(false);
    void loadEditedProfile(id);
  };

  const finishCloseEdit = () => {
    if (editSaveInFlight.current) return;
    editFieldOnOpen.current = null;
    resetEditProxyCheck();
    editSessionRef.current = null;
    setEditLoadedGeneration(null);
    setEditId(null);
    setEditEngine(null);
    setEditChromiumRuntime("");
    setEditHardware(undefined);
    setTimezoneBusy(false);
    setEditLoading(false);
    setEditSaving(false);
    setEditForm({});
    setEditSnapshot(null);
    setEditClearQuarantinedProxy(false);
    setEditInitialFingerprint({});
    setEditExts([]);
    setEditInitialExts([]);
    setEditErr(null);
    setEditMobile(null);
    setEditTotp(null);
  };

  const closeEdit = () => {
    if (editSaveInFlight.current || !editSessionRef.current) return;
    const dirty =
      !!editSnapshot &&
      (PROFILE_EDIT_FORM_FIELDS.some((field) => editForm[field] !== editSnapshot.form[field]) ||
        !sameExtensionSelection(editExts, [...editSnapshot.extensions]) ||
        editClearQuarantinedProxy);
    editCloseGuard.requestClose({ dirty, onDiscard: finishCloseEdit });
  };

  const checkEditedProxy = async () => {
    if (!editSessionRef.current?.ready || editSaveInFlight.current) return;
    const generation = ++editProxyCheckGeneration.current;
    const value = editForm.proxy ?? "";
    if (editForm.proxyType === "https" || /^\s*https:\/\//i.test(value)) {
      setEditProxyCheck({ checking: false, result: null, error: "unavailable" });
      return;
    }
    setEditProxyCheck({ checking: true, result: null, error: null });
    let proxy: ProxyCheckInput;
    try {
      proxy = parsePastedProxy(value, editForm.proxyType === "socks5" ? "socks5" : "http");
    } catch {
      if (generation === editProxyCheckGeneration.current) {
        setEditProxyCheck({ checking: false, result: null, error: "invalid" });
      }
      return;
    }
    try {
      const result = await checkProxy(proxy);
      if (generation === editProxyCheckGeneration.current) {
        setEditProxyCheck({ checking: false, result, error: null });
      }
    } catch (error) {
      if (generation === editProxyCheckGeneration.current) {
        setEditProxyCheck({
          checking: false,
          result: null,
          error: error instanceof ProxyCheckError ? error.kind : "unavailable",
        });
      }
    }
  };

  const refreshEditedTimezone = async () => {
    const session = editSessionRef.current;
    if (!editId || !editReady || !session?.ready || !editSnapshot || editSaveInFlight.current || editProxyChanged || timezoneBusy || editForm.proxyError) return;
    const confirmed = await requestConfirm({
      title: t("Confirm fingerprint change"),
      message: `${t(CONNECTION_TIMEZONE_SAVE_NOTE)}\n\n${t(FINGERPRINT_EDIT_WARNING)}`,
      confirmLabel: t("Continue"),
      cancelLabel: t("Cancel"),
    });
    if (!confirmed || editSessionRef.current !== session || editSaveInFlight.current || timezoneBusy) return;
    const id = editId;
    const generation = editProxyCheckGeneration.current;
    editSaveInFlight.current = true;
    setTimezoneBusy(true);
    setEditErr(null);
    try {
      const { timezone, locale } = await refreshProfileTimezone(id);
      if (editSessionRef.current !== session || generation !== editProxyCheckGeneration.current) return;
      setEditForm((form) => ({
        ...form,
        timezone: form.timezone === editSnapshot.form.timezone ? timezone : form.timezone ?? timezone,
        locale: form.locale === editSnapshot.form.locale ? locale : form.locale ?? locale,
      }));
      setEditInitialFingerprint((initial) => ({ ...initial, timezone, locale }));
      setEditSnapshot((initial) => (initial ? captureProfileEditSnapshot({ ...initial, form: { ...initial.form, timezone, locale }, timezoneManual: false }) : null));
      onRefreshQualityAfterEdit();
      await onLoadRoster();
    } catch (error) {
      if (editSessionRef.current === session && generation === editProxyCheckGeneration.current) {
        setEditErr(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (editSessionRef.current === session) {
        editSaveInFlight.current = false;
        setTimezoneBusy(false);
      }
    }
  };

  const saveEdit = async () => {
    const session = editSessionRef.current;
    if (!editId || !editReady || !session?.ready || session.id !== editId || editSaveInFlight.current || timezoneBusy) return;
    if (!editSnapshot) return;
    let changes: ReturnType<typeof buildProfileEditPatch>;
    try {
      changes = buildProfileEditPatch(editSnapshot, { form: editForm, extensions: editExts, clearQuarantinedProxy: editClearQuarantinedProxy });
    } catch (error) {
      setEditErr(error instanceof ProfileEditPatchError ? error.message : "Edited fields could not be validated. Reload this editor before saving.");
      return;
    }
    if (!changes.summary.hasChanges) return;
    if (changes.summary.requiresFingerprintConfirmation) {
      const confirmed = await requestConfirm({
        title: t("Confirm fingerprint change"),
        message: t(FINGERPRINT_EDIT_WARNING),
        confirmLabel: t("Save fingerprint changes"),
        cancelLabel: t("Cancel"),
      });
      if (!confirmed || editSessionRef.current !== session || editSaveInFlight.current || timezoneBusy) return;
    }
    editSaveInFlight.current = true;
    setEditSaving(true);
    setEditErr(null);
    try {
      const r = await updateProfile(session.id, changes.patch);
      if (editSessionRef.current !== session) return;
      if (r?.ok === true) {
        onRefreshQualityAfterEdit();
        await onLoadRoster();
        if (editSessionRef.current !== session) return;
        editSaveInFlight.current = false;
        finishCloseEdit();
        if (r.restartRequired) onFlash(t("Saved. The open browser keeps its current proxy and fingerprint until it restarts."));
      } else if (r.status === 409) {
        setEditErr(r.error || "Profile changed; reopen Edit before saving");
      } else {
        setEditErr(r.error || "save failed");
      }
    } catch (e) {
      if (editSessionRef.current === session) setEditErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (editSessionRef.current === session) {
        editSaveInFlight.current = false;
        setEditSaving(false);
      }
    }
  };

  const convertEditedMobile = async () => {
    const session = editSessionRef.current;
    if (!editId || !editReady || !session?.ready || !editMobile || editSaveInFlight.current) return;
    const platform = editMobile.platform === "macos" ? "macOS" : "Windows";
    const screenNote = editMobile.screenChanged
      ? t("Its mobile-sized screen will become {resolution}.", { resolution: editMobile.resolution })
      : t("Its existing desktop-sized screen will be kept.");
    const confirmed = await requestConfirm({
      title: t("Convert to desktop persona"),
      message: `${t("Convert this imported mobile persona to a stable {platform} desktop persona?", { platform })}\n\n${t("Cookies, login/session, credentials, proxy, timezone, fingerprint seed, tags and extensions are preserved.")} ${screenNote}\n\n${t("The website may treat the first launch as a new desktop device and request verification. Other unsaved edits in this dialog are not included.")}`,
      confirmLabel: t("Convert"),
      cancelLabel: t("Cancel"),
    });
    if (!confirmed || editSessionRef.current !== session || editSaveInFlight.current) return;
    editSaveInFlight.current = true;
    setEditSaving(true);
    setEditErr(null);
    try {
      const r = await convertMobileProfile(session.id);
      if (editSessionRef.current !== session) return;
      if (!r.ok) {
        setEditErr(r.error || t("Conversion failed"));
        return;
      }
      onRefreshQualityAfterEdit();
      await onLoadRoster();
      if (editSessionRef.current !== session) return;
      editSaveInFlight.current = false;
      finishCloseEdit();
      onFlash(t("Converted profile to a stable {platform} desktop persona", { platform }));
    } catch (e) {
      if (editSessionRef.current === session) setEditErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (editSessionRef.current === session) {
        editSaveInFlight.current = false;
        setEditSaving(false);
      }
    }
  };

  const toggleEditExt = (id: string) => setEditExts((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const removeExtensionFromDraft = (id: string) => setEditExts((current) => current.filter((item) => item !== id));
  const isEditSessionOpen = () => !!editSessionRef.current;
  const setReturnFocusElement = (element: HTMLElement | null) => { editReturnFocus.current = element; };

  useDesktopCloseDraft("profile-edit", {
    dirty:
      !!editId &&
      !!editSnapshot &&
      (PROFILE_EDIT_FORM_FIELDS.some((field) => editForm[field] !== editSnapshot.form[field]) ||
        !sameExtensionSelection(editExts, [...editSnapshot.extensions]) ||
        editClearQuarantinedProxy),
    busy: editSaving || timezoneBusy,
  });

  return {
    editId,
    editForm,
    setEditForm,
    editClearQuarantinedProxy,
    setEditClearQuarantinedProxy,
    editInitialFingerprint,
    editProxyCheck,
    editErr,
    setEditErr,
    editSaving,
    editLoading,
    editReady,
    editEditorRef,
    editCloseGuard,
    editEngine,
    editChromiumRuntime,
    editHardware,
    timezoneBusy,
    editMobile,
    editTotp,
    editExts,
    editSerial,
    editRunning,
    editReview,
    editHasProxy,
    editProxyChanged,
    editExtensionChoices,
    editSaveInFlight,
    editFieldFeedback,
    locateEditProblem,
    resetEditProxyCheck,
    setEF,
    loadEditedProfile,
    openEdit,
    closeEdit,
    checkEditedProxy,
    refreshEditedTimezone,
    saveEdit,
    convertEditedMobile,
    toggleEditExt,
    removeExtensionFromDraft,
    isEditSessionOpen,
    setReturnFocusElement,
  };
}

export type ProfileEditController = ReturnType<typeof useProfileEditModal>;

export function ProfileEditModal({
  controller,
  existingGroups,
  windowChrome,
  editorScroll,
  onFlash,
}: {
  controller: ProfileEditController;
  existingGroups: string[];
  windowChrome: ReturnType<typeof useWindowChrome>;
  editorScroll: ScrollBehavior;
  onFlash: (message: string) => void;
}) {
  const { t } = useTranslation();
  const {
    editId,
    editForm,
    setEditForm,
    editClearQuarantinedProxy,
    setEditClearQuarantinedProxy,
    editInitialFingerprint,
    editProxyCheck,
    editErr,
    setEditErr,
    editSaving,
    editLoading,
    editReady,
    editEditorRef,
    editCloseGuard,
    editEngine,
    editChromiumRuntime,
    editHardware,
    timezoneBusy,
    editMobile,
    editTotp,
    editExts,
    editSerial,
    editRunning,
    editReview,
    editHasProxy,
    editProxyChanged,
    editExtensionChoices,
    editSaveInFlight,
    editFieldFeedback,
    locateEditProblem,
    resetEditProxyCheck,
    setEF,
    loadEditedProfile,
    closeEdit,
    checkEditedProxy,
    refreshEditedTimezone,
    saveEdit,
    convertEditedMobile,
    toggleEditExt,
  } = controller;

  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyState, setPolicyState] = useState<"idle" | "loading" | "ready" | "unsupported" | "error">("idle");
  const [policyMemMode, setPolicyMemMode] = useState<ProfileResourcePolicyMode>("inherit");
  const [policyDataMode, setPolicyDataMode] = useState<ProfileResourcePolicyMode>("inherit");
  const [policyBlockImages, setPolicyBlockImages] = useState(true);
  const [policyBlockMedia, setPolicyBlockMedia] = useState(true);
  const [policyBlockFonts, setPolicyBlockFonts] = useState(false);
  const [policyEffective, setPolicyEffective] = useState<EffectiveProfileResourcePolicy | null>(null);
  const [policySaving, setPolicySaving] = useState(false);
  const [policyMsg, setPolicyMsg] = useState<string | null>(null);
  const [policyErr, setPolicyErr] = useState<string | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheMsg, setCacheMsg] = useState<string | null>(null);
  const [cacheErr, setCacheErr] = useState<string | null>(null);
  const policyTargetIdRef = useRef<string | null>(null);
  policyTargetIdRef.current = editId;

  useEffect(() => {
    setPolicyOpen(false);
    setPolicyState("idle");
    setPolicyMemMode("inherit");
    setPolicyDataMode("inherit");
    setPolicyBlockImages(true);
    setPolicyBlockMedia(true);
    setPolicyBlockFonts(false);
    setPolicyEffective(null);
    setPolicySaving(false);
    setPolicyMsg(null);
    setPolicyErr(null);
    setCacheBusy(false);
    setCacheMsg(null);
    setCacheErr(null);
  }, [editId]);

  const loadResourcePolicy = async (targetId: string) => {
    setPolicyState("loading");
    setPolicyErr(null);
    try {
      const res = await fetchProfileResourcePolicy(targetId);
      if (policyTargetIdRef.current !== targetId) return;
      if (!res.supported || !res.policy) {
        setPolicyState("unsupported");
        return;
      }
      setPolicyMemMode(res.policy.memorySaverMode);
      setPolicyDataMode(res.policy.dataSaver.mode);
      setPolicyBlockImages(res.policy.dataSaver.blockImages ?? true);
      setPolicyBlockMedia(res.policy.dataSaver.blockMedia ?? true);
      setPolicyBlockFonts(res.policy.dataSaver.blockFonts ?? false);
      setPolicyEffective(res.effective);
      setPolicyState("ready");
    } catch (error) {
      if (policyTargetIdRef.current !== targetId) return;
      setPolicyState("error");
      setPolicyErr(error instanceof Error ? error.message : t("Could not load resource policy."));
    }
  };

  const saveResourcePolicy = async () => {
    if (!editId || policySaving || policyState !== "ready") return;
    const targetId = editId;
    setPolicySaving(true);
    setPolicyMsg(null);
    setPolicyErr(null);
    try {
      const res = await updateProfileResourcePolicy(targetId, {
        memorySaverMode: policyMemMode,
        dataSaver:
          policyDataMode === "on"
            ? {
                mode: "on",
                blockImages: policyBlockImages,
                blockMedia: policyBlockMedia,
                blockFonts: policyBlockFonts,
              }
            : { mode: policyDataMode },
      });
      if (policyTargetIdRef.current !== targetId) return;
      setPolicyEffective(res.effective);
      setPolicyMsg(res.restartRequired ? `${t("Resource policy saved.")} ${t("Saved changes apply at the next start.")}` : t("Resource policy saved."));
      onFlash(t("Resource policy saved."));
    } catch (error) {
      if (policyTargetIdRef.current !== targetId) return;
      setPolicyErr(error instanceof Error ? error.message : t("Could not save resource policy."));
    } finally {
      if (policyTargetIdRef.current === targetId) setPolicySaving(false);
    }
  };

  const handleClearProfileCache = async () => {
    if (!editId || cacheBusy || editRunning) return;
    const targetId = editId;
    setCacheBusy(true);
    setCacheMsg(null);
    setCacheErr(null);
    try {
      const res = await clearProfileCache(targetId);
      if (policyTargetIdRef.current !== targetId) return;
      if (res?.ok === false) {
        throw new Error(typeof res.error === "string" ? res.error : t("Could not clear browser cache."));
      }
      const message = res?.cleared ? t("Browser cache cleared.") : t("No cache files to clear.");
      setCacheMsg(message);
      onFlash(message);
    } catch (error) {
      if (policyTargetIdRef.current !== targetId) return;
      setCacheErr(error instanceof Error ? error.message : t("Could not clear browser cache."));
    } finally {
      if (policyTargetIdRef.current === targetId) setCacheBusy(false);
    }
  };

  return (
    <>
      {editCloseGuard.dialog}
      <MotionPresence present={!!editId}>{() => (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop profile-editor-backdrop">
          <div
            ref={editEditorRef}
            inert={editCloseGuard.pending || undefined}
            aria-hidden={editCloseGuard.pending || undefined}
            tabIndex={-1}
            className="modal profile-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-profile-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <Icon name="edit" /><span id="edit-profile-title">{t("Edit profile")}</span>
              <EditorWindowControls chrome={windowChrome} disabled={editSaving || timezoneBusy} />
              <button type="button" className="modal-close" aria-label={t("Close")} disabled={editSaving || timezoneBusy} onClick={closeEdit}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {editErr && <div className="modal-err profile-edit-save-error" role="alert" tabIndex={-1}><Icon name="alert" className="sm" />{t(editErr)}</div>}
              {!editReady ? (
                <>
                  <p className="hint" role="status">{t(editLoading ? "Loading profile…" : "Load this profile successfully before saving changes.")}</p>
                  <div>
                    <button type="button" className="btn" disabled={editLoading} aria-busy={editLoading} onClick={() => { if (editId) void loadEditedProfile(editId); }}>
                      {t("Retry loading profile")}
                    </button>
                  </div>
                </>
              ) : (
                <fieldset className="profile-create-fields profile-edit-fields" disabled={editSaving || timezoneBusy} aria-busy={editSaving || timezoneBusy}>
                  {editForm.proxyError && (
                    <div className="modal-err proxy-quarantine-note">
                      <Icon name="alert" className="sm" />
                      <span>{t("This saved proxy needs repair.")} <small>{editForm.proxyError}</small></span>
                      <button
                        type="button"
                        className="btn xs ghost"
                        disabled={editSaving || timezoneBusy}
                        onClick={() => {
                          if (editSaveInFlight.current) return;
                          resetEditProxyCheck();
                          setEditClearQuarantinedProxy(true);
                          setEditForm((current) => ({ ...current, proxy: "", proxyError: "" }));
                        }}
                      >
                        {t("Remove invalid proxy")}
                      </button>
                    </div>
                  )}
                  {editClearQuarantinedProxy && <p className="hint">{t("The invalid proxy will be removed when you save. This environment will then use a direct connection.")}</p>}
                  {editRunning && (
                    <p className="hint" role="status">
                      {t("This browser is open. Changes save now. Proxy and fingerprint changes apply at the next start.")}
                    </p>
                  )}
                  {editMobile && (
                    <div className="persona-warning">
                      <strong><Icon name="warning" className="sm" />{t("Imported mobile persona cannot open safely")}</strong>
                      <span>
                        {t("Earlier versions of the app opened it as a desktop browser anyway: Android became Windows; iPhone/iPad became macOS. That looked usable, but it was not coherent mobile emulation.")}
                      </span>
                      <span>
                        Convert it once to {editMobile.platform === "macos" ? "macOS" : "Windows"} desktop. Cookies, login/session, proxy, timezone, credentials and fingerprint seed stay intact
                        {editMobile.screenChanged ? `; the mobile-sized screen becomes ${editMobile.resolution}` : t("; the existing desktop-sized screen stays intact")}.
                      </span>
                      <button className="btn persona-convert" disabled={editSaving} onClick={convertEditedMobile}>
                        {editSaving ? t("Converting…") : `Convert to ${editMobile.platform === "macos" ? "macOS" : "Windows"} desktop`}
                      </button>
                    </div>
                  )}
                  <ProfileEditorLayout
                    label={t("Environment sections")}
                    sessionKey={editId}
                    scrollBehavior={editorScroll}
                    sections={[
                      { id: "basic", label: t("Basic information"), icon: "profiles" },
                      { id: "proxy", label: t("Network & proxy"), icon: "activity" },
                      { id: "account", label: t("Account data"), icon: "key" },
                      { id: "fingerprint", label: t("Fingerprint settings"), icon: "fingerprint" },
                      ...(editEngine === "chromium" && editExtensionChoices.length > 0 ? [{ id: "extensions", label: t("Extensions"), icon: "puzzle" as const }] : []),
                    ]}
                    preview={
                      <ProfileEditorPreviewCard
                        title={t("Live summary")}
                        heading={(editForm.name ?? "").trim() || (editSerial != null ? `#${editSerial}` : t("Loading profile…"))}
                        subheading={(editForm.group ?? "").trim() || t("Ungrouped")}
                        badgeText={
                          (editForm.customNo ?? "").trim()
                            ? `#${(editForm.customNo ?? "").trim()}`
                            : editSerial != null
                              ? `#${editSerial}`
                              : t("Automatic")
                        }
                        avatarText={(editForm.name ?? "").trim() || "MB"}
                        statusLabel={
                          editReview.error || editErr
                            ? t("Needs attention")
                            : editRunning
                              ? t("Running")
                              : t("Ready")
                        }
                        statusTone={
                          editReview.error || editErr
                            ? "warn"
                            : editRunning
                              ? "success"
                              : "neutral"
                        }
                        items={[
                          {
                            key: "browser",
                            label: t("Browser"),
                            value: editEngine ? browserLabel(editEngine, editChromiumRuntime) : "—",
                            muted: !editEngine,
                          },
                          {
                            key: "platform",
                            label: t("Platform"),
                            value: (editForm.platform ?? "").trim() || t("Not set"),
                            muted: !(editForm.platform ?? "").trim(),
                          },
                          {
                            key: "proxy",
                            label: t("Proxy"),
                            value: editHasProxy
                              ? `${editForm.proxyType ?? "http"} · ${(editForm.proxy ?? "").trim()}`
                              : t("Direct connection"),
                            muted: !editHasProxy,
                            mono: editHasProxy,
                          },
                          {
                            key: "os",
                            label: t("Operating system"),
                            value: editForm.platformOs || t("Automatic"),
                            muted: !editForm.platformOs,
                          },
                          {
                            key: "screen",
                            label: t("Screen"),
                            value: (editForm.resolution ?? "").trim() || t("Automatic"),
                            muted: !(editForm.resolution ?? "").trim(),
                            mono: !!(editForm.resolution ?? "").trim(),
                          },
                          ...(editEngine === "chromium" && editExtensionChoices.length > 0
                            ? [{
                                key: "extensions",
                                label: t("Extensions"),
                                value: String(editExts.length),
                                muted: editExts.length === 0,
                              }]
                            : []),
                        ]}
                      />
                    }
                  >
                    <ProfileEditorSection sectionId="basic">
                      <div className="fld-row">
                        <label className="fld grow">
                          <span>{t("Name")}</span>
                          <input value={editForm.name ?? ""} onChange={(e) => setEF("name", e.target.value)} />
                        </label>
                        <label className="fld no">
                          <span>{t("Custom NO.")}</span>
                          <input
                            {...editorFieldAttributes(editFieldFeedback("customNo"))}
                            value={editForm.customNo ?? ""}
                            inputMode="numeric"
                            maxLength={MAX_CUSTOM_NO}
                            placeholder={editSerial != null ? String(editSerial) : t("Automatic")}
                            onChange={(e) => setEF("customNo", e.target.value.replace(/\D/g, "").slice(0, MAX_CUSTOM_NO))}
                          />
                          <small>{t("Digits only · blank uses the serial")}</small>
                        </label>
                      </div>
                      <div className="fld-row">
                        <label className="fld grow">
                          <span>{t("Folder")}</span>
                          <GroupPicker value={editForm.group ?? ""} onChange={(v) => setEF("group", v)} groups={existingGroups} allowCreate />
                        </label>
                        <label className="fld grow">
                          <span>{t("Platform")}</span>
                          <PlatformPicker value={editForm.platform ?? ""} onChange={(v) => setEF("platform", v)} />
                        </label>
                      </div>
                      <label className="fld">
                        <span>{t("Browser")}</span>
                        <input value={editEngine ? browserLabel(editEngine, editChromiumRuntime) : ""} readOnly className="ro" />
                        {editEngine === "firefox" && <small>{t("Native Firefox profile · no CDP, PDF, or Chrome extensions.")}</small>}
                        {editEngine === "chromium" && !editChromiumRuntime && <small>{t(CLOAKBROWSER_NOTE)}</small>}
                      </label>
                      <label className="fld">
                        <span>{t("Tags")} <span className="muted">{t("(comma-separated)")}</span></span>
                        <input {...editorFieldAttributes(editFieldFeedback("tags"))} value={editForm.tags ?? ""} placeholder="warmup, us, priority" onChange={(e) => setEF("tags", e.target.value)} />
                      </label>
                    </ProfileEditorSection>
                    <ProfileEditorSection sectionId="proxy">
                      <div className="fld-row">
                        <label className="fld type">
                          <span>{t("Proxy type")}</span>
                          <select {...editorFieldAttributes(editFieldFeedback("proxyType"))} value={editForm.proxyType ?? "http"} onChange={(e) => setEF("proxyType", e.target.value)}>
                            <option value="http">http</option>
                            <option value="https">https</option>
                            <option value="socks5">socks5</option>
                          </select>
                        </label>
                        <label className="fld grow">
                          <span>{t("Proxy")}</span>
                          <input {...editorFieldAttributes(editFieldFeedback("proxy"))} value={editForm.proxy ?? ""} placeholder="host:port:username:password" onChange={(e) => setEF("proxy", e.target.value)} />
                          <small>{t("Leave blank to launch on a direct connection.")}</small>
                        </label>
                      </div>
                      <div className="profile-editor-proxy-actions">
                        <button type="button" className="btn proxy-check-btn" disabled={editProxyCheck.checking || timezoneBusy || !editHasProxy} aria-busy={editProxyCheck.checking} onClick={checkEditedProxy}>
                          <Icon name="activity" className="sm" />
                          {editProxyCheck.checking ? t("Checking…") : t("Check proxy")}
                        </button>
                        <button type="button" className="btn proxy-check-btn" disabled={timezoneBusy || editSaving || editProxyChanged || !!editForm.proxyError} onClick={refreshEditedTimezone}>
                          <Icon name="activity" className="sm" />
                          {timezoneBusy ? t("Looking up timezone and language…") : editHasProxy ? t("Set timezone and language from proxy") : t("Use current connection timezone and language")}
                        </button>
                      </div>
                      <ProxyCheckFeedback hasProxy={editHasProxy} state={editProxyCheck} />
                      <p className="hint">
                        {editProxyChanged
                          ? t("Save proxy changes before setting the timezone.")
                          : t(CONNECTION_TIMEZONE_SAVE_NOTE)}
                      </p>
                      {editForm.locale && localeTimezoneMismatch(editForm.locale, editForm.timezone ?? "") && (
                        <p className="hint">{t("This language does not match the timezone's country. Use “Set timezone and language from proxy” to match them.")}</p>
                      )}
                    </ProfileEditorSection>
                    <ProfileEditorSection sectionId="account">
                      <div className="fld-row">
                        <CopyField label={t("Username")} value={editForm.username ?? ""} onChange={(value) => setEF("username", value)} />
                        <CopyField label={t("Password")} value={editForm.password ?? ""} onChange={(value) => setEF("password", value)} />
                      </div>
                      <div className="fld-row">
                        <CopyField label={t("Email")} value={editForm.email ?? ""} onChange={(value) => setEF("email", value)} />
                        <CopyField label={t("Email password")} value={editForm.emailPassword ?? ""} onChange={(value) => setEF("emailPassword", value)} />
                      </div>
                      <CopyField label={t("2FA secret")} value={editForm.twofa ?? ""} onChange={(value) => setEF("twofa", value)} />
                      {editTotp && (
                        <div className="authrow">
                          <span className="authlabel">{t("Authenticator")}</span>
                          <span className="authcode">{editTotp.code.slice(0, 3)} {editTotp.code.slice(3)}</span>
                          <span className="authsecs" title={t("seconds until it refreshes")}>{editTotp.secs}s</span>
                          <button
                            className="btn xs"
                            type="button"
                            onClick={() => {
                              void copyPlainText(editTotp.code)
                                .then(() => onFlash(t("Copied")))
                                .catch((err) => setEditErr(err instanceof Error ? err.message : t("Could not copy to clipboard.")));
                            }}
                          >
                            <Icon name="copy" className="sm" />{t("Copy")}
                          </button>
                        </div>
                      )}
                    </ProfileEditorSection>
                    <ProfileEditorSection sectionId="fingerprint">
                      {editEngine && (
                        <FingerprintSettings
                          allowAutomaticScreen={false}
                          feedback={editFieldFeedback}
                          engine={editEngine}
                          chromiumRuntime={editChromiumRuntime}
                          screen={editForm.resolution ?? ""}
                          onScreenChange={(value) => setEF("resolution", value)}
                          platformOs={editForm.platformOs ?? ""} onPlatformOsChange={editEngine === "chromium" ? (value) => setEF("platformOs", value) : undefined}
                          timezone={editForm.timezone ?? ""}
                          onTimezoneChange={(value) => setEF("timezone", value)}
                          locale={editForm.locale ?? ""}
                          onLocaleChange={(value) => setEF("locale", value)}
                          cores={editForm.cores ?? ""}
                          onCoresChange={(value) => setEF("cores", value)}
                          seed={editForm.fingerprintSeed ?? ""}
                          onSeedChange={(value) => setEF("fingerprintSeed", value)}
                          disabled={editSaving || timezoneBusy}
                          onUndo={() => setEditForm((form) => ({ ...form, ...editInitialFingerprint }))}
                          hardware={editHardware}
                        />
                      )}
                    </ProfileEditorSection>
                    {editEngine === "chromium" && editExtensionChoices.length > 0 && (
                      <ProfileEditorSection sectionId="extensions" description={t(" Extensions load when the browser opens.")}>
                        <div className="extassign">
                          {editExtensionChoices.map((x) => (
                            <label key={x.id} className="extchk">
                              <input type="checkbox" checked={editExts.includes(x.id)} onChange={() => toggleEditExt(x.id)} />
                              <span>{x.name}{x.missing && <span className="muted">{t(" · Not installed on this device")}</span>}</span>
                            </label>
                          ))}
                        </div>
                      </ProfileEditorSection>
                    )}
                  </ProfileEditorLayout>
                  <details
                    className="profile-resource-policy-disclosure"
                    open={policyOpen}
                    onToggle={(event) => {
                      const nextOpen = event.currentTarget.open;
                      setPolicyOpen(nextOpen);
                      if (nextOpen && editId && policyState === "idle") {
                        void loadResourcePolicy(editId);
                      }
                    }}
                  >
                    <summary>
                      <Icon name="activity" className="sm" />
                      <span>{t("Resource policy & cache")}</span>
                      {policyEffective && (
                        <span className="profile-policy-summary-pill">
                          {t("Memory saver")}: {policyEffective.memorySaver ? t("Enabled") : t("Disabled")}
                        </span>
                      )}
                    </summary>
                    <div className="profile-resource-policy-body">
                      {policyState === "loading" && <p className="hint" role="status">{t("Loading…")}</p>}
                      {policyState === "unsupported" && (
                        <p className="hint">{t("Resource policies are unavailable on this server.")}</p>
                      )}
                      {policyErr && <div className="modal-err" role="alert"><Icon name="alert" className="sm" />{policyErr}</div>}
                      {policyState === "ready" && (
                        <div className="profile-policy-controls">
                          <div className="fld-row">
                            <label className="fld grow">
                              <span>{t("Memory saver")}</span>
                              <select
                                value={policyMemMode}
                                disabled={policySaving}
                                onChange={(e) => { setPolicyMemMode(e.target.value as ProfileResourcePolicyMode); setPolicyMsg(null); }}
                              >
                                <option value="inherit">{t("Follow global setting")}</option>
                                <option value="on">{t("Always enable")}</option>
                                <option value="off">{t("Disable for this profile")}</option>
                              </select>
                            </label>
                            <label className="fld grow">
                              <span>{t("Bandwidth data saver mode")}</span>
                              <select
                                value={policyDataMode}
                                disabled={policySaving}
                                onChange={(e) => { setPolicyDataMode(e.target.value as ProfileResourcePolicyMode); setPolicyMsg(null); }}
                              >
                                <option value="inherit">{t("Follow global setting")}</option>
                                <option value="on">{t("Always enable")}</option>
                                <option value="off">{t("Disable for this profile")}</option>
                              </select>
                            </label>
                          </div>
                          {policyDataMode === "on" && (
                            <div className="profile-policy-checks">
                              <label className="extchk">
                                <input type="checkbox" checked={policyBlockImages} disabled={policySaving} onChange={(e) => setPolicyBlockImages(e.target.checked)} />
                                <span>{t("Block images")}</span>
                              </label>
                              <label className="extchk">
                                <input type="checkbox" checked={policyBlockMedia} disabled={policySaving} onChange={(e) => setPolicyBlockMedia(e.target.checked)} />
                                <span>{t("Block media autoplay & preload")}</span>
                              </label>
                              <label className="extchk">
                                <input type="checkbox" checked={policyBlockFonts} disabled={policySaving} onChange={(e) => setPolicyBlockFonts(e.target.checked)} />
                                <span>{t("Block remote web fonts")}</span>
                              </label>
                            </div>
                          )}
                          {policyEffective && (
                            <p className="hint">
                              {t("Effective: {summary}", {
                                summary: `${t("Memory saver")} ${policyEffective.memorySaver ? t("Enabled") : t("Disabled")} · ${t("Bandwidth data saver mode")} ${policyEffective.dataSaver.enabled ? t("Enabled") : t("Disabled")}`,
                              })}
                            </p>
                          )}
                          <div className="profile-policy-actions">
                            <button type="button" className="btn" disabled={policySaving} onClick={() => { void saveResourcePolicy(); }}>
                              {policySaving ? t("Saving…") : t("Save resource policy")}
                            </button>
                            {policyMsg && <span className="hint" role="status">{policyMsg}</span>}
                          </div>
                        </div>
                      )}
                      <div className="profile-cache-actions">
                        <button
                          type="button"
                          className="btn"
                          disabled={cacheBusy || editRunning}
                          onClick={() => { void handleClearProfileCache(); }}
                        >
                          {cacheBusy ? t("Clearing…") : t("Clear browser cache")}
                        </button>
                        {editRunning && <span className="hint">{t("Stop this environment before clearing cache.")}</span>}
                        {cacheMsg && <span className="hint" role="status">{cacheMsg}</span>}
                        {cacheErr && <span className="modal-err" role="alert">{cacheErr}</span>}
                      </div>
                    </div>
                  </details>
                  <p className="formnote">
                    {t("Cookies and locked fingerprint values are preserved. Only editable fields change.")}
                  </p>
                </fieldset>
              )}
              {editReady && editReview.error && <div id="profile-edit-validation-error" className="modal-err" role="alert" tabIndex={-1}>{t(editReview.error)}</div>}
              {editReady && editReview.summary && (editReview.summary.hasChanges || editReview.summary.notices.length > 0) && (
                <div className="editor-summary-anchor" tabIndex={-1}><EditChangesSummary summary={editReview.summary} running={editRunning} busy={editSaving} /></div>
              )}
            </div>
            <div className="modal-foot profile-editor-status-footer">
              {editReady && (
                <ProfileEditorStatus
                  kind="edit"
                  editChangeCount={editReview.summary?.count ?? 0}
                  hasValidationError={!!editReview.error}
                  hasSaveError={!!editErr}
                  onReview={() => focusEditorTarget(editEditorRef.current?.querySelector<HTMLElement>(".editor-summary-anchor"), editorScroll)}
                  onLocateProblem={locateEditProblem}
                />
              )}
              <button className="btn ghost" disabled={editSaving || timezoneBusy} onClick={closeEdit}>{t("Cancel")}</button>
              <button className="btn primary" disabled={!editReady || !editReview.summary?.hasChanges || !!editReview.error || editSaving || editLoading || timezoneBusy} onClick={saveEdit}>
                {editSaving ? t("Saving…") : t("Save changes")}
              </button>
            </div>
          </div>
        </div>
      )}</MotionPresence>
    </>
  );
}
