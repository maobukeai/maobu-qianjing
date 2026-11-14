import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { isolateModalSiblings } from "./modal-isolation.ts";

for (const lowerFirst of [false, true]) {
  test(`stacked modal isolation restores siblings after ${lowerFirst ? "lower" : "upper"} layer releases first`, async () => {
    const window = new Window();
    const { document } = window;
    const app = document.createElement("main"), original = document.createElement("aside");
    const lower = document.createElement("div"), upper = document.createElement("div");
    const lowerDialog = document.createElement("div");
    lower.append(lowerDialog);
    upper.className = "top-layer";
    original.setAttribute("inert", "existing");
    original.setAttribute("aria-hidden", "false");
    document.body.append(app, original, lower);

    const releaseLower = isolateModalSiblings(lowerDialog as unknown as HTMLElement, child => child.classList.contains("top-layer"));
    document.body.append(upper);
    const releaseUpper = isolateModalSiblings(upper as unknown as HTMLElement);
    try {
      const late = document.createElement("div");
      document.body.append(late);
      await window.happyDOM.waitUntilComplete();
      expect(app.hasAttribute("inert")).toBe(true);
      expect(original.getAttribute("aria-hidden")).toBe("true");
      expect(lower.hasAttribute("inert")).toBe(true);
      expect(upper.hasAttribute("inert")).toBe(false);
      expect(late.hasAttribute("inert")).toBe(true);

      const first = lowerFirst ? releaseLower : releaseUpper;
      const second = lowerFirst ? releaseUpper : releaseLower;
      first(); first();
      expect(app.hasAttribute("inert")).toBe(true);
      expect(late.getAttribute("aria-hidden")).toBe("true");
      expect(lower.hasAttribute("inert")).toBe(lowerFirst);
      expect(upper.hasAttribute("inert")).toBe(false);

      second();
      expect(app.hasAttribute("inert")).toBe(false);
      expect(app.hasAttribute("aria-hidden")).toBe(false);
      expect(lower.hasAttribute("inert")).toBe(false);
      expect(late.hasAttribute("inert")).toBe(false);
      expect(late.hasAttribute("aria-hidden")).toBe(false);
      expect(original.getAttribute("inert")).toBe("existing");
      expect(original.getAttribute("aria-hidden")).toBe("false");
    } finally { releaseLower(); releaseUpper(); await window.happyDOM.close(); }
  });
}
