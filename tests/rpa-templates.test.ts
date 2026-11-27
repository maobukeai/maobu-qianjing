import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloneTemplateToScriptInput,
  getRpaTemplate,
  isRpaTemplateId,
  listRpaTemplates,
  validateTemplateInputs,
} from "../rpa-templates.ts";
import { ScriptLibrary } from "../scripts.ts";

test("built-in RPA template library ships all 4 offline templates with valid ESM source and schemas", () => {
  const templates = listRpaTemplates();
  expect(templates.map((item) => item.id)).toEqual([
    "cookie-warmup",
    "batch-status-check",
    "page-health-snapshot",
    "form-fill-skeleton",
  ]);

  const transpiler = new Bun.Transpiler({ loader: "js" });
  for (const template of templates) {
    expect(isRpaTemplateId(template.id)).toBe(true);
    expect(template.language).toBe("javascript");
    expect(template.inputSchema.length).toBeGreaterThan(0);
    expect(template.source).toContain("export default async");
    // Must parse cleanly as ESM JavaScript without syntax errors.
    expect(() => transpiler.transformSync(template.source)).not.toThrow();
    // Default inputs must always validate cleanly against the template schema.
    const validated = validateTemplateInputs(template, template.defaultInputs);
    expect(validated.ok).toBe(true);
  }
  expect(isRpaTemplateId("non-existent")).toBe(false);
  expect(getRpaTemplate("non-existent")).toBeNull();
});

test("page-health-snapshot is strictly passive and never attempts challenge bypass", () => {
  const template = getRpaTemplate("page-health-snapshot")!;
  expect(template.safetyNote).toContain("Passive");
  expect(template.source).not.toContain(".click(");
  expect(template.source).not.toContain("mouse.click");
  expect(template.source).toContain("signals");
});

test("form-fill-skeleton defaults to dryRun=true, requests credentials safely, and never logs passwords", () => {
  const template = getRpaTemplate("form-fill-skeleton")!;
  expect(template.useCredentialsDefault).toBe(true);
  expect(template.defaultInputs.dryRun).toBe(true);
  const dryRunField = template.inputSchema.find((f) => f.key === "dryRun");
  expect(dryRunField?.defaultValue).toBe(true);
  expect(template.source).toContain("inputs?.dryRun !== false");
  expect(template.source).toContain("form-dry-run-preview");
  expect(template.source).not.toMatch(/log\([^)]*(\$\{\s*password|\bcredentials\??\.password|,\s*password\b)/);
});

test("validateTemplateInputs rejects unsafe URL schemes, inverted ranges, and missing required values", () => {
  const warmup = getRpaTemplate("cookie-warmup")!;
  expect(validateTemplateInputs(warmup, { urls: ["file:///C:/Windows/win.ini"] })).toMatchObject({ ok: false });
  expect(validateTemplateInputs(warmup, { urls: ["javascript:alert(1)"] })).toMatchObject({ ok: false });
  expect(validateTemplateInputs(warmup, { urls: [] })).toMatchObject({ ok: false });
  expect(validateTemplateInputs(warmup, { urls: ["https://example.com"], dwellMinSec: 10, dwellMaxSec: 3 })).toMatchObject({ ok: false });

  const normalized = validateTemplateInputs(warmup, {
    urls: "https://example.com\nhttps://example.org\n",
    dwellMinSec: "2",
    dwellMaxSec: "5",
    scrollSteps: 3,
    shuffle: false,
  });
  expect(normalized).toEqual({
    ok: true,
    inputs: {
      urls: ["https://example.com", "https://example.org"],
      dwellMinSec: 2,
      dwellMaxSec: 5,
      scrollSteps: 3,
      shuffle: false,
    },
  });

  const statusCheck = getRpaTemplate("batch-status-check")!;
  expect(validateTemplateInputs(statusCheck, { targetUrl: "ftp://invalid.test" })).toMatchObject({ ok: false });
  expect(validateTemplateInputs(statusCheck, { targetUrl: "https://example.com", timeoutMs: 500 })).toMatchObject({ ok: false });
});

test("cloneTemplateToScriptInput saves cleanly into local ScriptLibrary", async () => {
  const root = mkdtempSync(join(tmpdir(), "maobu-rpa-templates-"));
  try {
    const library = new ScriptLibrary(root);
    const template = getRpaTemplate("batch-status-check")!;
    const saved = await library.save(cloneTemplateToScriptInput(template, "My Status Inspector"));
    expect(saved.name).toBe("My Status Inspector");
    expect(saved.language).toBe("javascript");
    expect(saved.source).toBe(template.source);
    expect(saved.revision).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
