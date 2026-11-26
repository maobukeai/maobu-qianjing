import { useEffect, useId, useState } from "react";
import type { UiProfile } from "./api.ts";
import {
  type DefaultBrowserRoutingConfig,
  type DefaultBrowserRoutingMode,
  type DefaultBrowserStatus,
  fetchDefaultBrowserStatus,
  isDesktopDefaultBrowserHost,
  normalizeRuleDomain,
  openDefaultBrowserSystemSettings,
  profileDisplayNumber,
  registerDefaultBrowser,
  removeDomainRule,
  unregisterDefaultBrowser,
  upsertDomainRule,
} from "./default-browser.ts";
import { useTranslation } from "./i18n.tsx";
import { AppIcon } from "./ui-primitives.tsx";
import "./default-browser-settings.css";

export interface DefaultBrowserSettingsProps {
  profiles: readonly UiProfile[];
  config: DefaultBrowserRoutingConfig;
  onChange: (next: DefaultBrowserRoutingConfig) => void;
  onTestExternalUrl?: (url: string) => void;
}

export function DefaultBrowserSettings({
  profiles,
  config,
  onChange,
  onTestExternalUrl,
}: DefaultBrowserSettingsProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const modeGroupId = useId();
  const desktopHost = isDesktopDefaultBrowserHost();

  const [status, setStatus] = useState<DefaultBrowserStatus | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [domainInput, setDomainInput] = useState("");
  const [domainProfileId, setDomainProfileId] = useState("");
  const [ruleError, setRuleError] = useState("");
  const [rulesOpen, setRulesOpen] = useState(config.domainRules.length > 0);

  const launchableProfiles = profiles.filter((profile) => !profile.mobilePersona);
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));

  const refreshStatus = async () => {
    if (!desktopHost) return;
    setStatusBusy(true);
    try {
      const next = await fetchDefaultBrowserStatus();
      setStatus(next);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setStatusBusy(false);
    }
  };

  useEffect(() => {
    if (!desktopHost) return;
    void refreshStatus();
    const onFocus = () => {
      void refreshStatus();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [desktopHost]);

  const handleSetDefault = async () => {
    setActionError("");
    setActionNotice("");
    setStatusBusy(true);
    try {
      const registered = await registerDefaultBrowser();
      setStatus(registered);
      await openDefaultBrowserSystemSettings();
      setActionNotice(
        registered.isDefault
          ? t("Maobu is already set as your Windows default browser.")
          : t("Registered Maobu for the current Windows user. Select 猫步·千境 as default in Windows Settings, then return here."),
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setStatusBusy(false);
    }
  };

  const handleUnregister = async () => {
    setActionError("");
    setActionNotice("");
    setStatusBusy(true);
    try {
      const next = await unregisterDefaultBrowser();
      setStatus(next);
      setActionNotice(t("Removed Windows default browser registration for the current user."));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setStatusBusy(false);
    }
  };

  const handleAddRule = (event: React.FormEvent) => {
    event.preventDefault();
    setRuleError("");
    const normalized = normalizeRuleDomain(domainInput);
    if (!normalized) {
      setRuleError(t("Enter a valid domain such as mail.google.com or *.github.com."));
      return;
    }
    const targetId = domainProfileId || launchableProfiles[0]?.id || "";
    if (!targetId) {
      setRuleError(t("Select an environment for this domain rule."));
      return;
    }
    onChange(upsertDomainRule(config, normalized, targetId));
    setDomainInput("");
    setRulesOpen(true);
  };

  const statusTone = !desktopHost || (status && !status.supported)
    ? "muted"
    : status?.isDefault
      ? "ok"
      : status?.registered
        ? "warn"
        : "muted";

  const statusLabel = !desktopHost
    ? t("Desktop app only")
    : statusBusy && !status
      ? t("Checking…")
      : !status?.supported
        ? t("Windows only")
        : status.isDefault
          ? t("Default browser")
          : status.registered
            ? t("Registered · Not default")
            : t("Not registered");

  const routingModes: Array<{ value: DefaultBrowserRoutingMode; label: string; desc: string }> = [
    {
      value: "smart",
      label: t("Smart hybrid"),
      desc: t("Match domain rules first; auto-open when 1 environment is running; otherwise prompt quickly."),
    },
    {
      value: "always-ask",
      label: t("Always ask"),
      desc: t("Always let you choose an environment (except saved domain rules)."),
    },
    {
      value: "fixed-profile",
      label: t("Fixed environment"),
      desc: t("Route all unmatched links directly to one designated environment without prompting."),
    },
  ];
  const activeMode = routingModes.find((option) => option.value === config.mode) ?? routingModes[0]!;
  const currentHandler = !status?.isDefault
    ? status?.currentHttpsProgId || status?.currentHttpProgId || ""
    : "";

  return (
    <section className="settings-card default-browser-card" aria-labelledby={titleId}>
      <header>
        <AppIcon name="globe" className="sm" />
        <h2 id={titleId}>{t("Default browser")}</h2>
        <span className={`db-status-pill tone-${statusTone}`}>{statusLabel}</span>
        {desktopHost && (
          <button
            type="button"
            className="btn xs ghost db-header-refresh"
            title={t("Refresh status")}
            aria-label={t("Refresh status")}
            disabled={statusBusy}
            onClick={() => void refreshStatus()}
          >
            <AppIcon name="refresh" className="sm" />
          </button>
        )}
      </header>
      <div className="card-body db-card-body">
        <div className="db-compact-row">
          <div className="db-row-label">
            <strong>{t("System default browser integration")}</strong>
            <small>
              {t("Register Maobu in Windows Default Apps to route external links into isolated environments.")}
              {currentHandler && (
                <span className="db-inline-handler">
                  {" · "}
                  {t("Current: {handler}", { handler: currentHandler })}
                </span>
              )}
            </small>
          </div>
          <div className="db-row-actions">
            <button
              type="button"
              className="btn primary sm"
              disabled={!desktopHost || (status !== null && !status.supported) || statusBusy}
              onClick={() => void handleSetDefault()}
            >
              <AppIcon name="globe" className="sm" />
              <span>{t(status?.isDefault ? "Open Windows Default Apps" : "Set as default browser")}</span>
            </button>
            {onTestExternalUrl && (
              <button
                type="button"
                className="btn sm"
                onClick={() => onTestExternalUrl("https://example.com/")}
              >
                <AppIcon name="play" className="sm" />
                <span>{t("Test link routing")}</span>
              </button>
            )}
            {desktopHost && status?.registered && (
              <button
                type="button"
                className="btn sm ghost"
                disabled={statusBusy}
                onClick={() => void handleUnregister()}
              >
                <span>{t("Unregister")}</span>
              </button>
            )}
          </div>
        </div>

        {actionError && <div className="feature-alert" role="alert">{actionError}</div>}
        {actionNotice && <p className="feature-success" role="status">{actionNotice}</p>}

        <div className="db-compact-row db-divider">
          <div className="db-row-label">
            <strong id={modeGroupId}>{t("External link routing")}</strong>
            <small>{activeMode.desc}</small>
          </div>
          <div className="db-segmented" role="radiogroup" aria-labelledby={modeGroupId}>
            {routingModes.map((option) => (
              <label
                key={option.value}
                className={`db-seg-btn${config.mode === option.value ? " is-active" : ""}`}
                title={option.desc}
              >
                <input
                  className="sr-only"
                  type="radio"
                  name={`db-routing-mode-${modeGroupId}`}
                  value={option.value}
                  checked={config.mode === option.value}
                  onChange={() => onChange({ ...config, mode: option.value })}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>

        {config.mode === "smart" && (
          <label className="db-compact-row db-sub-row">
            <span className="db-row-label">
              <strong>{t("Auto-open when only 1 environment is running")}</strong>
              <small>{t("Skip the picker when a single environment is active and no domain rule matches.")}</small>
            </span>
            <input
              className="db-switch"
              type="checkbox"
              role="switch"
              checked={config.autoOpenSingleRunning}
              onChange={(event) =>
                onChange({ ...config, autoOpenSingleRunning: event.target.checked })
              }
            />
          </label>
        )}

        {config.mode === "fixed-profile" && (
          <label className="db-compact-row db-sub-row">
            <span className="db-row-label">
              <strong>{t("Designated default environment")}</strong>
            </span>
            <select
              className="select db-fixed-select"
              value={config.defaultProfileId}
              onChange={(event) =>
                onChange({ ...config, defaultProfileId: event.target.value })
              }
            >
              <option value="">{t("Choose an environment…")}</option>
              {launchableProfiles.map((profile) => {
                const no = profileDisplayNumber(profile);
                return (
                  <option key={profile.id} value={profile.id}>
                    {profile.running ? "● " : ""}
                    {profile.name}
                    {no ? ` (${no})` : ""}
                  </option>
                );
              })}
            </select>
          </label>
        )}

        <details
          className="db-rules-disclosure db-divider"
          open={rulesOpen}
          onToggle={(event) => setRulesOpen((event.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="db-rules-summary">
            <span className="db-rules-summary-title">
              <strong>{t("Domain routing rules")}</strong>
              <span className="db-rules-count">{config.domainRules.length}</span>
            </span>
            <span className="db-rules-summary-hint">
              {t("Bind domains or *.wildcards to specific environments")}
            </span>
          </summary>

          <div className="db-rules-content">
            {config.domainRules.length > 0 && (
              <ul className="db-rule-list" role="list">
                {config.domainRules.map((rule) => {
                  const target = profileMap.get(rule.profileId);
                  return (
                    <li key={rule.domain} className="db-rule-item">
                      <code className="db-rule-domain">{rule.domain}</code>
                      <span className="db-rule-arrow" aria-hidden="true">→</span>
                      <span className={`db-rule-profile${target ? "" : " is-missing"}`}>
                        {target
                          ? `${target.name}${profileDisplayNumber(target) ? ` (${profileDisplayNumber(target)})` : ""}`
                          : t("Deleted environment")}
                      </span>
                      <button
                        type="button"
                        className="btn xs ghost"
                        aria-label={t("Remove rule for {domain}", { domain: rule.domain })}
                        onClick={() => onChange(removeDomainRule(config, rule.domain))}
                      >
                        <AppIcon name="trash" className="sm" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <form className="db-rule-form" onSubmit={handleAddRule}>
              <input
                type="text"
                className="input"
                value={domainInput}
                placeholder={t("mail.google.com or *.github.com")}
                aria-label={t("Domain pattern")}
                onChange={(event) => {
                  setDomainInput(event.target.value);
                  if (ruleError) setRuleError("");
                }}
              />
              <select
                className="select"
                value={domainProfileId || launchableProfiles[0]?.id || ""}
                aria-label={t("Target environment")}
                disabled={launchableProfiles.length === 0}
                onChange={(event) => setDomainProfileId(event.target.value)}
              >
                {launchableProfiles.length === 0 ? (
                  <option value="">{t("No environments available")}</option>
                ) : (
                  launchableProfiles.map((profile) => {
                    const no = profileDisplayNumber(profile);
                    return (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                        {no ? ` (${no})` : ""}
                      </option>
                    );
                  })
                )}
              </select>
              <button type="submit" className="btn sm" disabled={launchableProfiles.length === 0}>
                <AppIcon name="plus" className="sm" />
                <span>{t("Add rule")}</span>
              </button>
            </form>
            {ruleError && <div className="field-error">{ruleError}</div>}
          </div>
        </details>
      </div>
    </section>
  );
}
