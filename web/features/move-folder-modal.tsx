import type { FolderInfo } from "../../folders";
import { useTranslation } from "../i18n";
import { ModalDialog } from "../ui-primitives";

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

  return (
    <ModalDialog
      open={Boolean(movingFolder)}
      onClose={onClose}
      title={movingFolder ? t("Move {folder}", { folder: movingFolder }) : ""}
      size="sm"
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
            disabled={folderMoveBusy}
            onClick={onCommit}
          >
            {t("Move")}
          </button>
        </>
      }
    >
      <label className="fld">
        <span>{t("Parent folder")}</span>
        <select
          value={folderParent}
          disabled={folderMoveBusy}
          onChange={(event) => onParentChange(event.target.value)}
        >
          <option value="">{t("Top level")}</option>
          {movingFolder &&
            tree
              .filter(
                (folder) =>
                  folder.name !== movingFolder &&
                  !folder.ancestors.includes(movingFolder),
              )
              .map((folder) => (
                <option key={folder.name} value={folder.name}>
                  {folder.name}
                </option>
              ))}
        </select>
      </label>
      {folderMoveErr && (
        <div className="modal-err" role="alert">
          {folderMoveErr}
        </div>
      )}
    </ModalDialog>
  );
}
