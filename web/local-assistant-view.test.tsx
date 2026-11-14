import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "./i18n.tsx";
import { LocalAssistantPage } from "./local-assistant.tsx";

type ElementView = { tag: string; attrs: Record<string, string> };
async function elementsIn(html: string, selector = "*"): Promise<ElementView[]> {
  const elements: ElementView[] = [];
  await new HTMLRewriter().on(selector, { element(element) {
    elements.push({ tag: element.tagName, attrs: Object.fromEntries(element.attributes) });
  } }).transform(new Response(html)).text();
  return elements;
}
function render(active = true): string {
  return renderToStaticMarkup(<I18nProvider><LocalAssistantPage active={active} /></I18nProvider>);
}

describe("local assistant initial view", () => {
  test("opening or hiding the workspace starts no requests and opts out of workspace context", async () => {
    const failRequest = Object.assign(() => { throw new Error("render must not connect"); }, { preconnect: globalThis.fetch.preconnect });
    const network = spyOn(globalThis, "fetch").mockImplementation(failRequest);
    try {
      for (const active of [true, false]) {
        const html = render(active);
        const elements = await elementsIn(html);
        const workspace = elements.find(element => element.attrs.class?.split(" ").includes("assistant-workspace"))!;
        expect(Object.hasOwn(workspace.attrs, "hidden")).toBe(!active);
        const checkbox = elements.find(element => element.tag === "input" && element.attrs.type === "checkbox")!;
        expect(checkbox).toBeDefined();
        expect(checkbox.attrs.checked).toBeUndefined();
        expect(elements.filter(element => ["iframe", "img", "script", "form"].includes(element.tag))).toHaveLength(0);
      }
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  test("the connection and composer have labels and sending is disabled before an explicit connection", async () => {
    const html = render();
    const elements = await elementsIn(html);
    const connectionInput = (await elementsIn(html, "label.fld > input"))[0]!;
    expect(connectionInput.attrs.value).toBe("http://127.0.0.1:11434");
    expect(connectionInput.attrs.disabled).toBeUndefined();
    expect(await elementsIn(html, "label.assistant-draft > textarea")).toHaveLength(1);
    expect(await elementsIn(html, "label.assistant-draft > .sr-only")).toHaveLength(1);
    expect(await elementsIn(html, "label > input[type=checkbox]")).toHaveLength(1);
    const buttons = elements.filter(element => element.tag === "button");
    expect(buttons.every(element => element.attrs.type === "button")).toBe(true);
    expect(buttons.filter(element => Object.hasOwn(element.attrs, "disabled"))).toHaveLength(1);
    expect(buttons.find(element => element.attrs.class?.includes("primary"))?.attrs.disabled).toBeDefined();
    expect(elements.some(element => element.tag === "select")).toBe(false);
  });

  test("the keyboard-scrollable log leaves live updates to the concise task status", async () => {
    const elements = await elementsIn(render());
    const conversation = elements.find(element => element.tag === "section" && element.attrs.class === "assistant-chat")!;
    expect(conversation.attrs["aria-label"]?.trim().length).toBeGreaterThan(0);
    const log = elements.find(element => element.attrs.role === "log")!;
    expect(log.attrs["aria-live"]).toBe("off");
    expect(log.attrs.tabindex).toBe("0");
    expect(log.attrs["aria-label"]?.trim().length).toBeGreaterThan(0);
    expect(await elementsIn(render(), '.assistant-task-progress [role="status"]')).toHaveLength(1);
    const guide = elements.find(element => element.tag === "a")!;
    expect(guide.attrs.href).toBe("https://docs.ollama.com/faq");
    expect(guide.attrs.target).toBe("_blank");
    expect(guide.attrs.rel?.split(" ")).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
  });

  test("the optional MCP action appears only with a navigation callback and never runs on render", async () => {
    let opened = 0;
    const selector = ".assistant-session-info > button";
    expect(await elementsIn(render(), selector)).toHaveLength(0);
    const html = renderToStaticMarkup(<I18nProvider><LocalAssistantPage active onOpenMcp={() => { opened++; }} /></I18nProvider>);
    const action = (await elementsIn(html, selector))[0]!;
    expect(action.attrs.type).toBe("button");
    expect(action.attrs.disabled).toBeUndefined();
    expect(opened).toBe(0);
  });
});
