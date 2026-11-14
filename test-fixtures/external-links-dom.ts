import assert from "node:assert/strict";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { installExternalLinkHandler } from "../web/external-links.ts";
import { createWebDomHarness } from "./web-dom.ts";

const scenario = process.argv[2] ?? "desktop";
const dom = await createWebDomHarness({ desktop: scenario !== "browser" });
const calls: unknown[] = [], errors: unknown[] = [], prevented: boolean[] = [];
let bodyClicks = 0;
try {
  mockIPC((command, args) => {
    assert.equal(command, "open_external_resource");
    calls.push(args);
    if (scenario === "failure") throw new Error("private native launcher details");
  });
  dom.container.innerHTML = '<a href="https://docs.ollama.com/faq" target="_blank"><span>Official guide</span></a><a href="#local">Local section</a>';
  const dispose = installExternalLinkHandler(dom.container as unknown as HTMLElement);
  // Prevent Happy DOM's default navigation after observing the production handler.
  dom.container.addEventListener("click", event => { prevented.push(event.defaultPrevented); event.preventDefault(); });
  dom.window.document.body.addEventListener("click", () => { bodyClicks++; });
  dom.window.addEventListener("external-link-error", event => errors.push((event as unknown as CustomEvent).detail));
  dom.container.querySelector("span")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  await dom.flush();
  if (scenario === "browser") {
    assert.equal(calls.length, 0); assert.deepEqual(prevented, [false]); assert.equal(bodyClicks, 1);
  } else {
    assert.deepEqual(calls, [{ url: "https://docs.ollama.com/faq" }]);
    assert.deepEqual(prevented, [true]); assert.equal(bodyClicks, 0);
    if (scenario === "failure") {
      assert.deepEqual(errors, ["The external link could not be opened. Copy its address and open it in your browser."]);
      assert(!JSON.stringify(errors).includes("private"));
    } else assert.deepEqual(errors, []);
  }
  const before = calls.length;
  dom.container.querySelector('a[href="#local"]')!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  assert.equal(calls.length, before);
  dispose();
  dom.container.querySelector("span")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  assert.equal(calls.length, before); assert.equal(prevented.at(-1), false);
  console.log("external resource link fixture passed");
} finally { clearMocks(); await dom.cleanup(); }
