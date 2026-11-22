import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, firefox } from "playwright-core";

const MAX_SCREENSHOTS_PER_PROFILE = 5;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const JPEG_QUALITY = 75;
const FALLBACK_JPEG_QUALITY = 45;
const ERROR_SCREENSHOT_TIMEOUT_MS = 5_000;
const MANUAL_SCREENSHOT_TIMEOUT_MS = 10_000;

const scriptPath = process.argv[2];
if (!scriptPath) throw new Error("script path is missing");

process.stdin.setEncoding("utf8");
process.stdin.once("end", () => process.exit(1));
process.stdin.resume();

function firstInputLine() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      process.stdin.off("data", onData);
      resolve(buffer.slice(0, newline).replace(/\r$/, ""));
    };
    const onEnd = () => {
      process.stdin.off("data", onData);
      reject(new Error("runner input is missing"));
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
}

function errorText(error, input) {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return input?.engine === "firefox" && typeof input.endpoint === "string"
    ? text.replaceAll(input.endpoint, "private Firefox endpoint")
    : text;
}

function shortErrorText(error, input) {
  const text = error instanceof Error ? error.message : String(error);
  const redacted = input?.engine === "firefox" && typeof input.endpoint === "string"
    ? text.replaceAll(input.endpoint, "private Firefox endpoint")
    : text;
  return redacted.slice(0, 400);
}

function appendJsonLine(filePath, record) {
  if (typeof filePath !== "string" || !filePath) return;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Receipt telemetry must never abort or override user script execution.
  }
}

function sanitizeLabel(label, fallback) {
  const cleaned = String(label ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || fallback;
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("screenshot timed out")), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function capturePageJpeg(targetPage, timeoutMs) {
  if (!targetPage || typeof targetPage.screenshot !== "function") return null;
  let bytes = await withTimeout(
    targetPage.screenshot({ type: "jpeg", quality: JPEG_QUALITY, timeout: timeoutMs }),
    timeoutMs,
  );
  if (!bytes || typeof bytes.byteLength !== "number") return null;
  let buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.byteLength > MAX_SCREENSHOT_BYTES) {
    const retry = await withTimeout(
      targetPage.screenshot({ type: "jpeg", quality: FALLBACK_JPEG_QUALITY, timeout: timeoutMs }),
      timeoutMs,
    );
    if (!retry || typeof retry.byteLength !== "number") return null;
    buffer = Buffer.isBuffer(retry) ? retry : Buffer.from(retry);
    if (buffer.byteLength > MAX_SCREENSHOT_BYTES) return null;
  }
  return buffer;
}

async function run(input) {
  if (typeof input?.endpoint !== "string" || !input.endpoint) throw new Error("runner input is missing");
  if (input.endpoint.startsWith("firefox://")) throw new Error("Firefox scripts require a private Playwright endpoint");
  if (input.engine !== undefined && input.engine !== "firefox") throw new Error("runner input is invalid");

  const stepsPath = typeof input.stepsPath === "string" && input.stepsPath ? input.stepsPath : null;
  const artifactsDir = typeof input.artifactsDir === "string" && input.artifactsDir ? input.artifactsDir : null;
  const manifestPath = artifactsDir ? join(artifactsDir, "manifest.jsonl") : null;

  let browser;
  let context;
  let page;
  let stepCounter = 0;
  let screenshotCount = 0;

  const saveScreenshot = async (label, kind, explicitFileName, timeoutMs) => {
    if (!artifactsDir || screenshotCount >= MAX_SCREENSHOTS_PER_PROFILE) return null;
    const pages = typeof context?.pages === "function" ? context.pages() : [];
    const targetPage = (page && (!page.isClosed || !page.isClosed())) ? page : pages[pages.length - 1];
    if (!targetPage || typeof targetPage.screenshot !== "function") return null;
    const buffer = await capturePageJpeg(targetPage, timeoutMs);
    if (!buffer || buffer.byteLength === 0 || buffer.byteLength > MAX_SCREENSHOT_BYTES) return null;

    const index = screenshotCount + 1;
    const displayLabel = String(label ?? (kind === "error" ? "error-final" : `shot-${index}`)).trim().slice(0, 80) || `shot-${index}`;
    const fileName = explicitFileName ?? `shot-${String(index).padStart(2, "0")}-${sanitizeLabel(displayLabel, `shot-${index}`)}.jpg`;
    if (!/^[A-Za-z0-9_-]{1,64}\.(?:jpg|png)$/.test(fileName)) return null;

    mkdirSync(artifactsDir, { recursive: true });
    const targetPath = join(artifactsDir, fileName);
    writeFileSync(targetPath, buffer, { mode: 0o600 });
    screenshotCount += 1;
    const record = {
      fileName,
      label: displayLabel,
      mimeType: "image/jpeg",
      sizeBytes: buffer.byteLength,
      capturedAt: Date.now(),
      kind,
    };
    appendJsonLine(manifestPath, record);
    return { ...record, path: targetPath };
  };

  const step = async (title, fn) => {
    if (typeof fn !== "function") {
      throw new TypeError("step(title, fn) requires a function");
    }
    const index = ++stepCounter;
    const safeTitle = String(title ?? "").trim().slice(0, 200) || `Step ${index}`;
    const startedAt = Date.now();
    appendJsonLine(stepsPath, { index, title: safeTitle, status: "running", startedAt });
    try {
      const value = await fn();
      const finishedAt = Date.now();
      appendJsonLine(stepsPath, {
        index,
        title: safeTitle,
        status: "succeeded",
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
      });
      return value;
    } catch (error) {
      const finishedAt = Date.now();
      appendJsonLine(stepsPath, {
        index,
        title: safeTitle,
        status: "failed",
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        error: shortErrorText(error, input),
      });
      throw error;
    }
  };

  const screenshot = async (label) => {
    try {
      return await saveScreenshot(label, "manual", undefined, MANUAL_SCREENSHOT_TIMEOUT_MS);
    } catch {
      return null;
    }
  };

  try {
    browser = input.engine === "firefox"
      ? await firefox.connect(input.endpoint, { timeout: 30_000 })
      : await chromium.connectOverCDP(input.endpoint, { timeout: 30_000 });
    context = browser.contexts()[0];
    if (!context) throw new Error("猫步·千境 browser context is unavailable");
    page = context.pages()[0] ?? await context.newPage();
    const module = await import(pathToFileURL(scriptPath).href);
    if (typeof module.default !== "function") {
      throw new Error("Playwright script must export a default async function");
    }
    await module.default({
      browser,
      context,
      page,
      profile: input.profile,
      inputs: input.inputs,
      credentials: input.credentials ?? null,
      log: (...values) => console.log(...values),
      step,
      screenshot,
    });
  } catch (error) {
    // Capture error-final.jpg BEFORE browser.close(); fail silently without masking the original error.
    try {
      await saveScreenshot("Error snapshot", "error", "error-final.jpg", ERROR_SCREENSHOT_TIMEOUT_MS);
    } catch {
      // Intentionally silent.
    }
    throw error;
  } finally {
    await browser?.close().catch(() => {});
  }
}

let input;
try {
  input = JSON.parse(await firstInputLine());
  await run(input);
} catch (error) {
  process.exitCode = 1;
  console.error(errorText(error, input));
} finally {
  process.stdin.pause();
}
