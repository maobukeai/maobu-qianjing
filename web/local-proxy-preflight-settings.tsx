import { useEffect, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import { fetchSettings, patchSettings } from "./settings-api.ts";
import { useDesktopCloseDraft } from "./desktop-close.tsx";

/** User-controlled preference only. Opening this card never scans a port. */
export function LocalProxyPreflightSettings() {
  const { t } = useTranslation(), lifecycle = useRef({ active: true, busy: false, generation: 0 });
  const [saved, setSaved] = useState<boolean | null>(null), [value, setValue] = useState(false), [busy, setBusy] = useState(true);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const dirty = saved !== null && value !== saved;
  useDesktopCloseDraft("network-settings", { dirty, busy: busy && dirty });
  async function load() {
    const owner = lifecycle.current; if (!owner.active || owner.busy) return;
    owner.busy = true; const generation = owner.generation;
    setBusy(true); setError(""); setNotice("");
    try { const result = await fetchSettings(); if (owner.active && owner.generation === generation) { const enabled = result.network?.checkLocalProxyBeforeLaunch ?? false; setSaved(enabled); setValue(enabled); } }
    catch (error) { if (owner.active && owner.generation === generation) setError(error instanceof Error ? error.message : "Network settings could not be loaded. Try again."); }
    finally { if (owner.active && owner.generation === generation) { owner.busy = false; setBusy(false); } }
  }
  useEffect(() => { lifecycle.current.active = true; void load(); return () => { lifecycle.current.active = false; lifecycle.current.generation++; lifecycle.current.busy = false; }; }, []);
  async function save() {
    const owner = lifecycle.current; if (!owner.active || owner.busy || saved === null || value === saved) return;
    owner.busy = true; const generation = owner.generation;
    const desired = value; setBusy(true); setError(""); setNotice("");
    try {
      const result = await patchSettings({ network: { checkLocalProxyBeforeLaunch: desired } });
      if ((result.network?.checkLocalProxyBeforeLaunch ?? false) !== desired) throw new Error("The network preference was not saved. Reload and try again.");
      if (owner.active && owner.generation === generation) { setSaved(desired); setNotice("Network startup preference saved."); }
    } catch (error) { if (owner.active && owner.generation === generation) setError(error instanceof Error ? error.message : "Network settings could not be saved. Try again."); }
    finally { if (owner.active && owner.generation === generation) { owner.busy = false; setBusy(false); } }
  }
  return <section className="feature-card">
    <div className="feature-card-title"><div><h3>{t("Local proxy startup check")}</h3><p>{t("Stop a new profile launch early when its configured desktop proxy is unavailable.")}</p></div></div>
    <label className="feature-toggle"><input type="checkbox" checked={value} disabled={busy || saved === null} onChange={event => { setValue(event.target.checked); setNotice(""); }} /><span>{t("Check configured local proxies before opening profiles")}</span></label>
    <p className="feature-inline-note">{t("Off by default. Checks only the profile's configured loopback port before a fresh launch. HTTP and HTTPS use TCP listening checks; SOCKS5 also checks method negotiation. Credentials and exit connectivity are not verified, and system proxy settings are not changed.")}</p>
    {error && <p className="feature-alert" role="alert">{t(error)}</p>}{notice && <p className="feature-success" role="status">{t(notice)}</p>}
    <div className="feature-actions">{saved === null ? <button type="button" className="btn" disabled={busy} onClick={() => void load()}>{t(busy ? "Loading…" : "Try again")}</button> : <button type="button" className="btn primary" disabled={busy || value === saved} aria-busy={busy} onClick={() => void save()}>{t(busy ? "Saving…" : "Save network preference")}</button>}</div>
  </section>;
}
