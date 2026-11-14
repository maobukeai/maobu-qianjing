import assert from "node:assert/strict";
import { act } from "react";
import type { HTMLElement, HTMLButtonElement } from "happy-dom";
import type { createWebDomHarness } from "./web-dom.ts";

type ActivityDom = Pick<Awaited<ReturnType<typeof createWebDomHarness>>, "window">;
const interactive = (node: HTMLElement) => !node.closest('[hidden], [inert], [aria-hidden="true"]');

export function activityTrigger(dom: ActivityDom): HTMLButtonElement | null {
  return [...dom.window.document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')].find(node => interactive(node) && node.getAttribute("aria-label")?.startsWith("Background activity,")) ?? null;
}
export async function openActivity(dom: ActivityDom): Promise<HTMLElement> {
  const existing = [...dom.window.document.querySelectorAll<HTMLElement>(".workbench-activity-popover")].find(interactive);
  if (existing) return existing;
  const trigger = activityTrigger(dom); assert.ok(trigger, "Background activity should expose the actual active task owners");
  await act(async () => { trigger.focus(); trigger.click(); });
  const panel = [...dom.window.document.querySelectorAll<HTMLElement>(".workbench-activity-popover")].find(interactive);
  assert.ok(panel, "Activity should open its task list"); return panel;
}
export async function activityTask(dom: ActivityDom, title: string): Promise<HTMLElement> {
  const panel = await openActivity(dom);
  const view = [...panel.querySelectorAll<HTMLButtonElement>("button")].find(node => node.getAttribute("aria-label") === `View ${title}`);
  assert.ok(view, `Missing activity View ${title}`);
  const item = view.closest(".workbench-activity-item"); assert.ok(item); return item as HTMLElement;
}
export async function viewActivityTask(dom: ActivityDom, title: string): Promise<void> {
  const item = await activityTask(dom, title), view = item.querySelector<HTMLButtonElement>(`button[aria-label="View ${title}"]`); assert.ok(view);
  await act(async () => { view.focus(); view.click(); });
}
