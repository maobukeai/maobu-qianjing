import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLElement, HTMLButtonElement } from "happy-dom";
import { useAssistantTranscriptPosition } from "../web/assistant-transcript-position.ts";
import { createWebDomHarness } from "./web-dom.ts";

const dom = await createWebDomHarness();
const offsets = new WeakMap<HTMLElement, number>();
const viewportHeight = 240;
let contentHeight = 900;
Object.defineProperties(dom.window.HTMLElement.prototype, {
  clientHeight: { configurable: true, get(this: HTMLElement) { return this.closest("[hidden]") ? 0 : viewportHeight; } },
  scrollHeight: { configurable: true, get(this: HTMLElement) { return this.closest("[hidden]") ? 0 : contentHeight; } },
  scrollTop: {
    configurable: true,
    get(this: HTMLElement) { return this.closest("[hidden]") ? 0 : offsets.get(this) ?? 0; },
    set(this: HTMLElement, top: number) { offsets.set(this, Math.max(0, Math.min(top, contentHeight - viewportHeight))); },
  },
  getBoundingClientRect: {
    configurable: true,
    value(this: HTMLElement) {
      const relative = this.dataset.testTop;
      const top = relative === undefined ? 100 : 100 + Number(relative) - (this.parentElement?.scrollTop ?? 0);
      return new dom.window.DOMRect(0, top, 300, 24);
    },
  },
});

type View = Parameters<typeof useAssistantTranscriptPosition>[0] & { replyTop?: number };
function Transcript(view: View) {
  const { viewport, onScroll, readLatestReply } = useAssistantTranscriptPosition(view);
  return <><div hidden={!view.active}>
    <button type="button" onClick={readLatestReply}>Read latest</button>
    <div ref={viewport} data-transcript onScroll={onScroll}>
      {view.latestReplyId !== null && <h3 tabIndex={-1} data-assistant-reply-heading={view.latestReplyId} data-test-top={view.replyTop}>Assistant</h3>}
    </div>
  </div><button type="button" data-outside>Model setting</button></>;
}

const render = (view: Partial<View> = {}) => dom.render(<Transcript active latestMessageId={null} latestReplyId={null} sending={false} {...view} />);
const viewport = () => dom.container.querySelector<HTMLElement>("[data-transcript]")!;
const control = () => dom.container.querySelector<HTMLButtonElement>("button")!;
const outside = () => dom.container.querySelector<HTMLButtonElement>("[data-outside]")!;
const scroll = (top: number) => act(async () => {
  viewport().scrollTop = top;
  viewport().dispatchEvent(new dom.window.Event("scroll"));
});

try {
  await render();
  assert.equal(viewport().scrollTop, 0, "The overflowing welcome starts at the top");
  contentHeight = 500;
  await render({ latestMessageId: 1, sending: true });
  assert.equal(viewport().scrollTop, 260, "A first request follows its waiting indicator");
  await act(async () => outside().focus());
  contentHeight = 900;
  await render({ latestMessageId: 2, latestReplyId: 2, replyTop: 360 });
  assert.equal(viewport().scrollTop, 348, "The beginning of a long reply stays visible");
  assert.ok(dom.window.document.activeElement === outside(), "An automatic scroll must never move focus");

  await scroll(620);
  contentHeight = 960;
  await render({ latestMessageId: 3, latestReplyId: 2, sending: true, replyTop: 360 });
  assert.equal(viewport().scrollTop, 720, "A reader already near the tail follows the next request");
  await scroll(95);
  contentHeight = 1700;
  await render({ latestMessageId: 4, latestReplyId: 4, replyTop: 800 });
  assert.equal(viewport().scrollTop, 95, "A reply does not move someone reading earlier material");
  await render({ active: false, latestMessageId: 4, latestReplyId: 4, replyTop: 800 });
  assert.equal(viewport().scrollTop, 0, "The simulated hidden pane reports no scroll offset");
  await render({ latestMessageId: 4, latestReplyId: 4, replyTop: 800 });
  assert.equal(viewport().scrollTop, 95, "The mounted session restores its previous visible offset");

  await act(async () => control().click());
  assert.equal(viewport().scrollTop, 788);
  assert.equal(dom.window.document.activeElement?.getAttribute("data-assistant-reply-heading"), "4", "Explicit navigation focuses the real reply heading");
  await render({ active: false, latestMessageId: 4, latestReplyId: 4, replyTop: 800 });
  await render({ active: false });
  await render();
  assert.equal(viewport().scrollTop, 0, "Returning after a hidden reset reveals the welcome");
} finally {
  await dom.cleanup();
}

console.log("assistant transcript position fixture passed");
