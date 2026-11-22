import { afterEach, describe, expect, test } from "bun:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import { Window } from "happy-dom";
import * as React from "react";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AboutPopover, DEFAULT_GITHUB_REPOSITORY } from "./about-popover.tsx";
import { createDesktopCloseRegistry, DesktopCloseRegistryProvider } from "./desktop-close.tsx";
import { I18nProvider } from "./i18n.tsx";
import type { ResolvedAppSettings, UpdateResult } from "./settings-api.ts";
import type { SignedUpdateProgress, SignedUpdateStatus } from "./signed-update-api.ts";
import type { SignedUpdateStartupController } from "./signed-updates.tsx";
import { windowMouseAction } from "./window-chrome.tsx";
import { createWorkspaceOperationCoordinator, WorkspaceOperationsProvider } from "./workspace-operations.tsx";

const realFetch = globalThis.fetch;

interface MountedDom {
  dom: Window;
  container: HTMLElement;
  cleanup: () => Promise<void>;
}

function baseSettings(overrides: Partial<ResolvedAppSettings["updates"]> = {}, signedCheckOnStartup = false): ResolvedAppSettings {
  return {
    version: 1,
    updates: {
      repository: "",
      channel: "stable",
      checkOnStartup: false,
      ...overrides,
    },
    sync: { enabled: false, folder: "", retainSnapshots: 10 },
    network: { checkLocalProxyBeforeLaunch: false, chromiumPreloading: "browser-default" },
    signedUpdates: { checkOnStartup: signedCheckOnStartup },
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function setupDom(options: {
  desktop?: boolean;
  language?: string;
  clipboardWrite?: (text: string) => Promise<void>;
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}) {
  const dom = new Window({ url: "http://127.0.0.1:47865/ui/" });
  dom.localStorage.setItem("aliasmode.shell.language", options.language ?? "en-US");
  dom.document.documentElement.dataset.desktopMotion = "reduced";

  const keys = [
    "window",
    "document",
    "navigator",
    "localStorage",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "PointerEvent",
    "KeyboardEvent",
    "CustomEvent",
    "MutationObserver",
    "isTauri",
    "IS_REACT_ACT_ENVIRONMENT",
    "fetch",
  ] as const;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const expose = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  if (options.clipboardWrite) {
    Object.defineProperty(dom.navigator, "clipboard", {
      configurable: true,
      value: { writeText: options.clipboardWrite },
    });
  }

  expose("window", dom);
  expose("document", dom.document);
  expose("navigator", dom.navigator);
  expose("localStorage", dom.localStorage);
  expose("HTMLElement", dom.HTMLElement);
  expose("Element", dom.Element);
  expose("Node", dom.Node);
  expose("Event", dom.Event);
  expose("MouseEvent", dom.MouseEvent);
  expose("PointerEvent", dom.PointerEvent ?? dom.MouseEvent);
  expose("KeyboardEvent", dom.KeyboardEvent);
  expose("CustomEvent", dom.CustomEvent);
  expose("MutationObserver", dom.MutationObserver);
  expose("isTauri", options.desktop === true);
  expose("IS_REACT_ACT_ENVIRONMENT", true);
  expose(
    "fetch",
    Object.assign(options.fetchImpl, { preconnect: realFetch.preconnect }),
  );

  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const htmlContainer = container as unknown as HTMLElement;
  const root: Root = createRoot(htmlContainer);

  const cleanup = async () => {
    await act(async () => {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await dom.happyDOM.waitUntilComplete();
    await dom.close();
    for (const key of keys) {
      const descriptor = saved.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };

  return { dom, container: htmlContainer, root, cleanup } satisfies MountedDom & { root: Root };
}

let activeCleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (activeCleanup) {
    await activeCleanup();
    activeCleanup = null;
  }
  globalThis.fetch = realFetch;
});

function TestHarness(props: {
  appVersion?: string;
  initialOpen?: boolean;
  signedUpdateStartup?: SignedUpdateStartupController;
  onOpenUpdateSettings?: () => void;
  onGithubUpdateResult?: (result: UpdateResult | null) => void;
}) {
  const [open, setOpen] = useState(props.initialOpen ?? false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        className="desktop-brand"
        data-no-drag
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>猫步·千境</span>
        <span>{props.appVersion ?? "0.1.0-local.1"}</span>
      </button>
      <AboutPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        appVersion={props.appVersion ?? "0.1.0-local.1"}
        signedUpdateStartup={props.signedUpdateStartup}
        onOpenUpdateSettings={props.onOpenUpdateSettings ?? (() => {})}
        onGithubUpdateResult={props.onGithubUpdateResult}
        dialogId="about-popover-dialog"
      />
    </div>
  );
}

describe("AboutPopover", () => {
  test("opens from .desktop-brand, copies version, switches channel, checks GitHub with fallback repo, and closes on Esc", async () => {
    let settings = baseSettings();
    let lastUpdate: UpdateResult | null = null;
    const patches: unknown[] = [];
    const copiedValues: string[] = [];
    let openedFullSettings = 0;
    const githubResults: Array<UpdateResult | null> = [];

    const mounted = setupDom({
      desktop: false,
      clipboardWrite: async (text) => {
        copiedValues.push(text);
      },
      fetchImpl: async (input, init) => {
        const path = String(input);
        const method = init?.method ?? "GET";
        if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
        if (path === "/ui/api/settings" && method === "GET") return Response.json({ ok: true, settings });
        if (path === "/ui/api/settings" && method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as {
            updates?: Partial<ResolvedAppSettings["updates"]>;
            signedUpdates?: Partial<ResolvedAppSettings["signedUpdates"]>;
          };
          patches.push(patch);
          settings = {
            ...settings,
            updates: { ...settings.updates, ...(patch.updates ?? {}) },
            signedUpdates: { ...settings.signedUpdates, ...(patch.signedUpdates ?? {}) },
          };
          return Response.json({ ok: true, settings });
        }
        if (path === "/ui/api/settings/updates" && method === "GET") {
          return Response.json({ ok: true, update: lastUpdate });
        }
        if (path === "/ui/api/settings/updates" && method === "POST") {
          lastUpdate = {
            status: "available",
            currentVersion: "0.1.0-local.1",
            repository: settings.updates.repository,
            channel: settings.updates.channel,
            checkedAt: Date.now(),
            cached: false,
            latest: {
              version: "0.2.0",
              tag: "v0.2.0",
              name: "v0.2.0",
              notes: "Added local workbench improvements.",
              publishedAt: "2026-11-14T00:00:00Z",
              url: `https://github.com/${settings.updates.repository}/releases/tag/v0.2.0`,
              assets: [],
            },
          };
          return Response.json({ ok: true, update: lastUpdate });
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
    });
    activeCleanup = mounted.cleanup;

    await act(async () => {
      mounted.root.render(
        <I18nProvider>
          <TestHarness
            onOpenUpdateSettings={() => {
              openedFullSettings++;
            }}
            onGithubUpdateResult={(result) => {
              githubResults.push(result);
            }}
          />
        </I18nProvider>,
      );
    });
    await flush();

    const trigger = mounted.container.querySelector(".desktop-brand") as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();

    // Window drag check must ignore .desktop-brand
    expect(windowMouseAction({ button: 0, detail: 1, defaultPrevented: false, target: trigger })).toBeNull();

    // Open popover
    await act(async () => {
      trigger.click();
    });
    await flush();

    const dialog = mounted.container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain("猫步·千境");
    expect(dialog.textContent).toContain("Local edition");
    expect(dialog.textContent).toContain("v0.1.0-local.1");
    expect(dialog.textContent).toContain("Community local build");
    expect(dialog.textContent).toContain("Xreacher (AliasMode)");

    // Copy version
    const copyButton = dialog.querySelector(".about-copy-btn") as HTMLButtonElement;
    await act(async () => {
      copyButton.click();
    });
    await flush();
    expect(copiedValues).toEqual(["0.1.0-local.1"]);
    expect(copyButton.textContent).toBe("Copied ✓");

    // Switch channel to beta
    const channelSelect = dialog.querySelector(".about-channel-select") as HTMLSelectElement;
    await act(async () => {
      channelSelect.value = "beta";
      channelSelect.dispatchEvent(new mounted.dom.Event("change", { bubbles: true }) as unknown as Event);
    });
    await flush();
    expect(settings.updates.channel).toBe("beta");

    // Check GitHub updates when repository was empty -> falls back to maobukeai/maobu-qianjing
    const checkGithubButton = Array.from(dialog.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Check for updates"),
    ) as HTMLButtonElement;
    await act(async () => {
      checkGithubButton.click();
    });
    await flush();
    expect(settings.updates.repository).toBe(DEFAULT_GITHUB_REPOSITORY);
    expect(dialog.textContent).toContain("New GitHub release");
    expect(dialog.textContent).toContain("0.1.0-local.1 → 0.2.0");
    expect(githubResults.at(-1)?.status).toBe("available");

    // Expand collapsed release notes drawer
    const notesToggle = dialog.querySelector(".about-notes-toggle") as HTMLButtonElement;
    const notesAccordion = dialog.querySelector(".about-notes-accordion") as HTMLElement;
    expect(notesToggle.getAttribute("aria-expanded")).toBe("false");
    expect(notesAccordion.getAttribute("data-open")).toBe("false");
    expect(notesAccordion.getAttribute("aria-hidden")).toBe("true");
    await act(async () => {
      notesToggle.click();
    });
    await flush();
    expect(notesToggle.getAttribute("aria-expanded")).toBe("true");
    expect(notesAccordion.getAttribute("data-open")).toBe("true");
    expect(notesAccordion.getAttribute("aria-hidden")).toBe("false");
    expect(notesAccordion.textContent).toContain("Added local workbench improvements.");

    const releaseLink = Array.from(dialog.querySelectorAll("a")).find((anchor) =>
      anchor.textContent?.includes("View release on GitHub"),
    );
    expect(releaseLink?.getAttribute("href")).toBe("https://github.com/maobukeai/maobu-qianjing/releases/tag/v0.2.0");

    // Toggle GitHub startup check
    const switches = Array.from(dialog.querySelectorAll('input[type="checkbox"][role="switch"]')) as HTMLInputElement[];
    expect(switches).toHaveLength(2);
    const githubSwitch = switches[1]!;
    await act(async () => {
      githubSwitch.click();
    });
    await flush();
    expect(settings.updates.checkOnStartup).toBe(true);
    expect(patches.some((patch) => (patch as { updates?: { checkOnStartup?: boolean } }).updates?.checkOnStartup === true)).toBe(true);

    // Esc closes and returns focus to trigger
    await act(async () => {
      mounted.dom.document.dispatchEvent(
        new mounted.dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await flush();
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
    expect(mounted.dom.document.activeElement as unknown).toBe(trigger);

    // Reopen and click Open full update settings
    await act(async () => {
      trigger.click();
    });
    await flush();
    const shortcutBtn = mounted.container.querySelector('[role="dialog"] .about-settings-shortcut') as HTMLButtonElement;
    expect(shortcutBtn.textContent).toContain("Update settings");
    await act(async () => {
      shortcutBtn.click();
    });
    await flush();
    expect(openedFullSettings).toBe(1);
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
  });

  test("handles configured signed updates: startup toggle, manual check, install confirmation, progress, and completion", async () => {
    let settings = baseSettings({ repository: DEFAULT_GITHUB_REPOSITORY }, false);
    let startupPref = false;
    const savedPrefs: boolean[] = [];
    let currentSignedStatus: SignedUpdateStatus = {
      configured: true,
      status: "up-to-date",
      currentVersion: "1.0.0",
      endpoint: "https://github.com/maobukeai/maobu-qianjing/releases/latest/download/latest.json",
      message: "Signed updates are ready.",
      update: null,
    };
    const availableSignedStatus: SignedUpdateStatus = {
      configured: true,
      status: "available",
      currentVersion: "1.0.0",
      endpoint: "https://github.com/maobukeai/maobu-qianjing/releases/latest/download/latest.json",
      message: "A signed update is available.",
      update: { version: "1.2.3", currentVersion: "1.0.0", notes: "Security & engine updates.", publishedAt: null },
    };

    let finishInstall!: () => void;
    let emitProgress!: (event: SignedUpdateProgress) => void;
    let checkCount = 0;

    const mounted = setupDom({
      desktop: true,
      fetchImpl: async (input, init) => {
        const path = String(input);
        const method = init?.method ?? "GET";
        if (path === "/ui/api/shell-language") return Response.json({ ok: true, language: "en-US" });
        if (path === "/ui/api/settings" && method === "GET") return Response.json({ ok: true, settings });
        if (path === "/ui/api/settings/updates") {
          return Response.json({
            ok: true,
            update: {
              checkedAt: "2026-11-14T00:00:00.000Z",
              repository: DEFAULT_GITHUB_REPOSITORY,
              channel: "stable",
              currentVersion: "1.0.0",
              status: "up-to-date",
            },
          });
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
    });
    activeCleanup = mounted.cleanup;

    mockIPC((command, payload) => {
      if (command === "signed_update_status") return currentSignedStatus;
      if (command === "signed_update_check") {
        checkCount++;
        currentSignedStatus = availableSignedStatus;
        return availableSignedStatus;
      }
      if (command === "signed_update_install") {
        const args = payload as { expectedVersion: string; onProgress: Channel<SignedUpdateProgress> };
        expect(args.expectedVersion).toBe("1.2.3");
        emitProgress = args.onProgress.onmessage;
        return new Promise<void>((resolve) => {
          finishInstall = resolve;
        });
      }
      throw new Error(`Unexpected IPC command: ${command}`);
    });

    const registry = createDesktopCloseRegistry();
    registry.register("profile-edit", { dirty: true, busy: false });
    const coordinator = createWorkspaceOperationCoordinator({ currentId: "ws-1", activeId: "ws-1" });

    function DesktopHarness() {
      const [pref, setPref] = useState(startupPref);
      const startupController: SignedUpdateStartupController = {
        workspaceId: "ws-1",
        preference: pref,
        preferenceBusy: false,
        preferenceError: null,
        checking: false,
        status: null,
        error: null,
        noticeVersion: null,
        dismissNotice() {},
        retryPreference() {},
        beginManualOperation() {},
        async savePreference(enabled: boolean) {
          startupPref = enabled;
          savedPrefs.push(enabled);
          setPref(enabled);
          settings = { ...settings, signedUpdates: { checkOnStartup: enabled } };
        },
      };
      return (
        <I18nProvider>
          <DesktopCloseRegistryProvider registry={registry}>
            <WorkspaceOperationsProvider coordinator={coordinator}>
              <TestHarness appVersion="1.0.0" initialOpen signedUpdateStartup={startupController} />
            </WorkspaceOperationsProvider>
          </DesktopCloseRegistryProvider>
        </I18nProvider>
      );
    }

    await act(async () => {
      mounted.root.render(<DesktopHarness />);
    });
    await flush();

    const dialog = mounted.container.querySelector("#about-popover-dialog") as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain("Up to date");
    expect(dialog.textContent).toContain("v1.0.0 is up to date");

    // Toggle signed startup check (a)
    const signedSwitch = dialog.querySelectorAll('input[type="checkbox"][role="switch"]')[0] as HTMLInputElement;
    expect(signedSwitch.disabled).toBe(false);
    expect(signedSwitch.checked).toBe(false);
    await act(async () => {
      signedSwitch.click();
    });
    await flush();
    expect(savedPrefs).toEqual([true]);
    expect(signedSwitch.checked).toBe(true);

    // Check updates via unified CTA -> discovers signed 1.2.3
    const checkUpdatesBtn = dialog.querySelector(".about-primary-cta") as HTMLButtonElement;
    expect(checkUpdatesBtn.textContent).toContain("Check for updates");
    await act(async () => {
      checkUpdatesBtn.click();
    });
    await flush();
    expect(checkCount).toBe(1);
    expect(dialog.textContent).toContain("Update available");
    expect(dialog.textContent).toContain("1.0.0 → 1.2.3");

    const notesToggle = dialog.querySelector(".about-notes-toggle") as HTMLButtonElement;
    await act(async () => {
      notesToggle.click();
    });
    await flush();
    expect(dialog.textContent).toContain("Security & engine updates.");

    // Install verified update -> opens SignedUpdateDraftDialog because of dirty draft
    const installBtn = Array.from(dialog.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Install verified update"),
    ) as HTMLButtonElement;
    await act(async () => {
      installBtn.click();
    });
    await flush();

    const draftDialog = mounted.dom.document.querySelector(".signed-update-dialog") as unknown as HTMLElement;
    expect(draftDialog).toBeTruthy();
    expect(draftDialog.textContent).toContain("Install with unsaved changes?");

    const discardBtn = Array.from(draftDialog.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Discard drafts and install"),
    ) as HTMLButtonElement;
    await act(async () => {
      discardBtn.click();
    });
    await flush();

    // Emit download progress and finish install
    await act(async () => {
      emitProgress({ phase: "downloading", downloadedBytes: 50, totalBytes: 100 });
    });
    await flush();
    expect(mounted.dom.document.body.textContent).toContain("50%");

    await act(async () => {
      finishInstall();
    });
    await flush();
    expect(dialog.textContent).toContain("Update installed. Restart requested.");
  });
});
