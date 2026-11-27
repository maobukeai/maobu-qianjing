import type { FolderInfo } from "../../src/folders.ts";
import { useTranslation } from "../i18n";
import { AppIcon, ModalDialog } from "../ui-primitives";
import "./group-management.css";

export interface MoveFolderModalProps {
  movingFolder: string | null;
  folderParent: string;
  folderMoveBusy: boolean;
  folderMoveErr: string | null;
  tree: Array<FolderInfo & { depth: number; ancestors: string[] }>;
  onParentChange: (value: string) => void;
  onClose: () => void;
  onCommit: () => void;
}

export function MoveFolderModal({
  movingFolder,
  folderParent,
  folderMoveBusy,
  folderMoveErr,
  tree,
  onParentChange,
  onClose,
  onCommit,
}: MoveFolderModalProps) {
  const { t } = useTranslation();
  const source = tree.find(({ name }) => name === movingFolder);
  const currentParent = source?.parentName ?? "";
  const destinations = tree.filter(({ name, ancestors }) => name !== movingFolder && !ancestors.includes(movingFolder ?? ""));
  const destinationReady = folderParent === "" || destinations.some(({ name }) => name === folderParent);
  const hasAlternative = currentParent !== "" || destinations.length > 0;
  const changed = folderParent !== currentParent;
  const newPath = folderParent ? `${folderParent}/${source?.label ?? movingFolder}` : source?.label ?? movingFolder;

  return (
    <ModalDialog
      open={Boolean(movingFolder)}
      onClose={onClose}
      title={t("Move group")}
      className="group-move-dialog"
      backdropClassName="group-dialog-backdrop"
      closeOnBackdrop={false}
      portal
      busy={folderMoveBusy}
      footer={
        <>
          <button
            className="btn ghost"
            type="button"
            disabled={folderMoveBusy}
            onClick={onClose}
          >
            {t("Cancel")}
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={folderMoveBusy || !source || !changed || !destinationReady}
            onClick={onCommit}
          >
            {t("Move")}
          </button>
        </>
      }
    >
      <div className="group-path"><AppIcon name="folder" />
        <div><small>{t("Current group path")}</small><span>{movingFolder}</span></div>
      </div>
      {source ? <>
        <label className="fld">
          <span>{t("Parent folder")}</span>
          <select
            value={folderParent}
            disabled={folderMoveBusy || !hasAlternative}
            onChange={(event) => onParentChange(event.target.value)}
          >
            {!destinationReady && <option value={folderParent} disabled>{folderParent}</option>}
            <option value="">{t("Top level")}</option>
            {destinations.map(({ name }) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        {!destinationReady
          ? <p className="group-move-hint" role="status">{t("This parent group is no longer available. Choose another.")}</p>
          : !hasAlternative
            ? <p className="group-move-hint">{t("No other parent group is available.")}</p>
            : changed && newPath && <div className="group-path is-target">
              <AppIcon name="move" /><div aria-live="polite"><small>{t("New group path")}</small><span>{newPath}</span></div>
            </div>}
      </> : <p className="group-move-hint" role="status">{t("This group is no longer available.")}</p>}
      {folderMoveErr && (
        <div className="modal-err" role="alert">
          {folderMoveErr}
        </div>
      )}
    </ModalDialog>
  );
}
