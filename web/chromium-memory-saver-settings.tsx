import { useEffect, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import { fetchSettings, patchSettings } from "./settings-api.ts";
import { useDesktopCloseDraft } from "./desktop-close.tsx";

/** Saving changes workspace intent only; running browsers keep their process layout. */
export function ChromiumMemorySaverSettings() {
  const { t } = useTranslation();
  const lifecycle = useRef({ generation: 0, active: true, busy: false });
  const [saved, setSaved] = useState<boolean | null>(null), [value, setValue] = useState(false);
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
      if (state.active && generation === state.generation) { const on = result.network.chromiumMemorySaver === true; setSaved(on); setValue(on); }
    } catch {
      if (state.active && generation === state.generation) setError("Memory saver settings could not be loaded. Try again.");
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
      const result = await patchSettings({ network: { chromiumMemorySaver: desired } });
      if ((result.network.chromiumMemorySaver === true) !== desired) throw new Error("Unacknowledged preference");
      if (state.active && generation === state.generation) { setSaved(desired); setNotice("Memory saver preference saved. It will apply the next time you open a closed profile."); }
    } catch {
      if (state.active && generation === state.generation) setError("Memory saver settings could not be saved. Reload or try again.");
    } finally { if (state.active && generation === state.generation) { state.busy = false; setBusy(false); } }
  }
  return <section className="feature-card feature-card-split" aria-label={t("Memory saver")}>
    <div className="feature-card-title">
      <div className="feature-card-head-main">
        <h3>{t("Memory saver")}</h3>
        <p>{t("Let tabs in a Chromium profile share a few renderer processes to use less memory. Pages with many tabs may respond more slowly.")}</p>
      </div>
      <span className={`feature-badge ${value ? "positive" : ""}`}>{t(value ? "Enabled" : "Disabled")}</span>
    </div>
    <div className="feature-card-body">
      <label className="feature-toggle">
        <span><strong>{t("Limit renderer processes")}</strong></span>
        <input type="checkbox" role="switch" checked={value} disabled={busy || saved === null} onChange={event => { setValue(event.target.checked); setNotice(""); setError(""); }} />
      </label>
      <details className="feature-note-disclosure">
        <summary>{t("Scope & notes")}</summary>
        <div className="feature-note-disclosure-body">
          <p>{t("Applies to Chromium profiles on the next fresh launch. Running browsers and Firefox are left as they are. Off by default.")}</p>
        </div>
      </details>
      {error && <p className="feature-alert" role="alert">{t(error)}</p>}{notice && <p className="feature-success" role="status">{t(notice)}</p>}
      <div className="feature-actions feature-card-footer-actions">{saved === null ? <button type="button" className="btn sm" disabled={busy} onClick={() => void load()}>{t(busy ? "Loading…" : "Try again")}</button> : <button type="button" className="btn sm primary" disabled={busy || value === saved} aria-busy={busy} onClick={() => void save()}>{t(busy ? "Saving…" : "Save memory saver preference")}</button>}</div>
    </div>
  </section>;
}
