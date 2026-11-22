import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DEBOUNCE_MS = 400;
const ALLOWED_PRESS_KEYS = new Set(["Enter", "Escape", "Tab"]);

/** Escape a string for safe inclusion inside CSS attribute value `[attr="..."]`. */
export function cssAttrEscape(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

/** Escape a CSS identifier (used for `#id` and class selectors). */
export function cssIdentEscape(value) {
  return String(value ?? "").replace(/([^\w-])/g, "\\$1");
}

/**
 * Determine whether an HTML `#id` looks stable rather than auto-generated/random.
 * Rejects leading digits, long digit runs (>=4), UUID/hex hashes, and framework generated ids.
 */
export function isStableId(id) {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  if (!trimmed || trimmed.length > 80) return false;
  if (/^\d/.test(trimmed)) return false;
  if (/^:r[0-9a-z]+:$/i.test(trimmed)) return false;
  if (/^(?:react|radix|mui|ember|headlessui|el-id|rc_select)[-_:]?[0-9a-z-]*\d/i.test(trimmed)) return false;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(trimmed)) return false;
  if (/\d{4,}/.test(trimmed)) return false;
  if (/(?:^|[-_])[0-9a-f]{7,}(?:$|[-_])/i.test(trimmed) && /\d/.test(trimmed)) return false;
  return true;
}

/**
 * Classify sensitive form fields so plaintext secrets NEVER leave the page or touch disk.
 * Matches:
 * - `type="password"`
 * - `autocomplete` containing `password`, `one-time-code`, `cc-number`, `cc-csc`
 */
export function classifySensitiveField(meta) {
  if (!meta || typeof meta !== "object") return null;
  const type = String(meta.inputType ?? meta.type ?? "").trim().toLowerCase();
  const autocomplete = String(meta.autocomplete ?? "").trim().toLowerCase();
  const tokens = autocomplete.split(/\s+/).filter(Boolean);

  if (tokens.some((tok) => tok === "one-time-code" || tok.includes("one-time-code"))) {
    return { credentialRef: "twofa", masked: true };
  }
  if (type === "password") {
    return { credentialRef: "password", masked: true };
  }
  if (
    tokens.some((tok) => tok.includes("password") || tok.includes("cc-number") || tok.includes("cc-csc"))
    || autocomplete.includes("password")
    || autocomplete.includes("one-time-code")
    || autocomplete.includes("cc-number")
  ) {
    if (autocomplete.includes("one-time-code")) {
      return { credentialRef: "twofa", masked: true };
    }
    return { credentialRef: "password", masked: true };
  }
  return null;
}

/**
 * Choose the highest-priority stable selector from extracted DOM element metadata:
 * 1. `[data-testid]`
 * 2. Stable `#id`
 * 3. `getByRole` / `[aria-label]` / `[name]` / `[placeholder]`
 * 4. Unique button/link text
 * 5. Bounded CSS path (`<= 4` levels)
 */
export function selectStableLocator(meta) {
  const tag = String(meta?.tagName ?? "div").toLowerCase();
  const testId = typeof meta?.testId === "string" ? meta.testId.trim() : "";
  if (testId) {
    return {
      selectorStrategy: "testid",
      selector: `[data-testid="${cssAttrEscape(testId)}"]`,
      label: meta.label || testId,
    };
  }

  const id = typeof meta?.id === "string" ? meta.id.trim() : "";
  if (isStableId(id)) {
    return {
      selectorStrategy: "id",
      selector: `#${cssIdentEscape(id)}`,
      label: meta.label || id,
    };
  }

  const role = typeof meta?.role === "string" ? meta.role.trim().toLowerCase() : "";
  const accessibleName = typeof meta?.accessibleName === "string" ? meta.accessibleName.trim().slice(0, 60) : "";
  if (role && accessibleName) {
    return {
      selectorStrategy: "role",
      role,
      accessibleName,
      selector: meta.ariaLabel
        ? `[aria-label="${cssAttrEscape(meta.ariaLabel)}"]`
        : meta.cssPath || tag,
      label: meta.label || accessibleName,
    };
  }

  const ariaLabel = typeof meta?.ariaLabel === "string" ? meta.ariaLabel.trim() : "";
  if (ariaLabel) {
    return {
      selectorStrategy: "aria-label",
      selector: `[aria-label="${cssAttrEscape(ariaLabel)}"]`,
      label: meta.label || ariaLabel,
    };
  }

  const name = typeof meta?.name === "string" ? meta.name.trim() : "";
  if (name && ["input", "select", "textarea", "button"].includes(tag)) {
    return {
      selectorStrategy: "name",
      selector: `${tag}[name="${cssAttrEscape(name)}"]`,
      label: meta.label || name,
    };
  }

  const placeholder = typeof meta?.placeholder === "string" ? meta.placeholder.trim() : "";
  if (placeholder && ["input", "textarea"].includes(tag)) {
    return {
      selectorStrategy: "placeholder",
      selector: `${tag}[placeholder="${cssAttrEscape(placeholder)}"]`,
      label: meta.label || placeholder,
    };
  }

  const uniqueText = meta?.uniqueText === true && typeof meta?.text === "string"
    ? meta.text.trim().slice(0, 60)
    : "";
  if (uniqueText && (tag === "button" || tag === "a" || role === "button" || role === "link")) {
    return {
      selectorStrategy: "text",
      accessibleName: uniqueText,
      selector: `${tag}:has-text("${cssAttrEscape(uniqueText)}")`,
      label: meta.label || uniqueText,
    };
  }

  const bounded = boundCssPath(typeof meta?.cssPath === "string" && meta.cssPath.trim() ? meta.cssPath.trim() : tag, 4);
  return {
    selectorStrategy: "css",
    selector: bounded,
    label: meta?.label || accessibleName || bounded,
  };
}

/** Cap a `>`-delimited CSS path to at most `maxDepth` (default 4) levels. */
export function boundCssPath(path, maxDepth = 4) {
  const parts = String(path ?? "")
    .split(">")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (parts.length === 0) return "body";
  return parts.slice(-Math.max(1, maxDepth)).join(" > ");
}

/** Redact Firefox private Playwright endpoint strings from errors. */
export function redactRecorderError(error, config) {
  const text = error instanceof Error ? (error.message || String(error)) : String(error);
  if (config?.engine === "firefox" && typeof config.endpoint === "string" && config.endpoint) {
    return text.replaceAll(config.endpoint, "private Firefox endpoint");
  }
  return text;
}

/** Normalize a raw browser event into a safe recorded step payload (never retaining sensitive plaintext). */
export function normalizeRecordedRawEvent(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind;
  const timestamp = Number.isFinite(raw.timestamp) ? Number(raw.timestamp) : Date.now();
  const id = `step-${index}`;

  if (kind === "goto") {
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) return null;
    return { id, index, kind: "goto", timestamp, url, label: url };
  }

  if (kind !== "click" && kind !== "fill" && kind !== "select" && kind !== "press") {
    return null;
  }

  if (kind === "press") {
    const key = typeof raw.key === "string" ? raw.key : "";
    if (!ALLOWED_PRESS_KEYS.has(key)) return null;
    const locator = raw.target ? selectStableLocator(raw.target) : null;
    return {
      id,
      index,
      kind: "press",
      timestamp,
      key,
      ...(locator ? {
        selector: locator.selector,
        selectorStrategy: locator.selectorStrategy,
        ...(locator.role ? { role: locator.role } : {}),
        ...(locator.accessibleName ? { accessibleName: locator.accessibleName } : {}),
        label: locator.label,
      } : { label: key }),
      ...(raw.target?.tagName ? { tagName: String(raw.target.tagName).toLowerCase() } : {}),
    };
  }

  const locator = selectStableLocator(raw.target ?? {});
  const base = {
    id,
    index,
    kind,
    timestamp,
    selector: locator.selector,
    selectorStrategy: locator.selectorStrategy,
    ...(locator.role ? { role: locator.role } : {}),
    ...(locator.accessibleName ? { accessibleName: locator.accessibleName } : {}),
    ...(locator.label ? { label: String(locator.label).slice(0, 120) } : {}),
    ...(raw.target?.tagName ? { tagName: String(raw.target.tagName).toLowerCase() } : {}),
  };

  if (kind === "fill") {
    const sensitive = raw.credentialRef === "password" || raw.credentialRef === "twofa"
      ? { credentialRef: raw.credentialRef, masked: true }
      : classifySensitiveField(raw.target);
    if (sensitive) {
      // Security invariant: NEVER keep plaintext `value` for sensitive fields.
      return {
        ...base,
        credentialRef: sensitive.credentialRef,
        masked: true,
      };
    }
    return {
      ...base,
      value: typeof raw.value === "string" ? raw.value.slice(0, 4000) : "",
    };
  }

  if (kind === "select") {
    return {
      ...base,
      value: typeof raw.value === "string" ? raw.value.slice(0, 1000) : "",
    };
  }

  return base;
}

/**
 * 400ms fill debouncer: merges consecutive `fill` events targeting the same selector
 * into one step, flushing immediately when a different target/action arrives or on stop.
 */
export function createStepAggregator(onStep, options = {}) {
  const debounceMs = Math.max(0, Number(options.debounceMs ?? DEFAULT_DEBOUNCE_MS));
  let counter = 0;
  let lastGotoUrl = null;
  let pendingFill = null;
  let pendingTimer = null;

  const targetKey = (raw) => {
    const loc = selectStableLocator(raw.target ?? {});
    return `${loc.selectorStrategy}:${loc.role ?? ""}:${loc.accessibleName ?? ""}:${loc.selector ?? ""}`;
  };

  const emitRaw = (raw) => {
    if (raw.kind === "goto") {
      if (raw.url === lastGotoUrl) return;
      lastGotoUrl = raw.url;
    }
    const step = normalizeRecordedRawEvent(raw, counter + 1);
    if (!step) return;
    counter += 1;
    onStep(step);
  };

  const flush = () => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (pendingFill) {
      const latest = pendingFill.raw;
      pendingFill = null;
      emitRaw(latest);
    }
  };

  const push = (raw) => {
    if (!raw || typeof raw !== "object") return;
    if (raw.kind === "fill") {
      const key = targetKey(raw);
      if (pendingFill && pendingFill.key !== key) {
        flush();
      }
      pendingFill = { key, raw };
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      if (debounceMs === 0) {
        flush();
      } else {
        pendingTimer = setTimeout(flush, debounceMs);
      }
      return;
    }
    flush();
    emitRaw(raw);
  };

  return { push, flush };
}

/**
 * Browser-side injected script. Runs inside every page in the recorded BrowserContext.
 * Sensitive field values are stripped INSIDE the page before calling `__maobuRecordEvent`.
 */
export const INJECTED_RECORDER_SCRIPT = `(() => {
  if (window.__maobuRecorderInstalled) return;
  window.__maobuRecorderInstalled = true;

  const ALLOWED_KEYS = new Set(["Enter", "Escape", "Tab"]);

  function isStableIdBrowser(id) {
    if (!id || id.length > 80) return false;
    if (/^\\d/.test(id)) return false;
    if (/^:r[0-9a-z]+:$/i.test(id)) return false;
    if (/^(?:react|radix|mui|ember|headlessui|el-id|rc_select)[-_:]?[0-9a-z-]*\\d/i.test(id)) return false;
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(id)) return false;
    if (/\\d{4,}/.test(id)) return false;
    if (/(?:^|[-_])[0-9a-f]{7,}(?:$|[-_])/i.test(id) && /\\d/.test(id)) return false;
    return true;
  }

  function cssEscape(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    return String(value).replace(/([^\\w-])/g, "\\\\$1");
  }

  function computeBoundedCssPath(el) {
    const parts = [];
    let current = el;
    while (current && current.nodeType === 1 && parts.length < 4) {
      const tag = current.tagName.toLowerCase();
      if (tag === "html" || tag === "body") {
        parts.unshift(tag);
        break;
      }
      const testId = current.getAttribute("data-testid");
      if (testId) {
        parts.unshift('[data-testid="' + testId.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"') + '"]');
        break;
      }
      if (current.id && isStableIdBrowser(current.id)) {
        parts.unshift("#" + cssEscape(current.id));
        break;
      }
      let segment = tag;
      const parent = current.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (sameTagSiblings.length > 1) {
          const nth = sameTagSiblings.indexOf(current) + 1;
          segment += ":nth-of-type(" + nth + ")";
        }
      }
      parts.unshift(segment);
      current = parent;
    }
    return parts.slice(-4).join(" > ") || "body";
  }

  function implicitRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      return "textbox";
    }
    return "";
  }

  function labelForControl(el) {
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    if (el.id) {
      const linked = document.querySelector('label[for="' + el.id.replace(/"/g, '\\\\"') + '"]');
      if (linked && linked.textContent) return linked.textContent.trim().replace(/\\s+/g, " ").slice(0, 60);
    }
    const parentLabel = el.closest("label");
    if (parentLabel && parentLabel.textContent) {
      return parentLabel.textContent.trim().replace(/\\s+/g, " ").slice(0, 60);
    }
    return (el.getAttribute("placeholder") || el.getAttribute("name") || "").trim().slice(0, 60);
  }

  function isUniqueInteractiveText(el, text) {
    if (!text || text.length > 60) return false;
    const tag = el.tagName.toLowerCase();
    const candidates = document.querySelectorAll(tag === "a" || tag === "button" ? tag : "button, a, [role='button'], [role='link']");
    let matches = 0;
    for (const node of candidates) {
      const nodeText = (node.textContent || "").trim().replace(/\\s+/g, " ");
      if (nodeText === text) {
        matches++;
        if (matches > 1) return false;
      }
    }
    return matches === 1;
  }

  function detectSensitivity(el) {
    const inputType = (el.getAttribute("type") || "").trim().toLowerCase();
    const ac = (el.getAttribute("autocomplete") || "").trim().toLowerCase();
    if (ac.includes("one-time-code")) return "twofa";
    if (inputType === "password") return "password";
    if (ac.includes("password") || ac.includes("cc-number") || ac.includes("cc-csc")) return "password";
    return null;
  }

  function extractTargetMeta(el) {
    const tagName = el.tagName.toLowerCase();
    const text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 60);
    const ariaLabel = (el.getAttribute("aria-label") || "").trim();
    const role = implicitRole(el);
    const label = labelForControl(el) || text;
    const accessibleName = ariaLabel
      || (tagName === "button" || tagName === "a" || role === "button" || role === "link" ? text : label);
    return {
      tagName,
      testId: (el.getAttribute("data-testid") || "").trim(),
      id: (el.id || "").trim(),
      role,
      ariaLabel,
      accessibleName: (accessibleName || "").slice(0, 60),
      name: (el.getAttribute("name") || "").trim(),
      placeholder: (el.getAttribute("placeholder") || "").trim(),
      inputType: (el.getAttribute("type") || "").trim().toLowerCase(),
      autocomplete: (el.getAttribute("autocomplete") || "").trim().toLowerCase(),
      text,
      uniqueText: isUniqueInteractiveText(el, text),
      label: (label || "").slice(0, 80),
      cssPath: computeBoundedCssPath(el),
    };
  }

  function emit(payload) {
    try {
      if (typeof window.__maobuRecordEvent === "function") {
        void window.__maobuRecordEvent(payload);
      }
    } catch {}
  }

  function clickableTarget(node) {
    if (!(node instanceof Element)) return null;
    return node.closest("button, a[href], [role='button'], [role='link'], [role='tab'], [role='menuitem'], input[type='checkbox'], input[type='radio'], input[type='submit'], input[type='button']") || node;
  }

  document.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    const target = clickableTarget(event.target);
    if (!target) return;
    const tag = target.tagName.toLowerCase();
    if (tag === "select" || tag === "option") return;
    if (tag === "textarea") return;
    if (tag === "input") {
      const t = (target.getAttribute("type") || "text").toLowerCase();
      if (!["checkbox", "radio", "submit", "button", "reset"].includes(t)) return;
    }
    emit({ kind: "click", timestamp: Date.now(), target: extractTargetMeta(target) });
  }, true);

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    const tag = target.tagName.toLowerCase();
    if (tag === "input") {
      const t = (target.getAttribute("type") || "text").toLowerCase();
      if (["checkbox", "radio", "submit", "button", "reset", "file"].includes(t)) return;
    }
    const credentialRef = detectSensitivity(target);
    if (credentialRef) {
      // NEVER transmit plaintext secret over binding!
      emit({
        kind: "fill",
        timestamp: Date.now(),
        target: extractTargetMeta(target),
        credentialRef,
        masked: true,
      });
      return;
    }
    emit({
      kind: "fill",
      timestamp: Date.now(),
      target: extractTargetMeta(target),
      value: String(target.value ?? ""),
    });
  }, true);

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    emit({
      kind: "select",
      timestamp: Date.now(),
      target: extractTargetMeta(target),
      value: String(target.value ?? ""),
    });
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.isComposing || event.keyCode === 229) return;
    if (!ALLOWED_KEYS.has(event.key)) return;
    const target = event.target instanceof Element ? extractTargetMeta(event.target) : null;
    emit({ kind: "press", timestamp: Date.now(), key: event.key, target });
  }, true);
})();`;

function emitLine(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function readConfigAndWatchStdin(onStop) {
  process.stdin.setEncoding("utf8");
  let firstLineResolved = false;
  let buffer = "";

  return new Promise((resolve, reject) => {
    const handleLine = (line) => {
      const trimmed = line.replace(/\r$/, "").trim();
      if (!trimmed) return;
      if (!firstLineResolved) {
        firstLineResolved = true;
        try {
          resolve(JSON.parse(trimmed));
        } catch {
          reject(new Error("recorder config is invalid JSON"));
        }
        return;
      }
      try {
        const message = JSON.parse(trimmed);
        if (message?.cmd === "stop") {
          void onStop("command");
        }
      } catch {
        // Ignore malformed control messages.
      }
    };

    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    });

    process.stdin.once("end", () => {
      if (!firstLineResolved) {
        reject(new Error("recorder input is missing"));
        return;
      }
      void onStop("eof");
    });

    process.stdin.resume();
  });
}

async function runRecorderProcess() {
  const { chromium, firefox } = await import("playwright-core");
  let browser;
  let config;
  let aggregator;
  let stopping = false;

  const stopRecorder = async (reason) => {
    if (stopping) return;
    stopping = true;
    try {
      aggregator?.flush();
    } catch {}
    try {
      await browser?.close().catch(() => {});
    } catch {}
    if (reason === "command") {
      emitLine({ type: "stopped" });
      process.stdin.pause();
      process.exit(0);
    } else {
      // Parent died / closed stdin: exit non-zero cleanly without hanging.
      process.exit(1);
    }
  };

  try {
    config = await readConfigAndWatchStdin(stopRecorder);
    if (typeof config?.endpoint !== "string" || !config.endpoint) {
      throw new Error("recorder endpoint is missing");
    }
    if (config.endpoint.startsWith("firefox://")) {
      throw new Error("Firefox recorder requires a private Playwright endpoint");
    }
    if (config.engine !== undefined && config.engine !== "chromium" && config.engine !== "firefox") {
      throw new Error("recorder engine is invalid");
    }

    aggregator = createStepAggregator(
      (step) => emitLine({ type: "step", step }),
      { debounceMs: Number.isFinite(config.debounceMs) ? Number(config.debounceMs) : DEFAULT_DEBOUNCE_MS },
    );

    browser = config.engine === "firefox"
      ? await firefox.connect(config.endpoint, { timeout: 30_000 })
      : await chromium.connectOverCDP(config.endpoint, { timeout: 30_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("猫步·千境 browser context is unavailable");

    await context.exposeBinding("__maobuRecordEvent", (_source, payload) => {
      if (!stopping) aggregator.push(payload);
    });
    await context.addInitScript(INJECTED_RECORDER_SCRIPT);

    const attachedPages = new WeakSet();
    const attachPage = async (targetPage) => {
      if (!targetPage || attachedPages.has(targetPage)) return;
      attachedPages.add(targetPage);
      if (typeof targetPage.on === "function") {
        targetPage.on("framenavigated", (frame) => {
          if (stopping) return;
          try {
            if (typeof targetPage.mainFrame === "function" && frame !== targetPage.mainFrame()) return;
            const url = typeof frame?.url === "function" ? frame.url() : "";
            if (/^https?:\/\//i.test(url)) {
              aggregator.push({ kind: "goto", url, timestamp: Date.now() });
            }
          } catch {}
        });
      }
      if (typeof targetPage.evaluate === "function") {
        await targetPage.evaluate(INJECTED_RECORDER_SCRIPT).catch(() => {});
      }
    };

    if (typeof context.on === "function") {
      context.on("page", (newPage) => {
        void attachPage(newPage);
      });
    }

    const existingPages = typeof context.pages === "function" ? context.pages() : [];
    for (const existing of existingPages) {
      await attachPage(existing);
    }

    const activeUrl = existingPages[0] && typeof existingPages[0].url === "function"
      ? existingPages[0].url()
      : "";
    emitLine({ type: "ready", url: activeUrl });
    if (/^https?:\/\//i.test(activeUrl)) {
      aggregator.push({ kind: "goto", url: activeUrl, timestamp: Date.now() });
    }
  } catch (error) {
    const message = redactRecorderError(error, config);
    emitLine({ type: "error", message });
    process.stderr.write(`${message}\n`);
    try {
      await browser?.close().catch(() => {});
    } catch {}
    process.exit(1);
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const selfPath = resolve(fileURLToPath(import.meta.url));
  const argPath = resolve(process.argv[1]);
  return process.platform === "win32"
    ? selfPath.toLowerCase() === argPath.toLowerCase()
    : selfPath === argPath;
}

if (isMainModule()) {
  void runRecorderProcess();
}
