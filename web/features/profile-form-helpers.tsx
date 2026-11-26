import { useEffect, useRef, useState } from "react";
import type { EditProfile, ProxyCheckResult, RuntimeDownload, UiProfile } from "../api.ts";
import type { InspectionEditField } from "../environment-inspection.tsx";
import { useTranslation } from "../i18n.tsx";
import type { FormChromiumRuntime } from "../profile-creation-runtime.ts";
import type { ProfileEditorBrowserLabel } from "../profile-editor-status.tsx";
import { proxyExitNote } from "../proxy-check-presentation.ts";
import { AppIcon } from "../ui-primitives.tsx";

const Icon = AppIcon;

/** Mirrors MAX_CUSTOM_NO_LENGTH in parse.ts — the server rejects anything longer. */
export const MAX_CUSTOM_NO = 12;

export const CSV_TEMPLATE =
  "name,group,platform,proxy,username,password,email,emailpassword,twofa\n" +
  "alice_warmup,Warmup,x.com,1.2.3.4:8080:proxyuser:proxypass,alice_user,SuperSecret1,alice@example.com,MailboxSecret1,JBSWY3DPEHPK3PXP\n" +
  "bob_eu,EU,telegram.org,,bob_user,SuperSecret2,bob@example.com,MailboxSecret2,\n" +
  "carol_noproxy,Warmup,,,carol_user,SuperSecret3,carol@example.com,MailboxSecret3,KRSXG5CTMVRXEZLU\n";

export const TXT_EXAMPLE =
  "id=k1example01\ngroup=Warmup\nplatform=x.com\nname=alice_warmup\nusername=alice@example.com\n" +
  "password=SuperSecret1\nemail=mailbox@example.com\nemailpassword=MailboxSecret1\nfakey=JBSWY3DPEHPK3PXP\ncookie=[]\nproxytype=http\n" +
  "proxy=1.2.3.4:8080:proxyuser:proxypass\nua=\nresolution=1920*1080\n******************\n";

// Example sheet for the Update-from-file flow. The FIRST column (id) is what
// matches each row to an existing profile — keep it. Edit the other columns;
// delete any column you don't want to change.
export const UPDATE_TEMPLATE_CSV =
  "id,name,group,platform,proxy,proxytype,username,password,twofa,resolution,custom_no\n" +
  "<paste-the-profile-id-here>,New name,Warmup,x.com,1.2.3.4:8080:user:pass,http,new@example.com,NewPass1,JBSWY3DPEHPK3PXP,1920*1080,123456\n";

/**
 * How many profiles a pasted AdsPower export would create. Every record starts
 * with its own `id=` line, so counting those is exact rather than a guess at
 * blocks — and it gives the operator a number to sanity-check before importing.
 */
export function countPastedRecords(text: string): number {
  return (text.match(/^id=/gm) ?? []).length;
}

export function sameExtensionSelection(left: string[], right: string[]): boolean {
  const leftIds = new Set(left);
  const rightIds = new Set(right);
  return leftIds.size === rightIds.size && [...leftIds].every((id) => rightIds.has(id));
}

export function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function StatusDot({ running }: { running: boolean }) {
  return <span className={`dot ${running ? "on" : ""}`} title={running ? "running" : "stopped"} />;
}

export interface EditorFieldFeedback {
  field: string;
  invalid: boolean;
  describedBy: string;
}

export function editorFieldAttributes(feedback?: EditorFieldFeedback) {
  return {
    "data-profile-field": feedback?.field,
    "aria-invalid": feedback?.invalid || undefined,
    "aria-describedby": feedback?.invalid ? feedback.describedBy : undefined,
  };
}

export function focusEditorTarget(target: HTMLElement | null | undefined, behavior: ScrollBehavior) {
  if (!target) return;
  for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.tagName === "DETAILS") (ancestor as HTMLDetailsElement).open = true;
  }
  target.focus({ preventScroll: true });
  target.scrollIntoView({ behavior, block: "nearest" });
}

/** Keep keyboard navigation inside an editor and return to its entry point. */
export function useProfileEditorFocus(
  open: boolean,
  ready = true,
  returnFocus?: { current: HTMLElement | null },
  fieldOnOpen?: { current: InspectionEditField | null },
) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const editor = ref.current;
    if (!editor) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      [...editor.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
        .filter((element) => !element.closest('[inert], [hidden], [aria-hidden="true"]') && element.getClientRects().length > 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) {
        event.preventDefault();
        editor.focus();
        return;
      }
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === editor || !editor.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !editor.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    editor.focus();
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const target = returnFocus?.current?.isConnected ? returnFocus.current : previous;
      if (returnFocus) returnFocus.current = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [open, returnFocus]);
  useEffect(() => {
    const editor = ref.current;
    if (!open || !ready || !editor) return;
    if (fieldOnOpen?.current) {
      const field = fieldOnOpen.current;
      fieldOnOpen.current = null;
      if (document.activeElement !== editor && editor.contains(document.activeElement)) return;
      const target = editor.querySelector<HTMLElement>(`[data-profile-field="${field}"]:not(:disabled)`);
      if (target) {
        focusEditorTarget(target, "instant");
        return;
      }
    }
    editor.querySelector<HTMLInputElement>('.modal-body input:not(:disabled):not([readonly])')?.focus({ preventScroll: true });
  }, [open, ready, fieldOnOpen]);
  return ref;
}

/**
 * Real brand marks for the platforms a profile can target. A letter in a colored
 * box reads as a placeholder; the actual logo is what makes a row scannable at a
 * glance. Paths are the official single-color marks on a 24x24 grid, filled (not
 * stroked) — see .brandmark in styles.css. Tile colors live in CSS as .pm-*.
 */
export const PLATFORM_MARKS: Record<string, { key: string; path: string }> = {
  "x.com": {
    key: "x",
    path: "M18.9 1.153h3.682l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.153h7.594l5.243 6.932ZM17.61 20.644h2.04L6.486 3.24H4.298Z",
  },
  "telegram.org": {
    key: "telegram",
    path: "M23.91 3.79 20.3 20.84c-.25 1.21-.98 1.5-1.99.93l-5.49-4.05-2.65 2.55c-.3.3-.55.55-1.12.55l.4-5.63 10.24-9.25c.45-.4-.1-.62-.69-.22L6.44 13.09.2 11.14c-1.36-.42-1.38-1.36.28-2.01L22.17 1.8c1.13-.42 2.12.26 1.74 1.99Z",
  },
  "instagram.com": {
    key: "instagram",
    path: "M12 0C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63a5.9 5.9 0 0 0-2.13 1.38A5.9 5.9 0 0 0 .63 4.14C.33 4.9.13 5.78.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.27.26 2.15.56 2.91a5.9 5.9 0 0 0 1.38 2.13 5.9 5.9 0 0 0 2.13 1.38c.76.3 1.64.5 2.91.56C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c1.27-.06 2.15-.26 2.91-.56a5.9 5.9 0 0 0 2.13-1.38 5.9 5.9 0 0 0 1.38-2.13c.3-.76.5-1.64.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.27-.26-2.15-.56-2.91a5.9 5.9 0 0 0-1.38-2.13A5.9 5.9 0 0 0 19.86.63c-.76-.3-1.64-.5-2.91-.56C15.67.01 15.26 0 12 0Zm0 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23-.06-1.27-.07-1.65-.07-4.85s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16Zm0 3.68a6.16 6.16 0 1 0 0 12.32 6.16 6.16 0 0 0 0-12.32ZM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm7.85-10.4a1.44 1.44 0 1 1-2.88 0 1.44 1.44 0 0 1 2.88 0Z",
  },
  "facebook.com": {
    key: "facebook",
    path: "M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.09 24 18.1 24 12.07Z",
  },
  "tiktok.com": {
    key: "tiktok",
    path: "M12.53.02C13.84 0 15.14.01 16.44 0c.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07Z",
  },
  "linkedin.com": {
    key: "linkedin",
    path: "M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13Zm1.78 13.02H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0Z",
  },
  "reddit.com": {
    key: "reddit",
    path: "M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0Zm6.07 6.53a1.4 1.4 0 0 1 1.4 1.4 1.4 1.4 0 0 1-.83 1.28c.02.15.03.3.03.45 0 2.87-3.44 5.2-7.67 5.2s-7.67-2.33-7.67-5.2c0-.16.01-.31.03-.46a1.4 1.4 0 1 1 1.58-2.28 7.6 7.6 0 0 1 4.1-1.31l.78-3.66a.34.34 0 0 1 .4-.26l2.6.55a1 1 0 1 1-.14.67l-2.24-.48-.7 3.3c1.5.06 2.9.5 4.05 1.2a1.4 1.4 0 0 1 1.28-.8ZM8.1 10.42a1.16 1.16 0 1 0 0 2.32 1.16 1.16 0 0 0 0-2.32Zm7.8 0a1.16 1.16 0 1 0 0 2.32 1.16 1.16 0 0 0 0-2.32Zm-7.6 4.9a.34.34 0 0 0-.24.58c.98.98 2.53 1.46 3.94 1.46s2.96-.48 3.94-1.46a.34.34 0 0 0-.48-.48c-.78.78-2.1 1.18-3.46 1.18s-2.68-.4-3.46-1.18a.34.34 0 0 0-.24-.1Z",
  },
  "youtube.com": {
    key: "youtube",
    path: "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
  },
  "threads.com": {
    key: "threads",
    path: "M18.263 11.097c-.03-3.486-1.92-5.586-5.111-5.586-2.13 0-3.922.963-4.863 2.499l2.062 1.438c.535-.843 1.272-1.543 2.628-1.543 1.528 0 2.318.85 2.544 2.431a15 15 0 0 0-2.236-.173c-4.125 0-6.068 1.867-6.068 4.336s1.943 3.99 4.804 3.99c3.139 0 5.013-2.115 5.781-4.735.798.361 1.348 1.204 1.348 2.47 0 3.387-3.907 5.232-7.22 5.232-4.885 0-8.077-3.207-8.077-8.424 0-6.392 4.223-10.487 9.9-10.487 3.808 0 5.69 1.671 6.97 3.914l2.108-1.475C21.44 2.078 18.331 0 13.663 0 6.227 0 1.168 5.277 1.168 12.934c0 7 4.953 11.066 10.856 11.066 4.878 0 9.809-2.846 9.809-7.716 0-2.545-1.46-4.231-3.569-5.187m-6.33 4.855c-1.077 0-2.026-.512-2.026-1.453 0-1.483 1.822-1.934 3.606-1.934.678 0 1.34.045 1.927.173-.422 1.927-1.671 3.215-3.508 3.214Z",
  },
  "pinterest.com": {
    key: "pinterest",
    path: "M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z",
  },
  "snapchat.com": {
    key: "snapchat",
    path: "M12.206.793c.99 0 4.347.276 5.93 3.821.529 1.193.403 3.219.299 4.847l-.003.06c-.012.18-.022.345-.03.51.075.045.203.09.401.09.3-.016.659-.12 1.033-.301.165-.088.344-.104.464-.104.182 0 .359.029.509.09.45.149.734.479.734.838.015.449-.39.839-1.213 1.168-.089.029-.209.075-.344.119-.45.135-1.139.36-1.333.81-.09.224-.061.524.12.868l.015.015c.06.136 1.526 3.475 4.791 4.014.255.044.435.27.42.509 0 .075-.015.149-.045.225-.24.569-1.273.988-3.146 1.271-.059.091-.12.375-.164.57-.029.179-.074.36-.134.553-.076.271-.27.405-.555.405h-.03c-.135 0-.313-.031-.538-.074-.36-.075-.765-.135-1.273-.135-.3 0-.599.015-.913.074-.6.104-1.123.464-1.723.884-.853.599-1.826 1.288-3.294 1.288-.06 0-.119-.015-.18-.015h-.149c-1.468 0-2.427-.675-3.279-1.288-.599-.42-1.107-.779-1.707-.884-.314-.045-.629-.074-.928-.074-.54 0-.958.089-1.272.149-.211.043-.391.074-.54.074-.374 0-.523-.224-.583-.42-.061-.192-.09-.389-.135-.567-.046-.181-.105-.494-.166-.57-1.918-.222-2.95-.642-3.189-1.226-.031-.063-.052-.15-.055-.225-.015-.243.165-.465.42-.509 3.264-.54 4.73-3.879 4.791-4.02l.016-.029c.18-.345.224-.645.119-.869-.195-.434-.884-.658-1.332-.809-.121-.029-.24-.074-.346-.119-1.107-.435-1.257-.93-1.197-1.273.09-.479.674-.793 1.168-.793.146 0 .27.029.383.074.42.194.789.3 1.104.3.234 0 .384-.06.465-.105l-.046-.569c-.098-1.626-.225-3.651.307-4.837C7.392 1.077 10.739.807 11.727.807l.419-.015h.06z",
  },
  "discord.com": {
    key: "discord",
    path: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
  },
  "twitch.tv": {
    key: "twitch",
    path: "M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z",
  },
  "gmail.com": {
    key: "gmail",
    path: "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z",
  },
  "amazon.com": {
    key: "amazon",
    path: "M.045 18.02c.072-.116.187-.124.348-.022 3.636 2.11 7.594 3.166 11.87 3.166 2.852 0 5.668-.533 8.447-1.595l.315-.14c.138-.06.234-.1.293-.13.226-.088.39-.046.525.13.12.174.09.336-.12.48-.256.19-.6.41-1.006.654-1.244.743-2.64 1.316-4.185 1.726a17.617 17.617 0 01-10.951-.577 17.88 17.88 0 01-5.43-3.35c-.1-.074-.151-.15-.151-.22 0-.047.021-.09.051-.13zm6.565-6.218c0-1.005.247-1.863.743-2.577.495-.71 1.17-1.25 2.04-1.615.796-.335 1.756-.575 2.912-.72.39-.046 1.033-.103 1.92-.174v-.37c0-.93-.105-1.558-.3-1.875-.302-.43-.78-.65-1.44-.65h-.182c-.48.046-.896.196-1.246.46-.35.27-.575.63-.675 1.096-.06.3-.206.465-.435.51l-2.52-.315c-.248-.06-.372-.18-.372-.39 0-.046.007-.09.022-.15.247-1.29.855-2.25 1.82-2.88.976-.616 2.1-.975 3.39-1.05h.54c1.65 0 2.957.434 3.888 1.29.135.15.27.3.405.48.12.165.224.314.283.45.075.134.15.33.195.57.06.254.105.42.135.51.03.104.062.3.076.615.01.313.02.493.02.553v5.28c0 .376.06.72.165 1.036.105.313.21.54.315.674l.51.674c.09.136.136.256.136.36 0 .12-.06.226-.18.314-1.2 1.05-1.86 1.62-1.963 1.71-.165.135-.375.15-.63.045a6.062 6.062 0 01-.526-.496l-.31-.347a9.391 9.391 0 01-.317-.42l-.3-.435c-.81.886-1.603 1.44-2.4 1.665-.494.15-1.093.227-1.83.227-1.11 0-2.04-.343-2.76-1.034-.72-.69-1.08-1.665-1.08-2.94l-.05-.076zm3.753-.438c0 .566.14 1.02.425 1.364.285.34.675.512 1.155.512.045 0 .106-.007.195-.02.09-.016.134-.023.166-.023.614-.16 1.08-.553 1.424-1.178.165-.28.285-.58.36-.91.09-.32.12-.59.135-.8.015-.195.015-.54.015-1.005v-.54c-.84 0-1.484.06-1.92.18-1.275.36-1.92 1.17-1.92 2.43l-.035-.02zm9.162 7.027c.03-.06.075-.11.132-.17.362-.243.714-.41 1.05-.5a8.094 8.094 0 011.612-.24c.14-.012.28 0 .41.03.65.06 1.05.168 1.172.33.063.09.099.228.099.39v.15c0 .51-.149 1.11-.424 1.8-.278.69-.664 1.248-1.156 1.68-.073.06-.14.09-.197.09-.03 0-.06 0-.09-.012-.09-.044-.107-.12-.064-.24.54-1.26.806-2.143.806-2.64 0-.15-.03-.27-.087-.344-.145-.166-.55-.257-1.224-.257-.243 0-.533.016-.87.046-.363.045-.7.09-1 .135-.09 0-.148-.014-.18-.044-.03-.03-.036-.047-.02-.077 0-.017.006-.03.02-.063v-.06z",
  },
  "ebay.com": {
    key: "ebay",
    path: "M6.056 12.132v-4.92h1.2v3.026c.59-.703 1.402-.906 2.202-.906 1.34 0 2.828.904 2.828 2.855 0 .233-.015.457-.06.668.24-.953 1.274-1.305 2.896-1.344.51-.018 1.095-.018 1.56-.018v-.135c0-.885-.556-1.244-1.53-1.244-.72 0-1.245.3-1.305.81h-1.275c.136-1.29 1.5-1.62 2.686-1.62 1.064 0 1.995.27 2.415 1.02l-.436-.84h1.41l2.055 4.125 2.055-4.126H24l-3.72 7.305h-1.346l1.07-2.04-2.33-4.38c.13.255.2.555.2.93v2.46c0 .346.01.69.04 1.005H16.8a6.543 6.543 0 01-.046-.765c-.603.734-1.32.96-2.32.96-1.48 0-2.272-.78-2.272-1.695 0-.15.015-.284.037-.405-.3 1.246-1.36 2.086-2.767 2.086-.87 0-1.694-.315-2.2-.93 0 .24-.015.494-.04.734h-1.18c.02-.39.04-.855.04-1.245v-1.05h-4.83c.065 1.095.818 1.74 1.853 1.74.718 0 1.355-.3 1.568-.93h1.24c-.24 1.29-1.61 1.725-2.79 1.725C.95 15.009 0 13.822 0 12.232c0-1.754.982-2.91 3.116-2.91 1.688 0 2.93.886 2.94 2.806v.005zm9.137.183c-1.095.034-1.77.233-1.77.95 0 .465.36.97 1.305.97 1.26 0 1.935-.69 1.935-1.814v-.13c-.45 0-.99.006-1.484.022h.012zm-6.06 1.875c1.11 0 1.876-.806 1.876-2.02s-.768-2.02-1.893-2.02c-1.11 0-1.89.806-1.89 2.02s.765 2.02 1.875 2.02h.03zm-4.35-2.514c-.044-1.125-.854-1.546-1.725-1.546-.944 0-1.694.474-1.815 1.546z",
  },
  "etsy.com": {
    key: "etsy",
    path: "M8.559 2.445c0-.325.033-.52.59-.52h7.465c1.3 0 2.02 1.11 2.54 3.193l.42 1.666h1.27c.23-4.728.43-6.784.43-6.784s-3.196.36-5.09.36H6.635L1.521.196v1.37l1.725.326c1.21.24 1.5.496 1.6 1.606 0 0 .11 3.27.11 8.64 0 5.385-.09 8.61-.09 8.61 0 .973-.39 1.333-1.59 1.573l-1.722.33V24l5.13-.165h8.55c1.935 0 6.39.165 6.39.165.105-1.17.75-6.48.855-7.064h-1.2l-1.284 2.91c-1.005 2.28-2.476 2.445-4.11 2.445h-4.906c-1.63 0-2.415-.64-2.415-2.05V12.8s3.62 0 4.79.096c.912.064 1.463.325 1.76 1.598l.39 1.695h1.41l-.09-4.278.192-4.305h-1.391l-.45 1.89c-.283 1.244-.48 1.47-1.754 1.6-1.666.17-4.815.14-4.815.14V2.45h-.05z",
  },
};

export const KNOWN_PLATFORMS: { value: string; label: string }[] = [
  { value: "", label: "(none)" },
  { value: "x.com", label: "Twitter / X" },
  { value: "instagram.com", label: "Instagram" },
  { value: "facebook.com", label: "Facebook" },
  { value: "tiktok.com", label: "TikTok" },
  { value: "linkedin.com", label: "LinkedIn" },
  { value: "reddit.com", label: "Reddit" },
  { value: "telegram.org", label: "Telegram" },
  { value: "youtube.com", label: "YouTube" },
  { value: "threads.com", label: "Threads" },
  { value: "pinterest.com", label: "Pinterest" },
  { value: "snapchat.com", label: "Snapchat" },
  { value: "discord.com", label: "Discord" },
  { value: "twitch.tv", label: "Twitch" },
  { value: "gmail.com", label: "Gmail" },
  { value: "amazon.com", label: "Amazon" },
  { value: "ebay.com", label: "eBay" },
  { value: "etsy.com", label: "Etsy" },
];

export function PlatformPill({ platform }: { platform: string }) {
  if (!platform) return <span className="muted">—</span>;
  const known = KNOWN_PLATFORMS.find((candidate) => candidate.value === platform);
  const mark = PLATFORM_MARKS[platform];
  return (
    <span className="platform-pill" title={platform}>
      <span className={`glyph pm-${mark?.key ?? "other"}`}>
        {mark ? <svg className="brandmark" viewBox="0 0 24 24" aria-hidden="true"><path d={mark.path} /></svg> : platform.slice(0, 1).toUpperCase()}
      </span>
      {known?.label ?? platform}
    </span>
  );
}

/**
 * Group selector used in every dialog: a styled <select> of existing groups
 * plus "➕ New group…", which flips to an inline text field so you can create a
 * group on the fly. Consistent with the other modal selects (no native datalist).
 */
export function GroupPicker({
  value,
  onChange,
  groups,
  allowCreate = true,
  emptyLabel = "(ungrouped)",
}: {
  value: string;
  onChange: (v: string) => void;
  groups: string[];
  allowCreate?: boolean;
  emptyLabel?: string;
}) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  if (creating) {
    return (
      <div className="grouppick">
        <input autoFocus placeholder={t("new group name")} value={value} onChange={(e) => onChange(e.target.value)} />
        <button
          type="button"
          className="btn gp-back tip"
          data-tip={t("Pick an existing group")}
          title={t("Pick an existing group")}
          onClick={() => {
            setCreating(false);
            onChange("");
          }}
        >
          <Icon name="chevronLeft" />
        </button>
      </div>
    );
  }
  return (
    <select
      value={groups.includes(value) ? value : ""}
      onChange={(e) => {
        if (e.target.value === "__new__") {
          setCreating(true);
          onChange("");
        } else onChange(e.target.value);
      }}
    >
      <option value="">{t(emptyLabel)}</option>
      {groups.map((g) => <option key={g} value={g}>{g}</option>)}
      {allowCreate && <option value="__new__">{t("➕ New group…")}</option>}
    </select>
  );
}

export function PlatformPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const known = KNOWN_PLATFORMS.some((p) => p.value === value);
  const [creating, setCreating] = useState(false);
  if (creating || (!!value && !known)) {
    return (
      <div className="grouppick">
        <input autoFocus placeholder={t("new platform (e.g. linkedin.com)")} value={value} onChange={(e) => onChange(e.target.value)} />
        <button
          type="button"
          className="btn gp-back tip"
          data-tip={t("Pick a known platform")}
          title={t("Pick a known platform")}
          onClick={() => {
            setCreating(false);
            onChange("");
          }}
        >
          <Icon name="chevronLeft" />
        </button>
      </div>
    );
  }
  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value === "__new__") {
          setCreating(true);
          onChange("");
        } else onChange(e.target.value);
      }}
    >
      {KNOWN_PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.value ? p.label : t("None")}</option>)}
      <option value="__new__">{t("➕ New platform…")}</option>
    </select>
  );
}

export const AUTOMATIC_FINGERPRINT_FIELDS = [
  ["User agent", "Automatic"],
  ["Browser version", "Automatic · latest installed"],
  ["GPU", "Automatic"],
  ["CPU", "Automatic"],
  ["RAM", "Automatic"],
  ["Fingerprint seed", "Automatic · unique and stable"],
  ["Timezone", "Stored · set from the proxy automatically"],
  ["Canvas / WebGL / audio", "Automatic"],
  ["WebRTC", "Automatic · proxy-aware"],
] as const;

// A template literal, so the translation key holds the same line breaks as the source.
export const FINGERPRINT_EDIT_WARNING = `These settings work together. Changing them can create an inconsistent fingerprint, make your browser easier to detect, or trigger account verification. We recommend automatic settings. Custom changes are your responsibility.

Save fingerprint changes?`;

export const CLOAKBROWSER_NOTE = "CloakBrowser profiles on one computer can be linked to each other. Use Chromium or Firefox for separate identities.";

export function browserLabel(engine: "chromium" | "firefox", chromiumRuntime?: string): ProfileEditorBrowserLabel {
  if (engine === "firefox") return "Firefox";
  return chromiumRuntime ? "Chromium" : "CloakBrowser";
}

export function validEditDetail(value: unknown, id: string): value is EditProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return (
    profile.id === id &&
    (profile.engine === "chromium" || profile.engine === "firefox") &&
    ["name", "group", "platform", "proxyType", "proxy", "username", "password", "email", "emailPassword", "twofa", "resolution", "tags", "timezone", "platformOs"].every(
      (key) => typeof profile[key] === "string",
    ) &&
    ["chromiumRuntime", "proxyError", "customNo", "locale", "cores", "fingerprintSeed"].every(
      (key) => profile[key] === undefined || typeof profile[key] === "string",
    ) &&
    Array.isArray(profile.extensions) &&
    profile.extensions.every((extension) => typeof extension === "string")
  );
}

export function FingerprintSettings({
  engine,
  chromiumRuntime,
  screen,
  onScreenChange,
  platformOs,
  onPlatformOsChange,
  timezone,
  onTimezoneChange,
  locale,
  onLocaleChange,
  cores,
  onCoresChange,
  seed,
  onSeedChange,
  disabled = false,
  allowAutomaticScreen = true,
  onUndo,
  hardware,
  feedback,
}: {
  engine: "chromium" | "firefox";
  chromiumRuntime?: string;
  screen: string;
  onScreenChange: (value: string) => void;
  platformOs: string;
  onPlatformOsChange?: (value: string) => void;
  timezone?: string;
  onTimezoneChange?: (value: string) => void;
  locale?: string;
  onLocaleChange?: (value: string) => void;
  cores?: string;
  onCoresChange?: (value: string) => void;
  seed?: string;
  onSeedChange?: (value: string) => void;
  disabled?: boolean;
  allowAutomaticScreen?: boolean;
  onUndo?: () => void;
  feedback?: (field: string) => EditorFieldFeedback;
  hardware?: {
    gpu?: string;
    cores?: number;
  };
}) {
  const { t } = useTranslation();
  return (
    <details className="fingerprint-settings">
      <summary>
        <span>{t("Customize")}</span>
      </summary>
      <div className="fingerprint-grid">
        <label className="fld">
          <span>{t("Screen")}</span>
          <input
            {...editorFieldAttributes(feedback?.("resolution"))}
            value={screen}
            disabled={disabled}
            placeholder={allowAutomaticScreen ? t("Automatic · e.g. 1920x1080") : t("Required · e.g. 1920x1080")}
            onChange={(event) => onScreenChange(event.target.value)}
          />
        </label>
        <label className="fld">
          <span>{t("Operating system")}</span>
          {onPlatformOsChange ? (
            <select {...editorFieldAttributes(feedback?.("platformOs"))} value={platformOs} disabled={disabled} onChange={(event) => onPlatformOsChange(event.target.value)}>
              <option value="">{t("Automatic — match this computer")}</option>
              <option value="windows">Windows</option>
              <option value="macos">macOS</option>
              <option value="linux">Linux</option>
            </select>
          ) : (
            <input value={{ windows: "Windows", macos: "macOS", linux: "Linux" }[platformOs] ?? t("Automatic")} readOnly tabIndex={-1} className="ro" />
          )}
        </label>
        {onTimezoneChange && (
          <label className="fld">
            <span>{t("Timezone")}</span>
            <input {...editorFieldAttributes(feedback?.("timezone"))} value={timezone ?? ""} disabled={disabled} placeholder={t("Automatic · e.g. Europe/Paris")} onChange={(event) => onTimezoneChange(event.target.value)} />
          </label>
        )}
        {onLocaleChange && (
          <label className="fld">
            <span>{t("Language")}</span>
            <input {...editorFieldAttributes(feedback?.("locale"))} value={locale ?? ""} disabled={disabled} placeholder={t("Automatic · e.g. en-US")} onChange={(event) => onLocaleChange(event.target.value)} />
          </label>
        )}
        {onCoresChange && (
          <label className="fld">
            <span>{t("CPU")}</span>
            <input
              {...editorFieldAttributes(feedback?.("cores"))}
              value={cores ?? ""}
              disabled={disabled}
              inputMode="numeric"
              placeholder={hardware?.cores ? t("Automatic · {n} cores", { n: hardware.cores }) : t("Automatic · e.g. 8")}
              onChange={(event) => onCoresChange(event.target.value)}
            />
          </label>
        )}
        {onSeedChange && (
          <label className="fld">
            <span>{t("Fingerprint seed")}</span>
            <input {...editorFieldAttributes(feedback?.("fingerprintSeed"))} value={seed ?? ""} disabled={disabled} inputMode="numeric" onChange={(event) => onSeedChange(event.target.value)} />
          </label>
        )}
        {AUTOMATIC_FINGERPRINT_FIELDS.filter(
          ([label]) => !((label === "Timezone" && onTimezoneChange) || (label === "CPU" && onCoresChange) || (label === "Fingerprint seed" && onSeedChange)),
        ).map(([label, value]) => {
          // A stored value is the same on every computer that opens the profile.
          const stored = label === "GPU" ? hardware?.gpu : label === "CPU" && hardware?.cores ? `${hardware.cores} cores` : undefined;
          return (
            <label className="fld" key={label}>
              <span>{t(label)}</span>
              <input value={stored ? `Stored · ${stored}` : t(value)} title={stored} readOnly tabIndex={-1} className="ro" />
            </label>
          );
        })}
        <div className="hint">{t("We recommend keeping every setting automatic. Custom values can make the browser look inconsistent, easier to detect, and can trigger account checks.")}</div>
        <div className="hint">
          {onTimezoneChange
            ? `${t("Leave timezone or CPU blank for automatic settings. Screen size and fingerprint seed need explicit values; a blank language keeps the saved language. A timezone you type stays when the proxy changes.")}${chromiumRuntime && cores ? ` ${t("Chromium shows at most the processor count of the computer it runs on.")}` : ""}`
            : engine === "firefox"
              ? t("Firefox uses its native profile. CDP, PDF, and Chrome extensions are unavailable.")
              : t("The browser keeps the locked values coordinated. Screen and operating system are the only fingerprint settings you can override.")}
        </div>
        {onUndo && (
          <button type="button" className="btn ghost" disabled={disabled} onClick={onUndo}>
            {t("Undo fingerprint edits")}
          </button>
        )}
      </div>
    </details>
  );
}

/** The browser downloads that opening this profile waits for. */
export function profileDownloads(profile: UiProfile, downloads: RuntimeDownload[]): RuntimeDownload[] {
  const runtime = profile.engine === "firefox" ? "firefox" : profile.chromiumRuntime ?? "cloakbrowser";
  return downloads.filter((download) => download.runtime === runtime);
}

export function launchRecovery(message: string) {
  // Older sidecars send the public launcher guidance without a separate reason code.
  if (/^(?:Firefox|Chromium|CloakBrowser|The fonts for this profile's operating system) could not be downloaded\b/.test(message)) return "download";
  if (/^(?:Saved proxy settings are invalid|The configured local (?:proxy|SOCKS5 port)|Authenticated HTTPS proxies are unsupported)/.test(message)) return "proxy";
  if (/^(?:Local proxy startup|Page preloading) settings could not be read\b/.test(message)) return "network";
  return "logs";
}

export const BLANK_FORM = {
  name: "",
  engine: "chromium" as "chromium" | "firefox",
  chromiumRuntime: "" as FormChromiumRuntime,
  group: "",
  platform: "",
  proxyType: "http",
  host: "",
  port: "",
  user: "",
  pass: "",
  screen: "",
  platformOs: "",
  customNo: "",
  username: "",
  password: "",
  email: "",
  emailPassword: "",
  twofa: "",
};
export type CreateProfileForm = typeof BLANK_FORM;

export type ProxyCheckUiState = {
  checking: boolean;
  result: ProxyCheckResult | null;
  error: "invalid" | "unavailable" | null;
};

export const EMPTY_PROXY_CHECK: ProxyCheckUiState = { checking: false, result: null, error: null };

export function proxyFailureMessage(t: (s: string) => string, reason: ProxyCheckResult["reason"]): string {
  if (reason === "authentication_failed") return t("Proxy authentication failed.");
  if (reason === "timeout") return t("Proxy connection timed out.");
  if (reason === "dns_failed") return t("Proxy host could not be resolved.");
  if (reason === "unreachable") return t("Proxy server is unreachable.");
  if (reason === "proxy_bypassed") return t("Traffic did not use this proxy.");
  return t("Proxy connection failed.");
}

export function ProxyCheckFeedback({ hasProxy, state }: { hasProxy: boolean; state: ProxyCheckUiState }) {
  const { t } = useTranslation();
  if (!hasProxy) return null;
  if (state.error) {
    const invalid = state.error === "invalid";
    return (
      <div className={`proxy-check-result ${invalid ? "failed" : "unavailable"}`} role="status">
        <Icon name={invalid ? "alert" : "activity"} className="sm" />
        <span>
          {invalid ? t("Proxy details are invalid. Check them and try again.") : t("Proxy check is unavailable. Try again later.")}
        </span>
      </div>
    );
  }
  const result = state.result;
  // A profile that already has a proxy keeps the offer, so it also shows in Edit profile.
  if (!result) return null;
  const location = [result.city, result.region, result.country].filter(Boolean).join(", ");
  const exit = [result.ip ? t("Exit IP: {ip}", { ip: result.ip }) : "", location].filter(Boolean).join(" · ");
  const comparison = proxyExitNote(result);
  if (result.status === "working") {
    return (
      <div className="proxy-check-result working" role="status">
        <Icon name="check" className="sm" />
        <span>
          <strong>{t("Proxy is working.")}</strong>
          {exit && <> {exit}.</>}
          {result.rotating && <> {t("Rotating exit IPs detected.")}</>}
          {comparison && <> {t(comparison)}</>}
        </span>
      </div>
    );
  }
  if (result.status === "unstable") {
    return (
      <div className="proxy-check-result unstable" role="status">
        <Icon name="warning" className="sm" />
        <span>
          <strong>{t("Proxy checks were mixed.")}</strong>{" "}
          {t("{successes} of {attempts} succeeded.", { successes: result.successes, attempts: result.attempts })}
          {comparison && <> {t(comparison)}</>}
        </span>
      </div>
    );
  }
  if (result.status === "failed") {
    return (
      <div className="proxy-check-result failed" role="status">
        <Icon name="alert" className="sm" />
        <span>{proxyFailureMessage(t, result.reason)}</span>
      </div>
    );
  }
  return (
    <div className="proxy-check-result unavailable" role="status">
      <Icon name="activity" className="sm" />
      <span>{t("Proxy check is unavailable. Try again later.")}</span>
    </div>
  );
}
