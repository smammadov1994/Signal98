// In-process pub/sub feeding the Server-Sent Events stream (/api/stream).
// Lives on globalThis for the same reason the database handle does.
function state() {
  return (globalThis.__s98_bus ||= { subs: new Set(), seq: 0 });
}

export function publish(type, data) {
  const s = state();
  const msg = { id: ++s.seq, type, data };
  for (const fn of s.subs) {
    try { fn(msg); } catch { /* a dead subscriber must not break ingest */ }
  }
}

export function subscribe(fn) {
  const s = state();
  s.subs.add(fn);
  return () => s.subs.delete(fn);
}

export const subscriberCount = () => state().subs.size;

export function sseResponse(req, { projectId } = {}) {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (type, data, id) => {
        try {
          controller.enqueue(enc.encode(`${id ? `id: ${id}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };
      send("hello", { ok: true, at: Date.now() });
      const unsub = subscribe((m) => {
        if (projectId && m.data?.project_id && m.data.project_id !== projectId) return;
        send(m.type, m.data, m.id);
      });
      const ping = setInterval(() => send("ping", { at: Date.now() }), 15_000);
      cleanup = () => {
        clearInterval(ping);
        unsub();
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal?.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
