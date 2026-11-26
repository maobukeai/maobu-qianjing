import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMarkdown, hasMarkdownSyntax } from "./assistant-markdown.tsx";

describe("AssistantMarkdown", () => {
  test("preserves plain text verbatim without wrapper elements", () => {
    const plain = "Hello world. No formatting needed here.";
    expect(hasMarkdownSyntax(plain)).toBe(false);
    expect(renderToStaticMarkup(<AssistantMarkdown content={plain} />)).toBe(plain);
  });

  test("renders headings, lists, inline code, bold text, and fenced code blocks cleanly", () => {
    const md = [
      "### Inspection steps",
      "",
      "- **Timezone**: match exit `America/New_York`",
      "- **Screen**: avoid *mobile* mismatch",
      "",
      "```ts",
      "const title = await page.title();",
      "```",
    ].join("\n");

    const html = renderToStaticMarkup(<AssistantMarkdown content={md} />);
    expect(html).toContain('<h4 class="assistant-md-heading">Inspection steps</h4>');
    expect(html).toContain('<ul class="assistant-md-list">');
    expect(html).toContain("<strong>Timezone</strong>");
    expect(html).toContain('<code class="assistant-md-inline-code">America/New_York</code>');
    expect(html).toContain("<em>mobile</em>");
    expect(html).toContain('<div class="assistant-md-code-lang">ts</div>');
    expect(html).toContain("const title = await page.title();");
  });

  test("never executes raw HTML tags or renders interactive buttons inside model text", () => {
    const unsafe = "**Note:** <script>alert(1)</script> and <button>Click</button>";
    const html = renderToStaticMarkup(<AssistantMarkdown content={unsafe} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<button");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
