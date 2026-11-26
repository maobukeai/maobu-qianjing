import * as React from "react";

const MARKDOWN_SYNTAX_RE = /(^|\n)\s*(#{1,4}\s|[-*]\s|\d+\.\s|>\s|```|---+$|\*\*\*+$)|`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*/m;

export function hasMarkdownSyntax(text: string): boolean {
  return MARKDOWN_SYNTAX_RE.test(text);
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenRe = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let lastIndex = 0;
  let part = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const key = `${keyPrefix}-i-${part++}`;
    if (match[1] !== undefined) {
      nodes.push(<code key={key} className="assistant-md-inline-code">{match[1]}</code>);
    } else if (match[2] !== undefined) {
      nodes.push(<strong key={key}>{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      nodes.push(<em key={key}>{match[3]}</em>);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes.length ? nodes : [text];
}

function renderTextBlocks(segment: string, baseKey: string): React.ReactNode[] {
  const lines = segment.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let blockIndex = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    const headingMatch = line.match(/^\s{0,3}(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const key = `${baseKey}-h-${blockIndex++}`;
      blocks.push(<h4 key={key} className="assistant-md-heading">{renderInline(headingMatch[2]!.trim(), key)}</h4>);
      i++;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={`${baseKey}-hr-${blockIndex++}`} className="assistant-md-hr" />);
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i++;
      }
      const key = `${baseKey}-q-${blockIndex++}`;
      blocks.push(
        <blockquote key={key} className="assistant-md-quote">
          {renderInline(quoteLines.join(" ").trim(), key)}
        </blockquote>,
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      const listKey = `${baseKey}-ul-${blockIndex++}`;
      blocks.push(
        <ul key={listKey} className="assistant-md-list">
          {items.map((item, idx) => <li key={`${listKey}-${idx}`}>{renderInline(item, `${listKey}-${idx}`)}</li>)}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      const listKey = `${baseKey}-ol-${blockIndex++}`;
      blocks.push(
        <ol key={listKey} className="assistant-md-list">
          {items.map((item, idx) => <li key={`${listKey}-${idx}`}>{renderInline(item, `${listKey}-${idx}`)}</li>)}
        </ol>,
      );
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s{0,3}#{1,4}\s+/.test(lines[i]!) &&
      !/^\s*(?:-{3,}|\*{3,})\s*$/.test(lines[i]!) &&
      !/^\s*>\s?/.test(lines[i]!) &&
      !/^\s*[-*]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    const paraKey = `${baseKey}-p-${blockIndex++}`;
    blocks.push(
      <p key={paraKey} className="assistant-md-p">
        {paraLines.map((paraLine, idx) => (
          <React.Fragment key={`${paraKey}-l-${idx}`}>
            {idx > 0 && <br />}
            {renderInline(paraLine, `${paraKey}-l-${idx}`)}
          </React.Fragment>
        ))}
      </p>,
    );
  }

  return blocks;
}

/** Pure, XSS-safe Markdown renderer with zero buttons/scripts/raw HTML execution. */
export function AssistantMarkdown({ content }: { content: string }) {
  if (!hasMarkdownSyntax(content)) {
    return <>{content}</>;
  }

  const normalized = content.replace(/\r\n/g, "\n");
  const fenceRe = /```([a-zA-Z0-9_-]*)[ \t]*\n([\s\S]*?)```/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let chunk = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(normalized)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(...renderTextBlocks(normalized.slice(lastIndex, match.index), `seg-${chunk++}`));
    }
    const lang = match[1]?.trim() || "";
    const code = match[2]!.replace(/\n$/, "");
    nodes.push(
      <div key={`code-${chunk++}`} className="assistant-md-code">
        {lang && <div className="assistant-md-code-lang">{lang}</div>}
        <pre><code>{code}</code></pre>
      </div>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < normalized.length) {
    nodes.push(...renderTextBlocks(normalized.slice(lastIndex), `seg-${chunk++}`));
  }

  return <div className="assistant-md-root">{nodes}</div>;
}
