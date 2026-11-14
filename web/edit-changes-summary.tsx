import { useId } from "react";
import type { ProfileEditSummary } from "./profile-edit-patch.ts";
import { useTranslation } from "./i18n.tsx";
import "./edit-changes-summary.css";

/** Receives labels/counts only, never the full editor snapshot or submitted patch. */
export function EditChangesSummary({ summary, running, busy = false }: { summary: ProfileEditSummary; running: boolean; busy?: boolean }) {
  const { t } = useTranslation(), id = useId();
  return <section className={`edit-changes-summary${summary.hasChanges ? " has-changes" : ""}`} aria-labelledby={id} aria-busy={busy}>
    <div className="edit-changes-heading"><h3 id={id}>{t(summary.hasChanges ? "Review before saving" : "No changes to save")}</h3>{summary.hasChanges && <span>{t(summary.count === 1 ? "1 field changed" : "{count} fields changed", { count: summary.count })}</span>}</div>
    {summary.hasChanges && <><p className="edit-changes-note">{t("Only the fields listed here will be submitted.")}</p><ul className="edit-changes-fields">{summary.changes.map(change => <li key={change.field}><span>{t(change.label)}</span><small>{t(change.clearing ? "Cleared" : change.effect === "next-start" ? "Next start" : "Environment details")}</small></li>)}</ul>
      {summary.nextStartCount > 0 && <p className="edit-changes-note">{t(running ? "The open browser keeps its current settings. Browser-setting changes apply after it restarts." : "Browser-setting changes apply the next time this environment starts.")}</p>}
      {summary.groupDefaultsMayApply && <p className="edit-changes-note">{t("The new group's extension defaults may apply at the next browser start because the extension selection was not changed.")}</p>}
    </>}
    {summary.notices.map(notice => <p key={notice.code} className="edit-changes-caveat" role="status">{t(notice.message)}</p>)}
    {busy && <p className="edit-changes-note" role="status">{t("Saving the reviewed changes…")}</p>}
  </section>;
}
