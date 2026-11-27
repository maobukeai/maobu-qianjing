import { API_SECURITY_HEADERS } from "../server.ts";
import { encodeSseEvent, SSE_KEEPALIVE_BYTES } from "./events-bus.ts";
import { noStoreJson, rejectCrossOriginMutation, type UiRuntimeOptions } from "./shared.ts";

// Must exceed SSE_HISTORY_CAPACITY (256) so a full Last-Event-ID replay fits without tripping backpressure.
const SSE_MAX_QUEUED_FRAMES = 320;

function parseLastEventId(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Handles `GET /ui/api/events` Server-Sent Events stream with same-origin checks and replay. */
export function handleEventsUiRoutes(
  req: Request,
  pathname: string,
  options: UiRuntimeOptions,
): Response | null {
  if (pathname !== "/ui/api/events") return null;

  if (req.method !== "GET") {
    return Response.json(
      { ok: false, error: "GET is required" },
      {
        status: 405,
        headers: {
          ...API_SECURITY_HEADERS,
          Allow: "GET",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const crossOrigin = rejectCrossOriginMutation(req);
  if (crossOrigin) {
    crossOrigin.headers.set("Cache-Control", "no-store");
    return crossOrigin;
  }

  const bus = options.events;
  if (!bus || bus.isClosed()) {
    return noStoreJson({ ok: false, error: "event stream is unavailable" }, 503);
  }

  const lastEventId = parseLastEventId(req.headers.get("last-event-id"));
  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    req.signal.removeEventListener("abort", onAbort);
    const detach = unsubscribe;
    unsubscribe = undefined;
    detach?.();
    const ctrl = controllerRef;
    controllerRef = null;
    if (ctrl) {
      try {
        ctrl.close();
      } catch {}
    }
  };

  const onAbort = () => {
    cleanup();
  };

  const enqueueBytes = (bytes: Uint8Array) => {
    if (closed || !controllerRef) return;
    // Slow-consumer backpressure protection: disconnect rather than growing unbounded buffers.
    if (controllerRef.desiredSize !== null && controllerRef.desiredSize <= 0) {
      cleanup();
      return;
    }
    try {
      controllerRef.enqueue(bytes);
    } catch {
      cleanup();
    }
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controllerRef = controller;
        if (req.signal.aborted || bus.isClosed()) {
          cleanup();
          return;
        }
        req.signal.addEventListener("abort", onAbort, { once: true });

        const head = bus.headId();
        enqueueBytes(
          encodeSseEvent({
            id: head,
            type: "connected",
            payload: {
              workspaceId: bus.workspaceId ?? null,
              protocol: 1,
            },
          }),
        );
        if (closed) return;

        if (lastEventId !== null) {
          const { events, overflow } = bus.replaySince(lastEventId);
          if (overflow) {
            enqueueBytes(
              encodeSseEvent({
                id: bus.headId(),
                type: "roster.changed",
                payload: {
                  reasons: ["resync"],
                  resync: true,
                },
              }),
            );
          } else {
            for (const event of events) {
              enqueueBytes(encodeSseEvent(event));
              if (closed) return;
            }
          }
        }
        if (closed) return;

        unsubscribe = bus.subscribe({
          send: enqueueBytes,
          close: cleanup,
        });
        if (closed) {
          unsubscribe?.();
          unsubscribe = undefined;
          return;
        }

        heartbeatTimer = setInterval(() => {
          enqueueBytes(SSE_KEEPALIVE_BYTES);
        }, bus.heartbeatIntervalMs);
      },
      cancel() {
        cleanup();
      },
    },
    new CountQueuingStrategy({ highWaterMark: SSE_MAX_QUEUED_FRAMES }),
  );

  return new Response(stream, {
    status: 200,
    headers: {
      ...API_SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
