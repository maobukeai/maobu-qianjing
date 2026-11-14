import assert from "node:assert/strict";
import { act, useState } from "react";
import type { HTMLButtonElement, HTMLElement } from "happy-dom";
import { createImportReceipt, type ImportReceipt } from "../web/import-receipt-data.ts";
import { ImportReceiptPanel } from "../web/import-receipt.tsx";
import { I18nProvider } from "../web/i18n.tsx";
import { createWebDomHarness } from "./web-dom.ts";

const scenario = process.argv[2] ?? "collapsed";
const dom = await createWebDomHarness();
const receipt = createImportReceipt({ ok: true, files: 2, profiles: 60, cookiesStripped: 7, skipped: 5, errors: Array.from({ length: 65 }, (_, index) => ({
  file: index === 64 ? "authorization=PRIVATE_TOKEN.csv" : `source-${index}.json`, id: index === 64 ? "http://person:PRIVATE_PASSWORD@host" : `record_${index}`, error: `PRIVATE_RAW_ERROR_${index}`, quarantined: index % 5 === 0,
})) }, 1000);
const empty = createImportReceipt({ ok: true, files: 0, profiles: 0, cookiesStripped: 0, skipped: 0, errors: [] }, 2000);
const mixed = createImportReceipt({ ok: true, files: 1, profiles: 3, cookiesStripped: 0, skipped: 2, errors: [] }, 3000);
let browsed = 0, attention = 0, dismissed = 0;
function Harness({ current = receipt, refreshing = false }: { current?: ImportReceipt; refreshing?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return <I18nProvider><ImportReceiptPanel receipt={current} expanded={expanded} refreshing={refreshing} onExpandedChange={setExpanded} onBrowseAll={() => { browsed++; }} onViewAttention={() => { attention++; }} onDismiss={() => { dismissed++; }} /></I18nProvider>;
}
const visible = <T extends HTMLElement>(selector: string) => [...dom.container.querySelectorAll<T>(selector)].filter(item => !item.closest('[hidden], [inert], [aria-hidden="true"]'));
const button = (label: string) => { const item = visible<HTMLButtonElement>("button").find(node => node.textContent?.trim() === label || node.getAttribute("aria-label") === label); assert.ok(item, `Missing ${label}`); return item; };
const click = (label: string) => act(async () => { button(label).click(); });
try {
  await dom.render(<Harness current={scenario === "zero" ? empty : scenario === "compact-mixed" ? mixed : receipt} refreshing={scenario === "refreshing"} />);
  assert.equal(visible(".import-receipt-list li").length, 0); assert.equal(button("View import details").getAttribute("aria-expanded"), "false");
  assert.ok(!dom.container.textContent?.includes("PRIVATE")); assert.ok(visible<HTMLElement>(".import-receipt-scope")[0]?.textContent?.includes("whole workspace, including earlier imports"));
  assert.equal(visible(".import-receipt-privacy").length, 0, "Privacy and session notes belong in expanded details");
  if (scenario === "zero") assert.equal(visible(".import-receipt-totals").length, 0, "A successful receipt with no problems must not use a row for zero counters");
  if (scenario === "collapsed") {
    assert.ok(visible<HTMLElement>("h2")[0]?.textContent?.includes("60 environment records imported or updated"));
    assert.deepEqual(visible<HTMLElement>(".import-receipt-totals strong").map(item => item.textContent), ["5", "7", "65"]);
  } else if (scenario === "compact-mixed") {
    assert.deepEqual(visible<HTMLElement>(".import-receipt-totals strong").map(item => item.textContent), ["2"]);
    await click("View import details"); assert.deepEqual(visible<HTMLElement>(".import-receipt-totals strong").map(item => item.textContent), ["2", "0", "0"]); assert.equal(visible(".import-receipt-privacy").length, 2);
  } else if (scenario === "actions") {
    await click("Browse all environments"); await click("View environments needing attention"); assert.equal(browsed, 1); assert.equal(attention, 1); assert.equal(dismissed, 0); await click("Dismiss import result"); assert.equal(dismissed, 1);
  } else if (scenario === "refreshing") {
    for (const label of ["Browse all environments", "View environments needing attention", "Dismiss import result"]) { assert.equal(button(label).disabled, true); await click(label); }
    assert.deepEqual([browsed, attention, dismissed], [0, 0, 0]); await click("View import details"); assert.equal(visible(".import-receipt-list li").length, 50);
  } else {
    await click("View import details");
    if (scenario === "zero") { assert.equal(visible(".import-receipt-list li").length, 0); assert.ok(visible<HTMLElement>(".import-receipt-details")[0]?.textContent?.includes("No individual review items")); assert.deepEqual(visible<HTMLElement>(".import-receipt-totals strong").map(item => item.textContent), ["0", "0", "0"]); }
    else {
      assert.equal(visible(".import-receipt-list li").length, 50); assert.equal(button("Previous").disabled, true);
      assert.ok(visible<HTMLElement>(".import-receipt-details")[0]?.textContent?.includes("do not establish that every invalid record was imported"));
      await click("Next"); assert.equal(visible(".import-receipt-list li").length, 15); assert.equal(button("Next").disabled, true);
      assert.ok(visible<HTMLElement>(".import-receipt-list")[0]?.textContent?.includes("File name withheld")); assert.ok(visible<HTMLElement>(".import-receipt-list")[0]?.textContent?.includes("Record identifier unavailable"));
      if (scenario === "replace") {
        await dom.render(<Harness current={empty} />); assert.equal(visible(".import-receipt-list li").length, 0); assert.ok(!visible<HTMLElement>(".import-receipt-details")[0]?.textContent?.includes("record_50"));
      } else { await click("Hide import details"); assert.equal(visible(".import-receipt-list li").length, 0); await click("View import details"); assert.equal(visible(".import-receipt-list li").length, 15); }
    }
  }
  assert.ok(!dom.container.textContent?.includes("PRIVATE"));
  console.log("import receipt interaction fixture passed");
} finally { await dom.cleanup(); }
