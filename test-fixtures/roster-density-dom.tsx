import assert from "node:assert/strict";
import { act, useState } from "react";
import type { HTMLElement as DomElement, HTMLButtonElement as DomButton, HTMLInputElement as DomInput } from "happy-dom";
import { I18nProvider } from "../web/i18n.tsx";
import { RosterDensityControl, type RosterDensity } from "../web/roster-density.tsx";
import { createWebDomHarness } from "./web-dom.ts";

async function run(scenario: string) {
  const dom = await createWebDomHarness();
  const calls: RosterDensity[] = [];
  const coarse = scenario === "coarse-targets";
  dom.window.happyDOM.settings.navigator.maxTouchPoints = coarse ? 1 : 0;
  dom.window.happyDOM.settings.device.prefersReducedMotion = scenario === "reduced-motion" ? "reduce" : "no-preference";
  const styles = dom.window.document.createElement("style");
  styles.textContent = `${await Bun.file(new URL("../web/styles.css", import.meta.url)).text()}\n${await Bun.file(new URL("../web/workbench-layout.css", import.meta.url)).text()}\n${await Bun.file(new URL("../web/roster-views.css", import.meta.url)).text()}\n${await Bun.file(new URL("../web/roster-density.css", import.meta.url)).text()}`;
  dom.window.document.head.append(styles);
  let setDensity!: (value: RosterDensity) => void;
  function Harness({ busy = false, disabled = false }: { busy?: boolean; disabled?: boolean }) {
    const [density, update] = useState<RosterDensity>("comfortable"); setDensity = update;
    const choose = (value: RosterDensity) => { calls.push(value); update(value); };
    return <div className="app folded-workbench" data-roster-density={density}>
      <RosterDensityControl value={density} onChange={choose} busy={busy} disabled={disabled} />
      <RosterDensityControl value={density} onChange={choose} variant="settings" busy={busy} disabled={disabled} />
      <div className="profiles-workspace"><div className="profile-browser"><div className="tablewrap"><table className="profile-table"><thead><tr><th className="chk" style={{ width: 36 }}><input type="checkbox" aria-label="Select all rows" /></th><th>Name</th><th>Actions</th></tr></thead>
        <tbody className="profile-group-header"><tr className="profile-group-row"><td colSpan={3}><div className="profile-group-heading"><input type="checkbox" className="profile-group-check" aria-label="Select group" /><button className="profile-group-toggle">Group · 1 environment</button><button className="profile-group-create">+</button><button className="profile-menu-trigger">More</button></div></td></tr></tbody>
        <tbody className="profile-group-body"><tr data-profile-id="fixture"><td className="chk"><input type="checkbox" aria-label="Select environment" /></td><td className="col-name"><span className="name-cell"><span className="profile-name-line"><button className="profile-favorite">Star</button><button className="profile-name-button">Readable name</button></span><span className="sub">fixture ID</span><button className="profile-tags-preview">Important tag</button><span className="status"><button className="status-chip">Restart to apply</button></span></span></td><td className="col-action"><span className="rowactions"><button className="btn row-start">Start</button><button className="btn profile-menu-trigger">Actions</button></span></td></tr></tbody>
      </table></div></div><section role="dialog"><div className="tablewrap"><table className="profile-table"><tbody><tr data-profile-id="dialog"><td>Dialog row</td></tr></tbody></table></div></section></div>
      <div className="other-workspace"><div className="tablewrap"><table className="profile-table"><tbody><tr data-profile-id="other"><td>Other page row</td></tr></tbody></table></div></div>
    </div>;
  }
  const render = (props: { busy?: boolean; disabled?: boolean } = {}) => dom.render(<I18nProvider><Harness {...props} /></I18nProvider>);
  const groups = () => [...dom.container.querySelectorAll<DomElement>('[role="radiogroup"]')];
  const radio = (value: string, group = 0) => { const target = [...groups()[group]!.querySelectorAll<DomButton>('[role="radio"]')].find(item => item.textContent === value); assert.ok(target); return target; };
  const key = async (target: DomButton, key: string, extra = {}) => { const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }); await act(async () => { target.dispatchEvent(event); }); return event; };
  const click = async (target: DomButton) => act(async () => { target.click(); });
  const selected = (group = 0) => groups()[group]!.querySelector('[aria-checked="true"]')?.textContent;
  const row = () => dom.container.querySelector<DomElement>('tr[data-profile-id="fixture"] > td')!;
  const style = (target: DomElement) => dom.window.getComputedStyle(target);
  try {
    await render();
    if (scenario === "keyboard") {
      radio("Comfortable").focus();
      assert.equal((await key(radio("Comfortable"), "ArrowRight")).defaultPrevented, true); assert.equal(selected(), "Standard"); assert.equal(selected(1), "Standard"); assert.equal(dom.window.document.activeElement, radio("Standard"));
      await key(radio("Standard"), "ArrowDown"); assert.equal(selected(), "Compact"); assert.equal(selected(1), "Compact"); assert.equal(dom.window.document.activeElement, radio("Compact"));
      await key(radio("Compact"), "ArrowRight"); assert.equal(selected(), "Comfortable"); assert.equal(dom.window.document.activeElement, radio("Comfortable"));
      await key(radio("Comfortable"), "ArrowLeft"); assert.equal(selected(), "Compact");
      await key(radio("Compact"), "Home"); assert.equal(selected(), "Comfortable");
      await key(radio("Comfortable"), "End"); assert.equal(selected(), "Compact");
      await key(radio("Compact"), "End"); assert.equal(calls.length, 6, "Selecting the current density must not write it again");
      assert.equal((await key(radio("Compact"), "k", { ctrlKey: true })).defaultPrevented, false);
      assert.equal((await key(radio("Compact"), "ArrowLeft", { isComposing: true })).defaultPrevented, false);
      assert.equal((await key(radio("Compact"), "ArrowLeft", { altKey: true })).defaultPrevented, false); assert.equal(calls.length, 6);
      for (const group of groups()) assert.equal(group.querySelectorAll('[tabindex="0"]').length, 1);
    } else if (scenario === "busy-disabled") {
      radio("Comfortable").focus(); await render({ busy: true });
      assert.equal(dom.window.document.activeElement, radio("Comfortable")); assert.equal(radio("Comfortable").disabled, false); assert.equal(groups()[0]!.getAttribute("aria-busy"), "true");
      await click(radio("Compact")); await key(radio("Comfortable"), "ArrowRight"); assert.deepEqual(calls, []); assert.equal(selected(), "Comfortable");
      await render({ disabled: true }); assert.ok(radio("Compact").disabled); await click(radio("Compact")); await key(radio("Comfortable"), "End"); assert.deepEqual(calls, []);
      await render(); await click(radio("Standard")); assert.equal(selected(), "Standard"); await click(radio("Compact")); assert.equal(selected(), "Compact"); assert.deepEqual(calls, ["standard", "compact"]);
    } else if (scenario === "compact-css" || scenario === "reduced-motion") {
      const originalRow = row(), originalFont = style(originalRow).fontSize, originalName = dom.container.querySelector<DomElement>(".profile-name-button")!;
      assert.equal(style(originalRow).height, "48px");
      assert.equal(style(dom.container.querySelector<DomElement>(".profile-group-heading")!).minHeight, "35px");
      await click(radio("Standard"));
      assert.equal(row(), originalRow); assert.equal(style(row()).height, "44px"); assert.equal(style(row()).fontSize, originalFont); assert.equal(style(originalName).fontSize, "14px");
      assert.equal(style(dom.container.querySelector<DomElement>(".profile-group-heading")!).minHeight, "32px");
      assert.equal(style(dom.container.querySelector<DomElement>('tr[data-profile-id="dialog"] > td')!).height, "52px"); assert.equal(style(dom.container.querySelector<DomElement>('tr[data-profile-id="other"] > td')!).height, "52px");
      await click(radio("Compact"));
      assert.equal(row(), originalRow); assert.equal(style(row()).height, "36px"); assert.equal(style(row()).fontSize, originalFont); assert.equal(style(originalName).fontSize, "14px");
      assert.equal(style(dom.container.querySelector<DomElement>(".profile-group-heading")!).minHeight, "28px");
      assert.ok(dom.container.textContent?.includes("Important tag")); assert.ok(dom.container.textContent?.includes("Restart to apply"));
      assert.equal(style(dom.container.querySelector<DomElement>('tr[data-profile-id="dialog"] > td')!).height, "52px"); assert.equal(style(dom.container.querySelector<DomElement>('tr[data-profile-id="other"] > td')!).height, "52px");
      assert.notEqual(style(row()).transform, "scale(0.9)");
      await click(radio("Comfortable")); assert.equal(style(row()).height, "48px");
    } else if (scenario === "coarse-targets") {
      assert.equal(dom.window.matchMedia("(pointer: coarse)").matches, true);
      const targetSelectors = [".rowactions > .btn", ".profile-name-button", ".profile-tags-preview", ".status-chip", ".profile-group-toggle", ".profile-group-create"];
      for (const mode of ["Standard", "Compact"] as const) {
        await click(radio(mode));
        for (const selector of targetSelectors) {
          const targets = dom.container.querySelectorAll<DomElement>(`.profiles-workspace > .profile-browser > .tablewrap ${selector}`);
          assert.ok(targets.length > 0, `${selector} must resolve to a real roster control`);
          for (const target of targets) assert.ok(parseFloat(style(target).minHeight) >= 44, `${selector} must keep a 44px touch target in ${mode}`);
        }
      }
      for (const target of groups()[0]!.querySelectorAll<DomButton>("button")) assert.equal(style(target).minHeight, "44px");
      const check = dom.container.querySelector<DomInput>('input[aria-label="Select environment"]')!;
      assert.equal(style(check).width, "44px"); assert.equal(style(check).height, "44px");
      assert.equal(style(dom.container.querySelector<DomElement>("th.chk")!).width, "44px", "The checkbox hit target must not overlap its neighboring name column");
      await act(async () => { check.click(); }); assert.equal(check.checked, true);
      await click(radio("Standard")); assert.equal(check.checked, true);
      await click(radio("Comfortable")); assert.equal(check.checked, true); await click(radio("Compact")); assert.equal(check.checked, true, "Changing density preserves row selection");
    } else if (scenario === "instance-scope") {
      const ids = [...dom.container.querySelectorAll("[id]")].map(item => item.id); assert.equal(new Set(ids).size, ids.length);
      const settings = groups()[1]!; assert.ok(settings.getAttribute("aria-describedby")); assert.ok(dom.window.document.getElementById(settings.getAttribute("aria-describedby")!));
      await click(radio("Compact", 1)); assert.equal(selected(), "Compact"); assert.equal(selected(1), "Compact");
      await act(async () => { setDensity("comfortable"); }); assert.equal(selected(), "Comfortable"); assert.equal(selected(1), "Comfortable");
      assert.equal(dom.window.localStorage.getItem("aliasmode.roster.density"), null, "The controlled module must not leak a workspace preference into an unrelated global store");
    } else throw new Error(scenario);
  } finally { await dom.cleanup(); }
}
await run(process.argv[2] ?? "keyboard"); console.log("roster density fixture passed");
