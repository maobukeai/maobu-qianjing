import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import * as React from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { I18nProvider } from "./i18n.tsx";
import type { SystemDiagnosticReport } from "./diagnostics-api.ts";
import { DiagnosticsBox } from "./diagnostics-box.tsx";

function makeSampleReport(): SystemDiagnosticReport {
  return {
    version: 1,
    generatedAt: "2026-11-22T14:30:00.000Z",
    appVersion: "0.20.0",
    platform: "win32",
    arch: "x64",
    desktopAvailable: true,
    overallStatus: "warn",
    summary: { pass: 5, warn: 1, fail: 0, skipped: 0 },
    checks: [
      { id: "webview2_os", title: "WebView2 & Operating System", status: "pass", summary: "Windows 11 · WebView2 130.0.2849.68", durationMs: 2, details: { osName: "Windows 11" } },
      { id: "ports", title: "Loopback Ports & Active Browsers", status: "pass", summary: "Dashboard :50401 · Automation :50400 (listening)", durationMs: 5, details: { dashboardPort: 50401 } },
      { id: "sqlite", title: "SQLite Database Integrity", status: "pass", summary: "PRAGMA quick_check ok · 3 profiles", durationMs: 4, details: { quickCheckOk: true } },
      { id: "runtimes", title: "Browser Runtimes & SHA-256 Integrity", status: "pass", summary: "Verified 1 installed browser engine(s)", durationMs: 12, details: { browserRuntimes: [] } },
      { id: "disk_space", title: "Disk Space & Workspace Storage", status: "warn", summary: "Free space: 3.10 GiB (threshold: 5 GiB)", durationMs: 6, details: { freeBytes: 3_328_599_654 }, recommendations: ["Clean up old backups."] },
      { id: "mcp", title: "MCP Resources & Read-Only Handshake", status: "pass", summary: "MCP helper ready", durationMs: 1, details: { status: "ready" } },
    ],
  };
}

async function createHarness(fetchImpl: typeof fetch) {
  const dom = new Window({ url: "http://127.0.0.1/" });
  dom.localStorage.setItem("aliasmode.shell.language", "en-US");
  const prev = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (key: string, value: unknown) => {
    prev.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  setGlobal("window", dom);
  setGlobal("document", dom.document);
  setGlobal("navigator", dom.navigator);
  setGlobal("localStorage", dom.localStorage);
  setGlobal("HTMLElement", dom.HTMLElement);
  setGlobal("HTMLInputElement", dom.HTMLInputElement);
  setGlobal("Element", dom.Element);
  setGlobal("Node", dom.Node);
  setGlobal("Event", dom.Event);
  setGlobal("MouseEvent", dom.MouseEvent);
  setGlobal("fetch", fetchImpl);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const { createRoot } = await import("react-dom/client");
  const rawContainer = dom.document.createElement("div");
  dom.document.body.appendChild(rawContainer);
  const container = rawContainer as unknown as HTMLElement;
  const root: Root = createRoot(container);

  const flush = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  };
  const cleanup = async () => {
    await act(async () => {
      root.unmount();
      await new Promise((r) => setTimeout(r, 15));
    });
    await dom.happyDOM.waitUntilComplete();
    await dom.close();
    for (const [k, desc] of prev) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else Reflect.deleteProperty(globalThis, k);
    }
  };
  return { dom, container, root, flush, cleanup };
}

let dispose: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (dispose) {
    await dispose();
    dispose = null;
  }
});

describe("DiagnosticsBox", () => {
  test("runs all 6 checks, previews redacted JSON before export, and triggers redacted ZIP download", async () => {
    const requests: Array<{ path: string; body?: unknown; header?: string | null }> = [];
    const sampleReport = makeSampleReport();

    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      if (url.pathname === "/ui/api/shell-language") return Response.json({ language: "en-US" });
      const headers = new Headers(init?.headers);
      if (url.pathname === "/ui/api/diagnostics/run") {
        requests.push({
          path: url.pathname,
          body: JSON.parse(String(init?.body ?? "{}")),
          header: headers.get("X-Maobu-Settings"),
        });
        return Response.json({ ok: true, report: sampleReport });
      }
      if (url.pathname === "/ui/api/diagnostics/export") {
        requests.push({
          path: url.pathname,
          body: JSON.parse(String(init?.body ?? "{}")),
          header: headers.get("X-Maobu-Settings"),
        });
        return new Response(new Uint8Array([80, 75, 3, 4, 0, 0]), {
          status: 200,
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": 'attachment; filename="maobu-diagnostics-20261122-143000.zip"',
            "X-Diagnostics-SHA256": "a".repeat(64),
          },
        });
      }
      return Response.json({ ok: false }, { status: 404 });
    }) as typeof fetch;

    const h = await createHarness(fakeFetch);
    dispose = h.cleanup;

    let runNotified = 0;
    await act(async () => {
      h.root.render(
        <I18nProvider>
          <DiagnosticsBox onDiagnosticsRun={() => { runNotified++; }} />
        </I18nProvider>,
      );
    });
    await h.flush();

    expect(h.container.textContent).toContain("Strict redaction");

    // Toggle MCP handshake checkbox and click Run diagnostics
    const checkboxes = Array.from(h.container.querySelectorAll<HTMLInputElement>("input[type='checkbox']"));
    await act(async () => {
      checkboxes[0]!.click();
    });
    const runBtn = Array.from(h.container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Run diagnostics"),
    )!;
    await act(async () => {
      runBtn.click();
    });
    await h.flush();

    expect(runNotified).toBe(1);
    expect(requests[0]).toMatchObject({
      path: "/ui/api/diagnostics/run",
      header: "1",
      body: { includeMcpProbe: true },
    });
    expect(h.container.querySelectorAll("[data-diag-check]")).toHaveLength(6);
    expect(h.container.textContent).toContain("Windows 11 · WebView2 130.0.2849.68");

    // Open collapsible redacted JSON preview before export
    expect(h.container.querySelector("[data-diag-json-preview='true']")).toBeNull();
    const previewToggle = h.container.querySelector<HTMLButtonElement>(".diag-preview-toggle")!;
    await act(async () => {
      previewToggle.click();
    });
    await h.flush();
    const previewPre = h.container.querySelector("[data-diag-json-preview='true']");
    expect(previewPre).not.toBeNull();
    expect(previewPre!.textContent).toContain('"webview2_os"');

    // Click Export redacted ZIP
    const exportZipBtn = Array.from(h.container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Export redacted ZIP"),
    )!;
    await act(async () => {
      exportZipBtn.click();
    });
    await h.flush();

    expect(requests[1]).toMatchObject({
      path: "/ui/api/diagnostics/export",
      header: "1",
      body: { format: "zip", includeMcpProbe: true, includeLogs: true },
    });
    expect(h.container.textContent).toContain("maobu-diagnostics-20261122-143000.zip");
  });
});
