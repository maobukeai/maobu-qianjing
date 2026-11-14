// Local-only diagnostic for typed-array access in Firefox's automation execution context.
import { firefox } from "playwright-core";
const browser = await firefox.connect(process.argv[2], { timeout: 15_000 });
try {
  const context = browser.contexts()[0];
  const page = await context.newPage();
  const url = "https://fingerprint.aliasmode.invalid/?__engine_qa_realm__=1";
  await page.route("**/*", route => route.request().url() === url
    ? route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Local realm probe</title>" })
    : route.abort());
  try {
    await page.goto(url);
    const results = await page.evaluate(async () => {
      const out = {};
      async function step(name, action) {
        try { out[name] = { ok: true, value: await action() }; }
        catch (error) { out[name] = { ok: false, error: String(error?.message ?? error) }; }
      }
      await step("encoder", () => new TextEncoder().encode("abc").length);
      await step("encoderIndex", () => new TextEncoder().encode("abc")[0]);
      await step("encoderSpread", () => [...new TextEncoder().encode("abc")]);
      await step("digest", async () => (await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"))).byteLength);
      await step("digestIndex", async () => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc")))[0]);
      await step("digestSpread", async () => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc")))].map(byte => byte.toString(16).padStart(2, "0")).join(""));
      await step("digestDataView", async () => {
        const view = new DataView(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc")));
        let value = ""; for (let i = 0; i < view.byteLength; i++) value += view.getUint8(i).toString(16).padStart(2, "0");
        return value;
      });
      const audio = new OfflineAudioContext(1, 5000, 44100);
      const oscillator = audio.createOscillator(); oscillator.type = "triangle"; oscillator.frequency.value = 10000;
      const compressor = audio.createDynamicsCompressor(); oscillator.connect(compressor); compressor.connect(audio.destination); oscillator.start();
      const buffer = await audio.startRendering();
      await step("audioLength", () => buffer.getChannelData(0).length);
      await step("audioIndex", () => buffer.getChannelData(0)[0]);
      await step("audioSlice", () => buffer.getChannelData(0).slice(0, 10).length);
      await step("audioSum", () => { let sum = 0; for (const value of buffer.getChannelData(0).slice(0, 1000)) sum += Math.abs(value); return sum; });
      await step("audioDataView", () => { const data = buffer.getChannelData(0), view = new DataView(data.buffer, data.byteOffset, data.byteLength); let sum = 0; for (let i = 0; i < 1000; i++) sum += Math.abs(view.getFloat32(i * 4, true)); return sum; });
      return out;
    });
    process.stdout.write(JSON.stringify(results));
  } finally { await page.close(); }
} finally { await browser.close(); }
