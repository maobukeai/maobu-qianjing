import { expect, test } from "bun:test";
import type { RpaRecordedStep } from "../contracts/local.ts";
import { generateRpaScript } from "../src/rpa-codegen.ts";

const sampleSteps: RpaRecordedStep[] = [
  { id: "step-1", index: 1, kind: "goto", timestamp: 1000, url: "https://example.com/login" },
  {
    id: "step-2",
    index: 2,
    kind: "fill",
    timestamp: 1100,
    selector: '[data-testid="email-input"]',
    selectorStrategy: "testid",
    label: "Email",
    value: "alice@example.com",
  },
  {
    id: "step-3",
    index: 3,
    kind: "fill",
    timestamp: 1200,
    selector: 'input[name="password"]',
    selectorStrategy: "name",
    label: "Password",
    credentialRef: "password",
    masked: true,
    // Even if a rogue caller injects plaintext, codegen MUST ignore it!
    value: "NEVER_EMIT_THIS_PASSWORD",
  },
  {
    id: "step-4",
    index: 4,
    kind: "fill",
    timestamp: 1250,
    selector: 'input[autocomplete="one-time-code"]',
    selectorStrategy: "css",
    label: "OTP",
    credentialRef: "twofa",
    masked: true,
    value: "998877",
  },
  {
    id: "step-5",
    index: 5,
    kind: "select",
    timestamp: 1300,
    selector: "#region",
    selectorStrategy: "id",
    label: "Region",
    value: "us-west",
  },
  {
    id: "step-6",
    index: 6,
    kind: "click",
    timestamp: 1400,
    selectorStrategy: "role",
    role: "button",
    accessibleName: "Sign in",
    selector: 'button[type="submit"]',
    label: "Sign in",
  },
  {
    id: "step-7",
    index: 7,
    kind: "press",
    timestamp: 1500,
    key: "Enter",
    selectorStrategy: "text",
    accessibleName: "Continue",
    selector: 'button:has-text("Continue")',
  },
];

test("generateRpaScript produces deterministic, valid ESM matching script-runner.mjs contract", () => {
  const first = generateRpaScript(sampleSteps, { scriptName: "Login Flow" });
  const second = generateRpaScript(sampleSteps, { scriptName: "Login Flow" });
  expect(first).toEqual(second);
  expect(first.language).toBe("javascript");
  expect(first.stepCount).toBe(7);
  expect(first.usesCredentials).toBe(true);

  const transpiler = new Bun.Transpiler({ loader: "js" });
  expect(() => transpiler.transformSync(first.source)).not.toThrow();

  expect(first.source).toContain("export default async ({ page, inputs, credentials, log, step }) =>");
  expect(first.source).toContain('await page.goto("https://example.com/login"');
  expect(first.source).toContain('page.locator("[data-testid=\\"email-input\\"]").first().fill("alice@example.com")');
  expect(first.source).toContain('credentials?.password ?? inputs?.password ?? ""');
  expect(first.source).toContain('credentials?.twofa ?? inputs?.twofa ?? ""');
  expect(first.source).toContain('page.locator("#region").first().selectOption("us-west")');
  expect(first.source).toContain('page.getByRole("button", { name: "Sign in" }).first().click()');
  expect(first.source).toContain('page.getByText("Continue", { exact: true }).first().press("Enter")');

  // Security invariant: sensitive values must NEVER leak into source or suggestedInputs.
  expect(first.source).not.toContain("NEVER_EMIT_THIS_PASSWORD");
  expect(first.source).not.toContain("998877");
  expect(JSON.stringify(first.suggestedInputs)).not.toContain("NEVER_EMIT_THIS_PASSWORD");
  expect(JSON.stringify(first.suggestedInputs)).not.toContain("998877");
});

test("parameterizeInputs and humanDelay generate configurable inputs safely", () => {
  const result = generateRpaScript(sampleSteps, {
    parameterizeInputs: true,
    humanDelay: true,
    defaultMinDelayMs: 250,
    defaultMaxDelayMs: 750,
  });

  const transpiler = new Bun.Transpiler({ loader: "js" });
  expect(() => transpiler.transformSync(result.source)).not.toThrow();

  expect(result.suggestedInputs.minDelayMs).toBe(250);
  expect(result.suggestedInputs.maxDelayMs).toBe(750);
  expect(result.suggestedInputs.email).toBe("alice@example.com");
  expect(result.suggestedInputs.region).toBe("us-west");
  expect(Object.values(result.suggestedInputs)).not.toContain("NEVER_EMIT_THIS_PASSWORD");
  expect(Object.values(result.suggestedInputs)).not.toContain("998877");
  expect(result.source).toContain("const humanPause = async () =>");
  expect(result.source).toContain("await humanPause();");
});

test("malicious labels, selectors, and line separators cannot inject code into generated scripts", () => {
  const hostile: RpaRecordedStep[] = [
    {
      id: "step-1",
      index: 1,
      kind: "click",
      timestamp: 1000,
      selectorStrategy: "css",
      selector: 'div[title="x"]\nprocess.exit(99);//',
      label: "Evil\nprocess.exit(99);\u2028alert(1)",
    },
    {
      id: "step-2",
      index: 2,
      kind: "fill",
      timestamp: 1001,
      selectorStrategy: "id",
      selector: "#q",
      value: 'hello"; process.exit(99); //\u2029',
    },
  ];
  const result = generateRpaScript(hostile, { scriptName: "Bad\nName" });
  const transpiler = new Bun.Transpiler({ loader: "js" });
  expect(() => transpiler.transformSync(result.source)).not.toThrow();
  // Line comments must never split onto a new executable line.
  const commentLines = result.source.split("\n").filter((line) => line.trim().startsWith("//"));
  expect(commentLines.every((line) => !line.includes("\u2028") && !line.includes("\u2029"))).toBe(true);
});

test("empty step list generates a valid no-op script", () => {
  const result = generateRpaScript([]);
  expect(result.stepCount).toBe(0);
  expect(result.usesCredentials).toBe(false);
  const transpiler = new Bun.Transpiler({ loader: "js" });
  expect(() => transpiler.transformSync(result.source)).not.toThrow();
});
