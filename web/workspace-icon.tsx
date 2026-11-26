import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import {
  WORKSPACE_COLORS,
  WORKSPACE_STATIC_ICONS,
  WORKSPACE_STUDIO_ICONS,
  fetchWorkspaceIconBlobUrl,
  isCustomWorkspaceIcon,
  uploadWorkspaceIcon,
  type BuiltinWorkspaceIcon,
  type CustomWorkspaceIcon,
  type WorkspaceIcon,
  type WorkspaceMetadata,
} from "./workspaces-api.ts";
import catGlassUrl from "./assets/workspace-icons/cat-glass.png";
import prismCrystalUrl from "./assets/workspace-icons/prism-crystal.png";
import rocketPearlUrl from "./assets/workspace-icons/rocket-pearl.png";
import globeGlassUrl from "./assets/workspace-icons/globe-glass.png";
import shieldTitaniumUrl from "./assets/workspace-icons/shield-titanium.png";
import boltAmberUrl from "./assets/workspace-icons/bolt-amber.png";
import "./workspace-icon.css";

type Translator = (source: string, values?: Record<string, string | number>) => string;
export type WorkspaceIconCategory = "studio" | "static" | "custom";

type StudioIconId = typeof WORKSPACE_STUDIO_ICONS[number];
type StaticIconId = typeof WORKSPACE_STATIC_ICONS[number];

const STUDIO_ICON_URLS: Record<StudioIconId, string> = {
  "studio-cat": catGlassUrl,
  "studio-prism": prismCrystalUrl,
  "studio-rocket": rocketPearlUrl,
  "studio-globe": globeGlassUrl,
  "studio-shield": shieldTitaniumUrl,
  "studio-bolt": boltAmberUrl,
};

export const WORKSPACE_ICON_LABELS: Record<BuiltinWorkspaceIcon, string> = {
  "studio-cat": "3D Cat Glass",
  "studio-prism": "3D Optical Prism",
  "studio-rocket": "3D Pearl Rocket",
  "studio-globe": "3D Sapphire Globe",
  "studio-shield": "3D Titanium Shield",
  "studio-bolt": "3D Amber Bolt",
  laptop: "Laptop",
  folder: "Folder",
  briefcase: "Briefcase",
  globe: "Globe",
  star: "Star",
  layers: "Layers",
  bag: "Shopping Bag",
  store: "Storefront",
  shield: "Security Shield",
  key: "Key Vault",
  bot: "Automation Bot",
  terminal: "Terminal",
  cpu: "Compute Cluster",
  video: "Short Video",
  mail: "Mailbox",
  crown: "Flagship Crown",
  monogram: "Name initial",
};

const STATIC_ICON_PATHS: Record<StaticIconId, ReactNode> = {
  laptop: <><rect x="4" y="4" width="16" height="12" rx="2" /><path d="M2 20h20" /></>,
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9H3Z" />,
  briefcase: <><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V3h8v4M3 12h18M10 12v3h4v-3" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
  star: <path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4L2.8 9.7l6.4-.9Z" />,
  layers: <><path d="m12 3 10 5-10 5L2 8Z" /><path d="m2 12 10 5 10-5M2 16l10 5 10-5" /></>,
  bag: <><path d="M6 7h12l1 13H5L6 7Z" /><path d="M9 7V5.5a3 3 0 0 1 6 0V7" /></>,
  store: <><path d="M3 9 5 4h14l2 5v1a2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0V9Z" /><path d="M5 12v8h14v-8" /></>,
  shield: <><path d="M12 3 4.5 6v5.5c0 4.8 3.1 8.8 7.5 10 4.4-1.2 7.5-5.2 7.5-10V6L12 3Z" /><path d="m9.2 12.2 2 2 3.8-4" /></>,
  key: <><circle cx="8" cy="12" r="3.5" /><path d="M11.5 12H20M17.5 12v3M14.5 12v2.2" /></>,
  bot: <><rect x="4" y="7" width="16" height="12" rx="4" /><path d="M12 3v4M9 14h6" /><circle cx="9" cy="11.5" r=".6" /><circle cx="15" cy="11.5" r=".6" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="m7.5 9.5 3 2.5-3 2.5M12.5 14.5h4" /></>,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>,
  video: <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-2.5v9L16 14Z" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  crown: <path d="M3 18h18M4.5 15 3.5 7l5 4 3.5-6 3.5 6 5-4-1 8H4.5Z" />,
};

export function isStudioWorkspaceIcon(icon: WorkspaceIcon): icon is StudioIconId {
  return (WORKSPACE_STUDIO_ICONS as readonly string[]).includes(icon);
}

export function workspaceIconCategory(icon: WorkspaceIcon): WorkspaceIconCategory {
  if (isStudioWorkspaceIcon(icon)) return "studio";
  if (icon === "monogram" || isCustomWorkspaceIcon(icon)) return "custom";
  return "static";
}

export function workspaceIconLabel(icon: WorkspaceIcon, t: Translator): string {
  if (isCustomWorkspaceIcon(icon)) return t("Custom image");
  return t(WORKSPACE_ICON_LABELS[icon] ?? "Laptop");
}

function CustomWorkspaceImage({ icon, fallbackSrc }: { icon: CustomWorkspaceIcon; fallbackSrc: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    setSrc(null);
    void fetchWorkspaceIconBlobUrl(icon)
      .then((url) => { if (active) setSrc(url); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [icon]);

  return (
    <img
      src={failed || !src ? fallbackSrc : src}
      alt=""
      aria-hidden="true"
      onError={() => setFailed(true)}
    />
  );
}

export function StaticWorkspaceIconSvg({ icon }: { icon: StaticIconId }) {
  return (
    <svg className="wm-icon" viewBox="0 0 24 24" aria-hidden="true">
      {STATIC_ICON_PATHS[icon] ?? STATIC_ICON_PATHS.laptop}
    </svg>
  );
}

export interface WorkspaceIconBadgeProps {
  workspace?: Partial<WorkspaceMetadata> | null;
  icon?: WorkspaceIcon;
  color?: string;
  monogram?: string;
  size?: number;
  render?: (name: string, className?: string) => ReactNode;
}

export function WorkspaceIconBadge({
  workspace,
  icon: iconOverride,
  color: colorOverride,
  monogram,
  size,
  render,
}: WorkspaceIconBadgeProps) {
  const resolvedIcon = iconOverride ?? workspace?.icon ?? "laptop";
  const color = colorOverride ?? workspace?.color ?? WORKSPACE_COLORS[0];
  const monogramChar = monogram || ([...(workspace?.name?.trim() || "W")][0]?.toUpperCase() || "W");
  const sizeStyle: CSSProperties = {
    "--workspace-color": color,
    ...(size ? { width: `${size}px`, height: `${size}px` } : {}),
  } as CSSProperties;

  if (monogram || resolvedIcon === "monogram") {
    return (
      <span className="wm-workspace-badge is-monogram" aria-hidden="true" style={sizeStyle}>
        {monogramChar}
      </span>
    );
  }
  if (isCustomWorkspaceIcon(resolvedIcon)) {
    return (
      <span className="wm-workspace-badge is-custom-image" aria-hidden="true" style={sizeStyle}>
        <CustomWorkspaceImage icon={resolvedIcon} fallbackSrc={catGlassUrl} />
      </span>
    );
  }
  if (isStudioWorkspaceIcon(resolvedIcon)) {
    return (
      <span className="wm-workspace-badge is-studio" aria-hidden="true" style={sizeStyle}>
        <img src={STUDIO_ICON_URLS[resolvedIcon]} alt="" />
      </span>
    );
  }
  const customRendered = render?.(resolvedIcon, "wm-icon");
  return (
    <span className="wm-workspace-badge" aria-hidden="true" style={sizeStyle}>
      {customRendered ?? <StaticWorkspaceIconSvg icon={(resolvedIcon in STATIC_ICON_PATHS ? resolvedIcon : "laptop") as StaticIconId} />}
    </span>
  );
}

export interface WorkspaceIconPickerProps {
  value: WorkspaceIcon;
  color: string;
  name: string;
  disabled?: boolean;
  render?: (name: string, className?: string) => ReactNode;
  onChange: (icon: WorkspaceIcon) => void;
  onError?: (message: string) => void;
}

export function WorkspaceIconPicker({
  value,
  color,
  name,
  disabled = false,
  render,
  onChange,
  onError,
}: WorkspaceIconPickerProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<WorkspaceIconCategory>(() => workspaceIconCategory(value));
  const [uploading, setUploading] = useState(false);

  const prevValueRef = useRef(value);
  useEffect(() => {
    if (prevValueRef.current !== value) {
      prevValueRef.current = value;
      setTab(workspaceIconCategory(value));
    }
  }, [value]);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || disabled || uploading) return;
    setUploading(true);
    try {
      const uploaded = await uploadWorkspaceIcon(file);
      onChange(uploaded);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="wm-icon-picker">
      <div className="wm-icon-picker-tabs" role="group" aria-label={t("Workspace icon style")} data-sliding-group data-sliding-axis="horizontal">
        <button type="button" aria-pressed={tab === "studio"} onClick={() => setTab("studio")}>{t("3D Glass")}</button>
        <button type="button" aria-pressed={tab === "static"} onClick={() => setTab("static")}>{t("Minimal")}</button>
        <button type="button" aria-pressed={tab === "custom"} onClick={() => setTab("custom")}>{t("Custom")}</button>
      </div>

      {tab === "studio" && (
        <div key="studio" className="wm-icon-picker-grid" data-sliding-group>
          {WORKSPACE_STUDIO_ICONS.map((icon) => (
            <button
              type="button"
              key={icon}
              className="wm-icon-picker-tile"
              disabled={disabled}
              aria-pressed={value === icon}
              aria-label={t(WORKSPACE_ICON_LABELS[icon])}
              onClick={() => onChange(icon)}
            >
              <WorkspaceIconBadge icon={icon} color={color} size={36} render={render} />
              <span className="wm-icon-picker-tile-name">{t(WORKSPACE_ICON_LABELS[icon])}</span>
            </button>
          ))}
        </div>
      )}

      {tab === "static" && (
        <div key="static" className="wm-icon-picker-grid" data-sliding-group>
          {WORKSPACE_STATIC_ICONS.map((icon) => (
            <button
              type="button"
              key={icon}
              className="wm-icon-picker-tile wm-icon-picker-tile--static"
              disabled={disabled}
              aria-pressed={value === icon}
              aria-label={t(WORKSPACE_ICON_LABELS[icon])}
              title={t(WORKSPACE_ICON_LABELS[icon])}
              onClick={() => onChange(icon)}
            >
              <WorkspaceIconBadge icon={icon} workspace={{ color }} size={28} render={render} />
            </button>
          ))}
        </div>
      )}

      {tab === "custom" && (
        <div className="wm-icon-picker-custom">
          <WorkspaceIconBadge
            workspace={{ color, name, icon: isCustomWorkspaceIcon(value) || value === "monogram" ? value : "monogram" }}
            size={42}
            render={render}
          />
          <div className="wm-icon-picker-custom-copy">
            <div className="wm-icon-picker-custom-actions">
              <label className="btn xs primary" aria-disabled={disabled || uploading}>
                {t(uploading ? "Uploading…" : "Upload image / GIF")}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  disabled={disabled || uploading}
                  hidden
                  onChange={(event) => { void handleFileChange(event); }}
                />
              </label>
              <button
                type="button"
                className="btn xs"
                disabled={disabled || uploading}
                aria-pressed={value === "monogram"}
                aria-label={t("Name initial")}
                onClick={() => onChange("monogram")}
              >
                {t("Use name initial")}
              </button>
            </div>
            <small>{t("Upload PNG, JPG, WebP, or GIF (max 2 MB)")}</small>
          </div>
        </div>
      )}
    </div>
  );
}
