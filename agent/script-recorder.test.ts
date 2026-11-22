import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundCssPath,
  classifySensitiveField,
  createStepAggregator,
  isStableId,
  normalizeRecordedRawEvent,
  selectStableLocator,
} from "./script-recorder.mjs";

const ROOT = import.meta.dir;
const recorderSource = join(ROOT, "script-recorder.mjs");

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "maobu-script-recorder-"));
}

function fakePlaywrightRuntime(root: string): string {
  const runner = join(root, "agent", "script-recorder.mjs");
  mkdirSync(join(root, "agent"), { recursive: true });
  cpSync(recorderSource, runner);
  const playwright = join(root, "node_modules", "playwright-core");
  mkdirSync(playwright, { recursive: true });
  writeFileSync(join(playwright, "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }));
  writeFileSync(
    join(playwright, "index.mjs"),
    `
    function makeBrowser(endpoint, engine) {
      let bindingFn = null;
      const frameListeners = [];
      let currentUrl = "https://example.test/start";
      const mainFrame = { url: () => currentUrl };
      const page = {
        url: () => currentUrl,
        mainFrame: () => mainFrame,
        on(event, fn) {
          if (event === "framenavigated") frameListeners.push(fn);
        },
        async evaluate() {
          // Simulate browser actions emitted right after attach.
          if (bindingFn && !endpoint.includes("idle-only")) {
            setTimeout(() => {
              bindingFn(null, {
                kind: "fill",
                timestamp: 1001,
                target: { tagName: "input", testId: "email", inputType: "email" },
                value: "a",
              });
              bindingFn(null, {
                kind: "fill",
                timestamp: 1010,
                target: { tagName: "input", testId: "email", inputType: "email" },
                value: "alice@example.test",
              });
              // Sensitive password field: even if a raw value were passed, Node side MUST strip it!
              bindingFn(null, {
                kind: "fill",
                timestamp: 1020,
                target: { tagName: "input", name: "pass", inputType: "password", autocomplete: "current-password" },
                value: "SUPER_SECRET_PASSWORD_999",
              });
              // Sensitive 2FA field
              bindingFn(null, {
                kind: "fill",
                timestamp: 1030,
                target: { tagName: "input", name: "code", inputType: "text", autocomplete: "one-time-code" },
                value: "654321",
              });
              bindingFn(null, {
                kind: "select",
                timestamp: 1040,
                target: { tagName: "select", id: "country" },
                value: "US",
              });
              bindingFn(null, {
                kind: "click",
                timestamp: 1050,
                target: { tagName: "button", role: "button", accessibleName: "Continue" },
              });
              bindingFn(null, {
                kind: "press",
                timestamp: 1060,
                key: "Enter",
                target: { tagName: "button", role: "button", accessibleName: "Continue" },
              });
              bindingFn(null, {
                kind: "press",
                timestamp: 1061,
                key: "a",
                target: { tagName: "input", testId: "email" },
              });
              currentUrl = "https://example.test/dashboard";
              for (const fn of frameListeners) fn(mainFrame);
            }, 10);
          }
        },
      };
      const context = {
        pages: () => [page],
        on() {},
        async exposeBinding(name, fn) {
          if (name === "__maobuRecordEvent") bindingFn = fn;
        },
        async addInitScript() {},
      };
      return {
        contexts: () => [context],
        close: async () => {},
      };
    }

    export const chromium = {
      async connectOverCDP(endpoint) {
        return makeBrowser(endpoint, "chromium");
      },
    };
    export const firefox = {
      async connect(endpoint) {
        if (endpoint.includes("fail")) throw new Error("Firefox connect boom: " + endpoint);
        return makeBrowser(endpoint, "firefox");
      },
    };
    `,
  );
  return runner;
}

test("selector priority ranks data-testid > stable #id > role/aria-label/name/placeholder > unique text > bounded css <= 4", () => {
  expect(
    selectStableLocator({
      tagName: "button",
      testId: "submit-order",
      id: "btn-main",
      role: "button",
      accessibleName: "Submit",
      cssPath: "div > form > button",
    }),
  ).toMatchObject({ selectorStrategy: "testid", selector: '[data-testid="submit-order"]' });

  expect(
    selectStableLocator({
      tagName: "input",
      id: "account-email",
      name: "email",
      placeholder: "Email",
    }),
  ).toMatchObject({ selectorStrategy: "id", selector: "#account-email" });

  // Unstable/random IDs are rejected in favor of role/aria-label/name/placeholder.
  expect(isStableId(":r0:")).toBe(false);
  expect(isStableId("mui-123456")).toBe(false);
  expect(isStableId("input-894213")).toBe(false);
  expect(isStableId("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  expect(isStableId("login-form")).toBe(true);

  expect(
    selectStableLocator({
      tagName: "button",
      id: "react-select-99123",
      role: "button",
      accessibleName: "Save changes",
    }),
  ).toMatchObject({ selectorStrategy: "role", role: "button", accessibleName: "Save changes" });

  expect(
    selectStableLocator({
      tagName: "input",
      id: "12345",
      ariaLabel: "Search workspace",
      name: "q",
    }),
  ).toMatchObject({ selectorStrategy: "aria-label", selector: '[aria-label="Search workspace"]' });

  expect(
    selectStableLocator({
      tagName: "input",
      name: "username",
      placeholder: "Enter user",
    }),
  ).toMatchObject({ selectorStrategy: "name", selector: 'input[name="username"]' });

  expect(
    selectStableLocator({
      tagName: "input",
      placeholder: "Search profiles",
    }),
  ).toMatchObject({ selectorStrategy: "placeholder", selector: 'input[placeholder="Search profiles"]' });

  expect(
    selectStableLocator({
      tagName: "a",
      text: "Billing settings",
      uniqueText: true,
    }),
  ).toMatchObject({ selectorStrategy: "text", accessibleName: "Billing settings" });

  const bounded = selectStableLocator({
    tagName: "span",
    cssPath: "body > main > section > div:nth-of-type(2) > ul > li > span",
  });
  expect(bounded.selectorStrategy).toBe("css");
  expect(bounded.selector.split(">").length).toBeLessThanOrEqual(4);
  expect(boundCssPath("a > b > c > d > e > f", 4)).toBe("c > d > e > f");
});

test("sensitive fields always mask plaintext and map to password or twofa credentialRef", () => {
  expect(classifySensitiveField({ inputType: "password" })).toEqual({ credentialRef: "password", masked: true });
  expect(classifySensitiveField({ inputType: "text", autocomplete: "current-password" })).toEqual({
    credentialRef: "password",
    masked: true,
  });
  expect(classifySensitiveField({ inputType: "text", autocomplete: "new-password" })).toEqual({
    credentialRef: "password",
    masked: true,
  });
  expect(classifySensitiveField({ inputType: "text", autocomplete: "one-time-code" })).toEqual({
    credentialRef: "twofa",
    masked: true,
  });
  expect(classifySensitiveField({ inputType: "text", autocomplete: "cc-number" })).toEqual({
    credentialRef: "password",
    masked: true,
  });
  expect(classifySensitiveField({ inputType: "email", autocomplete: "email" })).toBeNull();

  const normalized = normalizeRecordedRawEvent(
    {
      kind: "fill",
      timestamp: 1000,
      target: { tagName: "input", inputType: "password", name: "pwd" },
      value: "RAW_PLAINTEXT_SECRET",
    },
    1,
  );
  expect(normalized).toMatchObject({ kind: "fill", credentialRef: "password", masked: true });
  expect((normalized as Record<string, unknown> | null)?.value).toBeUndefined();
  expect(JSON.stringify(normalized)).not.toContain("RAW_PLAINTEXT_SECRET");
});

test("step aggregator debounces consecutive fill events on the same field and flushes on action switch", async () => {
  const captured: any[] = [];
  const agg = createStepAggregator((step: unknown) => captured.push(step), { debounceMs: 50 });

  agg.push({ kind: "fill", timestamp: 1, target: { tagName: "input", testId: "q" }, value: "h" });
  agg.push({ kind: "fill", timestamp: 2, target: { tagName: "input", testId: "q" }, value: "he" });
  agg.push({ kind: "fill", timestamp: 3, target: { tagName: "input", testId: "q" }, value: "hello" });
  expect(captured).toHaveLength(0);

  // Clicking flushes the pending fill immediately in order before emitting click.
  agg.push({ kind: "click", timestamp: 4, target: { tagName: "button", testId: "go" } });
  expect(captured).toHaveLength(2);
  expect(captured[0]).toMatchObject({ kind: "fill", value: "hello" });
  expect(captured[1]).toMatchObject({ kind: "click", selector: '[data-testid="go"]' });

  // Wait-based debounce flush for a trailing fill.
  agg.push({ kind: "fill", timestamp: 5, target: { tagName: "input", testId: "note" }, value: "final" });
  await Bun.sleep(80);
  expect(captured).toHaveLength(3);
  expect(captured[2]).toMatchObject({ kind: "fill", value: "final" });
});

test("Node script-recorder subprocess records debounced actions, masks passwords/2FA, and stops cleanly", async () => {
  const root = workspace();
  try {
    const runner = fakePlaywrightRuntime(root);
    const child = Bun.spawn(["node", runner], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(`${JSON.stringify({ endpoint: "ws://127.0.0.1:9222/devtools/browser/test", engine: "chromium", debounceMs: 30 })}\n`);
    await Bun.sleep(160);
    child.stdin.write(`${JSON.stringify({ cmd: "stop" })}\n`);

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).not.toContain("SUPER_SECRET_PASSWORD_999");
    expect(stdout).not.toContain("654321");

    const events = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: "ready" });
    expect(events.at(-1)).toEqual({ type: "stopped" });

    const steps = events.filter((e) => e.type === "step").map((e) => e.step);
    expect(steps.map((s) => s.kind)).toEqual(["goto", "fill", "fill", "fill", "select", "click", "press", "goto"]);
    expect(steps[1]).toMatchObject({ kind: "fill", selector: '[data-testid="email"]', value: "alice@example.test" });
    expect(steps[2]).toMatchObject({ kind: "fill", credentialRef: "password", masked: true });
    expect(steps[2].value).toBeUndefined();
    expect(steps[3]).toMatchObject({ kind: "fill", credentialRef: "twofa", masked: true });
    expect(steps[3].value).toBeUndefined();
    expect(steps[4]).toMatchObject({ kind: "select", selector: "#country", value: "US" });
    expect(steps[5]).toMatchObject({ kind: "click", selectorStrategy: "role", role: "button", accessibleName: "Continue" });
    expect(steps[6]).toMatchObject({ kind: "press", key: "Enter" });
    expect(steps[7]).toMatchObject({ kind: "goto", url: "https://example.test/dashboard" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Node script-recorder redacts Firefox private endpoints on error and exits on parent stdin EOF", async () => {
  const root = workspace();
  try {
    const runner = fakePlaywrightRuntime(root);

    // Firefox connect failure redacts endpoint.
    const secretEndpoint = "ws://127.0.0.1:9999/private-fail-token";
    const failing = Bun.spawn(["node", runner], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    failing.stdin.write(`${JSON.stringify({ endpoint: secretEndpoint, engine: "firefox" })}\n`);
    const [failOut, failErr, failCode] = await Promise.all([
      new Response(failing.stdout).text(),
      new Response(failing.stderr).text(),
      failing.exited,
    ]);
    expect(failCode).toBe(1);
    expect(failOut).toContain("private Firefox endpoint");
    expect(failOut).not.toContain(secretEndpoint);
    expect(failErr).not.toContain(secretEndpoint);

    // Parent death (stdin EOF) causes immediate exit.
    const eofChild = Bun.spawn(["node", runner], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    eofChild.stdin.write(`${JSON.stringify({ endpoint: "ws://127.0.0.1:9222/idle-only", engine: "chromium" })}\n`);
    await Bun.sleep(60);
    eofChild.stdin.end();
    const exitCode = await eofChild.exited;
    expect(exitCode).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
