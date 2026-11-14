// A separate Node process exercises the same real CDP endpoint as production workers.
import { chromium, firefox } from "playwright-core";
const [endpoint, url, engine = "chromium"] = process.argv.slice(2);
const browser = engine === "firefox"
  ? await firefox.connect(endpoint, { timeout: 15_000 })
  : await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
try {
  const context = browser.contexts()[0];
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "load", timeout: 15_000 });
    const evidence = await page.evaluate(async () => ({
      title: document.title, text: document.body.textContent,
      language: navigator.language, languages: [...navigator.languages],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cores: navigator.hardwareConcurrency, platform: navigator.platform,
      screen: `${screen.width}*${screen.height}`,
      cookie: document.cookie,
      roundtrip: await fetch("/roundtrip", { method: "POST", body: "中文隔离验收" }).then(response => response.text()),
    }));
    process.stdout.write(JSON.stringify(evidence));
  } finally { await page.close(); }
} finally { await browser.close(); } // CDP detach; Launcher remains the session owner.
