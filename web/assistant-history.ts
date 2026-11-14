export interface AssistantHistoryMessage { role: "user" | "assistant"; content: string }
const MESSAGE_BYTES = 8192, HISTORY_BYTES = 48 * 1024;
const EXCERPT = "\n[Earlier message excerpt]";
let encoder: TextEncoder | undefined;
function encode(value: string): Uint8Array { return (encoder ??= new TextEncoder()).encode(value); }
function bounded(value: string): { content: string; shortened: boolean } {
  const bytes = encode(value);
  if (bytes.length <= MESSAGE_BYTES) return { content: value, shortened: false };
  const budget = MESSAGE_BYTES - encode(EXCERPT).length;
  // Streaming decode drops a trailing incomplete UTF-8 sequence without corrupting text.
  return { content: new TextDecoder().decode(bytes.subarray(0, budget), { stream: true }) + EXCERPT, shortened: true };
}
/** Keep recent complete exchanges within the service budget; displayed answers remain intact. */
export function assistantHistory(history: readonly AssistantHistoryMessage[], prompt: string): { messages: AssistantHistoryMessage[]; shortened: boolean } {
  const user = bounded(prompt);
  let bytes = encode(user.content).length, shortened = user.shortened;
  const messages: AssistantHistoryMessage[] = [{ role: "user", content: user.content }];
  let index = history.length - 1;
  while (index >= 1 && messages.length + 2 <= 23) {
    const answer = history[index], question = history[index - 1];
    if (answer?.role !== "assistant" || question?.role !== "user") { shortened = true; index--; continue; }
    const q = bounded(question.content), a = bounded(answer.content);
    const needed = encode(q.content).length + encode(a.content).length;
    if (bytes + needed > HISTORY_BYTES) { shortened = true; break; }
    messages.unshift({ role: "user", content: q.content }, { role: "assistant", content: a.content });
    bytes += needed; shortened ||= q.shortened || a.shortened; index -= 2;
  }
  return { messages, shortened: shortened || index >= 0 };
}
