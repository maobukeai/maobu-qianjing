import { useTranslation } from "../i18n";
import { ModalDialog } from "../ui-primitives";

export interface LogModalProps {
  logView: { file: string; content: string } | null;
  logErr: string | null;
  onClose: () => void;
}

export function LogModal({ logView, logErr, onClose }: LogModalProps) {
  const { t } = useTranslation();
  const open = Boolean(logView || logErr);

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title={t("Detailed logs")}
      ariaLabel={t("Detailed logs")}
      footer={
        <button className="btn ghost" type="button" onClick={onClose}>
          {t("Close")}
        </button>
      }
    >
      {logErr && <p className="hint">{logErr}</p>}
      {logView && (
        <pre className="logpre">{`${logView.file}\n${logView.content}`}</pre>
      )}
    </ModalDialog>
  );
}
