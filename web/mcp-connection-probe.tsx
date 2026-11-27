import { useLayoutEffect, useRef, useState } from "react";
import { ALIASMODE_VERSION } from "../src/version.ts";
import type { IntegrationProbeResult } from "../agent/integration-probe.ts";
import { copyText } from "./clipboard.ts";
import { useTranslation } from "./i18n.tsx";
import { probeIntegration } from "./settings-api.ts";
import "./mcp-connection-probe.css";

type VerifiedCheck = { status: "connected"; checkedAt: number; toolCount: number };
type UnverifiedCheck = { status: "unavailable" | "timeout" | "failed"; checkedAt: number };
type LocalCheck = VerifiedCheck | UnverifiedCheck;
type ProbeHistory = { revision: number; latest: LocalCheck; verified: VerifiedCheck | null };

const details: Record<LocalCheck["status"], string> = {
  connected: "The local MCP handshake and tool discovery succeeded.",
  unavailable: "Local MCP resources are unavailable. Refresh connection info before trying again.",
  timeout: "The local MCP check timed out. Try again.",
  failed: "The local MCP check failed. Try again.",
};
const MAX_PROBE_TOOL_COUNT = 512;
const MAX_DATE_MS = 8_640_000_000_000_000;

/** Keep a bounded receipt without retaining tool names, helper output or configuration. */
function localCheck(result: IntegrationProbeResult, attemptedAt: number): LocalCheck {
  const validTime = Number.isSafeInteger(result.checkedAt) && result.checkedAt > 0 && result.checkedAt <= MAX_DATE_MS;
  const checkedAt = validTime ? result.checkedAt : attemptedAt;
  if (result.status === "connected" && result.connectionVerified === true && validTime
      && result.server?.name === "aliasmode" && result.server.version === ALIASMODE_VERSION
      && Number.isSafeInteger(result.toolCount) && result.toolCount > 0 && result.toolCount <= MAX_PROBE_TOOL_COUNT
      && result.tools.length === result.toolCount) {
    return { status: "connected", checkedAt, toolCount: result.toolCount };
  }
  const status = result.status === "unavailable" || result.status === "timeout" ? result.status : "failed";
  return { status, checkedAt };
}

export function McpConnectionProbe({ active, ready, catalogRevision, onBusyChange }: {
  active: boolean;
  ready: boolean;
  catalogRevision: number;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t, language } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ProbeHistory | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ check: LocalCheck; copied: boolean } | null>(null);
  const pending = useRef<{ revision: number } | null>(null);
  const owner = useRef({ mounted: false, catalogRevision, onBusyChange });

  useLayoutEffect(() => {
    owner.current.catalogRevision = catalogRevision;
    owner.current.onBusyChange = onBusyChange;
  }, [catalogRevision, onBusyChange]);

  useLayoutEffect(() => {
    owner.current.mounted = true;
    return () => {
      owner.current.mounted = false;
      if (pending.current) {
        pending.current = null;
        owner.current.onBusyChange?.(false);
      }
    };
  }, []);

  async function runCheck() {
    if (!active || !ready || pending.current) return;
    const request = { revision: catalogRevision };
    pending.current = request;
    setBusy(true);
    setCopyFeedback(null);
    owner.current.onBusyChange?.(true);
    const attemptedAt = Date.now();
    let result: LocalCheck;
    try {
      result = localCheck(await probeIntegration(), attemptedAt);
    } catch {
      result = { status: "failed", checkedAt: attemptedAt };
    }
    if (pending.current !== request) return;
    if (owner.current.catalogRevision === request.revision) {
      setHistory(previous => ({
        revision: request.revision,
        latest: result,
        verified: result.status === "connected" ? result : previous?.revision === request.revision ? previous.verified : null,
      }));
    }
    pending.current = null;
    setBusy(false);
    owner.current.onBusyChange?.(false);
  }

  const current = history?.revision === catalogRevision ? history : null;
  const check = current?.latest;
  const lastVerified = check?.status !== "connected" ? current?.verified : null;
  const statusLabel = check?.status === "connected" ? "Connection verified" : "Connection not verified";

  function checkTime(checkedAt: number) {
    return (
      <time dateTime={new Date(checkedAt).toISOString()}>
        {new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "medium" }).format(checkedAt)}
      </time>
    );
  }

  async function copySummary() {
    if (!check || !active || !ready || pending.current) return;
    const summary = [t(statusLabel), t("Last checked {time}", { time: new Date(check.checkedAt).toISOString() })];
    if (check.status === "connected") {
      summary.push(t("MCP server version {version}", { version: ALIASMODE_VERSION }), t("{count} tools discovered", { count: check.toolCount }));
    }
    let copied = false;
    try {
      await copyText(summary.join("\n"));
      copied = true;
    } catch {}
    if (owner.current.mounted) setCopyFeedback({ check, copied });
  }

  return (
    <div className="mcp-connection-probe" hidden={!active} inert={!active || undefined}>
      <div className="mcp-probe-actions">
        <button className="btn" type="button" disabled={!active || !ready || busy} aria-busy={busy} onClick={() => void runCheck()}>
          {t(busy ? "Checking MCP connection…" : "Test MCP connection")}
        </button>
        <span className="muted">{t("Checks initialization and tool discovery without opening a browser.")}</span>
      </div>
      {history && !current && ready && <p className="mcp-probe-note" role="status">{t("Connection info changed. Test again to verify it.")}</p>}
      {check && (
        <div className="mcp-probe-result">
          <div className="mcp-probe-result-detail" role="status">
            <div className="mcp-probe-result-meta">
              <span className={`feature-badge${check.status === "connected" ? " positive" : ""}`}>{t(statusLabel)}</span>
              <span>{t("Last checked")} {checkTime(check.checkedAt)}</span>
            </div>
            <p>{t(details[check.status])}</p>
            {check.status === "connected" && (
              <div className="mcp-probe-result-meta">
                <span>{t("MCP server version {version}", { version: ALIASMODE_VERSION })}</span>
                <span>{t("{count} tools discovered", { count: check.toolCount })}</span>
              </div>
            )}
            {lastVerified && <p>{t("Last verified")} {checkTime(lastVerified.checkedAt)}</p>}
          </div>
          <span className="feature-copy">
            <button className="btn xs" type="button" disabled={!active || !ready || busy} onClick={() => void copySummary()}>{t("Copy check summary")}</button>
            <span role="status">{copyFeedback?.check === check ? t(copyFeedback.copied ? "Copied" : "Copy failed. Select and copy the text.") : ""}</span>
          </span>
        </div>
      )}
    </div>
  );
}
