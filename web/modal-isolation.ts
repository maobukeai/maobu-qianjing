interface ModalLock {
  holders: number;
  inert: string | null;
  hidden: string | null;
}

const locks = new WeakMap<HTMLElement, ModalLock>();

function acquire(element: HTMLElement) {
  const existing = locks.get(element);
  if (existing) { existing.holders++; return; }
  locks.set(element, { holders: 1, inert: element.getAttribute("inert"), hidden: element.getAttribute("aria-hidden") });
  element.setAttribute("inert", "");
  element.setAttribute("aria-hidden", "true");
}

function restore(element: HTMLElement, attribute: string, applied: string, before: string | null) {
  if (element.getAttribute(attribute) !== applied) return;
  if (before === null) element.removeAttribute(attribute);
  else element.setAttribute(attribute, before);
}

function release(element: HTMLElement) {
  const lock = locks.get(element);
  if (!lock || --lock.holders > 0) return;
  locks.delete(element);
  restore(element, "inert", "", lock.inert);
  restore(element, "aria-hidden", "true", lock.hidden);
}

/** Overlapping portals share a lock on each body child and restore its original state on the last release. */
export function isolateModalSiblings(layer: HTMLElement, allow?: (child: HTMLElement) => boolean): () => void {
  const { body, defaultView } = layer.ownerDocument;
  if (!defaultView) return () => {};
  const ElementClass = defaultView.HTMLElement;
  const held = new Set<HTMLElement>();
  let closed = false;
  function includeSiblings() {
    if (closed) return;
    for (const child of body.children) {
      if (!(child instanceof ElementClass) || child.contains(layer) || held.has(child) || allow?.(child)) continue;
      held.add(child);
      acquire(child);
    }
  }
  includeSiblings();
  const observer = new defaultView.MutationObserver(includeSiblings);
  observer.observe(body, { childList: true });
  return () => {
    if (closed) return;
    closed = true;
    observer.disconnect();
    for (const child of held) release(child);
    held.clear();
  };
}
