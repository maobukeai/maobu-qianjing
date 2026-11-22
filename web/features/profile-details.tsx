import { useId, type Ref } from "react";
import type { UiProfile } from "../api.ts";
import { useTranslation } from "../i18n.tsx";
import { AppIcon } from "../ui-primitives.tsx";
import "./profile-details.css";

export interface ProfileDetailsPanelProps {
  profile: UiProfile | null;
  onClose: () => void;
  onEdit: (id: string) => void;
  onInspect: (id: string) => void;
  /** The parent owns opening focus and returning to the row that opened this panel. */
  headingRef?: Ref<HTMLHeadingElement>;
  id?: string;
}

/** The roster supplies a credential-free host:port. Reject unexpected credential-bearing forms. */
function safeProxySummary(value: string | null): string | null {
  if (!value || value.length > 300 || /[\s/@?#\\]/.test(value)) return null;
  const authority = /^(?:\[[\da-fA-F:.]+\]|[\p{L}\p{N}._-]+):(\d{1,5})$/u.exec(value);
  return authority && Number(authority[1]) > 0 && Number(authority[1]) <= 65535 ? value : null;
}

/** Read-only roster details. No requests, credentials, raw fingerprint evidence or control addresses. */
export function ProfileDetailsPanel({ profile, onClose, onEdit, onInspect, headingRef, id }: ProfileDetailsPanelProps) {
  const { t } = useTranslation();
  const generatedId = useId(), headingId = `${generatedId}-heading`;
  if (!profile) return null;
  const browser = profile.engine === "firefox" ? "Firefox" : profile.chromiumRuntime === "aliasmode" ? "Chromium" : "CloakBrowser";
  const number = profile.customNo?.trim() || (Number.isSafeInteger(profile.serial) && Number(profile.serial) > 0 ? String(profile.serial) : t("Unknown"));
  const proxy = safeProxySummary(profile.proxy);
  const cookies = Number.isSafeInteger(profile.cookieCount) && profile.cookieCount >= 0 ? profile.cookieCount : t("Unknown");
  const pendingCookies = Number.isSafeInteger(profile.pendingCookieCount) && Number(profile.pendingCookieCount) > 0 ? profile.pendingCookieCount! : 0;
  return <aside id={id} className="profile-details-panel" role="complementary" aria-labelledby={headingId} onKeyDown={event => {
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault(); event.stopPropagation(); onClose();
  }}>
    <header className="profile-details-header">
      <div><span className="profile-details-eyebrow">{t("Environment details")}</span><h2 id={headingId} ref={headingRef} tabIndex={-1}>{profile.name || profile.id}</h2></div>
      <button type="button" className="iconbtn profile-details-close" aria-label={t("Close environment details")} onClick={onClose}><AppIcon name="close" /></button>
    </header>
    <div className="profile-details-content">
      <div className={`profile-details-status${profile.running ? " is-running" : ""}`}><span aria-hidden="true" />{t(profile.running ? "Running" : "Stopped")}</div>
      {profile.restartPending && <p className="profile-details-warning"><AppIcon name="refresh" className="sm" /><span>{t("Saved changes apply at the next start.")}</span></p>}
      <section className="profile-details-section" aria-label={t("Environment identity")}>
        <h3>{t("Environment identity")}</h3>
        <dl>
          <div><dt>{t("No.")}</dt><dd className="profile-details-mono">{number}</dd></div>
          <div><dt>ID</dt><dd className="profile-details-mono">{profile.id}</dd></div>
          <div><dt>{t("Browser")}</dt><dd>{browser}</dd></div>
          <div><dt>{t("Group")}</dt><dd>{profile.group || t("Ungrouped")}</dd></div>
          <div><dt>{t("Platform")}</dt><dd>{profile.platform || t("Not set")}</dd></div>
          <div className="profile-details-tags-row"><dt>{t("Tags")}</dt><dd>{profile.tags.length ? <span className="profile-details-tags">{profile.tags.map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}</span> : t("No tags")}</dd></div>
        </dl>
      </section>
      <section className="profile-details-section" aria-label={t("Saved configuration")}>
        <h3>{t("Saved configuration")}</h3>
        <dl>
          <div><dt>{t("Proxy")}</dt><dd className="profile-details-mono">{profile.proxyError ? t("Invalid proxy — edit to fix") : proxy || t(profile.proxy ? "Proxy details unavailable" : "No profile proxy")}</dd></div>
          <div><dt>{t("Timezone")}</dt><dd>{profile.timezone || t("Unknown")}</dd></div>
          <div><dt>{t("Screen")}</dt><dd className="profile-details-mono">{profile.screen || t("Unknown")}</dd></div>
          <div><dt>{t("Saved cookies")}</dt><dd>{cookies}</dd></div>
        </dl>
        {pendingCookies > 0 && <p className="profile-details-note">{t("{count} cookie(s) at next start", { count: pendingCookies })}</p>}
      </section>
      <p className="profile-details-note">{t("Saved settings do not verify the current network or browser fingerprint.")}</p>
    </div>
    <footer className="profile-details-actions">
      <button type="button" className="btn primary" onClick={() => onEdit(profile.id)}><AppIcon name="edit" className="sm" />{t("Edit profile")}</button>
      <button type="button" className="btn" onClick={() => onInspect(profile.id)}><AppIcon name="activity" className="sm" />{t("Inspect network & fingerprint")}</button>
    </footer>
  </aside>;
}
