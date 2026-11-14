import type { ProxyCheckView } from "../proxy-tools-types.ts";
import { parsePastedProxy } from "./proxy-input.ts";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Reconstruct only protocol/host/port. Never fall back to the supplied string. */
export function proxySummaryEndpoint(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? new URL(value) : null;
    if (url && !["http:", "https:", "socks5:"].includes(url.protocol)) return null;
    const parsed = url ? { type: url.protocol.slice(0, -1), host: url.hostname.replace(/^\[|\]$/g, ""), port: url.port || (url.protocol === "http:" ? "80" : url.protocol === "https:" ? "443" : "") } : parsePastedProxy(value);
    if (!/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535) return null;
    if (!/^[a-z0-9._:-]+$/i.test(parsed.host)) return null;
    const host = parsed.host.includes(":") ? `[${parsed.host}]` : parsed.host;
    const normalized = new URL(`http://${host}:${parsed.port}/`);
    if (!normalized.hostname || normalized.username || normalized.password) return null;
    return `${parsed.type}://${normalized.hostname}:${parsed.port}`;
  } catch { return null; }
}

// Names and folders are user metadata, but may themselves contain pasted credentials.
function summaryField(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1[redacted]@")
    .replace(/((?:\[[^\]]+\]|[a-z0-9._-]+):\d{1,5}):[^:\s;,]+:[^\s;,]+/gi, "$1:[redacted]")
    .replace(/(["']?\b(?:proxy-authorization|authorization|token)\b["']?)\s*[:=]\s*["']?(?:basic|bearer)\s+[^"'\s,;]+["']?/gi, "$1=[redacted]")
    .replace(/(["']?\b(?:password|passwd|proxy-authorization|authorization|token|secret)\b["']?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/[\u0000-\u0020\u007f]+/g, " ").trim();
}

/** All completed problem rows, independent of visible-page/search filters. No raw reason, key, or exit IP is exported. */
export function proxyProblemSummary(rows: readonly ProxyCheckView[], options: {
  t: Translate;
  complete: boolean;
  needsRefresh?: boolean;
  statusLabel: (status: ProxyCheckView["status"]) => string;
  reasonLabel: (reason: string) => string;
}): string {
  const problems = rows.filter(row => row.status !== "working"), { t } = options;
  const environments = new Set(problems.flatMap(row => row.profiles.map(profile => profile.id))).size;
  return [
    t("Proxy problem summary"),
    t("{connections} problem results · {environments} affected environments", { connections: problems.length, environments }),
    t(options.needsRefresh ? "Changed or unconfirmed environments were removed from these results. Run a new check to include them again."
      : options.complete ? "The check run finished. This summary includes all completed problem results."
      : "Partial results only. The check run is unfinished or was interrupted; environments without results have not been verified."),
    t("Proxy authentication fields and exit IPs are omitted. Environment names, IDs and folders are included."),
    t("Reachability does not verify IP reputation, a separate exit, or browser leaks."),
    "",
    [t("Proxy address"), t("Connection"), t("Reason"), t("Affected environments")].join("\t"),
    ...problems.map(row => [
      row.proxy ? proxySummaryEndpoint(row.proxy) ?? t("Proxy address hidden: unreadable format") : t("No proxy assigned"),
      options.statusLabel(row.status),
      row.reason ? options.reasonLabel(row.reason) : "—",
      row.profiles.map(profile => `${summaryField(profile.name || profile.id)} (${summaryField(profile.id)}; ${summaryField(profile.group || t("Ungrouped"))})`).join("; "),
    ].map(summaryField).join("\t")),
  ].join("\n");
}
