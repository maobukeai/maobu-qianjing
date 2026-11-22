import type {
  RpaCodegenOptions,
  RpaCodegenResult,
  RpaRecordedStep,
} from "./contracts/local.ts";

const DEFAULT_MIN_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 600;

/** JSON string literal escaped safely for JS source emission (handles U+2028/U+2029). */
function jsString(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/** Single-line sanitized comment text (never allows line breaks to escape a comment). */
function safeComment(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Build a safe, deterministic JS identifier / input key from a step label or selector. */
function deriveParamName(
  step: RpaRecordedStep,
  used: Set<string>,
  fallbackPrefix: string,
): string {
  const raw = step.inputParamName || step.label || step.accessibleName || step.selector || "";
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  const base = cleaned && /^[a-z]/.test(cleaned) ? cleaned : `${fallbackPrefix}_${step.index}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) {
    suffix++;
  }
  const unique = `${base}_${suffix}`;
  used.add(unique);
  return unique;
}

/** Render a Playwright locator expression respecting stable selector priority. */
function locatorExpression(step: RpaRecordedStep): string {
  if (step.selectorStrategy === "role" && step.role) {
    if (step.accessibleName) {
      return `page.getByRole(${jsString(step.role)}, { name: ${jsString(step.accessibleName)} }).first()`;
    }
    return `page.getByRole(${jsString(step.role)}).first()`;
  }
  if (step.selectorStrategy === "text" && step.accessibleName) {
    return `page.getByText(${jsString(step.accessibleName)}, { exact: true }).first()`;
  }
  const selector = step.selector || "body";
  return `page.locator(${jsString(selector)}).first()`;
}

function stepDescription(step: RpaRecordedStep, position: number): string {
  const target = step.label || step.accessibleName || step.selector || step.url || "";
  switch (step.kind) {
    case "goto":
      return `第 ${position} 步：打开页面 ${safeComment(step.url || "")}`.trim();
    case "click":
      return `第 ${position} 步：点击 ${safeComment(target || "元素")}`;
    case "fill":
      if (step.credentialRef === "password") {
        return `第 ${position} 步：填入密码凭证（脱敏占位）`;
      }
      if (step.credentialRef === "twofa") {
        return `第 ${position} 步：填入二次验证/OTP 凭证（脱敏占位）`;
      }
      return `第 ${position} 步：输入 ${safeComment(target || "文本字段")}`;
    case "select":
      return `第 ${position} 步：选择下拉项 ${safeComment(target || "选项")}`;
    case "press":
      return `第 ${position} 步：按键 ${safeComment(step.key || "Enter")}`;
  }
}

/**
 * Deterministically compiles recorded RPA actions into readable, editable ESM JavaScript
 * conforming to `agent/script-runner.mjs`.
 *
 * Security invariants:
 * - Sensitive steps (`credentialRef: "password" | "twofa"` or `masked: true`) NEVER emit
 *   plaintext literals from `step.value`, even if a caller attempts to supply one.
 * - All emitted string literals use safe JSON escaping; comments strip line terminators.
 */
export function generateRpaScript(
  steps: readonly RpaRecordedStep[],
  options: RpaCodegenOptions = {},
): RpaCodegenResult {
  const parameterize = options.parameterizeInputs === true;
  const humanDelay = options.humanDelay === true;
  const minDelayMs = Math.max(0, Math.trunc(options.defaultMinDelayMs ?? DEFAULT_MIN_DELAY_MS));
  const maxDelayMs = Math.max(minDelayMs, Math.trunc(options.defaultMaxDelayMs ?? DEFAULT_MAX_DELAY_MS));

  const suggestedInputs: Record<string, unknown> = {};
  const usedParamNames = new Set<string>(["minDelayMs", "maxDelayMs", "password", "twofa"]);
  let usesCredentials = false;

  const lines: string[] = [];
  const headerName = options.scriptName?.trim()
    ? ` — ${safeComment(options.scriptName)}`
    : "";
  lines.push(`// 由 猫步·千境 RPA 录制器自动生成${headerName}`);
  lines.push(`// 共 ${steps.length} 个步骤；可在线编辑并直接在多环境中并发运行。`);
  lines.push(`export default async ({ page, inputs, credentials, log, step }) => {`);

  if (humanDelay) {
    suggestedInputs.minDelayMs = minDelayMs;
    suggestedInputs.maxDelayMs = maxDelayMs;
    lines.push(`  const minDelayMs = Math.max(0, Number(inputs?.minDelayMs ?? ${minDelayMs}));`);
    lines.push(`  const maxDelayMs = Math.max(minDelayMs, Number(inputs?.maxDelayMs ?? ${maxDelayMs}));`);
    lines.push(`  const humanPause = async () => {`);
    lines.push(`    const waitMs = minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));`);
    lines.push(`    if (waitMs > 0) await page.waitForTimeout(waitMs);`);
    lines.push(`  };`);
    lines.push("");
  }

  if (steps.length === 0) {
    lines.push(`  log("No recorded steps yet.");`);
    lines.push(`};`);
    return {
      language: "javascript",
      source: `${lines.join("\n")}\n`,
      suggestedInputs,
      usesCredentials,
      stepCount: 0,
    };
  }

  for (let i = 0; i < steps.length; i++) {
    const current = steps[i]!;
    const position = i + 1;
    const title = stepDescription(current, position);
    lines.push(`  // ${safeComment(title)}`);
    lines.push(`  await step(${jsString(title)}, async () => {`);

    switch (current.kind) {
      case "goto": {
        const rawUrl = typeof current.url === "string" ? current.url : "about:blank";
        if (parameterize) {
          const key = deriveParamName(current, usedParamNames, "url");
          suggestedInputs[key] = rawUrl;
          lines.push(`    const targetUrl = String(inputs?.[${jsString(key)}] ?? ${jsString(rawUrl)});`);
          lines.push(`    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });`);
        } else {
          lines.push(`    await page.goto(${jsString(rawUrl)}, { waitUntil: "domcontentloaded", timeout: 30_000 });`);
        }
        break;
      }
      case "click": {
        const locator = locatorExpression(current);
        lines.push(`    await ${locator}.click();`);
        break;
      }
      case "fill": {
        const locator = locatorExpression(current);
        if (current.credentialRef === "password" || (current.masked && current.credentialRef !== "twofa")) {
          usesCredentials = true;
          lines.push(`    const secretValue = credentials?.password ?? inputs?.password ?? "";`);
          lines.push(`    await ${locator}.fill(String(secretValue));`);
        } else if (current.credentialRef === "twofa") {
          usesCredentials = true;
          lines.push(`    const codeValue = credentials?.twofa ?? inputs?.twofa ?? "";`);
          lines.push(`    await ${locator}.fill(String(codeValue));`);
        } else {
          const literal = typeof current.value === "string" ? current.value : "";
          if (parameterize) {
            const key = deriveParamName(current, usedParamNames, "input");
            suggestedInputs[key] = literal;
            lines.push(`    const value = String(inputs?.[${jsString(key)}] ?? ${jsString(literal)});`);
            lines.push(`    await ${locator}.fill(value);`);
          } else {
            lines.push(`    await ${locator}.fill(${jsString(literal)});`);
          }
        }
        break;
      }
      case "select": {
        const locator = locatorExpression(current);
        const optionValue = typeof current.value === "string" ? current.value : "";
        if (parameterize) {
          const key = deriveParamName(current, usedParamNames, "select");
          suggestedInputs[key] = optionValue;
          lines.push(`    const selected = String(inputs?.[${jsString(key)}] ?? ${jsString(optionValue)});`);
          lines.push(`    await ${locator}.selectOption(selected);`);
        } else {
          lines.push(`    await ${locator}.selectOption(${jsString(optionValue)});`);
        }
        break;
      }
      case "press": {
        const keyName = typeof current.key === "string" && current.key ? current.key : "Enter";
        if (current.selector || current.role || current.accessibleName) {
          const locator = locatorExpression(current);
          lines.push(`    await ${locator}.press(${jsString(keyName)});`);
        } else {
          lines.push(`    await page.keyboard.press(${jsString(keyName)});`);
        }
        break;
      }
    }

    lines.push(`  });`);
    if (humanDelay && i < steps.length - 1) {
      lines.push(`  await humanPause();`);
    }
    if (i < steps.length - 1) {
      lines.push("");
    }
  }

  lines.push(`};`);

  return {
    language: "javascript",
    source: `${lines.join("\n")}\n`,
    suggestedInputs,
    usesCredentials,
    stepCount: steps.length,
  };
}
