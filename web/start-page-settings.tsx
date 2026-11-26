import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import { fetchSettings, fetchSettingsShared, patchSettings } from "./settings-api.ts";
import { AppIcon } from "./ui-primitives.tsx";

/** Workspace preference for opening the local offline environment start page on launch. */
export function StartPageSettings() {
  const { t } = useTranslation();
  const titleId = useId();
  const lifecycle = useRef({ generation: 0, active: true, busy: false });
  const loading = useRef<AbortController | null>(null);
  const [value, setValue] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load(forceFresh = false) {
    const state = lifecycle.current;
    if (!state.active || state.busy) return;
    state.busy = true;
    const generation = state.generation;
    const controller = new AbortController();
    loading.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = forceFresh ? await fetchSettings(controller.signal) : await fetchSettingsShared(controller.signal);
      if (state.active && generation === state.generation) {
        setValue(result.network.openStartPageOnLaunch !== false);
        setLoaded(true);
      }
    } catch {
      if (state.active && generation === state.generation) {
        setError("Browser startup settings could not be loaded. Try again.");
      }
    } finally {
      if (state.active && generation === state.generation) {
        state.busy = false;
        setBusy(false);
        loading.current = null;
      }
    }
  }

  useEffect(() => {
    lifecycle.current.active = true;
    void load(false);
    return () => {
      loading.current?.abort();
      loading.current = null;
      lifecycle.current.active = false;
      lifecycle.current.generation++;
      lifecycle.current.busy = false;
    };
  }, []);

  async function handleToggle(desired: boolean) {
    const state = lifecycle.current;
    if (!state.active || state.busy || !loaded) return;
    const previous = value;
    state.busy = true;
    const generation = state.generation;
    setValue(desired);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await patchSettings({ network: { openStartPageOnLaunch: desired } });
      if ((result.network.openStartPageOnLaunch !== false) !== desired) {
        throw new Error("Unacknowledged preference");
      }
      if (state.active && generation === state.generation) {
        setValue(desired);
        setNotice("Browser startup preference saved.");
      }
    } catch {
      if (state.active && generation === state.generation) {
        setValue(previous);
        setError("Browser startup settings could not be saved. Try again.");
      }
    } finally {
      if (state.active && generation === state.generation) {
        state.busy = false;
        setBusy(false);
      }
    }
  }

  return (
    <section className="settings-card" aria-labelledby={titleId}>
      <header>
        <AppIcon name="window" className="sm" />
        <h2 id={titleId}>{t("Browser startup")}</h2>
      </header>
      <div className="card-body">
        <label className="feature-toggle">
          <span>
            <strong>{t("Open local environment start page on launch")}</strong>
            <small>{t("Opens an offline zero-traffic start page with profile info, live browser fingerprint checks, and on-demand test site shortcuts.")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={value}
            disabled={busy || !loaded}
            onChange={(event) => void handleToggle(event.target.checked)}
          />
        </label>
        {error && (
          <div className="feature-alert" role="alert">
            <span>{t(error)}</span>
            {!loaded && (
              <button type="button" className="btn xs" disabled={busy} onClick={() => void load(true)}>
                {t("Try again")}
              </button>
            )}
          </div>
        )}
        {notice && <p className="feature-success" role="status">{t(notice)}</p>}
      </div>
    </section>
  );
}
