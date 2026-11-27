import type { UiProfile } from "./api.ts";
import { parsePastedProxy } from "./proxy-input.ts";
import type { ProxyCheckView, ProxyReplacementView, ProxyScope } from "../src/proxy-tools-types.ts";

export type ProxyScopeProfile = Pick<UiProfile, "id" | "group" | "running" | "proxy" | "proxyError">;

export function profilesInProxyScope(profiles: readonly ProxyScopeProfile[], scope: ProxyScope): ProxyScopeProfile[] {
  const groups = new Set(scope.groups ?? []), ids = scope.ids ? new Set(scope.ids) : null;
  return profiles.filter(profile => (scope.all || groups.has(profile.group)) && (!ids || ids.has(profile.id)));
}

export function proxyScopeOverview(profiles: readonly ProxyScopeProfile[], scope: ProxyScope) {
  const selected = profilesInProxyScope(profiles, scope);
  return {
    total: selected.length,
    running: selected.filter(profile => profile.running).length,
    configured: selected.filter(profile => !!profile.proxy && !profile.proxyError).length,
    missing: selected.filter(profile => !profile.proxy && !profile.proxyError).length,
    invalid: selected.filter(profile => !!profile.proxyError).length,
  };
}

/** Redacted metadata only. The server still validates full saved versions. */
export function proxyRosterSignature(profiles: readonly ProxyScopeProfile[], scope: ProxyScope): string {
  return JSON.stringify(profilesInProxyScope(profiles, scope)
    .map(profile => [profile.id, profile.group, profile.running, profile.proxy, profile.proxyError ?? ""])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

/** Syntax feedback never repeats a supplied address or authentication field. */
export function analyzeProxyList(input: string) {
  const invalidRows: number[] = [], identities = new Set<string>();
  let total = 0, readable = 0, repeated = 0, https = 0;
  input.split(/\r?\n/).forEach((value, index) => {
    const raw = value.trim();
    if (!raw) return;
    total++;
    try {
      const isHttps = /^https:\/\//i.test(raw);
      // HTTPS is valid for replacement although this page cannot check it.
      const proxy = parsePastedProxy(isHttps ? raw.replace(/^https:/i, "http:") : raw);
      if (/[\s\u0000-\u001f\u007f\[\]\\/@?#%]/.test(proxy.host)) throw new Error("host");
      const host = proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host;
      const normalized = new URL(`http://${host}/`);
      if (!normalized.hostname || normalized.username || normalized.password || normalized.port || normalized.pathname !== "/") throw new Error("host");
      readable++;
      if (isHttps) https++;
      const identity = JSON.stringify([isHttps ? "https" : proxy.type, normalized.hostname.toLowerCase(), proxy.port, proxy.user.trim(), proxy.pass]);
      if (identities.has(identity)) repeated++;
      identities.add(identity);
    } catch { invalidRows.push(index + 1); }
  });
  return { total, readable, repeated, https, invalidRows };
}

export function matchingProxyChecks(rows: readonly ProxyCheckView[], query: string): ProxyCheckView[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...rows];
  return rows.filter(row => [row.proxy, row.ip, row.country, ...row.profiles.flatMap(profile => [profile.name, profile.id, profile.group])]
    .filter(Boolean).join(" ").toLocaleLowerCase().includes(needle));
}

export function matchingProxyReplacements(rows: readonly ProxyReplacementView[], query: string): ProxyReplacementView[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...rows];
  return rows.filter(row => [row.profileId, row.name, row.group, row.previousProxy, row.proxy].filter(Boolean).join(" ").toLocaleLowerCase().includes(needle));
}

export function proxyCheckOverview(rows: readonly ProxyCheckView[]) {
  const completed = new Set<string>(), reachable = new Set<string>(), review = new Set<string>(), retry = new Set<string>();
  for (const row of rows) for (const profile of row.profiles) {
    completed.add(profile.id);
    if (row.status === "working") reachable.add(profile.id); else review.add(profile.id);
    if (["failed", "unstable", "unavailable"].includes(row.status)) retry.add(profile.id);
  }
  return { completed: completed.size, reachable: reachable.size, review: review.size, retry: retry.size };
}
