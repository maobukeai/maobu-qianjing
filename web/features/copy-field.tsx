import { useState } from "react";
import { useTranslation } from "../i18n";
import { AppIcon } from "../ui-primitives";

export async function copyPlainText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy failed");
}

export function CopyField({
  label,
  value,
  onChange,
  onCopyError,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onCopyError?: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await copyPlainText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (error) {
      setCopied(false);
      onCopyError?.(
        error instanceof Error ? error.message : t("Could not copy to clipboard."),
      );
    }
  };

  return (
    <div className="fld grow">
      <span>{label}</span>
      {/* Copy sits inside the field rather than beside it: a separate bordered
          button per credential turned the dialog into a grid of grey boxes. */}
      <div className="inputwrap">
        <input
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className={`inline-action tip${copied ? " ok" : ""}`}
          data-tip={copied ? t("Copied") : `${t("Copy")} ${label}`}
          aria-label={`${t("Copy")} ${label}`}
          onClick={copy}
        >
          <AppIcon name={copied ? "check" : "copy"} className="sm" />
        </button>
      </div>
    </div>
  );
}
