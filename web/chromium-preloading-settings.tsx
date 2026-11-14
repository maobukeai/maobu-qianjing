import { useEffect, useId, useRef, useState } from "react";
import type { ChromiumPreloadingMode } from "../chromium-preloading-preferences.ts";
import { useTranslation } from "./i18n.tsx";
import { fetchSettings, patchSettings } from "./settings-api.ts";
import { useDesktopCloseDraft } from "./desktop-close.tsx";

/** Saving changes workspace intent only; this component never opens/stops or probes a browser. */
export function ChromiumPreloadingSettings() {
  const { t } = useTranslation(), hint = useId();
  const lifecycle = useRef({ generation: 0, active: true, busy: false });
  const [saved, setSaved] = useState<ChromiumPreloadingMode | null>(null), [value, setValue] = useState<ChromiumPreloadingMode>("browser-default");
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const dirty = saved !== null && value !== saved;
  useDesktopCloseDraft("network-settings", { dirty, busy: busy && dirty });
  const loading = useRef<AbortController | null>(null);
  async function load() {
    const state = lifecycle.current;
    if (!state.active || state.busy) return;
    state.busy = true; const generation = state.generation;
    const controller = new AbortController(); loading.current = controller;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await fetchSettings(controller.signal);
      if (state.active && generation === state.generation) { const mode = result.network.chromiumPreloading ?? "browser-default"; setSaved(mode); setValue(mode); }
    } catch {
      if (state.active && generation === state.generation) setError("Page preloading settings could not be loaded. Try again.");
    } finally {
      if (state.active && generation === state.generation) { state.busy = false; setBusy(false); loading.current = null; }
    }
  }
  useEffect(() => {
    lifecycle.current.active = true;
    void load();
    return () => { loading.current?.abort(); loading.current = null; lifecycle.current.active = false; lifecycle.current.generation++; lifecycle.current.busy = false; };
  }, []);
  async function save() {
    const state = lifecycle.current;
    if (!state.active || state.busy || saved === null || value === saved) return;
    state.busy = true; const generation = state.generation, desired = value;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await patchSettings({ network: { chromiumPreloading: desired } });
      if ((result.network.chromiumPreloading ?? "browser-default") !== desired) throw new Error("Unacknowledged preference");
      if (state.active && generation === state.generation) { setSaved(desired); setNotice("Preloading preference saved. It will apply the next time you open a closed profile."); }
    } catch {
      if (state.active && generation === state.generation) setError("Page preloading settings could not be saved. Reload or try again.");
    } finally { if (state.active && generation === state.generation) { state.busy = false; setBusy(false); } }
  }
  return <section className="feature-card" aria-label={t("Page preloading")}>
    <div className="feature-card-title"><div><h3>{t("Page preloading")}</h3><p>{t("Reduce speculative connections and page loading ahead of time. Some pages may open more slowly.")}</p></div></div>
    <label className="fld"><span>{t("Preloading behavior")}</span><select value={value} disabled={busy || saved === null} aria-describedby={hint} onChange={event => {
      const next = event.target.value;
      if (next === "browser-default" || next === "disabled") { setValue(next); setNotice(""); setError(""); }
    }}><option value="browser-default">{t("Keep browser default")}</option><option value="disabled">{t("Disable preloading")}</option></select></label>
    <p id={hint} className="feature-inline-note">{t("Applies to managed Chromium 155 on the next fresh launch. Running browsers are left as they are. Firefox and CloakBrowser do not receive this policy. Websites and other browser services can still connect.")}</p>
    <p className="feature-inline-note">{t("Keep browser default restores your previous browser preference when this app changed it, while preserving later manual changes.")}</p>
    {error && <p className="feature-alert" role="alert">{t(error)}</p>}{notice && <p className="feature-success" role="status">{t(notice)}</p>}
    <div className="feature-actions">{saved === null ? <button type="button" className="btn" disabled={busy} onClick={() => void load()}>{t(busy ? "Loading…" : "Try again")}</button> : <button type="button" className="btn primary" disabled={busy || value === saved} aria-busy={busy} onClick={() => void save()}>{t(busy ? "Saving…" : "Save preloading preference")}</button>}</div>
  </section>;
}
