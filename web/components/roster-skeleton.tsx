import { useTranslation } from "../i18n.tsx";
import "./roster-skeleton.css";

export type RosterSkeletonDensity = "compact" | "standard" | "comfortable";

export interface RosterSkeletonProps {
  /** Number of placeholder rows to render. Defaults to 8. */
  rows?: number;
  /** Number of visible table columns so cells align with `<thead>`. */
  visibleColumnCount: number;
  /** Active roster density for matching row heights (`44 | 48 | 52` px). */
  density?: RosterSkeletonDensity;
}

const PRIMARY_WIDTHS = ["64%", "78%", "56%", "72%", "60%", "82%", "58%", "70%"] as const;
const SECONDARY_WIDTHS = ["42%", "54%", "38%", "48%", "44%", "52%", "36%", "46%"] as const;
const CELL_WIDTHS = ["58%", "72%", "64%", "50%", "68%", "56%", "74%", "62%"] as const;

/**
 * Column-aligned table skeleton rendered inside `<tbody>` while the roster loads.
 * Uses a GPU-composited pseudo-element shimmer (`transform: translateX`),
 * falls back to static calm blocks under reduced motion, and preserves the
 * accessible `role="status"` "Loading environments…" announcement.
 */
export function RosterSkeleton({
  rows = 8,
  visibleColumnCount,
  density = "comfortable",
}: RosterSkeletonProps) {
  const { t } = useTranslation();
  const rowCount = Math.max(1, Math.floor(rows));
  const colCount = Math.max(1, Math.floor(visibleColumnCount));
  const nameColIndex = colCount >= 4 ? 2 : colCount >= 2 ? 1 : 0;

  return (
    <>
      {Array.from({ length: rowCount }, (_, rowIndex) => {
        const primaryWidth = PRIMARY_WIDTHS[rowIndex % PRIMARY_WIDTHS.length]!;
        const secondaryWidth = SECONDARY_WIDTHS[rowIndex % SECONDARY_WIDTHS.length]!;
        return (
          <tr
            key={`skeleton-row-${rowIndex}`}
            className="roster-skeleton-row"
            data-skeleton-density={density}
            aria-hidden={rowIndex > 0 ? true : undefined}
          >
            {Array.from({ length: colCount }, (_, colIndex) => {
              const isFirst = colIndex === 0;
              const isLast = colCount > 1 && colIndex === colCount - 1;
              const isName = colIndex === nameColIndex;
              const cellWidth = CELL_WIDTHS[(rowIndex + colIndex) % CELL_WIDTHS.length]!;

              return (
                <td
                  key={`skeleton-cell-${rowIndex}-${colIndex}`}
                  className={
                    isFirst && colCount > 1
                      ? "chk roster-skeleton-cell"
                      : isLast
                        ? "col-action roster-skeleton-cell is-action"
                        : "roster-skeleton-cell"
                  }
                >
                  {rowIndex === 0 && isFirst && (
                    <span className="sr-only" role="status">
                      {t("Loading environments…")}
                    </span>
                  )}
                  {isFirst && colCount > 1 ? (
                    <span className="roster-skeleton-bar is-checkbox" aria-hidden="true" />
                  ) : isLast ? (
                    <span className="roster-skeleton-actions" aria-hidden="true">
                      <span className="roster-skeleton-bar is-action-pill" />
                    </span>
                  ) : isName ? (
                    <span className="roster-skeleton-stack" aria-hidden="true">
                      <span
                        className="roster-skeleton-bar is-title"
                        style={{ width: primaryWidth }}
                      />
                      {density !== "compact" && (
                        <span
                          className="roster-skeleton-bar is-sub"
                          style={{ width: secondaryWidth }}
                        />
                      )}
                    </span>
                  ) : (
                    <span
                      className="roster-skeleton-bar is-text"
                      style={{ width: cellWidth }}
                      aria-hidden="true"
                    />
                  )}
                </td>
              );
            })}
          </tr>
        );
      })}
    </>
  );
}
