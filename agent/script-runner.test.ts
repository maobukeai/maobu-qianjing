import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = import.meta.dir;
const nodeRunner = join(ROOT, "script-runner.mjs");
const pythonRunner = join(ROOT, "script-runner.py");
const pythonExecutable = process.platform === "win32" ? "python" : "python3";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "aliasmode-script-runner-"));
}

function nodeRuntime(root: string): string {
  const runner = join(root, "agent", "script-runner.mjs");
  mkdirSync(join(root, "agent"), { recursive: true });
  cpSync(nodeRunner, runner);
  const playwright = join(root, "node_modules", "playwright-core");
  mkdirSync(playwright, { recursive: true });
  writeFileSync(join(playwright, "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }));
  writeFileSync(join(playwright, "index.mjs"), `
    const chromium = {
      async connectOverCDP(endpoint) {
        process.stdout.write("connected " + endpoint + "\\n");
        return browser();
      },
    };
    const firefox = {
      async connect(endpoint) {
        if (endpoint.includes("fail")) throw new Error("Firefox endpoint failed: " + endpoint);
        process.stdout.write("firefox connected " + endpoint + "\\n");
        return browser();
      },
    };
    function browser() {
      return {
        contexts: () => [{
          pages: () => [{ kind: "first-page" }],
          newPage: async () => ({ kind: "new-page" }),
        }],
        close: async () => process.stdout.write("detached\\n"),
      };
    }
    export { chromium, firefox };
  `);
  return runner;
}

function pythonRuntime(root: string): string {
  const fake = join(root, "fake-python", "playwright");
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "__init__.py"), "");
  writeFileSync(join(fake, "async_api.py"), `
class Context:
    pages = [{"kind": "first-page"}]
    async def new_page(self):
        return {"kind": "new-page"}

class Browser:
    contexts = [Context()]
    async def close(self):
        print("detached", flush=True)

class Chromium:
    async def connect_over_cdp(self, endpoint, timeout=None):
        print(f"connected {endpoint}", flush=True)
        return Browser()

class Firefox:
    async def connect(self, endpoint, timeout=None):
        if "fail" in endpoint:
            raise RuntimeError(f"Firefox endpoint failed: {endpoint}")
        print(f"firefox connected {endpoint}", flush=True)
        return Browser()

class Playwright:
    chromium = Chromium()
    firefox = Firefox()
    async def start(self):
        return self
    async def stop(self):
        print("driver-stopped", flush=True)

def async_playwright():
    return Playwright()
`);
  return join(root, "fake-python");
}

async function output(child: ReturnType<typeof Bun.spawn>) {
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    child.exited,
  ]);
  return { stdout: stdout.replaceAll("\r\n", "\n"), stderr, code };
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
  let output = "";
  while (!output.includes(marker)) {
    const { done, value } = await reader.read();
    if (done) break;
    output = (output + new TextDecoder().decode(value)).replaceAll("\r\n", "\n");
  }
  return output;
}

const input = {
  endpoint: "ws://127.0.0.1:9222/devtools/browser/test",
  profile: { id: "profile-1", name: "Profile", group: "Group", platform: "Windows" },
  inputs: { message: "hello" },
  credentials: { username: "user" },
};

test("Node script runner passes the CDP objects and user data without a completion message", async () => {
  const root = workspace();
  try {
    const runner = nodeRuntime(root);
    const script = join(root, "script.mjs");
    writeFileSync(script, `
      export default async ({ page, profile, inputs, credentials, log }) => {
        log(profile.id, inputs.message, credentials.username, page.kind);
      };
    `);
    const child = Bun.spawn(["node", runner, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(`${JSON.stringify(input)}\n`);
    const result = await output(child);
    expect(result).toEqual({
      code: 0,
      stderr: "",
      stdout: "connected ws://127.0.0.1:9222/devtools/browser/test\nprofile-1 hello user first-page\ndetached\n",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Node script runner connects Firefox through a private Playwright endpoint", async () => {
  const root = workspace();
  try {
    const runner = nodeRuntime(root);
    const script = join(root, "script.mjs");
    writeFileSync(script, "export default async ({ log }) => log('firefox script');");
    const child = Bun.spawn(["node", runner, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(`${JSON.stringify({ ...input, endpoint: "ws://127.0.0.1:9223/private", engine: "firefox" })}\n`);
    expect(await output(child)).toEqual({
      code: 0,
      stderr: "",
      stdout: "firefox connected ws://127.0.0.1:9223/private\nfirefox script\ndetached\n",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Node script runner redacts Firefox endpoint errors", async () => {
  const root = workspace();
  try {
    const runner = nodeRuntime(root);
    const endpoint = "ws://127.0.0.1:9223/private-fail";
    const child = Bun.spawn(["node", runner, "unused.mjs"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(`${JSON.stringify({ ...input, endpoint, engine: "firefox" })}\n`);
    const result = await output(child);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("private Firefox endpoint");
    expect(result.stderr).not.toContain(endpoint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Node script runner rejects opaque Firefox locators", async () => {
  const root = workspace();
  try {
    const runner = nodeRuntime(root);
    const child = Bun.spawn(["node", runner, "unused.mjs"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write(`${JSON.stringify({ ...input, endpoint: "firefox://127.0.0.1:9000/generation" })}\n`);
    const result = await output(child);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Firefox scripts require a private Playwright endpoint");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Node script runner exits when its parent closes stdin", async () => {
  const root = workspace();
  try {
    const runner = nodeRuntime(root);
    const script = join(root, "script.mjs");
    writeFileSync(script, "export default async () => await new Promise(() => setInterval(() => {}, 1_000));");
    const child = Bun.spawn(["node", runner, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(`${JSON.stringify(input)}\n`);
    child.stdin.end();
    const result = await output(child);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A first Python start on a cold Windows runner can take longer than the 5 s default while
// antivirus scans the interpreter and the test's fresh files.
const PYTHON_TEST_TIMEOUT_MS = 30_000;

test("Python script runner passes the CDP objects and stops its driver", async () => {
  const root = workspace();
  try {
    const script = join(root, "script.py");
    writeFileSync(script, `
async def run(*, page, profile, inputs, credentials, log, **_):
    log(profile["id"], inputs["message"], credentials["username"], page["kind"])
`);
    const child = Bun.spawn([pythonExecutable, pythonRunner, script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONPATH: pythonRuntime(root) },
    });
    child.stdin.write(`${JSON.stringify(input)}\n`);
    const result = await output(child);
    expect(result).toEqual({
      code: 0,
      stderr: "",
      stdout: "connected ws://127.0.0.1:9222/devtools/browser/test\nprofile-1 hello user first-page\ndetached\ndriver-stopped\n",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, PYTHON_TEST_TIMEOUT_MS);

test("Python script runner connects Firefox through a private Playwright endpoint", async () => {
  const root = workspace();
  try {
    const script = join(root, "script.py");
    writeFileSync(script, "async def run(*, log, **_):\n    log('firefox script')\n");
    const child = Bun.spawn([pythonExecutable, pythonRunner, script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONPATH: pythonRuntime(root) },
    });
    child.stdin.write(`${JSON.stringify({ ...input, endpoint: "ws://127.0.0.1:9223/private", engine: "firefox" })}\n`);
    expect(await output(child)).toEqual({
      code: 0,
      stderr: "",
      stdout: "firefox connected ws://127.0.0.1:9223/private\nfirefox script\ndetached\ndriver-stopped\n",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, PYTHON_TEST_TIMEOUT_MS);

test("Python script runner redacts Firefox endpoint errors", async () => {
  const root = workspace();
  try {
    const endpoint = "ws://127.0.0.1:9223/private-fail";
    const child = Bun.spawn([pythonExecutable, pythonRunner, "unused.py"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONPATH: pythonRuntime(root) },
    });
    child.stdin.write(`${JSON.stringify({ ...input, endpoint, engine: "firefox" })}\n`);
    const result = await output(child);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("private Firefox endpoint");
    expect(result.stderr).not.toContain(endpoint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, PYTHON_TEST_TIMEOUT_MS);

test("Python script runner exits on parent EOF while user code blocks", async () => {
  const root = workspace();
  try {
    const script = join(root, "script.py");
    writeFileSync(script, "import time\nasync def run(*, log, **_):\n    log('blocking-ready')\n    time.sleep(60)\n");
    const child = Bun.spawn([pythonExecutable, pythonRunner, script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONPATH: pythonRuntime(root) },
    });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    child.stdin.write(`${JSON.stringify(input)}\n`);
    expect(await readUntil(reader, "blocking-ready\n")).toContain("blocking-ready\n");
    child.stdin.end();
    expect(await child.exited).toBe(1);
    expect(await stderr).toBe("");
    await reader.cancel();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, PYTHON_TEST_TIMEOUT_MS);

function nodeRuntimeWithScreenshot(root: string, screenshotBehavior = "ok"): string {
  const runner = join(root, "agent", "script-runner.mjs");
  mkdirSync(join(root, "agent"), { recursive: true });
  cpSync(nodeRunner, runner);
  const playwright = join(root, "node_modules", "playwright-core");
  mkdirSync(playwright, { recursive: true });
  writeFileSync(join(playwright, "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }));
  writeFileSync(
    join(playwright, "index.mjs"),
    `
    let browserClosed = false;
    const page = {
      kind: "shot-page",
      isClosed: () => browserClosed,
      async screenshot(opts) {
        process.stdout.write("shot:" + opts.type + ":" + opts.quality + ":closed=" + browserClosed + "\\n");
        if (${JSON.stringify(screenshotBehavior)} === "throw") {
          throw new Error("screenshot boom");
        }
        if (${JSON.stringify(screenshotBehavior)} === "oversize") {
          return Buffer.alloc(opts.quality === 75 ? 3 * 1024 * 1024 : 1024, 0xff);
        }
        return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      },
    };
    const browserObj = {
      contexts: () => [{ pages: () => [page], newPage: async () => page }],
      close: async () => { browserClosed = true; process.stdout.write("detached\\n"); },
    };
    export const chromium = { async connectOverCDP() { return browserObj; } };
    export const firefox = { async connect() { return browserObj; } };
    `,
  );
  return runner;
}

test("Node script runner records steps JSONL, caps screenshots at 5 (JPEG q=75 <= 2MiB), and retries oversize", async () => {
  const root = workspace();
  try {
    const runner = nodeRuntimeWithScreenshot(root, "oversize");
    const script = join(root, "script.mjs");
    const stepsPath = join(root, "steps.jsonl");
    const artifactsDir = join(root, "artifacts");
    writeFileSync(
      script,
      `
      export default async ({ step, screenshot }) => {
        const val = await step("First step", async () => 42);
        if (val !== 42) throw new Error("unexpected return");
        for (let i = 1; i <= 6; i++) {
          await screenshot("Capture " + i);
        }
      };
      `,
    );
    const child = Bun.spawn(["node", runner, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(`${JSON.stringify({ ...input, stepsPath, artifactsDir })}\n`);
    const result = await output(child);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    // First call at quality 75 exceeded 2 MiB and automatically retried at quality 45.
    expect(result.stdout).toContain("shot:jpeg:75:closed=false");
    expect(result.stdout).toContain("shot:jpeg:45:closed=false");

    const stepLines = (await Bun.file(stepsPath).text()).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(stepLines.at(-1)).toMatchObject({ index: 1, title: "First step", status: "succeeded" });
    expect(typeof stepLines.at(-1).durationMs).toBe("number");

    const manifestLines = (await Bun.file(join(artifactsDir, "manifest.jsonl")).text())
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(manifestLines).toHaveLength(5);
    expect(manifestLines[0].sizeBytes).toBe(1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Node script runner captures error-final.jpg before browser.close() and never masks original error if screenshot fails", async () => {
  const root = workspace();
  try {
    // 1. Succeeds capturing error-final.jpg BEFORE detached (browser.close()).
    const runner = nodeRuntimeWithScreenshot(root, "ok");
    const script = join(root, "fail.mjs");
    const stepsPath = join(root, "steps.jsonl");
    const artifactsDir = join(root, "artifacts");
    writeFileSync(
      script,
      `
      export default async ({ step }) => {
        await step("Explode", async () => { throw new Error("ORIGINAL_BOOM"); });
      };
      `,
    );
    const child = Bun.spawn(["node", runner, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(`${JSON.stringify({ ...input, stepsPath, artifactsDir })}\n`);
    const result = await output(child);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ORIGINAL_BOOM");
    expect(result.stdout).toContain("shot:jpeg:75:closed=false\ndetached\n");
    expect(await Bun.file(join(artifactsDir, "error-final.jpg")).exists()).toBe(true);
    const stepLines = (await Bun.file(stepsPath).text()).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(stepLines.at(-1)).toMatchObject({ title: "Explode", status: "failed", error: "ORIGINAL_BOOM" });

    // 2. When screenshot itself throws, original error is still preserved verbatim.
    const root2 = workspace();
    try {
      const runner2 = nodeRuntimeWithScreenshot(root2, "throw");
      const script2 = join(root2, "fail2.mjs");
      writeFileSync(script2, `export default async () => { throw new Error("REAL_ROOT_CAUSE"); };`);
      const child2 = Bun.spawn(["node", runner2, script2], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child2.stdin.write(`${JSON.stringify({ ...input, artifactsDir: join(root2, "artifacts") })}\n`);
      const res2 = await output(child2);
      expect(res2.code).toBe(1);
      expect(res2.stderr).toContain("REAL_ROOT_CAUSE");
      expect(res2.stderr).not.toContain("screenshot boom");
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Python script runner supports step(), screenshot(), auto error-final.jpg, and strict-signature scripts", async () => {
  const root = workspace();
  try {
    const fake = join(root, "fake-py-shot", "playwright");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "__init__.py"), "");
    writeFileSync(
      join(fake, "async_api.py"),
      `
class Page:
    def __init__(self, browser):
        self._browser = browser
    async def screenshot(self, type="jpeg", quality=75, timeout=5000):
        print(f"pyshot:{type}:{quality}:closed={self._browser.closed}", flush=True)
        return b"\\xff\\xd8\\xff\\xe0\\x00\\x10"

class Context:
    def __init__(self, browser):
        self.pages = [Page(browser)]
    async def new_page(self):
        return self.pages[0]

class Browser:
    def __init__(self):
        self.closed = False
        self.contexts = [Context(self)]
    async def close(self):
        self.closed = True
        print("detached", flush=True)

class Chromium:
    async def connect_over_cdp(self, endpoint, timeout=None):
        return Browser()

class Firefox:
    async def connect(self, endpoint, timeout=None):
        return Browser()

class Playwright:
    chromium = Chromium()
    firefox = Firefox()
    async def start(self):
        return self
    async def stop(self):
        pass

def async_playwright():
    return Playwright()
`,
    );

    const pyPath = join(root, "fake-py-shot");
    const stepsPath = join(root, "py-steps.jsonl");
    const artifactsDir = join(root, "py-artifacts");

    // 1. step + screenshot + auto error-final.jpg on failure.
    const script = join(root, "py_fail.py");
    writeFileSync(
      script,
      `
async def run(*, step, screenshot, **_):
    async def ok_work():
        await screenshot("before")
        return 7
    val = await step("Prepare", ok_work)
    assert val == 7
    async def boom():
        raise RuntimeError("PY_ORIGINAL_ERROR")
    await step("Fail step", boom)
`,
    );
    const child = Bun.spawn([pythonExecutable, pythonRunner, script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONPATH: pyPath },
    });
    child.stdin.write(`${JSON.stringify({ ...input, stepsPath, artifactsDir })}\n`);
    const result = await output(child);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("PY_ORIGINAL_ERROR");
    expect(result.stdout).toContain("pyshot:jpeg:75:closed=False\ndetached\n");
    expect(await Bun.file(join(artifactsDir, "error-final.jpg")).exists()).toBe(true);
    const steps = (await Bun.file(stepsPath).text()).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(steps.some((s) => s.title === "Prepare" && s.status === "succeeded")).toBe(true);
    expect(steps.some((s) => s.title === "Fail step" && s.status === "failed" && s.error === "PY_ORIGINAL_ERROR")).toBe(true);

    // 2. Legacy strict signature without **_ or step/screenshot must still execute cleanly.
    const legacy = join(root, "py_legacy.py");
    writeFileSync(
      legacy,
      `
async def run(*, browser, context, page, profile, inputs, credentials, log):
    log("legacy-ok", profile["id"])
`,
    );
    const legacyChild = Bun.spawn([pythonExecutable, pythonRunner, legacy], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONPATH: pyPath },
    });
    legacyChild.stdin.write(`${JSON.stringify(input)}\n`);
    const legacyResult = await output(legacyChild);
    expect(legacyResult.code).toBe(0);
    expect(legacyResult.stdout).toContain("legacy-ok profile-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, PYTHON_TEST_TIMEOUT_MS);
