import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "./i18n.tsx";
import { RosterDensityControl } from "./roster-density.tsx";

test("density radio groups and the compact selector expose the same setting name", () => {
  const html = renderToStaticMarkup(<I18nProvider><RosterDensityControl value="comfortable" onChange={() => {}} /><RosterDensityControl value="compact" variant="settings" onChange={() => {}} /></I18nProvider>);
  expect(html.match(/role="radiogroup"/g)).toHaveLength(2);
  expect(html.match(/aria-label="Environment list density"/g)).toHaveLength(3);
  expect(html).toMatch(/<select[^>]*class="select settings-compact-choice roster-density-select"[^>]*aria-label="Environment list density"/);
  expect(html.match(/aria-checked="true"/g)).toHaveLength(2);
  expect(html.match(/tabindex="0"/g)).toHaveLength(2);
  const descriptions = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((match) => match[1]);
  expect(descriptions).toHaveLength(2);
  expect(descriptions[0]).toBe(descriptions[1]);
  expect(html).toContain(`id="${descriptions[0]}"`);
});

for (const scenario of ["keyboard", "busy-disabled", "compact-css", "coarse-targets", "reduced-motion", "instance-scope"]) {
  test(`roster density: ${scenario} (isolated DOM)`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../test-fixtures/roster-density-dom.tsx"), scenario], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" }); expect(stdout).toContain("roster density fixture passed");
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 12_000);
}
