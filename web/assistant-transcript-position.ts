import { useLayoutEffect, useRef, type UIEvent } from "react";

interface TranscriptView {
  active: boolean;
  latestMessageId: number | null;
  latestReplyId: number | null;
  sending: boolean;
  pauseFollowing?: boolean;
}

const FOLLOW_DISTANCE = 48;
const REPLY_TOP_GAP = 12;

function viewportPosition(viewport: HTMLDivElement) {
  const top = Math.max(0, viewport.scrollTop);
  return { top, following: viewport.scrollHeight - viewport.clientHeight - top <= FOLLOW_DISTANCE };
}

function revealReply(viewport: HTMLDivElement, replyId: number, focus: boolean) {
  const heading = viewport.querySelector<HTMLElement>(`[data-assistant-reply-heading="${replyId}"]`);
  if (!heading) return;
  revealElement(viewport, heading, focus);
}

function revealElement(viewport: HTMLDivElement, element: HTMLElement, focus: boolean) {
  const distance = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - viewport.clientTop;
  viewport.scrollTop = Math.max(0, viewport.scrollTop + distance - REPLY_TOP_GAP);
  if (focus) element.focus({ preventScroll: true });
}

/** This hook follows the conversation's own scroll area and never scrolls the surrounding page. */
export function useAssistantTranscriptPosition({ active, latestMessageId, latestReplyId, sending, pauseFollowing = false }: TranscriptView) {
  const viewport = useRef<HTMLDivElement>(null);
  const previous = useRef<{ active: boolean; latestMessageId: number | null; sending: boolean } | null>(null);
  const position = useRef({ top: 0, following: true });

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { active, latestMessageId, sending };
    const node = viewport.current;
    if (latestMessageId === null && !sending) {
      position.current = { top: 0, following: true };
      if (active && node) node.scrollTop = 0;
      return;
    }
    // The hidden pane can report zero dimensions. Its last visible offset and
    // the intent to follow the tail are recorded separately from those metrics.
    if (!active || !node) return;
    if (!before?.active) {
      node.scrollTop = position.current.top;
    } else if (position.current.following && !pauseFollowing) {
      const newReply = latestReplyId !== null && latestReplyId === latestMessageId && latestReplyId > (before.latestMessageId ?? 0);
      if (newReply) revealReply(node, latestReplyId, false);
      else if (sending && (!before.sending || before.latestMessageId !== latestMessageId)) node.scrollTop = node.scrollHeight;
    }
    position.current = viewportPosition(node);
  }, [active, latestMessageId, latestReplyId, sending, pauseFollowing]);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    if (active) position.current = viewportPosition(event.currentTarget);
  }

  function readLatestReply() {
    const node = viewport.current;
    if (!active || !node || latestReplyId === null) return;
    revealReply(node, latestReplyId, true);
    position.current = viewportPosition(node);
  }

  function readFindMatch() {
    const node = viewport.current;
    const mark = node?.querySelector<HTMLElement>("[data-assistant-find-match]");
    if (!active || !node || !mark) return;
    revealElement(node, mark, false);
    position.current = viewportPosition(node);
  }

  return { viewport, onScroll, readLatestReply, readFindMatch };
}
