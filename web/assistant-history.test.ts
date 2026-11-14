import { expect, test } from "bun:test";
import { assistantHistory, type AssistantHistoryMessage } from "./assistant-history.ts";
const size = (value: string) => new TextEncoder().encode(value).length;
test("a normal conversation preserves the latest complete exchanges and user prompt", () => {
  expect(assistantHistory([{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }], "next")).toEqual({ messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }, { role: "user", content: "next" }], shortened: false });
});
test("long multilingual replies can be reused without breaking UTF-8 or message limits", () => {
  const result = assistantHistory([{ role: "user", content: "first" }, { role: "assistant", content: "指纹😀".repeat(6000) }], "continue");
  expect(result.shortened).toBe(true); expect(result.messages).toHaveLength(3);
  expect(result.messages.every(item => size(item.content) <= 8192)).toBe(true);
  expect(result.messages[1]?.content).not.toContain("�"); expect(result.messages[1]?.content).toContain("Earlier message excerpt");
});
test("the total context budget drops older exchanges while preserving the newest one", () => {
  const history: AssistantHistoryMessage[] = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `${index}-` + "x".repeat(8000) }));
  const result = assistantHistory(history, "new question");
  expect(result.shortened).toBe(true); expect(result.messages[0]?.role).toBe("user"); expect(result.messages.at(-1)?.content).toBe("new question");
  expect(result.messages.at(-2)?.content.startsWith("19-")).toBe(true);
  expect(result.messages.reduce((sum, item) => sum + size(item.content), 0)).toBeLessThanOrEqual(48 * 1024);
});
test("message count stays bounded and malformed old history cannot create a dangling assistant turn", () => {
  const history: AssistantHistoryMessage[] = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: String(index) }));
  const result = assistantHistory(history, "now"); expect(result.messages.length).toBeLessThanOrEqual(23); expect(result.shortened).toBe(true);
  const broken = assistantHistory([{ role: "assistant", content: "orphaned answer" }], "new question");
  expect(broken.messages).toEqual([{ role: "user", content: "new question" }]); expect(broken.shortened).toBe(true);
});
