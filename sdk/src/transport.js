// Delivery: a bounded, persisted queue drained in batches with retry.
//
// Invariant: `queue` always holds exactly the events the server has not yet
// acknowledged. A batch is only removed once it is accepted (2xx) or rejected
// for good (4xx); until then it stays queued *and* persisted, so a crash,
// reload or dead network between "sent" and "acknowledged" loses nothing.
// Re-delivery is safe because every event carries a uuid and ingest is idempotent.

import { backoffDelay, parseRetryAfter, sendDecision } from "./util.js";

const QUEUE_KEY = "s98_queue";
const PERSIST_CHARS = 200_000; // stay well inside the ~5 MB localStorage quota we share with the host app
const MAX_BATCH = 100; // server limit is 200 events / 1 MB per request
const MAX_BODY_CHARS = 900_000;
// Browsers cap sendBeacon and fetch(keepalive) bodies at 64 KB *in total*
// across in-flight requests; larger keepalive fetches reject outright.
const KEEPALIVE_CHARS = 50_000;

export function createTransport({ endpoint, apiKey, env, store, maxQueue, flushInterval, flushAt, log }) {
  const url = apiKey
    ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}`
    : endpoint;
  const queue = [];
  let inflight = null; // promise of the running drain — at most one at a time
  let flying = []; // the events of the batch currently on the wire
  let timer = null;
  let persistTimer = null;
  let attempt = 0;
  let retryAt = 0; // while now < retryAt we are backing off
  let batchMax = MAX_BATCH;
  let closed = false;

  // Pick up what a previous page load could not deliver.
  const saved = store.getJSON(QUEUE_KEY);
  if (Array.isArray(saved)) {
    queue.push(...saved.filter((e) => e && e.uuid && e.event).slice(-maxQueue));
  }

  function persist() {
    if (persistTimer) env.clearTimeout(persistTimer);
    persistTimer = null;
    if (!store.persistent) return;
    try {
      // Newest events win when the queue outgrows the storage budget.
      const parts = [];
      let size = 2;
      for (let i = queue.length - 1; i >= 0; i--) {
        const s = JSON.stringify(queue[i]);
        if (size + s.length + 1 > PERSIST_CHARS) break;
        size += s.length + 1;
        parts.push(s);
      }
      if (parts.length) store.set(QUEUE_KEY, `[${parts.reverse().join(",")}]`, true);
      else store.remove(QUEUE_KEY);
    } catch {
      /* unserializable event or quota — delivery still proceeds from memory */
    }
  }

  // Serializing up to 200 KB per captured event would be silly; coalesce.
  function persistSoon() {
    if (persistTimer || !store.persistent) return;
    persistTimer = env.setTimeout(persist, 200);
  }

  function schedule(delay) {
    if (closed) return;
    if (timer) env.clearTimeout(timer);
    timer = env.setTimeout(() => {
      timer = null;
      // Forced: this timer *is* the backoff clock, and timers may fire a hair
      // early relative to Date.now(), which would otherwise strand the queue.
      flush(true);
    }, delay);
    if (timer && timer.unref) timer.unref(); // never keep a Node process alive for telemetry
  }

  function remove(batch) {
    for (const evt of batch) {
      const i = queue.indexOf(evt);
      if (i >= 0) queue.splice(i, 1);
    }
  }

  const envelope = (batch) =>
    JSON.stringify({ api_key: apiKey, sent_at: new Date(env.now()).toISOString(), batch });

  // Sends the head of the queue. Resolves true when it makes sense to keep draining.
  async function sendBatch() {
    let n = Math.min(batchMax, queue.length);
    let batch, body;
    for (;;) {
      batch = queue.slice(0, n);
      body = envelope(batch);
      if (body.length <= MAX_BODY_CHARS || n === 1) break;
      n = Math.ceil(n / 2);
    }
    flying = batch;
    let status = 0;
    let retryAfter = 0;
    try {
      const res = await env.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: body.length < KEEPALIVE_CHARS,
      });
      status = res.status;
      retryAfter = parseRetryAfter(res.headers && res.headers.get && res.headers.get("Retry-After"), env.now());
    } catch {
      status = 0;
    }
    flying = [];

    const verdict = sendDecision(status);
    if (verdict === "retry") {
      attempt += 1;
      const delay = Math.max(backoffDelay(attempt, env.random), retryAfter);
      retryAt = env.now() + delay;
      log("send failed, status", status, "- retry in", delay, "ms");
      schedule(delay);
      persist(); // the network is unreliable right now: make sure a reload cannot lose these
      return false;
    }
    if (status === 413 && batch.length > 1) {
      batchMax = Math.ceil(batch.length / 2); // too large: split instead of dropping everything
      return true;
    }
    if (verdict === "drop") log("batch rejected with status", status, "- dropped", batch.length, "events");
    remove(batch);
    attempt = 0;
    retryAt = 0;
    persist();
    return true;
  }

  async function drain() {
    try {
      while (queue.length && (await sendBatch()));
    } catch (err) {
      log("drain error", err);
    }
    inflight = null;
    if (queue.length && !timer) schedule(flushInterval);
  }

  // force = the caller asked explicitly (public flush(), `online`), so skip
  // the backoff wait. Never rejects.
  function flush(force) {
    if (inflight) return inflight;
    if (!queue.length || !env.fetch) return Promise.resolve();
    if (!force && env.now() < retryAt) return Promise.resolve();
    // Known-offline: do not burn a retry attempt, the `online` event will wake us.
    if (env.win && env.win.navigator && env.win.navigator.onLine === false) return Promise.resolve();
    if (timer) env.clearTimeout(timer);
    timer = null;
    inflight = drain();
    return inflight;
  }

  // The page is going away: fetch may be cancelled, so hand what we can to
  // sendBeacon, which the browser completes after unload. Whatever a beacon
  // does not take stays persisted for the next page load.
  function flushBeacon() {
    try {
      const nav = env.win && env.win.navigator;
      let pending = queue.filter((e) => !flying.includes(e));
      while (pending.length && nav && nav.sendBeacon) {
        let n = Math.min(MAX_BATCH, pending.length);
        let body = envelope(pending.slice(0, n));
        while (body.length > KEEPALIVE_CHARS && n > 1) {
          n = Math.ceil(n / 2);
          body = envelope(pending.slice(0, n));
        }
        // text/plain keeps the beacon a CORS "simple request" — a JSON
        // content type would need a preflight, which cannot finish during unload.
        const blob = typeof Blob === "undefined" ? body : new Blob([body], { type: "text/plain" });
        if (!nav.sendBeacon(url, blob)) break;
        remove(pending.slice(0, n));
        pending = pending.slice(n);
      }
      if (pending.length) flush(true);
    } catch (err) {
      log("beacon error", err);
    }
    persist();
  }

  function enqueue(evt, urgent) {
    if (closed) return;
    if (queue.length >= maxQueue) queue.shift(); // bounded: drop oldest
    queue.push(evt);
    if (urgent) persist();
    else persistSoon();
    if (urgent || queue.length >= flushAt) flush();
    else if (!timer && !inflight) schedule(flushInterval);
  }

  const onOnline = () => {
    retryAt = 0;
    attempt = 0;
    flush(true);
  };
  if (env.win && env.win.addEventListener) env.win.addEventListener("online", onOnline);
  if (queue.length) schedule(Math.min(flushInterval, 1000));

  function close() {
    const done = flush(true).then(persist);
    closed = true;
    if (timer) env.clearTimeout(timer);
    timer = null;
    if (env.win && env.win.removeEventListener) env.win.removeEventListener("online", onOnline);
    return done;
  }

  return { queue, enqueue, flush, flushBeacon, close };
}
