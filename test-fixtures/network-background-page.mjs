// Only the caller's fresh synthetic CDP endpoint and loopback-fixture URL are used.
import { chromium } from "playwright-core";
const [endpoint, url, mode = "good"] = process.argv.slice(2);
const destination = new URL(url);
if (destination.hostname !== "maobu-engine-qa.test" || destination.protocol !== "http:" || !destination.port) throw new Error("Unexpected fixture origin");
async function run() {
const browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
try {
  const context = browser.contexts()[0];
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  try {
    let preference = null;
    if (mode === "good") {
      await page.goto("chrome://settings/privacy", { waitUntil: "domcontentloaded", timeout: 8_000 });
      preference = await page.evaluate(() => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("settingsPrivate readback timed out")), 3_000);
        if (!globalThis.chrome?.settingsPrivate?.getPref) { clearTimeout(timer); reject(new Error("settingsPrivate readback unavailable")); return; }
        chrome.settingsPrivate.getPref("net.network_prediction_options", pref => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) { reject(new Error("settingsPrivate readback failed")); return; }
          resolve({ key: pref.key, type: pref.type, value: pref.value, controlledBy: pref.controlledBy ?? null, enforcement: pref.enforcement ?? null });
        });
      }));
    }
    const navigationStarted = performance.now();
    try {
      await page.goto(url, { waitUntil: "load", timeout: 8_000 });
    } catch (error) {
      if (mode !== "denied") throw error;
      // Keep a small classification, never a browser URL/header/error dump.
      process.stdout.write(JSON.stringify({ blocked: true, networkError: /net::ERR_[A-Z_]+/.exec(String(error))?.[0] ?? "navigation-failed" }));
      process.exitCode = 0;
      return;
    }
    if (mode === "denied") throw new Error("Wrong credentials unexpectedly reached fixture origin");
    const navigationMs = performance.now() - navigationStarted;
    const evidence = await page.evaluate(async () => ({
      title: document.title, text: document.body.textContent,
      language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cores: navigator.hardwareConcurrency, screen: `${screen.width}*${screen.height}`,
      cookie: document.cookie,
      roundtrip: await fetch("/roundtrip", { method: "POST", body: "中文隔离验收" }).then(response => response.text()),
    }));
    process.stdout.write(JSON.stringify({ preference, page: evidence, navigationMs }));
  } finally { await page.close(); }
} finally { await browser.close(); } // CDP detach only; the Launcher owns shutdown.
}
await run();
