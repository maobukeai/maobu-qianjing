/**
 * Pure server-side anti-correlation risk evaluation engine for Proxy Vault.
 *
 * Security invariant: consumes internal `endpointHash` purely in memory for
 * correlation detection and NEVER emits `endpointHash` or credentials in output.
 */

import { canonicalIp } from "../ip.ts";

export type ProxyRiskLevel = "none" | "medium" | "high";
export type ProxyRiskSeverity = "medium" | "high";
export type ProxyRiskCode =
  | "same_platform_binding"
  | "duplicate_exit_ip_same_platform"
  | "same_host_exit"
  | "shared_binding"
  | "duplicate_proxy"
  | "duplicate_exit_ip";

export interface ProxyVaultRiskProfileRef {
  id: string;
  name: string;
  group: string;
  platform: string;
}

export interface ProxyVaultRiskItem {
  code: ProxyRiskCode;
  severity: ProxyRiskSeverity;
  platform?: string;
  exitIp?: string;
  relatedProxyIds?: string[];
  profiles?: ProxyVaultRiskProfileRef[];
}

export interface ProxyVaultRiskProxyInput {
  id: string;
  name: string;
  /** Internal SHA-256 hash used strictly for in-memory correlation; never echoed out. */
  endpointHash: string;
  lastExitIp: string;
  lastExitComparison: string;
}

export interface ProxyVaultRiskBindingInput {
  proxyId: string;
  profileId: string;
  profileName: string;
  profileGroup: string;
  platform: string;
}

export interface ProxyVaultRiskEvaluation {
  riskLevel: ProxyRiskLevel;
  risks: ProxyVaultRiskItem[];
}

const RISK_CODE_ORDER: Record<ProxyRiskCode, number> = {
  same_platform_binding: 0,
  duplicate_exit_ip_same_platform: 1,
  same_host_exit: 2,
  shared_binding: 3,
  duplicate_proxy: 4,
  duplicate_exit_ip: 5,
};

function normalizePlatform(raw: string): string {
  return raw.trim().toLowerCase();
}

function toProfileRef(binding: ProxyVaultRiskBindingInput): ProxyVaultRiskProfileRef {
  return {
    id: binding.profileId,
    name: binding.profileName,
    group: binding.profileGroup,
    platform: normalizePlatform(binding.platform),
  };
}

function dedupeProfiles(refs: readonly ProxyVaultRiskProfileRef[]): ProxyVaultRiskProfileRef[] {
  const byId = new Map<string, ProxyVaultRiskProfileRef>();
  for (const ref of refs) {
    if (!byId.has(ref.id)) byId.set(ref.id, ref);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sortRisks(risks: ProxyVaultRiskItem[]): ProxyVaultRiskItem[] {
  return risks.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "high" ? -1 : 1;
    const codeDiff = RISK_CODE_ORDER[a.code] - RISK_CODE_ORDER[b.code];
    if (codeDiff !== 0) return codeDiff;
    const platDiff = (a.platform ?? "").localeCompare(b.platform ?? "");
    if (platDiff !== 0) return platDiff;
    return (a.exitIp ?? "").localeCompare(b.exitIp ?? "");
  });
}

export function highestRiskLevel(risks: readonly ProxyVaultRiskItem[]): ProxyRiskLevel {
  if (risks.some((risk) => risk.severity === "high")) return "high";
  if (risks.some((risk) => risk.severity === "medium")) return "medium";
  return "none";
}

/**
 * Evaluate anti-correlation risks across all vault proxies and active bindings.
 * Returns a Map keyed by `proxy.id`.
 */
export function evaluateProxyVaultRisks(
  proxies: readonly ProxyVaultRiskProxyInput[],
  bindings: readonly ProxyVaultRiskBindingInput[],
): Map<string, ProxyVaultRiskEvaluation> {
  const byEndpointHash = new Map<string, ProxyVaultRiskProxyInput[]>();
  const byExitIp = new Map<string, ProxyVaultRiskProxyInput[]>();
  const canonicalExitByProxy = new Map<string, string>();
  const bindingsByProxy = new Map<string, ProxyVaultRiskProfileRef[]>();

  for (const proxy of proxies) {
    const hashGroup = byEndpointHash.get(proxy.endpointHash) ?? [];
    hashGroup.push(proxy);
    byEndpointHash.set(proxy.endpointHash, hashGroup);

    const exitIp = proxy.lastExitIp ? canonicalIp(proxy.lastExitIp) : null;
    if (exitIp) {
      canonicalExitByProxy.set(proxy.id, exitIp);
      const ipGroup = byExitIp.get(exitIp) ?? [];
      ipGroup.push(proxy);
      byExitIp.set(exitIp, ipGroup);
    }
  }

  for (const binding of bindings) {
    const list = bindingsByProxy.get(binding.proxyId) ?? [];
    list.push(toProfileRef(binding));
    bindingsByProxy.set(binding.proxyId, list);
  }

  const results = new Map<string, ProxyVaultRiskEvaluation>();

  for (const proxy of proxies) {
    const risks: ProxyVaultRiskItem[] = [];

    // 1. Same endpoint_hash cluster (proxy itself + any duplicate entries with identical endpoint)
    const hashPeers = byEndpointHash.get(proxy.endpointHash) ?? [proxy];
    const otherHashPeerIds = hashPeers
      .map((peer) => peer.id)
      .filter((id) => id !== proxy.id)
      .sort();

    const clusterProfiles = dedupeProfiles(
      hashPeers.flatMap((peer) => bindingsByProxy.get(peer.id) ?? []),
    );

    const profilesByPlatform = new Map<string, ProxyVaultRiskProfileRef[]>();
    let hasUnassignedPlatform = false;
    for (const ref of clusterProfiles) {
      if (!ref.platform) {
        hasUnassignedPlatform = true;
        continue;
      }
      const list = profilesByPlatform.get(ref.platform) ?? [];
      list.push(ref);
      profilesByPlatform.set(ref.platform, list);
    }

    // High: same_platform_binding (>= 2 active profiles on the same non-empty platform)
    let hasSamePlatformBinding = false;
    for (const [platform, platformProfiles] of profilesByPlatform) {
      if (platformProfiles.length >= 2) {
        hasSamePlatformBinding = true;
        risks.push({
          code: "same_platform_binding",
          severity: "high",
          platform,
          ...(otherHashPeerIds.length > 0 ? { relatedProxyIds: otherHashPeerIds } : {}),
          profiles: platformProfiles,
        });
      }
    }

    // Medium: shared_binding (>= 2 active profiles shared across platforms or without platform isolation)
    const distinctNonEmptyPlatforms = profilesByPlatform.size;
    if (
      clusterProfiles.length >= 2 &&
      (!hasSamePlatformBinding || distinctNonEmptyPlatforms >= 2 || hasUnassignedPlatform)
    ) {
      risks.push({
        code: "shared_binding",
        severity: "medium",
        ...(otherHashPeerIds.length > 0 ? { relatedProxyIds: otherHashPeerIds } : {}),
        profiles: clusterProfiles,
      });
    }

    // Medium: duplicate_proxy (>= 2 vault rows sharing the same endpoint_hash)
    if (otherHashPeerIds.length > 0) {
      risks.push({
        code: "duplicate_proxy",
        severity: "medium",
        relatedProxyIds: otherHashPeerIds,
      });
    }

    // High: same_host_exit (proxy exit IP matches host's direct exit IP)
    if (proxy.lastExitComparison === "same") {
      const exitIp = canonicalExitByProxy.get(proxy.id);
      risks.push({
        code: "same_host_exit",
        severity: "high",
        ...(exitIp ? { exitIp } : {}),
      });
    }

    // Exit-IP sharing across distinct vault entries
    const exitIp = canonicalExitByProxy.get(proxy.id);
    if (exitIp) {
      const ipPeers = (byExitIp.get(exitIp) ?? []).filter((peer) => peer.id !== proxy.id);
      if (ipPeers.length > 0) {
        const selfBindings = dedupeProfiles(bindingsByProxy.get(proxy.id) ?? []);
        const selfPlatforms = new Map<string, ProxyVaultRiskProfileRef[]>();
        for (const ref of selfBindings) {
          if (!ref.platform) continue;
          const list = selfPlatforms.get(ref.platform) ?? [];
          list.push(ref);
          selfPlatforms.set(ref.platform, list);
        }

        const samePlatformPeerIds = new Set<string>();
        for (const [platform, selfPlatformProfiles] of selfPlatforms) {
          const matchingPeers: ProxyVaultRiskProxyInput[] = [];
          const combinedProfiles: ProxyVaultRiskProfileRef[] = [...selfPlatformProfiles];
          for (const peer of ipPeers) {
            const peerMatches = (bindingsByProxy.get(peer.id) ?? []).filter((ref) => ref.platform === platform);
            if (peerMatches.length > 0) {
              matchingPeers.push(peer);
              combinedProfiles.push(...peerMatches);
              samePlatformPeerIds.add(peer.id);
            }
          }
          if (matchingPeers.length > 0) {
            // High: duplicate_exit_ip_same_platform
            risks.push({
              code: "duplicate_exit_ip_same_platform",
              severity: "high",
              platform,
              exitIp,
              relatedProxyIds: matchingPeers.map((peer) => peer.id).sort(),
              profiles: dedupeProfiles(combinedProfiles),
            });
          }
        }

        const otherIpPeerIds = ipPeers
          .map((peer) => peer.id)
          .filter((id) => !samePlatformPeerIds.has(id))
          .sort();
        if (otherIpPeerIds.length > 0) {
          // Medium: duplicate_exit_ip (unassigned or cross-platform peers sharing exit IP)
          risks.push({
            code: "duplicate_exit_ip",
            severity: "medium",
            exitIp,
            relatedProxyIds: otherIpPeerIds,
          });
        }
      }
    }

    sortRisks(risks);
    results.set(proxy.id, {
      riskLevel: highestRiskLevel(risks),
      risks,
    });
  }

  return results;
}
