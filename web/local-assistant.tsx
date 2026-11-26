import * as React from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import { AssistantRequestError, cancelLocalAssistant, fetchLocalModels, sendLocalAssistant, stripProposalFence, type AnomalyCriterion, type CompiledProposalView, type LocalModelCatalog } from "./local-assistant-api.ts";
import "./local-assistant.css";
import { assistantHistory } from "./assistant-history.ts";
import { AssistantMarkdown } from "./assistant-markdown.tsx";
import { useAssistantTranscriptPosition } from "./assistant-transcript-position.ts";
import { copyText } from "./clipboard.ts";
import { useDesktopCloseDraft } from "./desktop-close.tsx";
import { useOptionalWorkspaceOperations, type WorkspaceOperationCoordinator } from "./workspace-operations.tsx";
import { ASSISTANT_SERVICE_LABELS, readAssistantServices, requiresAssistantServiceKey, saveAssistantService, setDefaultAssistantService, type AssistantServicesCatalog, type AssistantServiceView } from "./assistant-services-api.ts";
import { AssistantApiSidebar } from "./assistant-api-sidebar.tsx";
import { AssistantProposalCard } from "./assistant-proposal-card.tsx";
import { AppIcon } from "./ui-primitives.tsx";

interface ChatMessage { id: number; role: "user" | "assistant"; content: string; model?: string; durationMs?: number; overview?: boolean; proposalMode?: boolean; proposal?: CompiledProposalView | null; proposalParseError?: string; source?: AssistantTaskSource }
interface AssistantThread { id: string; title: string; updatedAt: number; history: ChatMessage[]; taskSource: AssistantTaskSource | null; historyBoundary: number }
export interface AssistantTaskSource { title: string; description?: string; returnKey?: string }
export interface AssistantDraftSuggestion { id: number; text: string; source?: AssistantTaskSource }
type TaskPhase = "draft" | "waiting" | "complete" | "failed" | "cancelled";
const MESSAGE_BYTES = 8 * 1024;
const EXAMPLES = [
  { title: "Plan a browser workflow", prompt: "Help me plan a repeatable browser testing workflow. Break it into clear steps and explain which steps can use MCP." },
  { title: "Draft a Playwright script", prompt: "Draft a Playwright script that checks the title and accessibility of my own test website. Ask for the website URL if it is missing." },
  { title: "Understand fingerprint checks", prompt: "Explain how timezone, language, screen size and browser engine consistency affect a browser profile. Give me a practical inspection checklist." },
  { title: "Troubleshoot proxy connection", prompt: "A profile's local SOCKS5 proxy is listening, but websites fail to load. Walk me through a step-by-step troubleshooting checklist for proxy exit, DNS, and WebRTC." },
];
const SLASH_COMMANDS = [
  { cmd: "/Fingerprint check", desc: "Check timezone, language, screen size and engine consistency", prompt: EXAMPLES[2]!.prompt },
  { cmd: "/Playwright script", desc: "Draft a Playwright script to check titles and accessibility", prompt: EXAMPLES[1]!.prompt },
  { cmd: "/Anti-association", desc: "Design proxy isolation and group partitioning rules", prompt: EXAMPLES[0]!.prompt },
  { cmd: "/Proxy troubleshoot", desc: "Diagnose local SOCKS5 handshake, exit IP and WebRTC", prompt: EXAMPLES[3]!.prompt },
];
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function shortModelName(name: string): string {
  return name.replace(/^models\//, "");
}
function deriveThreadTitle(messages: readonly ChatMessage[], fallback: string): string {
  const firstUser = messages.find(item => item.role === "user")?.content.trim() || messages[0]?.content.trim() || "";
  if (!firstUser) return fallback;
  return firstUser.length > 26 ? `${firstUser.slice(0, 26)}…` : firstUser;
}

interface LocalAssistantPageProps {
  active: boolean;
  autoLoadDefaultModel?: boolean;
  onOpenMcp?: () => void;
  onOpenModelServices?: () => void;
  draftSuggestion?: AssistantDraftSuggestion | null;
  onDismissDraftSuggestion?: (id: number) => void;
  onReturnToTask?: (source: AssistantTaskSource) => void;
  onLocateProfiles?: (profileIds: string[], criteria?: AnomalyCriterion[]) => void;
}
interface ChatOperation { id: string; controller: AbortController; content: string; previousHistory: ChatMessage[]; source: AssistantTaskSource | null }
interface Cancellation { id: string; reason: "manual" | "navigation"; status: "pending" | "unconfirmed" }
interface ConversationCopy { replyId: number; status: "pending" | "copied" | "failed" }
interface ConversationMatch { id: number; start: number; end: number }

function visibleMessageContent(item: Pick<ChatMessage, "content" | "proposal">): string {
  return item.proposal ? stripProposalFence(item.content) : item.content;
}

function findConversationMatches(history: readonly ChatMessage[], lastReplyIndex: number, text: string): ConversationMatch[] {
  const query = text.trim();
  if (!query || lastReplyIndex < 0) return [];
  const literal = new RegExp(query.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&"), "iu");
  return history.slice(0, lastReplyIndex + 1).flatMap((item) => {
    const match = literal.exec(visibleMessageContent(item));
    return match ? [{ id: item.id, start: match.index, end: match.index + match[0].length }] : [];
  });
}

/** Navigation keeps this in-memory owner; a workspace identity change replaces it. */
export function LocalAssistantPage(props: LocalAssistantPageProps) {
  const { t } = useTranslation();
  const workspace = useOptionalWorkspaceOperations(), workspaceId = workspace?.snapshot.workspaceId ?? (workspace ? null : "local");
  const scope = useRef<{ workspaceId: string | null; blockedSuggestionId: number | null }>({ workspaceId, blockedSuggestionId: null });
  if (workspaceId && scope.current.workspaceId !== workspaceId) {
    if (scope.current.workspaceId) scope.current.blockedSuggestionId = props.draftSuggestion?.id ?? null;
    scope.current.workspaceId = workspaceId;
  }
  if (!workspaceId) return <div className="workspace assistant-workspace" hidden={!props.active}><div className="page-heading"><h1>{t("AI workspace")}</h1></div><p role="status">{t("Load this workspace before starting an AI conversation.")}</p></div>;
  const suggestion = props.draftSuggestion?.id === scope.current.blockedSuggestionId ? null : props.draftSuggestion;
  return <LocalAssistantSession key={workspaceId} {...props} draftSuggestion={suggestion} workspaceId={workspaceId} coordinator={workspace?.coordinator} workspaceBlocked={workspace?.snapshot.blocked ?? false} />;
}

function LocalAssistantSession({ active, autoLoadDefaultModel = false, onOpenMcp, onOpenModelServices, draftSuggestion, onDismissDraftSuggestion, onReturnToTask, onLocateProfiles, workspaceId, coordinator, workspaceBlocked }: LocalAssistantPageProps & { workspaceId: string; coordinator?: WorkspaceOperationCoordinator; workspaceBlocked: boolean }) {
  const { t } = useTranslation();
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:11434"), [catalog, setCatalog] = useState<LocalModelCatalog | null>(null), [model, setModel] = useState("");
  const [loading, setLoading] = useState(false), [sending, setSending] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [draft, setDraft] = useState(""), [overview, setOverview] = useState(false), [proposalMode, setProposalMode] = useState(false), [history, setHistory] = useState<ChatMessage[]>([]);
  const [undo, setUndo] = useState<{ history: ChatMessage[]; source: AssistantTaskSource | null; archivedId?: string } | null>(null);
  const [conversationCopy, setConversationCopy] = useState<ConversationCopy | null>(null);
  const copyInProgress = useRef(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findSelection, setFindSelection] = useState<{ id: number } | null>(null);
  const findId = useId();
  const findTrigger = useRef<HTMLButtonElement>(null), findInput = useRef<HTMLInputElement>(null);
  const findComposing = useRef(false);
  const [connectionError, setConnectionError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsMode, setSettingsMode] = useState<"local" | "api">("local");
  const [apiVisited, setApiVisited] = useState(false);
  const [activeService, setActiveService] = useState<AssistantServiceView | null>(null);
  const [keyEditRequest, setKeyEditRequest] = useState<{ id: string } | null>(null);
  const [keyRejected, setKeyRejected] = useState(false);
  const [modelEvidence, setModelEvidence] = useState<"selected" | "list" | "reply">("selected");
  const [defaultError, setDefaultError] = useState("");
  const [phase, setPhase] = useState<TaskPhase>("draft");
  const threadSeq = useRef(1);
  const [activeThreadId, setActiveThreadId] = useState("thread-1");
  const [savedThreads, setSavedThreads] = useState<AssistantThread[]>([]);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [pickerServices, setPickerServices] = useState<AssistantServicesCatalog | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const modelPickerWrapRef = useRef<HTMLDivElement>(null);
  const autoRestoredRef = useRef(false);
  // The task's local display name is deliberately separate from the anonymous
  // text the user may choose to add and send to the model.
  const [taskSource, setTaskSource] = useState<AssistantTaskSource | null>(null);
  const [cancellation, setCancellation] = useState<Cancellation | null>(null);
  const cancellationOwner = useRef<Cancellation | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null), [waitedSeconds, setWaitedSeconds] = useState(0);
  const connectionId = useId();
  const connectionInput = useRef<HTMLInputElement>(null);
  const connectionPanel = useRef<HTMLElement>(null);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const settingsClose = useRef<HTMLButtonElement>(null);
  const settingsVisible = useRef(settingsOpen);
  settingsVisible.current = settingsOpen;
  const focusAfterSettings = useRef<"settings" | "composer" | null>(null);
  const [suggestionFeedback, setSuggestionFeedback] = useState<{ id: number; state: "dismissed" | "too-long" } | null>(null);
  const dismissedSuggestion = useRef<number | null>(null);
  const currentDraft = useRef("");
  const abort = useRef<AbortController | null>(null), nextId = useRef(1), input = useRef<HTMLTextAreaElement>(null), mounted = useRef(true), wasSending = useRef(false);
  const appliedRoute = useRef("");
  const historyBoundary = useRef(0);
  const composer = useRef<HTMLDivElement>(null);
  const latestReplyIndex = history.findLastIndex(item => item.role === "assistant");
  const latestReplyId = history[latestReplyIndex]?.id ?? null;
  const transcript = useAssistantTranscriptPosition({ active, latestMessageId: history.at(-1)?.id ?? null, latestReplyId, sending, pauseFollowing: findOpen });
  const findMatches = useMemo(() => findConversationMatches(history, latestReplyIndex, findQuery), [history, latestReplyIndex, findQuery]);
  const matchIndex = findMatches.findIndex(match => match.id === findSelection?.id);
  const selectedMatch = findOpen ? findMatches[matchIndex] : undefined;
  useDesktopCloseDraft("assistant-draft", { dirty: !!draft.trim(), busy: false });
  const activeRequest = useRef<ChatOperation | null>(null);
  const activePage = useRef(active);
  activePage.current = active;
  const ownsSession = () => mounted.current && (!coordinator || coordinator.getSnapshot().workspaceId === workspaceId);
  const isRemote = !!activeService && activeService.provider !== "ollama";
  const selectedModel = activeService?.model ?? model;
  const missingKey = !!activeService && requiresAssistantServiceKey(activeService.provider) && !activeService.credentialConfigured;
  const needsKey = missingKey || keyRejected;
  useEffect(() => {
    if (!modelPickerOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (modelPickerWrapRef.current && !modelPickerWrapRef.current.contains(event.target as Node)) {
        setModelPickerOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModelPickerOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [modelPickerOpen]);
  useEffect(() => {
    if (!active || !autoLoadDefaultModel || autoRestoredRef.current) return;
    const controller = new AbortController();
    void readAssistantServices(controller.signal).then(async (result) => {
      if (!ownsSession() || controller.signal.aborted) return;
      autoRestoredRef.current = true;
      setPickerServices(result);
      if (appliedRoute.current) return;
      const preferred = result.services.find(item => item.id === result.defaultId);
      if (!preferred) return;
      appliedRoute.current = JSON.stringify([preferred.provider, preferred.endpoint, preferred.id]);
      setActiveService(preferred);
      setKeyRejected(false);
      setModelEvidence("selected");
      setSettingsMode(preferred.provider === "ollama" ? "local" : "api");
      if (preferred.provider !== "ollama") setApiVisited(true);
      if (preferred.provider === "ollama") {
        setEndpoint(preferred.endpoint);
        try {
          const local = await fetchLocalModels(preferred.endpoint, controller.signal);
          if (!ownsSession() || controller.signal.aborted) return;
          if (local.models.length > 0) {
            setCatalog(local);
            setModel(local.models.some(item => item.name === preferred.model) ? preferred.model : local.models[0]?.name ?? preferred.model);
            setModelEvidence("list");
          }
        } catch {
          // Local Ollama may not be running at startup; keep saved model service selected silently.
        }
      }
    }).catch(() => {});
    return () => controller.abort();
  }, [active, autoLoadDefaultModel]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    if (!draft) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draft]);

  useLayoutEffect(() => {
    if (findOpen && activePage.current) findInput.current?.focus({ preventScroll: true });
  }, [findOpen]);
  useLayoutEffect(() => {
    // Explicit selections are new objects. A reply can add results without
    // taking the reader to a different message or changing keyboard focus.
    if (findSelection) transcript.readFindMatch();
  }, [findSelection]);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false;
    const operation = activeRequest.current; activeRequest.current = null; cancellationOwner.current = null;
    abort.current?.abort(); abort.current = null;
    if (operation) void cancelLocalAssistant(operation.id).catch(error => {
      console.warn("Failed to cancel local assistant request:", error);
    });
  }; }, []);
  useEffect(() => { if (!active && activeRequest.current) cancel("navigation"); }, [active]);
  useEffect(() => {
    if (!sending || startedAt === null) return;
    const tick = () => setWaitedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      stop();
      if (typeof document !== "undefined" && document.hidden) return;
      tick();
      timer = setInterval(tick, 1000);
    };
    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };
    start();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [sending, startedAt]);
  useEffect(() => {
    if (wasSending.current && !sending && active && phase !== "complete") {
      const node = composer.current;
      const focused = node?.ownerDocument.activeElement;
      if (node && (!focused || focused === node.ownerDocument.body || node.contains(focused))) input.current?.focus({ preventScroll: true });
    }
    wasSending.current = sending;
  }, [sending, active, phase]);
  useLayoutEffect(() => {
    if (!activePage.current) {
      focusAfterSettings.current = null;
      return;
    }
    if (settingsOpen) {
      const address = connectionInput.current;
      const panel = connectionPanel.current;
      if (settingsMode === "local" && address && !address.disabled) address.focus();
      else if (panel && !panel.contains(panel.ownerDocument.activeElement)) settingsClose.current?.focus({ preventScroll: true });
      return;
    }
    const target = focusAfterSettings.current;
    focusAfterSettings.current = null;
    if (target === "settings") settingsTrigger.current?.focus({ preventScroll: true });
    if (target === "composer") input.current?.focus();
  }, [settingsOpen, settingsMode]);
  function closeSettings(target: "settings" | "composer") {
    focusAfterSettings.current = target;
    setSettingsOpen(false);
  }
  function returnToComposerAfterConnection() {
    if (settingsVisible.current) closeSettings("composer");
    else if (!settingsOpen && activePage.current) input.current?.focus();
  }
  function updateDraft(value: string) {
    currentDraft.current = value;
    setDraft(value);
    setPhase("draft");
    if (value === "/") setSlashOpen(true);
    else if (slashOpen && !value.startsWith("/")) setSlashOpen(false);
  }
  function archiveCurrentThread(): string | undefined {
    if (!history.length) return undefined;
    const id = activeThreadId;
    const snapshot: AssistantThread = {
      id,
      title: deriveThreadTitle(history, t("Untitled conversation")),
      updatedAt: Date.now(),
      history,
      taskSource: taskSource ? { ...taskSource } : null,
      historyBoundary: historyBoundary.current,
    };
    setSavedThreads(current => [snapshot, ...current.filter(item => item.id !== id)].slice(0, 20));
    return id;
  }
  function startNewConversation(withUndoNotice = false) {
    if (sending) return;
    closeFind(false);
    setSlashOpen(false);
    const archivedId = archiveCurrentThread();
    const nextThreadId = `thread-${++threadSeq.current}`;
    if (withUndoNotice && history.length) {
      setUndo({ history, source: taskSource, archivedId });
      setNotice("Conversation cleared. You can undo this before sending a new message.");
    } else {
      setUndo(null);
      setNotice("");
    }
    setActiveThreadId(nextThreadId);
    setHistory([]);
    setTaskSource(null);
    historyBoundary.current = nextId.current;
    setPhase("draft");
  }
  function switchThread(target: AssistantThread) {
    if (sending || target.id === activeThreadId) return;
    closeFind(false);
    setSlashOpen(false);
    setUndo(null);
    setNotice("");
    const currentSnapshot: AssistantThread | null = history.length
      ? {
          id: activeThreadId,
          title: deriveThreadTitle(history, t("Untitled conversation")),
          updatedAt: Date.now(),
          history,
          taskSource: taskSource ? { ...taskSource } : null,
          historyBoundary: historyBoundary.current,
        }
      : null;
    setSavedThreads(current => {
      const remaining = current.filter(item => item.id !== target.id && item.id !== activeThreadId);
      return currentSnapshot ? [currentSnapshot, ...remaining].slice(0, 20) : remaining;
    });
    setActiveThreadId(target.id);
    setHistory(target.history);
    setTaskSource(target.taskSource ? { ...target.taskSource } : null);
    historyBoundary.current = target.historyBoundary;
    setPhase("draft");
  }
  function removeSavedThread(id: string) {
    if (sending) return;
    setSavedThreads(current => current.filter(item => item.id !== id));
  }
  function applySlashCommand(promptText: string) {
    setSlashOpen(false);
    updateDraft(promptText);
    requestAnimationFrame(() => input.current?.focus());
  }
  const suggestion = suggestionFeedback?.state === "dismissed" && suggestionFeedback.id === draftSuggestion?.id ? null : draftSuggestion;
  function dismissSuggestion() {
    if (!suggestion || dismissedSuggestion.current === suggestion.id) return;
    dismissedSuggestion.current = suggestion.id;
    setSuggestionFeedback({ id: suggestion.id, state: "dismissed" });
    onDismissDraftSuggestion?.(suggestion.id);
    input.current?.focus();
  }
  function addSuggestion() {
    if (!active || !suggestion || sending || activeRequest.current || dismissedSuggestion.current === suggestion.id) return;
    const existing = currentDraft.current;
    const combined = existing ? `${existing}\n\n${suggestion.text}` : suggestion.text;
    if (new TextEncoder().encode(combined).length > MESSAGE_BYTES) {
      setSuggestionFeedback({ id: suggestion.id, state: "too-long" });
      return;
    }
    updateDraft(combined);
    setTaskSource(suggestion.source ? { ...suggestion.source } : null);
    dismissSuggestion();
  }
  function applyRoute(provider: AssistantServiceView["provider"], address: string, serviceId?: string) {
    const route = JSON.stringify([provider, address, serviceId]);
    if (appliedRoute.current && (appliedRoute.current !== route || serviceId !== undefined && provider !== "ollama")) {
      historyBoundary.current = nextId.current;
      setOverview(false);
      setProposalMode(false);
    }
    if (!appliedRoute.current && provider !== "ollama") {
      setOverview(false);
      setProposalMode(false);
    }
    appliedRoute.current = route;
  }
  function openApiKeyEditor(id: string) {
    setApiVisited(true);
    setSettingsMode("api");
    setSettingsOpen(true);
    setKeyEditRequest({ id });
  }
  function rememberSelectedService(serviceId: string) {
    void setDefaultAssistantService(serviceId).then(updated => {
      if (ownsSession()) setPickerServices(updated);
    }).catch(() => {});
  }
  function rememberLocalOllamaModel(targetEndpoint: string, modelName: string) {
    if (!modelName.trim()) return;
    void (async () => {
      try {
        const currentCatalog = pickerServices ?? await readAssistantServices();
        if (!ownsSession()) return;
        const exact = currentCatalog.services.find(
          item => item.provider === "ollama" && item.endpoint === targetEndpoint && item.model === modelName,
        );
        if (exact) {
          const updated = await setDefaultAssistantService(exact.id);
          if (ownsSession()) setPickerServices(updated);
          return;
        }
        const existingLocal = currentCatalog.services.find(item => item.provider === "ollama");
        const savedCatalog = await saveAssistantService({
          ...(existingLocal ? { id: existingLocal.id, name: existingLocal.name } : { name: "Local Ollama" }),
          provider: "ollama",
          endpoint: targetEndpoint,
          model: modelName,
        });
        if (!ownsSession()) return;
        const saved = savedCatalog.services.find(
          item => item.provider === "ollama" && item.endpoint === targetEndpoint && item.model === modelName,
        );
        if (saved) {
          const updated = await setDefaultAssistantService(saved.id);
          if (ownsSession()) setPickerServices(updated);
        } else {
          setPickerServices(savedCatalog);
        }
      } catch {
        // Persistence errors do not disrupt active chat flow.
      }
    })();
  }
  async function loadPickerServices() {
    setPickerLoading(true);
    setPickerError("");
    try {
      const result = await readAssistantServices();
      if (ownsSession()) setPickerServices(result);
    } catch {
      if (ownsSession()) setPickerError("Could not load saved services.");
    } finally {
      if (ownsSession()) setPickerLoading(false);
    }
  }
  function toggleModelPicker() {
    if (sending || cancelling) return;
    const next = !modelPickerOpen;
    setModelPickerOpen(next);
    if (next) void loadPickerServices();
  }
  function applySavedService(service: AssistantServiceView, listLoaded = false, persist = autoLoadDefaultModel) {
    if (!ownsSession() || coordinator?.getSnapshot().blocked || !activePage.current || activeRequest.current) return;
    applyRoute(service.provider, service.endpoint, service.id);
    setCatalog(null); setModel(""); setActiveService(service);
    setKeyRejected(false);
    setModelEvidence(listLoaded ? "list" : "selected");
    setError(""); setConnectionError(""); setDefaultError("");
    setSettingsMode(service.provider === "ollama" ? "local" : "api");
    if (service.provider !== "ollama") setApiVisited(true);
    if (requiresAssistantServiceKey(service.provider) && !service.credentialConfigured) {
      openApiKeyEditor(service.id);
      return;
    }
    if (persist) rememberSelectedService(service.id);
    setKeyEditRequest(null);
    returnToComposerAfterConnection();
  }
  function pickSavedService(service: AssistantServiceView) {
    setModelPickerOpen(false);
    applySavedService(service, false, true);
  }
  async function pickOllamaModel(targetEndpoint: string, targetModel: string) {
    setModelPickerOpen(false);
    if (!ownsSession() || activeRequest.current) return;
    applyRoute("ollama", targetEndpoint);
    setActiveService(null);
    setKeyRejected(false);
    setKeyEditRequest(null);
    setEndpoint(targetEndpoint);
    setModel(targetModel);
    setSettingsMode("local");
    setError("");
    setConnectionError("");
    setDefaultError("");
    if (catalog && catalog.endpoint === targetEndpoint && catalog.models.some(item => item.name === targetModel)) {
      setModelEvidence("list");
    } else {
      setModelEvidence("selected");
      void fetchLocalModels(targetEndpoint).then(result => {
        if (!ownsSession()) return;
        setCatalog(result);
        setEndpoint(result.endpoint);
        setModel(result.models.some(item => item.name === targetModel) ? targetModel : result.models[0]?.name ?? targetModel);
        setModelEvidence("list");
      }).catch(() => {});
    }
    rememberLocalOllamaModel(targetEndpoint, targetModel);
    input.current?.focus();
  }
  async function useDefaultService() {
    if (!ownsSession() || coordinator?.getSnapshot().blocked || !activePage.current || abort.current || cancellationOwner.current?.status === "pending") return;
    const controller = new AbortController(); abort.current = controller;
    setLoading(true); setDefaultError("");
    try {
      const catalog = await readAssistantServices(controller.signal);
      if (!ownsSession() || !activePage.current || controller.signal.aborted) return;
      const selected = catalog.services.find(item => item.id === catalog.defaultId);
      if (selected) applySavedService(selected, false, false);
      else setDefaultError("Set a default in Model services first.");
    } catch { if (ownsSession() && !controller.signal.aborted) setDefaultError("Could not load model services."); }
    finally { if (abort.current === controller) { abort.current = null; if (ownsSession()) setLoading(false); } }
  }
  async function connect() {
    if (!ownsSession() || !activePage.current || abort.current || cancellationOwner.current?.status === "pending") return;
    const previousModel = model;
    setLoading(true); setConnectionError(""); setError(""); setNotice(""); setCatalog(null); setModel("");
    if (!activeService) setModelEvidence("selected");
    const controller = new AbortController(); abort.current = controller;
    const owns = () => ownsSession() && abort.current === controller && !controller.signal.aborted;
    try {
      const result = await fetchLocalModels(endpoint.trim(), controller.signal);
      if (!owns()) return;
      const nextModel = result.models.some(item => item.name === previousModel) ? previousModel : result.models[0]?.name ?? "";
      if (result.models.length > 0) {
        applyRoute("ollama", result.endpoint);
        setActiveService(null); setKeyRejected(false); setKeyEditRequest(null); setModelEvidence("list");
      }
      setCatalog(result); setEndpoint(result.endpoint); setModel(nextModel);
      if (autoLoadDefaultModel && nextModel) rememberLocalOllamaModel(result.endpoint, nextModel);
      if (result.models.length > 0) returnToComposerAfterConnection();
    } catch (error) { if (owns()) setConnectionError(errorMessage(error)); }
    finally { if (abort.current === controller) { abort.current = null; if (ownsSession()) setLoading(false); } }
  }
  async function send() {
    const rawDraft = currentDraft.current, content = rawDraft.trim();
    if (!ownsSession() || !activePage.current || !content || !selectedModel || needsKey || !catalog && !activeService || sending || loading || abort.current || cancellationOwner.current?.status === "pending") return;
    if (new TextEncoder().encode(content).length > MESSAGE_BYTES) { setError("Keep each message within 8 KiB."); return; }
    setSlashOpen(false);
    const context = assistantHistory(history.filter(item => item.id >= historyBoundary.current), content);
    const previousHistory = history;
    const userMessage: ChatMessage = { id: nextId.current++, role: "user", content, source: taskSource ? { ...taskSource } : undefined };
    setHistory(current => [...current, userMessage].slice(-40)); updateDraft(""); setPhase("waiting"); setSending(true); setError(""); setNotice(context.shortened ? "Earlier conversation context was shortened for this request." : ""); setUndo(null);
    const controller = new AbortController(); abort.current = controller;
    const requestId = crypto.randomUUID();
    const operation: ChatOperation = { id: requestId, controller, content: rawDraft, previousHistory, source: taskSource ? { ...taskSource } : null };
    activeRequest.current = operation; cancellationOwner.current = null; setCancellation(null);
    setStartedAt(Date.now()); setWaitedSeconds(0);
    const owns = () => ownsSession() && activeRequest.current === operation && abort.current === controller;
    try {
      const route = activeService ? { serviceId: activeService.id, serviceProvider: activeService.provider, serviceEndpoint: activeService.endpoint } : { endpoint: catalog!.endpoint };
      const result = await sendLocalAssistant({ ...route, model: selectedModel, messages: context.messages, includeWorkspaceOverview: overview, ...(proposalMode ? { proposalMode: true } : {}) }, controller.signal, requestId);
      if (!owns() || controller.signal.aborted) return;
      const reply: ChatMessage = {
        id: nextId.current++,
        role: "assistant",
        content: result.message.content,
        model: result.model,
        durationMs: result.durationMs,
        overview: result.workspaceOverviewIncluded,
        ...(proposalMode ? { proposalMode: true } : {}),
        ...(result.proposal !== undefined ? { proposal: result.proposal } : {}),
        ...(result.proposalParseError !== undefined ? { proposalParseError: result.proposalParseError } : {}),
        source: operation.source ?? undefined,
      };
      setHistory(current => [...current, reply].slice(-40));
      setModelEvidence("reply");
      setPhase("complete");
    } catch (error) {
      if (!owns()) return;
      setHistory(previousHistory); updateDraft(rawDraft);
      if (controller.signal.aborted) { setNotice("Request cancelled. Your draft is ready to edit."); setPhase("cancelled"); }
      else {
        setError(errorMessage(error)); setPhase("failed");
        setModelEvidence(previous => previous === "reply" ? "selected" : previous);
        if (error instanceof AssistantRequestError) {
          if (isRemote && error.code === "auth") { setKeyRejected(true); setModelEvidence("selected"); }
          if (activeService && ["service-changed", "not-found"].includes(error.code)) { setActiveService(null); setKeyRejected(false); setModelEvidence("selected"); setSettingsOpen(true); }
          if (!activeService && ["model-not-found", "model-not-local", "unavailable", "invalid-endpoint"].includes(error.code)) { setConnectionError(errorMessage(error)); setCatalog(null); setModel(""); setModelEvidence("selected"); }
        }
      }
    } finally { if (owns()) { setSending(false); setStartedAt(null); abort.current = null; activeRequest.current = null; } }
  }
  function askCancellation(id: string, reason: Cancellation["reason"]) {
    const attempt: Cancellation = { id, reason, status: "pending" };
    cancellationOwner.current = attempt; setCancellation(attempt);
    const settle = (confirmed: boolean) => {
      if (!ownsSession() || cancellationOwner.current !== attempt) return;
      if (confirmed) {
        cancellationOwner.current = null; setCancellation(null);
        setNotice(reason === "navigation" ? "The request was cancelled when you left AI workspace. Your draft and earlier conversation were kept." : "Request cancelled. Your draft is ready to edit.");
      } else {
        const unconfirmed: Cancellation = { ...attempt, status: "unconfirmed" };
        cancellationOwner.current = unconfirmed; setCancellation(unconfirmed);
      }
    };
    void cancelLocalAssistant(id).then(settle).catch(() => settle(false));
  }
  function cancel(reason: Cancellation["reason"] = "manual") {
    const operation = activeRequest.current;
    if (!operation || !ownsSession()) return;
    // Release the generation's UI ownership before aborting: even a transport
    // that resolves after abort must not append an answer or reset a later draft.
    activeRequest.current = null;
    if (abort.current === operation.controller) abort.current = null;
    operation.controller.abort();
    setHistory(operation.previousHistory); updateDraft(operation.content); setSending(false); setStartedAt(null); setPhase("cancelled"); setError(""); setNotice("");
    askCancellation(operation.id, reason);
  }
  function retryCancellation() {
    const previous = cancellationOwner.current;
    if (ownsSession() && previous?.status === "unconfirmed") askCancellation(previous.id, previous.reason);
  }
  function reuseMessage(content: string, source?: AssistantTaskSource) {
    if (!ownsSession() || !activePage.current || sending || activeRequest.current) return;
    const existing = currentDraft.current;
    const combined = !existing || existing === content ? content : `${existing}\n\n${content}`;
    if (new TextEncoder().encode(combined).length > MESSAGE_BYTES) {
      setError("Adding this text would exceed 8 KiB. Shorten your draft and try again.");
      return;
    }
    updateDraft(combined); if (!existing && source) setTaskSource({ ...source }); setError(""); setNotice("Text added to your draft. Review it before sending."); input.current?.focus();
  }
  function closeFind(restoreFocus: boolean) {
    setFindOpen(false);
    setFindQuery("");
    setFindSelection(null);
    findComposing.current = false;
    if (restoreFocus && activePage.current && ownsSession()) findTrigger.current?.focus({ preventScroll: true });
  }
  function updateFind(value: string) {
    if (!ownsSession() || !activePage.current || !findOpen || value === findQuery) return;
    const first = findConversationMatches(history, latestReplyIndex, value)[0];
    setFindQuery(value);
    setFindSelection(first ? { id: first.id } : null);
  }
  function stepFind(direction: -1 | 1) {
    if (!ownsSession() || !activePage.current || !findMatches.length) return;
    const index = matchIndex < 0 ? (direction > 0 ? 0 : findMatches.length - 1)
      : (matchIndex + direction + findMatches.length) % findMatches.length;
    setFindSelection({ id: findMatches[index]!.id });
  }
  const findStatus = !findQuery.trim() ? "" : !findMatches.length ? t("No matching messages.")
    : matchIndex < 0 ? t("{count} matching messages", { count: findMatches.length })
      : t("{current} of {count} matching messages", { current: matchIndex + 1, count: findMatches.length });
  async function copyReply(content: string) {
    if (!ownsSession() || !activePage.current) return;
    try {
      await copyText(content);
      if (ownsSession() && activePage.current) setNotice("Copied");
    } catch {
      if (ownsSession() && activePage.current) setError("Copy failed. Select and copy the text.");
    }
  }
  async function copyConversation() {
    if (!ownsSession() || !activePage.current || copyInProgress.current || latestReplyId === null) return;
    // Only copy the displayed messages through the last completed reply.
    const copiedText = history.slice(0, latestReplyIndex + 1).flatMap(item => {
      const content = visibleMessageContent(item);
      return content ? [`${t(item.role === "user" ? "You" : "Assistant")}\n${content}`] : [];
    }).join("\n\n");
    copyInProgress.current = true;
    setConversationCopy({ replyId: latestReplyId, status: "pending" });
    let status: ConversationCopy["status"] = "copied";
    try { await copyText(copiedText); }
    catch { status = "failed"; }
    finally {
      copyInProgress.current = false;
      if (ownsSession()) setConversationCopy({ replyId: latestReplyId, status });
    }
  }
  const copyFeedback = conversationCopy && conversationCopy.replyId === latestReplyId ? conversationCopy.status : null;
  const selected = catalog?.models.find(item => item.name === model);
  const cancelling = cancellation?.status === "pending";
  const connectionNeeded = !selectedModel || needsKey;
  const evidenceStatus = missingKey ? "API key required" : keyRejected ? "Model connection needs attention"
    : selectedModel && modelEvidence === "reply" ? "Model replied" : modelEvidence === "list" ? "Model list loaded." : "";
  const statusTone = needsKey ? "attention" : selectedModel && modelEvidence === "reply" ? "connected" : "";
  const phaseMessage = cancellation ? cancellation.status === "unconfirmed" ? "Cancellation could not be confirmed by the local service." : "Confirming cancellation with the local service. Your draft is ready to edit." : {
    draft: "Prepare your draft, then choose when to send it.",
    waiting: isRemote ? "Waiting for the selected model service to return a response." : "Waiting for the local model to return a response.",
    complete: "Response received.",
    failed: "The request failed. Your draft is ready to edit and retry.",
    cancelled: "Request cancelled. Your draft is ready to edit.",
  }[phase];
  const currentThreadTitle = deriveThreadTitle(history, t("Current session"));
  const layoutClass = `assistant-layout${settingsOpen ? " settings-open" : ""}${sessionsCollapsed ? " sessions-collapsed" : ""}`;

  return <div className="workspace assistant-workspace" hidden={!active}>
    <header className={`assistant-tools${settingsOpen ? " showing-settings" : connectionNeeded ? " needs-connection" : ""}`}>
      <div className="assistant-header-left">
        <button
          type="button"
          className="btn xs ghost assistant-sidebar-toggle"
          title={t(sessionsCollapsed ? "Show sessions" : "Hide sessions")}
          aria-label={t(sessionsCollapsed ? "Show sessions" : "Hide sessions")}
          aria-pressed={!sessionsCollapsed}
          onClick={() => setSessionsCollapsed(current => !current)}
        >
          <AppIcon name="collapseRail" className="sm" />
        </button>
        <h1>{t("AI workspace")}</h1>
        <button
          type="button"
          className="assistant-model-summary"
          title={t("Click to configure or switch model")}
          onClick={() => {
            if (settingsOpen) closeSettings("settings");
            else setSettingsOpen(true);
          }}
        >
          <span className={`assistant-status-dot ${statusTone}`} aria-hidden="true" />
          <div>
            <strong>{loading ? t("Loading models…") : selectedModel || t(catalog ? "No local models found" : "Model not connected")}</strong>
            {activeService && <span>{t("Selected service · {service}", { service: activeService.name })}</span>}
            {evidenceStatus && <span className="assistant-model-evidence" data-tone={statusTone} role="status">{t(evidenceStatus)}</span>}
          </div>
        </button>
      </div>
      <div className="assistant-tools-actions">
        <details className="assistant-session-guide">
          <summary>{t("Conversation guide")}</summary>
          <div className="assistant-session-guide-content">
            <p className="assistant-session-caption">{t("Draft and conversation are kept while you navigate within this workspace.")}</p>
            <p>{t("Your conversation stays in this app session. Restarting the app clears it.")}</p>
            <p>{t("Changing workspaces clears this conversation and draft.")}</p>
          </div>
        </details>
        {needsKey && activeService && !settingsOpen && <button className="btn primary" type="button" aria-controls={connectionId} disabled={workspaceBlocked || loading || sending || cancelling} onClick={() => openApiKeyEditor(activeService.id)}>{t("Update API key")}</button>}
        <button ref={settingsTrigger} className={`btn${connectionNeeded && !settingsOpen && !needsKey ? " primary" : ""}`} type="button" aria-controls={connectionId} aria-expanded={settingsOpen} onClick={() => {
          if (settingsOpen) closeSettings("settings");
          else setSettingsOpen(true);
        }}><AppIcon name="settings" className="sm" />{t("Model settings")}</button>
      </div>
    </header>
    {connectionError && !settingsOpen && <div className="assistant-connection-recovery" role="alert"><div><strong>{t("Model connection needs attention")}</strong><p>{t(connectionError)}</p></div><button className="btn xs" type="button" disabled={loading || sending || cancelling} onClick={() => void connect()}>{t("Retry connection")}</button></div>}
    <div className={layoutClass}>
      <aside
        className="assistant-sessions"
        aria-label={t("Sessions")}
        data-collapsed={sessionsCollapsed ? "true" : undefined}
      >
        <div className="assistant-sessions-head">
          <button
            type="button"
            className="btn sm primary assistant-new-session-btn"
            title={t("New chat")}
            aria-label={t("New chat")}
            disabled={sending}
            onClick={() => startNewConversation(false)}
          >
            <AppIcon name="plus" className="sm" />
            <span className="assistant-rail-label">{t("New chat")}</span>
          </button>
        </div>
        <div className="assistant-sessions-label assistant-rail-label">{t("Recent in this session")}</div>
        <div className="assistant-sessions-list">
          <div className="assistant-session-item is-active" title={currentThreadTitle}>
            <span className="assistant-session-dot is-active" aria-hidden="true" />
            <span className="assistant-session-title assistant-rail-label">{currentThreadTitle}</span>
            {history.length > 0 && <span className="assistant-session-count assistant-rail-label">{history.length}</span>}
          </div>
          {savedThreads.map(thread => (
            <div key={thread.id} className="assistant-session-item">
              <button
                type="button"
                className="assistant-session-pick"
                title={thread.title}
                disabled={sending}
                onClick={() => switchThread(thread)}
              >
                <span className="assistant-session-dot" aria-hidden="true" />
                <span className="assistant-session-title assistant-rail-label">{thread.title}</span>
                <span className="assistant-session-count assistant-rail-label">{thread.history.length}</span>
              </button>
              <button
                type="button"
                className="assistant-session-remove"
                aria-label={t("Remove session")}
                disabled={sending}
                onClick={() => removeSavedThread(thread.id)}
              >
                <AppIcon name="close" className="sm" />
              </button>
            </div>
          ))}
        </div>
      </aside>
      <aside ref={connectionPanel} className="assistant-connection" id={connectionId} hidden={!settingsOpen} aria-labelledby={`${connectionId}-heading`} onKeyDown={event => {
        if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || !event.currentTarget.contains(event.target as Node)) return;
        event.preventDefault();
        event.stopPropagation();
        closeSettings("settings");
      }}>
        <header className="assistant-connection-title">
          <h2 id={`${connectionId}-heading`}>{t(onOpenModelServices ? "Model settings" : "Model connection")}</h2>
          <button ref={settingsClose} className="btn xs ghost assistant-settings-close" type="button" aria-label={t("Close model settings")} title={t("Close model settings")} onClick={() => closeSettings("settings")}>
            <AppIcon name="close" />
          </button>
        </header>
        <div className="assistant-connection-body">
          {onOpenModelServices && <div className="assistant-service-mode" role="group" aria-label={t("Model connection method")} data-sliding-group data-sliding-axis="horizontal">
            <button type="button" className="btn xs" aria-pressed={settingsMode === "local"} onClick={() => setSettingsMode("local")}>{t("Local Ollama")}</button>
            <button type="button" className="btn xs" aria-pressed={settingsMode === "api"} onClick={() => { setApiVisited(true); setSettingsMode("api"); }}>{t("API services")}</button>
          </div>}
          <div className="assistant-local-form" hidden={settingsMode !== "local"}>
            <label className="fld"><span>{t("Local service address")}</span><input ref={connectionInput} value={endpoint} spellCheck={false} disabled={loading || sending || cancelling} onChange={event => { setEndpoint(event.target.value); setCatalog(null); setModel(""); setConnectionError(""); if (!activeService) setModelEvidence("selected"); }} /></label>
            <button className="btn primary" type="button" disabled={loading || sending || cancelling} aria-busy={loading} onClick={() => void connect()}>{t(loading ? "Loading models…" : connectionError ? "Retry connection" : "Connect & load models")}</button>
            {connectionError && <p className="feature-alert assistant-connection-error" role="alert">{t(connectionError)}</p>}
            {catalog && <p className="assistant-note" role="status">{t("{count} local models available", { count: catalog.models.length })}</p>}
            {catalog && <><label className="fld"><span>{t("Model")}</span><select value={model} disabled={sending} onChange={event => { const nextModel = event.target.value; setModel(nextModel); if (!activeService) setModelEvidence("list"); if (autoLoadDefaultModel) rememberLocalOllamaModel(catalog.endpoint, nextModel); }}>{!catalog.models.length && <option value="">{t("No local models found")}</option>}{catalog.models.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>{selected && <div className="assistant-model-meta">{selected.parameterSize && <span>{selected.parameterSize}</span>}{selected.quantization && <span>{selected.quantization}</span>}{selected.sizeBytes !== null && <span>{(selected.sizeBytes / 1024 ** 3).toFixed(1)} GB</span>}</div>}{catalog.excludedRemoteModels > 0 && <p className="assistant-note">{t("{count} remote models excluded", { count: catalog.excludedRemoteModels })}</p>}</>}
            <div className="assistant-local-help">
              <p className="assistant-note">{t("This connects to a loopback service. Use Ollama's local-only mode when you need offline inference.")}</p>
              <a className="assistant-docs" href="https://docs.ollama.com/faq" target="_blank" rel="noopener noreferrer">{t("Local model setup guide")} ↗</a>
            </div>
          </div>
          {apiVisited && onOpenModelServices && <AssistantApiSidebar active={active && settingsOpen && settingsMode === "api"} disabled={workspaceBlocked || loading || sending || cancelling} keyEditRequest={keyEditRequest} onApply={applySavedService} />}
          {onOpenModelServices && <div className="assistant-api-actions assistant-service-shortcuts"><button className="btn xs" type="button" disabled={workspaceBlocked || loading || sending || cancelling} onClick={() => void useDefaultService()}>{t("Use default model")}</button><button className="btn xs ghost" type="button" disabled={sending} onClick={onOpenModelServices}>{t("Manage model services")}</button></div>}
          {defaultError && <p className="feature-alert assistant-connection-error" role="alert">{t(defaultError)}</p>}
          <details className="assistant-privacy">
            <summary>
              <AppIcon name="chevronRight" className="sm" />
              <span>{t("Choose the context you share")}</span>
              <small className={overview || proposalMode ? "enabled" : undefined}>{t(overview || proposalMode ? "Context sharing on" : "Context sharing off")}</small>
            </summary>
            <div className="assistant-privacy-options">
              <div className="assistant-privacy-option">
                <label><input type="checkbox" aria-describedby={`${connectionId}-overview`} checked={overview} disabled={sending} onChange={event => setOverview(event.target.checked)} /><span>{t("Include an anonymous workspace overview")}</span></label>
                <p id={`${connectionId}-overview`}>{t("Adds counts of profiles, groups, engines and proxy configuration. Account details and session data are excluded.")}</p>
              </div>
              <div className="assistant-privacy-option">
                <label><input type="checkbox" aria-describedby={`${connectionId}-proposals`} data-assistant-proposal-toggle="true" checked={proposalMode} disabled={sending} onChange={event => setProposalMode(event.target.checked)} /><span>{t("Allow actionable proposals (review before running)")}</span></label>
                <p id={`${connectionId}-proposals`}>{t("Shares redacted profile metadata (ID, name, group, tags, health status) and safe Proxy Vault labels so the model can propose previewable actions. Passwords, cookies, 2FA, proxy credentials, sessions and notes are never sent, and nothing runs automatically.")}</p>
              </div>
            </div>
          </details>
          {onOpenMcp && <div className="assistant-session-info">
            <button className="btn xs ghost" type="button" onClick={onOpenMcp}><AppIcon name="window" className="sm" />{t("Configure MCP connection")}</button>
          </div>}
        </div>
      </aside>
      <section className="assistant-chat" aria-label={t("AI conversation")}>
        {history.length > 0 && <div className="assistant-stage-top">
          <div className="assistant-chat-header">
            <div className="assistant-chat-actions">
              {latestReplyId !== null && <button className="btn xs ghost" type="button" onClick={transcript.readLatestReply}>{t("Read latest response")}</button>}
              {latestReplyId !== null && <button ref={findTrigger} className="btn xs ghost" type="button" aria-expanded={findOpen} aria-controls={findOpen ? findId : undefined} onClick={() => {
                if (!ownsSession() || !activePage.current) return;
                if (findOpen) closeFind(true); else setFindOpen(true);
              }}>{t("Find in conversation")}</button>}
              {latestReplyId !== null && <button className="btn xs ghost" type="button" disabled={conversationCopy?.status === "pending"} aria-busy={conversationCopy?.status === "pending"} onClick={() => void copyConversation()}>{t("Copy conversation")}</button>}
              <button className="btn xs ghost" type="button" disabled={sending} onClick={() => startNewConversation(true)}>{t("New conversation")}</button>
            </div>
          </div>
        </div>}
        {findOpen && latestReplyId !== null && <div id={findId} className="assistant-find" role="search" aria-label={t("Find in conversation")} onKeyDown={event => {
          if (findComposing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeFind(true); }
          if (event.key === "Enter" && event.target === findInput.current && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault(); event.stopPropagation(); stepFind(event.shiftKey ? -1 : 1);
          }
        }}>
          <input ref={findInput} type="search" className="input" maxLength={256} aria-label={t("Search message text")} placeholder={t("Search message text")}
            defaultValue={findQuery} onChange={event => { if (!findComposing.current) updateFind(event.currentTarget.value); }}
            onCompositionStart={() => { findComposing.current = true; }}
            onCompositionEnd={event => { findComposing.current = false; updateFind(event.currentTarget.value); }} />
          <span className="assistant-find-count" role="status">{findStatus}</span>
          <div className="assistant-find-actions">
            <button type="button" className="btn xs ghost" disabled={!findMatches.length} onClick={() => stepFind(-1)}>{t("Previous match")}</button>
            <button type="button" className="btn xs ghost" disabled={!findMatches.length} onClick={() => stepFind(1)}>{t("Next match")}</button>
          </div>
        </div>}
        {copyFeedback === "copied" && <p className="assistant-copy-feedback" role="status">{t("Conversation copied.")}</p>}
        {copyFeedback === "failed" && <p className="assistant-copy-feedback feature-alert" role="alert">{t("Could not copy the conversation. Select and copy the messages.")}</p>}
        {taskSource && <section className="assistant-task-source" aria-label={t("Current task")}><div><span>{t("Current task")}</span><strong>{taskSource.title}</strong>{taskSource.description && <p>{taskSource.description}</p>}</div>{onReturnToTask && <button type="button" className="btn xs" onClick={() => onReturnToTask(taskSource)}>{t("Return to inspection")}</button>}</section>}
        <div className={`assistant-task-progress ${phase}`} hidden={phase === "draft" && !cancellation} data-cancellation={cancellation?.status} aria-label={t("Assistant task progress")}>
          <p role="status">{t(phaseMessage)}</p>
          {sending && <><p className="assistant-waiting-clock" aria-live="off">{t("Local waiting time: {seconds}s", { seconds: waitedSeconds })}</p><p className="assistant-waiting-policy">{t("Leaving this page stops waiting and attempts to cancel this generation.")}</p></>}
          {cancellation?.status === "unconfirmed" && <><p>{t("The response will be ignored. Your draft is ready to edit.")}</p><button className="btn xs" type="button" onClick={retryCancellation}>{t("Retry cancellation")}</button></>}
        </div>
        <div ref={transcript.viewport} onScroll={transcript.onScroll} className={`assistant-messages${history.length ? "" : " is-empty"}`} role="log" aria-live="off" aria-label={t("Conversation history")} tabIndex={0}>
          {!history.length && <div className="assistant-welcome">
            <span className="assistant-welcome-mark"><AppIcon name="bot" /></span>
            <h2>{t("What would you like to work on?")}</h2>
            <p className="assistant-welcome-sub">{t("Supports Markdown code blocks, / commands, and workspace context sharing")}</p>
            <div className="assistant-examples">
              {EXAMPLES.map(example => <button key={example.title} type="button" disabled={sending || loading} onClick={() => reuseMessage(t(example.prompt))}>
                <span>{t(example.title)}</span><AppIcon name="chevronRight" className="sm" />
              </button>)}
            </div>
          </div>}
          {history.map(item => {
            const displayContent = visibleMessageContent(item);
            return <article key={item.id} className={`assistant-message ${item.role}`} data-find-selected={selectedMatch?.id === item.id || undefined}>
              <div className="assistant-message-heading">
                {item.role === "assistant" && <span className="assistant-avatar" aria-hidden="true">AI</span>}
                {item.role === "assistant"
                  ? <h3 tabIndex={-1} data-assistant-reply-heading={item.id}>{t("Assistant")}</h3>
                  : <h3>{t("You")}</h3>}
                {item.model && <span>{item.model}{item.durationMs !== undefined ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ""}</span>}
                {item.role === "assistant" && displayContent && <button className="btn xs ghost" type="button" onClick={() => void copyReply(displayContent)}>{t("Copy")}</button>}
              </div>
              {displayContent && <div className="assistant-message-content">{selectedMatch?.id === item.id ? <>{displayContent.slice(0, selectedMatch.start)}<mark data-assistant-find-match>{displayContent.slice(selectedMatch.start, selectedMatch.end)}</mark>{displayContent.slice(selectedMatch.end)}</> : item.role === "assistant" ? <AssistantMarkdown content={displayContent} /> : displayContent}</div>}
              {item.role === "assistant" && item.proposalParseError && <p className="assistant-proposal-parse-error" role="alert">{t("Action proposal could not be verified: {reason}", { reason: item.proposalParseError })}</p>}
              {item.role === "assistant" && item.proposal && <AssistantProposalCard proposal={item.proposal} disabled={workspaceBlocked} onLocateProfiles={onLocateProfiles} />}
              {item.overview && <span className="assistant-context-label">{t("Anonymous workspace overview included")}</span>}
              {item.proposalMode && <span className="assistant-context-label">{t("Action proposal mode enabled")}</span>}
              {item.role === "assistant" && item.source && <div className="assistant-answer-source">
                <span>{t("From task: {task}", { task: item.source.title })}</span>
                {onReturnToTask && <button className="btn xs ghost" type="button" onClick={() => onReturnToTask(item.source!)}>{t("Return to source inspection")}</button>}
              </div>}
              {displayContent && <div className="assistant-message-actions"><button className="btn xs ghost" type="button" disabled={sending} onClick={() => reuseMessage(displayContent, item.source)}>{t(item.role === "user" ? "Edit request" : "Use response as draft")}</button></div>}
            </article>;
          })}
          {sending && <div className="assistant-generating" aria-hidden="true"><span />{t("Generating a response…")}</div>}
        </div>
        {suggestion && <section className="assistant-suggestion" aria-label={t("Fingerprint explanation draft")}>
          <h3>{t("Fingerprint explanation draft")}</h3>
          {suggestion.source && <p className="assistant-suggestion-source">{t("Suggested task: {task}", { task: suggestion.source.title })}</p>}
          {suggestion.source && onReturnToTask && <button className="btn xs ghost" type="button" onClick={() => onReturnToTask(suggestion.source!)}>{t("Review source inspection")}</button>}
          <p>{t("Preview the anonymous summary and add it to your message when ready.")}</p>
          <details key={suggestion.id}>
            <summary>{t("Preview draft")}</summary>
            <pre tabIndex={0} aria-label={t("Preview draft")}>{suggestion.text}</pre>
          </details>
          {suggestionFeedback?.id === suggestion.id && suggestionFeedback.state === "too-long" && <p className="feature-alert" role="alert">
            {t("Adding this summary would exceed 8 KiB. Shorten your draft and try again.")}
          </p>}
          <div className="assistant-suggestion-actions">
            <button type="button" className="btn xs" disabled={sending} onClick={addSuggestion}>{t("Add to draft")}</button>
            <button type="button" className="btn xs ghost" onClick={dismissSuggestion}>{t("Dismiss suggestion")}</button>
          </div>
        </section>}
        <div ref={composer} className="assistant-composer">
          <div className="assistant-feedback">
            {error && <p className="feature-alert" role="alert">{t(error)}</p>}
            {notice && <p role="status">{t(notice)} {undo && <button className="btn xs" type="button" onClick={() => {
              const archivedId = undo.archivedId;
              setHistory(undo.history); setTaskSource(undo.source); setUndo(null); setNotice("");
              if (archivedId) {
                setActiveThreadId(archivedId);
                setSavedThreads(current => current.filter(item => item.id !== archivedId));
              }
            }}>{t("Undo")}</button>}</p>}
          </div>
          {slashOpen && (
            <div className="assistant-slash-menu" role="menu" aria-label={t("Slash commands")}>
              {SLASH_COMMANDS.map(cmd => (
                <button
                  key={cmd.cmd}
                  type="button"
                  className="assistant-slash-item"
                  onClick={() => applySlashCommand(t(cmd.prompt))}
                >
                  <strong>{t(cmd.cmd)}</strong>
                  <span>{t(cmd.desc)}</span>
                </button>
              ))}
            </div>
          )}
          <label className="assistant-draft">
            <span className="sr-only">{t("Message the assistant")}</span>
            <textarea ref={input} rows={1} maxLength={MESSAGE_BYTES} value={draft} disabled={sending} placeholder={t("Describe your task…")} onChange={event => { if (!activeRequest.current) updateDraft(event.target.value); }} onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (slashOpen && event.key === "Escape") {
                event.preventDefault();
                setSlashOpen(false);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }} />
          </label>
          <div className="assistant-composer-footer">
            <div className="assistant-composer-pills">
              <button
                type="button"
                className={`assistant-ctx-pill${overview ? " is-active" : ""}`}
                aria-pressed={overview}
                disabled={sending}
                onClick={() => setOverview(current => !current)}
              >
                <span>{t("Workspace overview")}</span>
              </button>
              <button
                type="button"
                className={`assistant-ctx-pill${proposalMode ? " is-active" : ""}`}
                aria-pressed={proposalMode}
                disabled={sending}
                onClick={() => setProposalMode(current => !current)}
              >
                <span>{t("Action proposals")}</span>
              </button>
              <button
                type="button"
                className={`assistant-ctx-pill${slashOpen ? " is-active" : ""}`}
                aria-expanded={slashOpen}
                disabled={sending}
                onClick={() => setSlashOpen(current => !current)}
              >
                <span>/ {t("Slash commands")}</span>
              </button>
            </div>
            <div className="assistant-composer-right">
              <span className="assistant-composer-hint">
                {isRemote && activeService
                  ? t("Send to {service}", { service: activeService.name })
                  : t(selectedModel ? "Enter to send · Shift + Enter for new line" : "Connect a model before sending.")}
              </span>
              <div className="assistant-model-picker-wrap" ref={modelPickerWrapRef}>
                <button
                  type="button"
                  className="assistant-model-picker-trigger"
                  title={t("Click to switch model")}
                  aria-haspopup="menu"
                  aria-expanded={modelPickerOpen}
                  disabled={sending || cancelling}
                  onClick={toggleModelPicker}
                >
                  <span className={`assistant-status-dot ${statusTone}`} aria-hidden="true" />
                  <span className="assistant-model-picker-name">
                    {loading ? t("Loading models…") : selectedModel ? shortModelName(selectedModel) : t("Choose model")}
                  </span>
                  <span className="assistant-model-picker-chevron" aria-hidden="true">{modelPickerOpen ? "▴" : "▾"}</span>
                </button>
                {modelPickerOpen && (
                  <div className="assistant-model-popover" role="menu" aria-label={t("Choose model")}>
                    <div className="assistant-model-popover-list">
                      {pickerLoading && <p className="assistant-model-popover-note">{t("Loading services…")}</p>}
                      {pickerError && <p className="assistant-model-popover-note">{t(pickerError)}</p>}
                      <div className="assistant-model-group">
                        <div className="assistant-model-group-title">{t("Saved API services")}</div>
                        {!pickerLoading && !pickerError && (pickerServices?.services.filter(item => item.provider !== "ollama").length ?? 0) === 0
                          ? <p className="assistant-model-popover-note">{t("No saved services yet")}</p>
                          : pickerServices?.services.filter(item => item.provider !== "ollama").map(service => {
                              const isActive = activeService?.id === service.id;
                              const needsCred = requiresAssistantServiceKey(service.provider) && !service.credentialConfigured;
                              return (
                                <button
                                  key={service.id}
                                  type="button"
                                  role="menuitem"
                                  className={`assistant-model-option${isActive ? " is-active" : ""}`}
                                  onClick={() => pickSavedService(service)}
                                >
                                  <span className="assistant-model-option-main">
                                    <span className="assistant-model-option-top">
                                      <span className={`assistant-status-dot ${needsCred ? "warn" : isActive ? "ready" : ""}`} aria-hidden="true" />
                                      <strong>{shortModelName(service.model)}</strong>
                                    </span>
                                    <span className="assistant-model-option-sub">{`${service.name} · ${t(ASSISTANT_SERVICE_LABELS[service.provider])}`}</span>
                                  </span>
                                  {needsCred
                                    ? <span className="assistant-model-option-warn">{t("Key needed")}</span>
                                    : isActive && <span className="assistant-model-option-check" aria-hidden="true">✓</span>}
                                </button>
                              );
                            })}
                      </div>
                      {(() => {
                        const localModels = catalog?.models.map(item => ({
                          key: `catalog:${catalog.endpoint}:${item.name}`,
                          endpoint: catalog.endpoint,
                          model: item.name,
                          label: item.name,
                          sub: catalog.endpoint,
                          service: null as AssistantServiceView | null,
                        })) ?? [];
                        const seen = new Set(localModels.map(item => item.model));
                        for (const service of pickerServices?.services ?? []) {
                          if (service.provider !== "ollama" || seen.has(service.model)) continue;
                          seen.add(service.model);
                          localModels.push({
                            key: `svc:${service.id}`,
                            endpoint: service.endpoint,
                            model: service.model,
                            label: shortModelName(service.model),
                            sub: `${service.name} · ${service.endpoint}`,
                            service,
                          });
                        }
                        if (localModels.length === 0) return null;
                        return (
                          <div className="assistant-model-group">
                            <div className="assistant-model-group-title">{t("Local Ollama models")}</div>
                            {localModels.map(item => {
                              const isActive = item.service
                                ? activeService?.id === item.service.id
                                : (!activeService && model === item.model);
                              return (
                                <button
                                  key={item.key}
                                  type="button"
                                  role="menuitem"
                                  className={`assistant-model-option${isActive ? " is-active" : ""}`}
                                  onClick={() => void pickOllamaModel(item.endpoint, item.model)}
                                >
                                  <span className="assistant-model-option-main">
                                    <span className="assistant-model-option-top">
                                      <span className={`assistant-status-dot ${isActive ? "ready" : ""}`} aria-hidden="true" />
                                      <strong>{item.label}</strong>
                                    </span>
                                    <span className="assistant-model-option-sub">{item.sub}</span>
                                  </span>
                                  {isActive && <span className="assistant-model-option-check" aria-hidden="true">✓</span>}
                                </button>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                    <div className="assistant-model-popover-footer">
                      <button
                        type="button"
                        className="btn xs ghost"
                        onClick={() => {
                          setModelPickerOpen(false);
                          setSettingsMode("local");
                          setSettingsOpen(true);
                        }}
                      >
                        {t("Connect local Ollama")}
                      </button>
                      {onOpenModelServices && (
                        <button
                          type="button"
                          className="btn xs ghost"
                          onClick={() => {
                            setModelPickerOpen(false);
                            onOpenModelServices();
                          }}
                        >
                          {t("Manage model services")}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
              {sending
                ? <button className="btn" type="button" onClick={() => cancel()}>{t("Cancel request")}</button>
                : <button className="btn primary" type="button" disabled={loading || cancelling || needsKey || !selectedModel || !draft.trim()} onClick={() => void send()}>{t("Send message")} ↑</button>}
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>;
}
