import { invoke, isTauri } from "@tauri-apps/api/core";

/** Native popups remain disabled; only the origin-checked resource command can open a system browser. */
export function installExternalLinkHandler(root: HTMLElement): () => void {
  const handle = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || !isTauri() || !(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>('a[target="_blank"]');
    if (!anchor || !root.contains(anchor)) return;
    event.preventDefault();
    event.stopPropagation(); // The shell plugin's generic body opener is deliberately unavailable.
    void invoke("open_external_resource", { url: anchor.href }).catch(() => {
      window.dispatchEvent(new window.CustomEvent("external-link-error", { detail: "The external link could not be opened. Copy its address and open it in your browser." }));
    });
  };
  root.addEventListener("click", handle);
  return () => root.removeEventListener("click", handle);
}
