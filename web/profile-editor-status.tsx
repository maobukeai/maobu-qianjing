import { useId } from "react";
import { useTranslation } from "./i18n.tsx";
import "./profile-editor-status.css";

export type ProfileEditorBrowserLabel = "Chromium" | "Firefox" | "CloakBrowser";
export interface ProfileCreateSummary {
  browserLabel: ProfileEditorBrowserLabel;
  hasProxy: boolean;
  manualFingerprint: boolean;
}
interface StatusCommon {
  hasValidationError: boolean;
  hasSaveError: boolean;
  /** Focus/scroll is owned by the editor and happens only after this explicit action. */
  onLocateProblem: () => void;
}
export type ProfileEditorStatusProps = StatusCommon & (
  { kind: "create"; createSummary: ProfileCreateSummary; editChangeCount?: never; onReview?: never }
  | { kind: "edit"; editChangeCount: number; onReview: () => void; createSummary?: never }
);
const BROWSER_LABELS: readonly string[] = ["Chromium", "Firefox", "CloakBrowser"];

/** Safe footer context only: no original values, patch, credentials or save callback. */
export function ProfileEditorStatus(props: ProfileEditorStatusProps) {
  const { t } = useTranslation(), statusId = useId();
  const problem = props.hasValidationError || props.hasSaveError;
  const errorMessage = [props.hasValidationError ? t("Some changes need attention") : "", props.hasSaveError ? t("Save needs attention") : ""].filter(Boolean).join(" · ");
  const count = props.kind === "edit" && Number.isSafeInteger(props.editChangeCount) && props.editChangeCount > 0 ? props.editChangeCount : 0;
  const changes = t(count === 1 ? "1 field changed" : count ? "{count} fields changed" : "No changes to save", { count });
  const browser = props.kind === "create" && BROWSER_LABELS.includes(props.createSummary.browserLabel) ? props.createSummary.browserLabel : t("Browser");
  return <div className={`profile-editor-status${problem ? " has-problem" : ""}`} data-editor-status={props.kind}>
    <div className="profile-editor-status-copy" id={statusId}>
      {/* Announce only problem-state changes. Counting fields or editing text
          does not repeatedly interrupt the input's own announcement. */}
      <span className="profile-editor-status-live" aria-live="polite" aria-atomic="true">{errorMessage}</span>
      {!problem && (props.kind === "edit"
        ? <span className="profile-editor-status-count">{changes}</span>
        : <span className="profile-editor-status-summary"><span>{browser}</span><span aria-hidden="true">·</span><span>{t(props.createSummary.hasProxy ? "Profile proxy configured" : "No profile proxy")}</span><span aria-hidden="true">·</span><span>{t(props.createSummary.manualFingerprint ? "Custom fingerprint settings" : "Default fingerprint settings")}</span></span>)}
      {problem && props.kind === "edit" && count > 0 && <span className="profile-editor-status-count is-secondary">{changes}</span>}
    </div>
    {problem ? <button type="button" className="profile-editor-status-action" aria-describedby={statusId} onClick={props.onLocateProblem}>{t("View problem")}</button>
      : props.kind === "edit" && count > 0 ? <button type="button" className="profile-editor-status-action" aria-describedby={statusId} onClick={props.onReview}>{t("Review changes")}</button> : null}
  </div>;
}
