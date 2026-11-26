/** Real React UI checks on synthetic SQLite data; no engine or user-profile access. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createUiQaFixture } from "./preview-airy-ui.ts";
const rowsIndex = process.argv.indexOf("--rows");
const fixture = await createUiQaFixture(rowsIndex < 0 ? 65 : Number(process.argv[rowsIndex + 1]), { frameless: true, fingerprintEvidence: true });
const output = join(fixture.root, "ui-upgrade");
mkdirSync(output, { recursive: true });
console.log(`UI QA output: ${output}`);
try {
  const child = Bun.spawn(["node", resolve(import.meta.dir, "qa-ui-upgrade-browser.mjs"), fixture.url, output, String(fixture.rows)], { stdout: "inherit", stderr: "inherit" });
  const timeout = setTimeout(() => child.kill(), 180_000);
  try { assert.equal(await child.exited, 0, "Browser UI regression must pass"); }
  finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); }
} finally { await fixture.close(); }
