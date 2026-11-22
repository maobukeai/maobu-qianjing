import * as React from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import { AssistantRequestError, cancelLocalAssistant, fetchLocalModels, sendLocalAssistant, stripProposalFence, type AnomalyCriterion, type CompiledProposalView, type LocalModelCatalog } from "./local-assistant-api.ts";
import "./local-assistant.css";
import { assistantHistory } from "./assistant-history.ts";
import { useAssistantTranscriptPosition } from "./assistant-transcript-position.ts";
import { copyText } from "./clipboard.ts";
import { useDesktopCloseDraft } from "./desktop-close.tsx";
import { useOptionalWorkspaceOperations, type WorkspaceOperationCoordinator } from "./workspace-operations.tsx";
import { readAssistantServices, requiresAssistantServiceKey, type AssistantServiceView } from "./assistant-services-api.ts";
import { AssistantApiSidebar } from "./assistant-api-sidebar.tsx";
import { AssistantProposalCard } from "./assistant-proposal-card.tsx";

interface ChatMessage { id: number; role: "user" | "assistant"; content: string; model?: string; durationMs?: number; overview?: boolean; proposalMode?: boolean; proposal?: CompiledProposalView | null; proposalParseError?: string; source?: AssistantTaskSource }
export interface AssistantTaskSource { title: string; description?: string; returnKey?: string }
export interface AssistantDraftSuggestion { id: number; text: string; source?: AssistantTaskSource }
type TaskPhase = "draft" | "waiting" | "complete" | "failed" | "cancelled";
const MESSAGE_BYTES = 8 * 1024;
const EXAMPLES = [
  { title: "Plan a browser workflow", prompt: "Help me plan a repeatable browser testing workflow. Break it into clear steps and explain which steps can use MCP." },
  { title: "Draft a Playwright script", prompt: "Draft a Playwright script that checks the title and accessibility of my own test website. Ask for the website URL if it is missing." },
  { title: "Understand fingerprint checks", prompt: "Explain how timezone, language, screen size and browser engine consistency affect a browser profile. Give me a practical inspection checklist." },
];
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

interface LocalAssistantPageProps {
  active: boolean;
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
  if (!item.proposal) return item.content;
  const prose = stripProposalFence(item.content);
  return prose || item.content;
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

function LocalAssistantSession({ active, onOpenMcp, onOpenModelServices, draftSuggestion, onDismissDraftSuggestion, onReturnToTask, onLocateProfiles, workspaceId, coordinator, workspaceBlocked }: LocalAssistantPageProps & { workspaceId: string; coordinator?: WorkspaceOperationCoordinator; workspaceBlocked: boolean }) {
  const { t } = useTranslation();
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:11434"), [catalog, setCatalog] = useState<LocalModelCatalog | null>(null), [model, setModel] = useState("");
  const [loading, setLoading] = useState(false), [sending, setSending] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [draft, setDraft] = useState(""), [overview, setOverview] = useState(false), [proposalMode, setProposalMode] = useState(false), [history, setHistory] = useState<ChatMessage[]>([]);
  const [undo, setUndo] = useState<{ history: ChatMessage[]; source: AssistantTaskSource | null } | null>(null);
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
  // The task's local display name is deliberately separate from the anonymous
  // text the user may choose to add and send to the model.
  const [taskSource, setTaskSource] = useState<AssistantTaskSource | null>(null);
  const [cancellation, setCancellation] = useState<Cancellation | null>(null);
  const cancellationOwner = useRef<Cancellation | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null), [waitedSeconds, setWaitedSeconds] = useState(0);
  const connectionId = useId();
  const connectionInput = useRef<HTMLInputElement>(null);
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
  useEffect(() => { if (settingsOpen && settingsMode === "local" && activePage.current) connectionInput.current?.focus(); }, [settingsOpen, settingsMode]);
  function updateDraft(value: string) {
    currentDraft.current = value;
    setDraft(value);
    setPhase("draft");
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
  function applySavedService(service: AssistantServiceView, listLoaded = false) {
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
    setKeyEditRequest(null);
    setSettingsOpen(false); input.current?.focus();
  }
  async function useDefaultService() {
    if (!ownsSession() || coordinator?.getSnapshot().blocked || !activePage.current || abort.current || cancellationOwner.current?.status === "pending") return;
    const controller = new AbortController(); abort.current = controller;
    setLoading(true); setDefaultError("");
    try {
      const catalog = await readAssistantServices(controller.signal);
      if (!ownsSession() || !activePage.current || controller.signal.aborted) return;
      const selected = catalog.services.find(item => item.id === catalog.defaultId);
      if (selected) applySavedService(selected);
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
      if (result.models.length > 0) {
        applyRoute("ollama", result.endpoint);
        setActiveService(null); setKeyRejected(false); setKeyEditRequest(null); setModelEvidence("list");
      }
      setCatalog(result); setEndpoint(result.endpoint); setModel(result.models.some(item => item.name === previousModel) ? previousModel : result.models[0]?.name ?? "");
      if (result.models.length > 0) { setSettingsOpen(false); if (activePage.current) input.current?.focus(); }
    } catch (error) { if (owns()) setConnectionError(errorMessage(error)); }
    finally { if (abort.current === controller) { abort.current = null; if (ownsSession()) setLoading(false); } }
  }
  async function send() {
    const rawDraft = currentDraft.current, content = rawDraft.trim();
    if (!ownsSession() || !activePage.current || !content || !selectedModel || needsKey || !catalog && !activeService || sending || loading || abort.current || cancellationOwner.current?.status === "pending") return;
    if (new TextEncoder().encode(content).length > MESSAGE_BYTES) { setError("Keep each message within 8 KiB."); return; }
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
  async function copyConversation() {
    if (!ownsSession() || !activePage.current || copyInProgress.current || latestReplyId === null) return;
    // Only copy the displayed messages through the last completed reply.
    const copiedText = history.slice(0, latestReplyIndex + 1)
      .map(({ role, content }) => `${t(role === "user" ? "You" : "Assistant")}\n${content}`).join("\n\n");
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
  const evidenceStatus = missingKey ? "API key required for this session" : keyRejected ? "Model connection needs attention"
    : selectedModel && modelEvidence === "reply" ? "Model replied" : modelEvidence === "list" ? "Model list loaded." : "";
  const statusTone = needsKey ? "attention" : selectedModel && modelEvidence === "reply" ? "connected" : "";
  const phaseMessage = cancellation ? cancellation.status === "unconfirmed" ? "Cancellation could not be confirmed by the local service." : "Confirming cancellation with the local service. Your draft is ready to edit." : {
    draft: "Prepare your draft, then choose when to send it.",
    waiting: isRemote ? "Waiting for the selected model service to return a response." : "Waiting for the local model to return a response.",
    complete: "Response received.",
    failed: "The request failed. Your draft is ready to edit and retry.",
    cancelled: "Request cancelled. Your draft is ready to edit.",
  }[phase];
  return <div className="workspace assistant-workspace" hidden={!active}>
    <div className="page-heading"><div><h1>{t("AI workspace")}</h1><p className="page-subtitle">{t(onOpenModelServices ? "Ask questions, plan browser workflows and draft scripts with your selected model." : "Ask questions, plan browser workflows and draft scripts with a model service on this computer.")}</p></div></div>
    <div className={`assistant-tools${connectionNeeded ? " needs-connection" : ""}`}>
      <div className="assistant-model-summary"><span className={`assistant-status-dot ${statusTone}`} aria-hidden="true" /><div><strong>{loading ? t("Loading models…") : selectedModel || t(catalog ? "No local models found" : "Model not connected")}</strong>{activeService ? <span>{t("Selected service · {service}", { service: activeService.name })}</span> : !catalog && <span>{t(onOpenModelServices ? "Choose a model when you are ready to send." : "Connect a local model when you are ready to send.")}</span>}{evidenceStatus && <span className="assistant-model-evidence" data-tone={statusTone} role="status">{t(evidenceStatus)}</span>}</div></div>
      <div className="assistant-tools-actions">
        {needsKey && activeService && !settingsOpen && <button className="btn primary xs" type="button" aria-controls={connectionId} disabled={workspaceBlocked || loading || sending || cancelling} onClick={() => openApiKeyEditor(activeService.id)}>{t("Update API key")}</button>}
        <button className={`btn xs ${connectionNeeded && !settingsOpen && !needsKey ? "primary" : "ghost"}`} type="button" aria-controls={connectionId} aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}>{t("Model settings")}</button>
      </div>
    </div>
    {connectionError && !settingsOpen && <div className="assistant-connection-recovery" role="alert"><div><strong>{t("Model connection needs attention")}</strong><p>{t(connectionError)}</p></div><button className="btn xs" type="button" disabled={loading || sending || cancelling} onClick={() => void connect()}>{t("Retry connection")}</button></div>}
    <div className={`assistant-layout${settingsOpen ? " settings-open" : ""}`}><aside className="assistant-connection" id={connectionId} hidden={!settingsOpen} aria-label={t("Model connection")}><div className="assistant-connection-title"><span className={`assistant-status-dot ${statusTone}`} aria-hidden="true" /><h2>{t(onOpenModelServices ? "Model settings" : "Model connection")}</h2></div>
      {onOpenModelServices && <div className="assistant-service-mode" role="group" aria-label={t("Model connection method")}>
        <button type="button" className="btn xs" aria-pressed={settingsMode === "local"} onClick={() => setSettingsMode("local")}>{t("Local Ollama")}</button>
        <button type="button" className="btn xs" aria-pressed={settingsMode === "api"} onClick={() => { setApiVisited(true); setSettingsMode("api"); }}>{t("API services")}</button>
      </div>}
      <div className="assistant-local-form" hidden={settingsMode !== "local"}>
      <label className="fld"><span>{t("Local service address")}</span><input ref={connectionInput} value={endpoint} spellCheck={false} disabled={loading || sending || cancelling} onChange={event => { setEndpoint(event.target.value); setCatalog(null); setModel(""); setConnectionError(""); if (!activeService) setModelEvidence("selected"); }} /></label>
      <button className="btn" type="button" disabled={loading || sending || cancelling} aria-busy={loading} onClick={() => void connect()}>{t(loading ? "Loading models…" : connectionError ? "Retry connection" : "Connect & load models")}</button>
      {connectionError && <p className="feature-alert assistant-connection-error" role="alert">{t(connectionError)}</p>}
      {catalog && <p className="assistant-note" role="status">{t("{count} local models available", { count: catalog.models.length })}</p>}
      {catalog && <><label className="fld"><span>{t("Model")}</span><select value={model} disabled={sending} onChange={event => { setModel(event.target.value); if (!activeService) setModelEvidence("list"); }}>{!catalog.models.length && <option value="">{t("No local models found")}</option>}{catalog.models.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>{selected && <div className="assistant-model-meta">{selected.parameterSize && <span>{selected.parameterSize}</span>}{selected.quantization && <span>{selected.quantization}</span>}{selected.sizeBytes !== null && <span>{(selected.sizeBytes / 1024 ** 3).toFixed(1)} GB</span>}</div>}{catalog.excludedRemoteModels > 0 && <p className="assistant-note">{t("{count} remote models excluded", { count: catalog.excludedRemoteModels })}</p>}</>}
      <p className="assistant-note">{t("This connects to a loopback service. Use Ollama's local-only mode when you need offline inference.")}</p><a className="assistant-docs" href="https://docs.ollama.com/faq" target="_blank" rel="noopener noreferrer">{t("Local model setup guide")} ↗</a>
      </div>
      {apiVisited && onOpenModelServices && <AssistantApiSidebar active={active && settingsOpen && settingsMode === "api"} disabled={workspaceBlocked || loading || sending || cancelling} keyEditRequest={keyEditRequest} onApply={applySavedService} />}
      {onOpenModelServices && <div className="assistant-api-actions assistant-service-shortcuts"><button className="btn xs" type="button" disabled={workspaceBlocked || loading || sending || cancelling} onClick={() => void useDefaultService()}>{t("Use default model")}</button><button className="btn xs ghost" type="button" disabled={sending} onClick={onOpenModelServices}>{t("Manage model services")}</button></div>}
      {defaultError && <p className="feature-alert assistant-connection-error" role="alert">{t(defaultError)}</p>}
      <div className="assistant-privacy"><strong>{t("Choose the context you share")}</strong><label><input type="checkbox" checked={overview} disabled={sending} onChange={event => setOverview(event.target.checked)} /><span>{t("Include an anonymous workspace overview")}</span></label><p>{t("Adds counts of profiles, groups, engines and proxy configuration. Account details and session data are excluded.")}</p><label className="assistant-proposal-toggle"><input type="checkbox" data-assistant-proposal-toggle="true" checked={proposalMode} disabled={sending} onChange={event => setProposalMode(event.target.checked)} /><span>{t("Allow actionable proposals (review before running)")}</span></label><p>{t("Shares redacted profile metadata (ID, name, group, tags, health status) and safe Proxy Vault labels so the model can propose previewable actions. Passwords, cookies, 2FA, proxy credentials, sessions and notes are never sent, and nothing runs automatically.")}</p></div>
      {onOpenMcp && <div className="assistant-session-info"><strong>{t("Browser tools")}</strong><p>{t("Connect your MCP client to run browser workflows alongside these plans and drafts.")}</p><button className="btn xs" type="button" onClick={onOpenMcp}>{t("Configure MCP connection")}</button></div>}
    </aside><section className="assistant-chat" aria-label={t("AI conversation")}>
      <div className="assistant-chat-header">
        {history.length === 0 && <span>{t("Plans, explanations and script drafts")}</span>}
        {history.length > 0 && <div className="assistant-chat-actions">
          {latestReplyId !== null && <button className="btn xs ghost" type="button" onClick={transcript.readLatestReply}>{t("Read latest response")}</button>}
          {latestReplyId !== null && <button ref={findTrigger} className="btn xs ghost" type="button" aria-expanded={findOpen} aria-controls={findOpen ? findId : undefined} onClick={() => {
            if (!ownsSession() || !activePage.current) return;
            if (findOpen) closeFind(true); else setFindOpen(true);
          }}>{t("Find in conversation")}</button>}
          {latestReplyId !== null && <button className="btn xs ghost" type="button" disabled={conversationCopy?.status === "pending"} aria-busy={conversationCopy?.status === "pending"} onClick={() => void copyConversation()}>{t("Copy conversation")}</button>}
          <button className="btn xs ghost" type="button" disabled={sending} onClick={() => {
            closeFind(false);
            setUndo({ history, source: taskSource }); setHistory([]); setTaskSource(null); setPhase("draft");
            setNotice("Conversation cleared. You can undo this before sending a new message.");
          }}>{t("New conversation")}</button>
        </div>}
      </div>
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
      <details className="assistant-session-guide">
        <summary>{t("Conversation guide")}</summary>
        <div className="assistant-session-guide-content">
          <strong>{t("Session memory")}</strong>
          <p className="assistant-session-caption">{t("Draft and conversation are kept while you navigate within this workspace.")}</p>
          <p>{t("Your conversation stays in this app session. Restarting the app clears it.")}</p>
          <p>{t("Changing workspaces clears this conversation and draft.")}</p>
          <ol className="assistant-workflow-steps"><li><span>1</span>{t("Prepare draft")}</li><li><span>2</span>{t("Generate suggestions")}</li><li><span>3</span>{t("Review and verify")}</li></ol>
        </div>
      </details>
      {taskSource && <section className="assistant-task-source" aria-label={t("Current task")}><div><span>{t("Current task")}</span><strong>{taskSource.title}</strong>{taskSource.description && <p>{taskSource.description}</p>}</div>{onReturnToTask && <button type="button" className="btn xs" onClick={() => onReturnToTask(taskSource)}>{t("Return to inspection")}</button>}</section>}
      <div className={`assistant-task-progress ${phase}`} hidden={phase === "draft" && !cancellation} data-cancellation={cancellation?.status} aria-label={t("Assistant task progress")}>
        <p role="status">{t(phaseMessage)}</p>
        {sending && <><p className="assistant-waiting-clock" aria-live="off">{t("Local waiting time: {seconds}s", { seconds: waitedSeconds })}</p><p className="assistant-waiting-policy">{t("Leaving this page stops waiting and attempts to cancel this generation.")}</p></>}
        {cancellation?.status === "unconfirmed" && <><p>{t("The response will be ignored. Your draft is ready to edit.")}</p><button className="btn xs" type="button" onClick={retryCancellation}>{t("Retry cancellation")}</button></>}
      </div>
      <div ref={transcript.viewport} onScroll={transcript.onScroll} className="assistant-messages" role="log" aria-live="off" aria-label={t("Conversation history")} tabIndex={0}>
        {!history.length && <div className="assistant-welcome"><span className="assistant-welcome-mark" aria-hidden="true">✦</span><h2>{t("What would you like to work on?")}</h2><p>{t("Start with a question or use one of these prompts as a draft.")}</p><div className="assistant-examples">{EXAMPLES.map(example => <button key={example.title} type="button" disabled={sending || loading} onClick={() => reuseMessage(t(example.prompt))}><strong>{t(example.title)}</strong><span aria-hidden="true">↗</span></button>)}</div></div>}
        {history.map(item => {
          const displayContent = visibleMessageContent(item);
          return <article key={item.id} className={`assistant-message ${item.role}`} data-find-selected={selectedMatch?.id === item.id || undefined}>
          <div className="assistant-message-heading">
            {item.role === "assistant"
              ? <h3 tabIndex={-1} data-assistant-reply-heading={item.id}>{t("Assistant")}</h3>
              : <h3>{t("You")}</h3>}
            {item.model && <span>{item.model}{item.durationMs !== undefined ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ""}</span>}
            {item.role === "assistant" && <button className="btn xs ghost" type="button" onClick={() => {
              void copyText(item.content).then(() => setNotice("Copied")).catch(() => setError("Copy failed. Select and copy the text."));
            }}>{t("Copy")}</button>}
          </div>
          <div className="assistant-message-content">{selectedMatch?.id === item.id ? <>{displayContent.slice(0, selectedMatch.start)}<mark data-assistant-find-match>{displayContent.slice(selectedMatch.start, selectedMatch.end)}</mark>{displayContent.slice(selectedMatch.end)}</> : displayContent}</div>
          {item.role === "assistant" && item.proposalParseError && <p className="assistant-proposal-parse-error" role="alert">{t("Action proposal could not be verified: {reason}", { reason: item.proposalParseError })}</p>}
          {item.role === "assistant" && item.proposal && <AssistantProposalCard proposal={item.proposal} disabled={workspaceBlocked} onLocateProfiles={onLocateProfiles} />}
          {item.overview && <span className="assistant-context-label">{t("Anonymous workspace overview included")}</span>}
          {item.proposalMode && <span className="assistant-context-label">{t("Action proposal mode enabled")}</span>}
          {item.role === "assistant" && item.source && <div className="assistant-answer-source">
            <span>{t("From task: {task}", { task: item.source.title })}</span>
            {onReturnToTask && <button className="btn xs ghost" type="button" onClick={() => onReturnToTask(item.source!)}>{t("Return to source inspection")}</button>}
          </div>}
          <div className="assistant-message-actions"><button className="btn xs ghost" type="button" disabled={sending} onClick={() => reuseMessage(item.content, item.source)}>{t(item.role === "user" ? "Edit request" : "Use response as draft")}</button></div>
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
      <div ref={composer} className="assistant-composer"><div className="assistant-feedback">{error && <p className="feature-alert" role="alert">{t(error)}</p>}{notice && <p role="status">{t(notice)} {undo && <button className="btn xs" type="button" onClick={() => { setHistory(undo.history); setTaskSource(undo.source); setUndo(null); setNotice(""); }}>{t("Undo")}</button>}</p>}</div><label className="assistant-draft"><span className="sr-only">{t("Message the assistant")}</span><textarea ref={input} rows={3} maxLength={MESSAGE_BYTES} value={draft} disabled={sending} placeholder={t("Describe your task…")} onChange={event => { if (!activeRequest.current) updateDraft(event.target.value); }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /></label><div className="assistant-composer-footer"><span className="assistant-composer-meta">{isRemote && activeService ? t("Send to {service}", { service: activeService.name }) : t(selectedModel ? "Ctrl / ⌘ + Enter to send" : "Connect a model before sending.")}{proposalMode && <span className="assistant-proposal-mode-pill">{t("Action proposals on")}</span>}</span>{sending ? <button className="btn" type="button" onClick={() => cancel()}>{t("Cancel request")}</button> : <button className="btn primary" type="button" disabled={loading || cancelling || needsKey || !selectedModel || !draft.trim()} onClick={() => void send()}>{t("Send message")} ↑</button>}</div></div>
    </section></div>
  </div>;
}
