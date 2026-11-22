import type { RpaTemplate, RpaTemplateId, ScriptInput } from "./contracts/local.ts";

const COOKIE_WARMUP_SOURCE = `// Cookie Warmup Bot — smoothly browses local-configured URLs to build natural cookie state.
// Uses only standard HTTP(S) URLs supplied in inputs; zero remote template fetches.
export default async ({ page, context, profile, inputs, log, step }) => {
  const rawUrls = Array.isArray(inputs?.urls) ? inputs.urls : [];
  const urls = rawUrls
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => /^https?:\\/\\//i.test(item));
  if (urls.length === 0) {
    throw new Error("Provide at least one http:// or https:// URL in inputs.urls");
  }
  const dwellMinSec = Math.max(1, Number(inputs?.dwellMinSec ?? 3));
  const dwellMaxSec = Math.max(dwellMinSec, Number(inputs?.dwellMaxSec ?? 8));
  const scrollSteps = Math.max(0, Math.min(30, Math.trunc(Number(inputs?.scrollSteps ?? 4))));
  const shuffle = inputs?.shuffle !== false;

  const targetUrls = [...urls];
  if (shuffle && targetUrls.length > 1) {
    for (let i = targetUrls.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [targetUrls[i], targetUrls[j]] = [targetUrls[j], targetUrls[i]];
    }
  }

  const beforeCookies = (await context.cookies()).length;
  log(\`[\${profile.name || profile.id}] Cookie warmup starting (\${targetUrls.length} URLs, cookies before: \${beforeCookies})\`);

  for (let index = 0; index < targetUrls.length; index++) {
    const url = targetUrls[index];
    await step(\`Visit \${url}\`, async () => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      for (let s = 0; s < scrollSteps; s++) {
        await page.evaluate(() => {
          const delta = Math.max(180, Math.round(window.innerHeight * 0.45));
          window.scrollBy({ top: delta, behavior: "smooth" });
        }).catch(() => {});
        await page.waitForTimeout(350 + Math.floor(Math.random() * 450));
      }
      const dwellMs = Math.round((dwellMinSec + Math.random() * (dwellMaxSec - dwellMinSec)) * 1000);
      await page.waitForTimeout(dwellMs);
      log(\`Visited (\${index + 1}/\${targetUrls.length}): \${page.url()} | title="\${await page.title()}"\`);
    });
  }

  const afterCookies = (await context.cookies()).length;
  const delta = afterCookies - beforeCookies;
  log(JSON.stringify({
    template: "cookie-warmup",
    profileId: profile.id,
    visited: targetUrls.length,
    cookiesBefore: beforeCookies,
    cookiesAfter: afterCookies,
    cookieDelta: delta,
  }));
};
`;

const BATCH_STATUS_CHECK_SOURCE = `// Batch Page Status Check — inspects HTTP status, redirect URL, title, and login state.
// Captures a receipt screenshot automatically when an anomaly or logged-out state is detected.
export default async ({ page, profile, inputs, log, step, screenshot }) => {
  const targetUrl = typeof inputs?.targetUrl === "string" ? inputs.targetUrl.trim() : "";
  if (!/^https?:\\/\\//i.test(targetUrl)) {
    throw new Error("inputs.targetUrl must be a valid http:// or https:// URL");
  }
  const loggedInSelector = typeof inputs?.loggedInSelector === "string" ? inputs.loggedInSelector.trim() : "";
  const loggedOutSelector = typeof inputs?.loggedOutSelector === "string" ? inputs.loggedOutSelector.trim() : "";
  const captureScreenshotOnFail = inputs?.captureScreenshotOnFail !== false;
  const timeoutMs = Math.max(1000, Math.min(120_000, Number(inputs?.timeoutMs ?? 20_000)));

  let httpStatus = null;
  let finalUrl = targetUrl;
  let title = "";

  await step("Open target page", async () => {
    const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    httpStatus = response ? response.status() : null;
    finalUrl = page.url();
    title = await page.title().catch(() => "");
  });

  let loginState = "unknown";
  await step("Check session selectors", async () => {
    const hasLoggedIn = loggedInSelector
      ? await page.locator(loggedInSelector).first().isVisible({ timeout: 3000 }).catch(() => false)
      : false;
    const hasLoggedOut = loggedOutSelector
      ? await page.locator(loggedOutSelector).first().isVisible({ timeout: 3000 }).catch(() => false)
      : false;
    if (hasLoggedIn && !hasLoggedOut) loginState = "logged_in";
    else if (hasLoggedOut) loginState = "logged_out";
  });

  const healthy = (httpStatus === null || httpStatus < 400) && loginState !== "logged_out";
  log(JSON.stringify({
    template: "batch-status-check",
    profileId: profile.id,
    httpStatus,
    finalUrl,
    title,
    loginState,
    healthy,
  }));

  if (!healthy && captureScreenshotOnFail) {
    await step("Capture anomaly screenshot", async () => {
      await screenshot?.("status-check-anomaly");
    });
  }
};
`;

const PAGE_HEALTH_SNAPSHOT_SOURCE = `// Page Health & Risk Signal Snapshot — passive reachability and interstitial telemetry only.
// Strictly read-only inspection: reports anomalies without ever attempting to bypass verifications.
export default async ({ page, profile, inputs, log, step, screenshot }) => {
  const rawUrls = Array.isArray(inputs?.urls) ? inputs.urls : [];
  const urls = rawUrls
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => /^https?:\\/\\//i.test(item));
  if (urls.length === 0) {
    throw new Error("Provide at least one http:// or https:// URL in inputs.urls");
  }
  const timeoutMs = Math.max(1000, Math.min(120_000, Number(inputs?.timeoutMs ?? 20_000)));
  const captureScreenshot = inputs?.captureScreenshot !== false;

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    await step(\`Inspect \${url}\`, async () => {
      const started = Date.now();
      let httpStatus = null;
      let loadError = null;
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        httpStatus = response ? response.status() : null;
      } catch (err) {
        loadError = err instanceof Error ? err.message : String(err);
      }
      const loadMs = Date.now() - started;
      const finalUrl = page.url();
      const title = await page.title().catch(() => "");

      // Passive read-only signal scan: never clicks or interacts with challenge UI.
      const signals = [];
      if (loadError) signals.push("navigation_error");
      if (httpStatus === 403) signals.push("http_403_forbidden");
      if (httpStatus === 429) signals.push("http_429_rate_limited");
      if (httpStatus !== null && httpStatus >= 500) signals.push(\`http_\${httpStatus}_server_error\`);

      const pageSignals = await page.evaluate(() => {
        const found = [];
        const text = ((document.title || "") + " " + (document.body?.innerText || "").slice(0, 1200)).toLowerCase();
        if (/(access denied|attention required|verify you are human|just a moment|unusual traffic|too many requests)/.test(text)) {
          found.push("interstitial_text_detected");
        }
        if (document.querySelector('iframe[src*="captcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, #cf-challenge-running')) {
          found.push("verification_gate_present");
        }
        return found;
      }).catch(() => []);

      for (const signal of pageSignals) {
        if (!signals.includes(signal)) signals.push(signal);
      }

      const report = {
        url,
        finalUrl,
        httpStatus,
        loadMs,
        title,
        healthy: signals.length === 0,
        signals,
        ...(loadError ? { error: loadError } : {}),
      };
      results.push(report);
      log(JSON.stringify({ template: "page-health-snapshot", profileId: profile.id, ...report }));

      if (captureScreenshot && i < 4) {
        await screenshot?.(\`health-\${i + 1}\`);
      }
    });
  }

  log(\`Health snapshot finished for \${profile.name || profile.id}: \${results.filter((r) => r.healthy).length}/\${results.length} healthy\`);
};
`;

const FORM_FILL_SKELETON_SOURCE = `// Safe Credential Form Fill Skeleton — fills fields from saved profile credentials.
// dryRun defaults to true: pauses BEFORE submit and saves a preview screenshot for review.
export default async ({ page, profile, inputs, credentials, log, step, screenshot }) => {
  const targetUrl = typeof inputs?.targetUrl === "string" ? inputs.targetUrl.trim() : "";
  if (!/^https?:\\/\\//i.test(targetUrl)) {
    throw new Error("inputs.targetUrl must be a valid http:// or https:// URL");
  }
  const usernameSelector = typeof inputs?.usernameSelector === "string" && inputs.usernameSelector.trim()
    ? inputs.usernameSelector.trim()
    : "input[name='username'], input[type='email']";
  const passwordSelector = typeof inputs?.passwordSelector === "string" && inputs.passwordSelector.trim()
    ? inputs.passwordSelector.trim()
    : "input[type='password']";
  const submitSelector = typeof inputs?.submitSelector === "string" && inputs.submitSelector.trim()
    ? inputs.submitSelector.trim()
    : "button[type='submit']";
  const dryRun = inputs?.dryRun !== false;
  const waitAfterFillMs = Math.max(0, Math.min(30_000, Number(inputs?.waitAfterFillMs ?? 1000)));

  const username = credentials?.username || (typeof inputs?.username === "string" ? inputs.username : "");
  const password = credentials?.password || "";

  await step("Open form page", async () => {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  });

  await step("Fill credential fields", async () => {
    if (username) {
      const userField = page.locator(usernameSelector).first();
      await userField.waitFor({ state: "visible", timeout: 10_000 });
      await userField.fill(username);
      log(\`[\${profile.name || profile.id}] Filled username field (value redacted)\`);
    } else {
      log(\`[\${profile.name || profile.id}] Skipped username: no credential provided\`);
    }
    if (password) {
      const passField = page.locator(passwordSelector).first();
      await passField.waitFor({ state: "visible", timeout: 10_000 });
      await passField.fill(password);
      log(\`[\${profile.name || profile.id}] Filled password field (value redacted)\`);
    } else {
      log(\`[\${profile.name || profile.id}] Skipped password: enable "Use saved profile login details" to fill\`);
    }
    if (waitAfterFillMs > 0) {
      await page.waitForTimeout(waitAfterFillMs);
    }
  });

  await step(dryRun ? "Dry-run pause before submit" : "Submit form", async () => {
    if (dryRun) {
      await screenshot?.("form-dry-run-preview");
      log("Dry run is enabled: stopped before clicking submit for manual review.");
      return;
    }
    const submitBtn = page.locator(submitSelector).first();
    await submitBtn.waitFor({ state: "visible", timeout: 10_000 });
    await submitBtn.click();
    log("Form submit triggered.");
  });
};
`;

const BUILTIN_TEMPLATES: readonly RpaTemplate[] = Object.freeze([
  {
    id: "cookie-warmup",
    name: "Cookie Warmup Bot",
    description: "Visits configured HTTP(S) URLs with smooth scrolling, natural dwell times, and cookie count delta reporting.",
    category: "warmup",
    language: "javascript",
    useCredentialsDefault: false,
    inputSchema: [
      {
        key: "urls",
        label: "Warmup URLs",
        description: "One HTTP(S) URL per line to browse during warmup.",
        type: "url-list",
        required: true,
        defaultValue: ["https://example.com"],
        placeholder: "https://example.com\nhttps://news.ycombinator.com",
      },
      {
        key: "dwellMinSec",
        label: "Minimum dwell (seconds)",
        description: "Shortest pause on each page after scrolling.",
        type: "number",
        defaultValue: 3,
        min: 1,
        max: 120,
        step: 1,
      },
      {
        key: "dwellMaxSec",
        label: "Maximum dwell (seconds)",
        description: "Longest pause on each page after scrolling.",
        type: "number",
        defaultValue: 8,
        min: 1,
        max: 300,
        step: 1,
      },
      {
        key: "scrollSteps",
        label: "Smooth scroll steps",
        description: "Number of incremental scroll gestures per page.",
        type: "number",
        defaultValue: 4,
        min: 0,
        max: 30,
        step: 1,
      },
      {
        key: "shuffle",
        label: "Shuffle visit order",
        description: "Randomizes the URL sequence for each profile.",
        type: "boolean",
        defaultValue: true,
      },
    ],
    defaultInputs: {
      urls: ["https://example.com"],
      dwellMinSec: 3,
      dwellMaxSec: 8,
      scrollSteps: 4,
      shuffle: true,
    },
    source: COOKIE_WARMUP_SOURCE,
  },
  {
    id: "batch-status-check",
    name: "Batch Status Check",
    description: "Checks HTTP status, redirect URL, page title, and optional login/logout selectors across multiple profiles, auto-capturing screenshots on failure.",
    category: "inspection",
    language: "javascript",
    useCredentialsDefault: false,
    inputSchema: [
      {
        key: "targetUrl",
        label: "Target URL",
        description: "Page URL to inspect in each selected profile.",
        type: "url",
        required: true,
        defaultValue: "https://example.com",
        placeholder: "https://example.com/dashboard",
      },
      {
        key: "loggedInSelector",
        label: "Logged-in selector",
        description: "Optional CSS selector visible only when signed in.",
        type: "string",
        defaultValue: "",
        placeholder: "[data-testid='user-avatar']",
      },
      {
        key: "loggedOutSelector",
        label: "Logged-out selector",
        description: "Optional CSS selector visible when signed out.",
        type: "string",
        defaultValue: "",
        placeholder: "a[href*='login'], form[action*='login']",
      },
      {
        key: "captureScreenshotOnFail",
        label: "Capture screenshot on anomaly",
        description: "Saves a JPEG receipt when HTTP >= 400 or logged-out selector appears.",
        type: "boolean",
        defaultValue: true,
      },
      {
        key: "timeoutMs",
        label: "Navigation timeout (ms)",
        description: "Maximum wait time for page load.",
        type: "number",
        defaultValue: 20000,
        min: 1000,
        max: 120000,
        step: 1000,
      },
    ],
    defaultInputs: {
      targetUrl: "https://example.com",
      loggedInSelector: "",
      loggedOutSelector: "",
      captureScreenshotOnFail: true,
      timeoutMs: 20000,
    },
    source: BATCH_STATUS_CHECK_SOURCE,
  },
  {
    id: "page-health-snapshot",
    name: "Page Health & Risk Snapshot",
    description: "Passively measures load timing, HTTP codes, and access-block or verification-gate signals across profiles without interacting with challenges.",
    category: "health",
    language: "javascript",
    useCredentialsDefault: false,
    safetyNote: "Passive inspection only: reports access blocks or verification gates without clicking or bypassing them.",
    inputSchema: [
      {
        key: "urls",
        label: "URLs to inspect",
        description: "One HTTP(S) URL per line for passive reachability checks.",
        type: "url-list",
        required: true,
        defaultValue: ["https://example.com"],
        placeholder: "https://example.com",
      },
      {
        key: "timeoutMs",
        label: "Navigation timeout (ms)",
        description: "Maximum wait per URL before recording a navigation error.",
        type: "number",
        defaultValue: 20000,
        min: 1000,
        max: 120000,
        step: 1000,
      },
      {
        key: "captureScreenshot",
        label: "Capture page snapshot",
        description: "Saves a JPEG snapshot for each inspected URL (up to 4).",
        type: "boolean",
        defaultValue: true,
      },
    ],
    defaultInputs: {
      urls: ["https://example.com"],
      timeoutMs: 20000,
      captureScreenshot: true,
    },
    source: PAGE_HEALTH_SNAPSHOT_SOURCE,
  },
  {
    id: "form-fill-skeleton",
    name: "Safe Form Fill Skeleton",
    description: "Credential-aware form fill starter that reads saved profile credentials securely and defaults to Dry Run so you review before submitting.",
    category: "form",
    language: "javascript",
    useCredentialsDefault: true,
    safetyNote: "Dry run is enabled by default: fields are filled and screenshotted, stopping before clicking Submit.",
    inputSchema: [
      {
        key: "targetUrl",
        label: "Form page URL",
        description: "HTTP(S) URL containing the target form.",
        type: "url",
        required: true,
        defaultValue: "https://example.com/login",
        placeholder: "https://example.com/login",
      },
      {
        key: "usernameSelector",
        label: "Username selector",
        description: "CSS selector for the account or email input.",
        type: "string",
        defaultValue: "input[name='username'], input[type='email']",
        placeholder: "input[name='username']",
      },
      {
        key: "passwordSelector",
        label: "Password selector",
        description: "CSS selector for the password input.",
        type: "string",
        defaultValue: "input[type='password']",
        placeholder: "input[type='password']",
      },
      {
        key: "submitSelector",
        label: "Submit button selector",
        description: "CSS selector clicked only when Dry Run is turned off.",
        type: "string",
        defaultValue: "button[type='submit']",
        placeholder: "button[type='submit']",
      },
      {
        key: "dryRun",
        label: "Dry run (stop before submit)",
        description: "Keep enabled to pause before submit and save a preview screenshot.",
        type: "boolean",
        defaultValue: true,
      },
      {
        key: "waitAfterFillMs",
        label: "Pause after fill (ms)",
        description: "Delay after typing before preview or submit.",
        type: "number",
        defaultValue: 1000,
        min: 0,
        max: 30000,
        step: 250,
      },
    ],
    defaultInputs: {
      targetUrl: "https://example.com/login",
      usernameSelector: "input[name='username'], input[type='email']",
      passwordSelector: "input[type='password']",
      submitSelector: "button[type='submit']",
      dryRun: true,
      waitAfterFillMs: 1000,
    },
    source: FORM_FILL_SKELETON_SOURCE,
  },
]);

export function listRpaTemplates(): RpaTemplate[] {
  return BUILTIN_TEMPLATES.map((template) => structuredClone(template));
}

export function getRpaTemplate(id: string): RpaTemplate | null {
  const found = BUILTIN_TEMPLATES.find((template) => template.id === id);
  return found ? structuredClone(found) : null;
}

export function isRpaTemplateId(value: unknown): value is RpaTemplateId {
  return typeof value === "string" && BUILTIN_TEMPLATES.some((template) => template.id === value);
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export interface TemplateInputValidationResult {
  ok: true;
  inputs: Record<string, unknown>;
}

export interface TemplateInputValidationError {
  ok: false;
  errors: string[];
}

export function validateTemplateInputs(
  template: RpaTemplate,
  raw: Record<string, unknown> = {},
): TemplateInputValidationResult | TemplateInputValidationError {
  const resolved: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const field of template.inputSchema) {
    const candidate = Object.hasOwn(raw, field.key) ? raw[field.key] : field.defaultValue;
    switch (field.type) {
      case "boolean": {
        resolved[field.key] = Boolean(candidate);
        break;
      }
      case "number": {
        const numeric = typeof candidate === "number" ? candidate : Number(candidate);
        if (!Number.isFinite(numeric)) {
          errors.push(`${field.key} must be a valid number`);
          break;
        }
        if (field.min !== undefined && numeric < field.min) {
          errors.push(`${field.key} must be at least ${field.min}`);
          break;
        }
        if (field.max !== undefined && numeric > field.max) {
          errors.push(`${field.key} must be at most ${field.max}`);
          break;
        }
        resolved[field.key] = numeric;
        break;
      }
      case "url": {
        const value = typeof candidate === "string" ? candidate.trim() : "";
        if (field.required && !value) {
          errors.push(`${field.key} is required`);
        } else if (value && !isSafeHttpUrl(value)) {
          errors.push(`${field.key} must be a valid http:// or https:// URL`);
        } else {
          resolved[field.key] = value;
        }
        break;
      }
      case "url-list": {
        const list = Array.isArray(candidate)
          ? candidate.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean)
          : typeof candidate === "string"
            ? candidate.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
            : [];
        if (field.required && list.length === 0) {
          errors.push(`${field.key} requires at least one URL`);
        } else {
          const invalid = list.find((item) => !isSafeHttpUrl(item));
          if (invalid) {
            errors.push(`${field.key} contains an invalid URL: ${invalid}`);
          } else {
            resolved[field.key] = list;
          }
        }
        break;
      }
      case "string-list": {
        const list = Array.isArray(candidate)
          ? candidate.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean)
          : typeof candidate === "string"
            ? candidate.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
            : [];
        if (field.required && list.length === 0) {
          errors.push(`${field.key} requires at least one item`);
        } else {
          resolved[field.key] = list;
        }
        break;
      }
      case "select": {
        const value = typeof candidate === "string" ? candidate : "";
        const allowed = field.options?.map((option) => option.value) ?? [];
        if (allowed.length > 0 && !allowed.includes(value)) {
          errors.push(`${field.key} must be one of: ${allowed.join(", ")}`);
        } else {
          resolved[field.key] = value;
        }
        break;
      }
      case "string":
      default: {
        const value = typeof candidate === "string" ? candidate : "";
        if (field.required && !value.trim()) {
          errors.push(`${field.key} is required`);
        } else {
          resolved[field.key] = value;
        }
        break;
      }
    }
  }

  if (template.id === "cookie-warmup") {
    const min = Number(resolved.dwellMinSec ?? 0);
    const max = Number(resolved.dwellMaxSec ?? 0);
    if (Number.isFinite(min) && Number.isFinite(max) && max < min) {
      errors.push("dwellMaxSec must be greater than or equal to dwellMinSec");
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, inputs: resolved };
}

export function cloneTemplateToScriptInput(template: RpaTemplate, customName?: string): ScriptInput {
  return {
    name: (customName?.trim() || template.name).slice(0, 120),
    description: template.description,
    language: template.language,
    source: template.source,
  };
}
