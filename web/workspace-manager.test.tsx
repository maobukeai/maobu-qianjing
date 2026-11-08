import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "./i18n.tsx";
import { DevicePanel, WorkspaceBackupIntro, WorkspaceManagementPage, WorkspaceProvider, WorkspaceSwitcher, useWorkspaceCatalog } from "./workspace-manager.tsx";
import type { WorkspaceCatalog } from "./workspaces-api.ts";
const catalog: WorkspaceCatalog = { currentId: "one", activeId: "one", workspaces: [{ id: "one", name: "Research & review", color: "#8169c8", icon: "folder", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 0 }, { id: "two", name: "Other project", color: "#628ac7", icon: "laptop", archived: false, createdAt: 1, updatedAt: 1, lastOpenedAt: 0 }] };
const noop = () => {};
type MarkupElement = { tag: string; attrs: Record<string, string> };
async function elementsIn(html: string): Promise<MarkupElement[]> {
  const elements: MarkupElement[] = [];
  await new HTMLRewriter().on("*", { element(element) { elements.push({ tag: element.tagName, attrs: Object.fromEntries(element.attributes) }); } }).transform(new Response(html)).text();
  return elements;
}
test("both sidebar entry points and consumers share the actual current workspace", () => {
  function CurrentName() { return <output>{useWorkspaceCatalog().currentName}</output>; }
  const html = renderToStaticMarkup(<I18nProvider><WorkspaceProvider initialCatalog={catalog}><WorkspaceSwitcher profileCount={8} runningCount={2} connection onShowRunning={noop} /><DevicePanel runningCount={2} downloads={[]} connection version="1.2.3" theme="light" chooseTheme={noop} language="en-US" setLanguage={noop} onShowRunning={noop} onSettings={noop} onViewLogs={noop} /><CurrentName /></WorkspaceProvider></I18nProvider>);
  expect(html).toContain("Open workspace switcher");
  expect(html).toContain("Open device panel");
  expect(html.match(/Research &amp; review/g)?.length).toBeGreaterThanOrEqual(3);
  expect(html).not.toContain("Other project");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('role="dialog"');
});
test("disconnected device entry announces interruption instead of a healthy local service", () => {
  const html = renderToStaticMarkup(<I18nProvider><WorkspaceProvider initialCatalog={catalog}><DevicePanel runningCount={2} downloads={[]} connection={false} version="" theme="system" chooseTheme={noop} language="en-US" setLanguage={noop} onShowRunning={noop} onSettings={noop} onViewLogs={noop} /></WorkspaceProvider></I18nProvider>);
  expect(html).toContain("Connection interrupted");
  expect(html).not.toContain("Local service connected");
});
test("a switch prepared in a previous page session stays visibly recoverable while current identity remains unchanged", () => {
  const pending = { ...catalog, activeId: "two" };
  const html = renderToStaticMarkup(<I18nProvider><WorkspaceProvider initialCatalog={pending}><WorkspaceSwitcher profileCount={8} runningCount={0} connection onShowRunning={noop} /></WorkspaceProvider></I18nProvider>);
  expect(html).toContain("Restart required");
  expect(html).toContain("Research &amp; review");
  expect(html).not.toContain("Other project");
});
test("startup connectivity is neutral and never falsely announces an interrupted connection", () => {
  const html = renderToStaticMarkup(<I18nProvider><WorkspaceProvider initialCatalog={catalog}><DevicePanel runningCount={0} downloads={[]} connection={false} connectionLoading version="" theme="light" chooseTheme={noop} language="en-US" setLanguage={noop} onShowRunning={noop} onSettings={noop} onViewLogs={noop} /></WorkspaceProvider></I18nProvider>);
  expect(html).toContain("Connecting to the local service…");
  expect(html).toContain("wm-connection-dot connecting");
  expect(html).not.toContain("Connection interrupted");
  expect(html).not.toContain("Local service connected");
});
test("backup introduction identifies the current workspace and makes the unencrypted archive boundary explicit", () => {
  const html = renderToStaticMarkup(<I18nProvider><WorkspaceProvider initialCatalog={catalog}><WorkspaceBackupIntro /></WorkspaceProvider></I18nProvider>);
  expect(html).toContain("Current backup workspace: Research &amp; review");
  expect(html).not.toContain("Other project");
  expect(html).toContain("not password-encrypted");
  expect(html).toContain("System protection may require you to sign in again");
});

test("workspace management renders as a labelled page with connected tabs and the current workspace identity", async () => {
  const html = renderToStaticMarkup(<I18nProvider><WorkspaceProvider initialCatalog={catalog}><WorkspaceManagementPage active request={{ mode: "manage", id: 0 }} onBack={noop} onShowRunning={noop} /></WorkspaceProvider></I18nProvider>);
  const elements = await elementsIn(html);
  const page = elements.find(element => element.tag === "section" && element.attrs["aria-labelledby"]);
  const heading = elements.find(element => element.tag === "h1");
  expect(page).toBeDefined();
  expect(heading).toBeDefined();
  expect(page!.attrs.hidden).toBeUndefined();
  expect(page!.attrs["aria-labelledby"]).toBe(heading!.attrs.id);
  expect(html).toMatch(/<h1\b[^>]*>Workspace management<\/h1>/);
  expect(elements.find(element => element.attrs.role === "tablist")?.attrs["aria-label"]).toBe("Workspace sections");

  const tabs = elements.filter(element => element.attrs.role === "tab");
  const panels = elements.filter(element => element.attrs.role === "tabpanel");
  expect(tabs).toHaveLength(2);
  expect(panels).toHaveLength(2);
  expect(tabs.filter(tab => tab.attrs["aria-selected"] === "true")).toHaveLength(1);
  for (const tab of tabs) {
    const panel = panels.find(panel => panel.attrs.id === tab.attrs["aria-controls"]);
    expect(panel).toBeDefined();
    expect(panel!.attrs["aria-labelledby"]).toBe(tab.attrs.id);
    if (tab.attrs["aria-selected"] === "true") {
      expect(tab.attrs.tabindex).toBe("0");
      expect(panel!.attrs.hidden).toBeUndefined();
    } else {
      expect(tab.attrs.tabindex).toBe("-1");
      expect(panel!.attrs.hidden).toBeDefined();
    }
  }
  expect(elements.find(element => element.tag === "input" && element.attrs.maxlength === "40")?.attrs.value).toBe("Research &amp; review");
  expect(html).toContain("Current backup workspace: Research &amp; review");
  expect(elements.some(element => element.attrs.role === "dialog" || "aria-modal" in element.attrs)).toBe(false);
});

test("an inactive management page keeps its ordinary form mounted inside a hidden page", async () => {
  const html = renderToStaticMarkup(<I18nProvider><WorkspaceProvider initialCatalog={catalog}><WorkspaceManagementPage active={false} request={{ mode: "manage", id: 0 }} onBack={noop} onShowRunning={noop} /></WorkspaceProvider></I18nProvider>);
  const elements = await elementsIn(html);
  const page = elements.find(element => element.tag === "section" && element.attrs["aria-labelledby"]);
  expect(page?.attrs.hidden).toBeDefined();
  expect(elements.filter(element => element.tag === "form")).toHaveLength(1);
  expect(elements.find(element => element.tag === "input" && element.attrs.maxlength === "40")?.attrs.value).toBe("Research &amp; review");
  expect(elements.some(element => element.attrs.role === "dialog" || "aria-modal" in element.attrs)).toBe(false);
});

test("the sidebar switcher and management page coexist with one heading and unique accessible IDs", async () => {
  const html = renderToStaticMarkup(<I18nProvider><WorkspaceProvider initialCatalog={catalog}><WorkspaceSwitcher profileCount={8} runningCount={2} connection onShowRunning={noop} onOpenManagement={noop} managementActive /><WorkspaceManagementPage active request={{ mode: "manage", id: 0 }} onBack={noop} onShowRunning={noop} /></WorkspaceProvider></I18nProvider>);
  const elements = await elementsIn(html);
  const ids = elements.flatMap(element => element.attrs.id ? [element.attrs.id] : []);
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
  expect(elements.filter(element => element.tag === "h1")).toHaveLength(1);
  expect(html.match(/<h1\b[^>]*>Workspace management<\/h1>/g)).toHaveLength(1);
  expect(elements.find(element => element.attrs["aria-label"] === "Open workspace switcher")?.attrs["aria-haspopup"]).toBe("menu");
  expect(elements.some(element => element.attrs.role === "dialog" || "aria-modal" in element.attrs)).toBe(false);
});

test("the context entry keeps the actual workspace identity and a visible route to management while a restart is pending", async () => {
  const pending = { ...catalog, activeId: "two" };
  const html = renderToStaticMarkup(<I18nProvider><WorkspaceProvider initialCatalog={pending}><WorkspaceSwitcher variant="context" profileCount={8} runningCount={2} connection onShowRunning={noop} onOpenManagement={noop} managementActive /></WorkspaceProvider></I18nProvider>);
  const elements = await elementsIn(html);
  const switcher = elements.find(element => element.tag === "button" && element.attrs["aria-label"] === "Open workspace switcher");
  expect(switcher?.attrs.title).toBe("Research &amp; review");
  expect(switcher?.attrs["aria-haspopup"]).toBe("menu");
  expect(html).toContain("Restart required");
  expect(html).not.toContain("Other project");
  expect(html).toContain("Manage workspaces");
  expect(elements.filter(element => element.tag === "button" && element.attrs["aria-current"] === "page")).toHaveLength(1);
  expect(elements.some(element => element.attrs.role === "dialog" || "aria-modal" in element.attrs)).toBe(false);
});

test("header and rail device entries have unique accessible connection descriptions and never impersonate a workspace", async () => {
  const device = { runningCount: 0, downloads: [], connection: false, connectionLoading: true, version: "1.2.3", theme: "light" as const, chooseTheme: noop, language: "en-US", setLanguage: noop, onShowRunning: noop, onSettings: noop, onViewLogs: noop };
  const html = renderToStaticMarkup(<I18nProvider><WorkspaceProvider initialCatalog={catalog}><DevicePanel {...device} variant="header" /><DevicePanel {...device} variant="rail" /></WorkspaceProvider></I18nProvider>);
  const elements = await elementsIn(html);
  const entries = elements.filter(element => element.tag === "button" && element.attrs["aria-label"] === "Open device panel");
  expect(entries).toHaveLength(2);
  const descriptions = entries.map(entry => entry.attrs["aria-describedby"]);
  expect(new Set(descriptions).size).toBe(2);
  for (const entry of entries) {
    expect(entry.attrs["aria-haspopup"]).toBe("dialog");
    expect(entry.attrs["aria-expanded"]).toBe("false");
    expect(entry.attrs.title).toContain("This device");
    expect(entry.attrs.title).toContain("Connecting to the local service…");
    expect(elements.filter(element => element.attrs.id === entry.attrs["aria-describedby"])).toHaveLength(1);
  }
  expect(html).not.toContain("Research &amp; review");
  expect(html).not.toContain("Connection interrupted");
  expect(elements.some(element => element.attrs.role === "dialog")).toBe(false);
});
