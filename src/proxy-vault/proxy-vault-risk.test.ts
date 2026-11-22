import { describe, expect, test } from "bun:test";
import {
  evaluateProxyVaultRisks,
  type ProxyVaultRiskBindingInput,
  type ProxyVaultRiskProxyInput,
} from "./proxy-vault-risk.ts";

function makeProxy(overrides: Partial<ProxyVaultRiskProxyInput> & { id: string }): ProxyVaultRiskProxyInput {
  return {
    name: overrides.id,
    endpointHash: `hash_${overrides.id}`,
    lastExitIp: "",
    lastExitComparison: "",
    ...overrides,
  };
}

function makeBinding(
  overrides: Partial<ProxyVaultRiskBindingInput> & { proxyId: string; profileId: string },
): ProxyVaultRiskBindingInput {
  return {
    profileName: overrides.profileId,
    profileGroup: "default",
    platform: "",
    ...overrides,
  };
}

describe("evaluateProxyVaultRisks", () => {
  test("clean single-binding proxy with unique exit IP has riskLevel none", () => {
    const proxies = [
      makeProxy({ id: "pxv_0000000000000001", lastExitIp: "203.0.113.10", lastExitComparison: "different" }),
    ];
    const bindings = [
      makeBinding({ proxyId: "pxv_0000000000000001", profileId: "p1", platform: "x.com" }),
    ];
    const result = evaluateProxyVaultRisks(proxies, bindings).get("pxv_0000000000000001")!;
    expect(result).toEqual({ riskLevel: "none", risks: [] });
  });

  test("flags high-risk same_platform_binding on single proxy and across duplicate endpoint_hash entries", () => {
    const sharedHash = "deadbeef".repeat(8);
    const proxies = [
      makeProxy({ id: "pxv_0000000000000001", endpointHash: sharedHash }),
      makeProxy({ id: "pxv_0000000000000002", endpointHash: sharedHash }),
    ];
    const bindings = [
      makeBinding({ proxyId: "pxv_0000000000000001", profileId: "p1", platform: "X.COM" }),
      makeBinding({ proxyId: "pxv_0000000000000002", profileId: "p2", platform: "x.com" }),
    ];
    const map = evaluateProxyVaultRisks(proxies, bindings);
    const first = map.get("pxv_0000000000000001")!;
    const second = map.get("pxv_0000000000000002")!;

    expect(first.riskLevel).toBe("high");
    expect(first.risks.map((r) => r.code)).toEqual(["same_platform_binding", "duplicate_proxy"]);
    expect(first.risks[0]).toMatchObject({
      code: "same_platform_binding",
      severity: "high",
      platform: "x.com",
      relatedProxyIds: ["pxv_0000000000000002"],
    });
    expect(first.risks[0]!.profiles?.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(second.riskLevel).toBe("high");
    expect(second.risks.map((r) => r.code)).toEqual(["same_platform_binding", "duplicate_proxy"]);

    // Never expose endpointHash in any evaluated output.
    const serialized = JSON.stringify([...map.entries()]);
    expect(serialized).not.toContain(sharedHash);
    expect(serialized).not.toContain("endpointHash");
    expect(serialized).not.toContain("endpoint_hash");
  });

  test("flags medium-risk shared_binding across different or unset platforms", () => {
    const proxies = [
      makeProxy({ id: "pxv_0000000000000001" }),
      makeProxy({ id: "pxv_0000000000000002" }),
    ];
    const bindings = [
      makeBinding({ proxyId: "pxv_0000000000000001", profileId: "p1", platform: "x.com" }),
      makeBinding({ proxyId: "pxv_0000000000000001", profileId: "p2", platform: "telegram.org" }),
      makeBinding({ proxyId: "pxv_0000000000000002", profileId: "p3", platform: "" }),
      makeBinding({ proxyId: "pxv_0000000000000002", profileId: "p4", platform: "" }),
    ];
    const map = evaluateProxyVaultRisks(proxies, bindings);
    expect(map.get("pxv_0000000000000001")).toMatchObject({
      riskLevel: "medium",
      risks: [{ code: "shared_binding", severity: "medium" }],
    });
    expect(map.get("pxv_0000000000000002")).toMatchObject({
      riskLevel: "medium",
      risks: [{ code: "shared_binding", severity: "medium" }],
    });
  });

  test("flags duplicate_exit_ip_same_platform (high) and duplicate_exit_ip (medium) with canonical IP folding", () => {
    const proxies = [
      makeProxy({ id: "pxv_0000000000000001", lastExitIp: "203.0.113.55" }),
      makeProxy({ id: "pxv_0000000000000002", lastExitIp: "::ffff:203.0.113.55" }),
      makeProxy({ id: "pxv_0000000000000003", lastExitIp: "203.0.113.55" }),
    ];
    const bindings = [
      makeBinding({ proxyId: "pxv_0000000000000001", profileId: "p1", platform: "x.com" }),
      makeBinding({ proxyId: "pxv_0000000000000002", profileId: "p2", platform: "x.com" }),
      makeBinding({ proxyId: "pxv_0000000000000003", profileId: "p3", platform: "telegram.org" }),
    ];
    const map = evaluateProxyVaultRisks(proxies, bindings);

    const p1 = map.get("pxv_0000000000000001")!;
    expect(p1.riskLevel).toBe("high");
    expect(p1.risks[0]).toMatchObject({
      code: "duplicate_exit_ip_same_platform",
      severity: "high",
      platform: "x.com",
      exitIp: "203.0.113.55",
      relatedProxyIds: ["pxv_0000000000000002"],
    });
    expect(p1.risks[1]).toMatchObject({
      code: "duplicate_exit_ip",
      severity: "medium",
      exitIp: "203.0.113.55",
      relatedProxyIds: ["pxv_0000000000000003"],
    });

    const p3 = map.get("pxv_0000000000000003")!;
    expect(p3.riskLevel).toBe("medium");
    expect(p3.risks).toEqual([
      {
        code: "duplicate_exit_ip",
        severity: "medium",
        exitIp: "203.0.113.55",
        relatedProxyIds: ["pxv_0000000000000001", "pxv_0000000000000002"],
      },
    ]);
  });

  test("flags high-risk same_host_exit when lastExitComparison is same", () => {
    const proxies = [
      makeProxy({ id: "pxv_0000000000000001", lastExitIp: "198.51.100.2", lastExitComparison: "same" }),
    ];
    const evalResult = evaluateProxyVaultRisks(proxies, []).get("pxv_0000000000000001")!;
    expect(evalResult).toEqual({
      riskLevel: "high",
      risks: [{ code: "same_host_exit", severity: "high", exitIp: "198.51.100.2" }],
    });
  });
});
