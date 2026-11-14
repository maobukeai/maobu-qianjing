/** Reachability and exit comparison are separate observations. */
export function proxyExitNote(result: { status: string; reason?: string; exitComparison?: "same" | "different" | "unknown" }): string | null {
  if (result.status !== "working" && result.status !== "unstable") return null;
  if (result.exitComparison === "same" || result.reason === "same_exit") return "At least one observed exit matches the system network. Reachability is confirmed; a separate exit is not confirmed.";
  if (result.exitComparison === "different") return "Exit differs from the system network. IP reputation and browser leaks need separate checks.";
  if (result.exitComparison === "unknown") return "The system exit was unavailable for comparison. This result confirms proxy reachability.";
  return null;
}

export function proxyCheckNote(result: { status: string; reason?: string; exitComparison?: "same" | "different" | "unknown" }): string | null {
  const comparison = proxyExitNote(result);
  if (comparison) return comparison;
  if (result.status === "unavailable") return "Proxy check is unavailable. Try again later.";
  if (result.status === "unstable") return "Proxy checks were mixed.";
  if (result.status !== "failed") return null;
  const reasons: Record<string, string> = {
    authentication_failed: "Proxy authentication failed.", timeout: "Proxy connection timed out.",
    dns_failed: "Proxy host could not be resolved.", unreachable: "Proxy server is unreachable.",
    proxy_bypassed: "Traffic did not use this proxy.",
  };
  return reasons[result.reason ?? ""] ?? "Proxy connection failed.";
}
