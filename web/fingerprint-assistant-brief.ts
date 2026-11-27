import type { FingerprintCheckStatus, FingerprintTranslator } from "../src/fingerprint-check-presentation.ts";
import type { FingerprintReport } from "./settings-api.ts";

// The report's labels and explanations are not part of the anonymous draft.
const CHECK_LABELS = {
  identity_seed: "Fixed identity seed",
  screen_config: "Screen configuration",
  timezone_config: "Timezone configuration",
  locale_config: "Language configuration",
  desktop_persona: "Desktop identity",
  engine_identity: "Engine identity",
  proxy_config: "Network route configuration",
  runtime_config: "Applied runtime configuration",
  browser_sample: "Browser measurement",
  capture_source: "Measurement source and current identity",
  sample_coverage: "Measurement coverage",
  measured_persona: "Measured desktop identity",
  sample_freshness: "Measurement time",
  platform_consistency: "Measured system consistency",
  platform_configuration: "Measured system and configuration",
  hardware_configuration: "Measured processors and configuration",
  locale_configuration: "Measured language and configuration",
  screen_measurement: "Measured screen and configuration",
  screen_available: "Available screen bounds",
  timezone_measurement: "Measured timezone and configuration",
  language_consistency: "Measured language consistency",
  sample_errors: "Measurement completeness",
  import_attestation: "Imported identity check",
} as const;
type KnownCheck = keyof typeof CHECK_LABELS;
const STATUS_PRIORITY = { pass: 0, unknown: 1, warn: 2, fail: 3 };
const MAX_FINDINGS = 12;

function knownCheck(id: unknown): id is KnownCheck {
  return typeof id === "string" && Object.hasOwn(CHECK_LABELS, id);
}
function knownStatus(status: unknown): status is FingerprintCheckStatus {
  return typeof status === "string" && Object.hasOwn(STATUS_PRIORITY, status);
}

/** Use only known categories and their bounded status counts. */
export function buildFingerprintAssistantBrief(report: Pick<FingerprintReport, "checks">, t: FingerprintTranslator): string {
  const checks = new Map<KnownCheck, FingerprintCheckStatus>();
  for (const check of report.checks) {
    if (check && knownCheck(check.id) && knownStatus(check.status) && !checks.has(check.id)) {
      checks.set(check.id, check.status);
    }
  }
  const counts = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const status of checks.values()) counts[status]++;
  const findings = [...checks].filter(([, status]) => status !== "pass")
    .sort(([, a], [, b]) => STATUS_PRIORITY[b] - STATUS_PRIORITY[a]);
  const lines = [t("Help me understand this anonymous fingerprint quality summary and suggest practical next checks."), ""];
  if (checks.size) {
    lines.push(t("Passed {pass} · Review {warn} · Issues {fail} · Unknown {unknown}", counts));
    for (const [id, status] of findings.slice(0, MAX_FINDINGS)) {
      lines.push(`- ${t(CHECK_LABELS[id])} · ${t(status)}`);
    }
    if (findings.length > MAX_FINDINGS) lines.push(t("Additional checks needing attention · {count}", { count: findings.length - MAX_FINDINGS }));
  } else {
    lines.push(t("No recognized checks are available in this summary."));
  }
  lines.push("", t("Use this stored summary as historical evidence. Treat unknown items as unmeasured. Leave current process state and anonymity unconfirmed."));
  return lines.join("\n");
}
