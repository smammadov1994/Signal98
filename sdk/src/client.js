// The client: event queue, batching, transport, sampling, beforeSend,
// and client-side burst protection (like PostHog's exception rate limiter).

import { normalizeException, fingerprintOf, nowIso, uuid } from "./util.js";

const LIB = "signal98";
const LIB_VERSION = "0.1.0";

export function createClient(options = {}) {
  const {
    endpoint,
    apiKey,
    release,
    environment = "production",
    sampleRate = 1.0,
    beforeSend,
    maxQueue = 200,
    flushInterval = 5000,
  } = options;

  if (!endpoint) throw new Error("signal98: init() requires an `endpoint` URL");

  const queue = [];
  const steps = []; // breadcrumb buffer; newest at the end
  const rateBuckets = new Map(); // fingerprint -> { count, windowStart }
  let distinctId = uuid();
  let timer = null;

  // Burst protection: max 10 events per fingerprint per 10s window.
  // Prevents an error thrown in a tight loop from flooding the queue.
  function rateLimited(fingerprint) {
    const now = Date.now();
    const b = rateBuckets.get(fingerprint) || { count: 0, windowStart: now };
    if (now - b.windowStart > 10_000) {
      b.count = 0;
      b.windowStart = now;
    }
    b.count += 1;
    rateBuckets.set(fingerprint, b);
    return b.count > 10;
  }

  function enqueue(evt) {
    if (Math.random() > sampleRate) return;
    let out = evt;
    if (beforeSend) {
      try {
        out = beforeSend(evt);
      } catch {
        out = evt; // a broken hook must never break the host app
      }
    }
    if (!out) return; // beforeSend dropped it
    if (queue.length >= maxQueue) queue.shift();
    queue.push(out);
    scheduleFlush();
  }

  function capture(event, properties = {}) {
    enqueue({
      event,
      timestamp: nowIso(),
      distinct_id: distinctId,
      properties: {
        ...properties,
        $release: release,
        $environment: environment,
        $lib: LIB,
        $lib_version: LIB_VERSION,
      },
    });
  }

  function captureException(input, properties = {}) {
    const n = normalizeException(input);
    const fingerprint = properties.$exception_fingerprint || fingerprintOf(n);
    if (rateLimited(fingerprint)) return;
    capture("$exception", {
      ...properties,
      $exception_list: [
        {
          type: n.type,
          value: n.value,
          stacktrace: { frames: n.stack },
          mechanism: {
            handled: properties.$handled ?? true,
            synthetic: false,
            type: properties.$mechanism || "manual",
          },
        },
      ],
      $exception_fingerprint: fingerprint,
      $exception_steps: [...steps],
    });
  }

  function addStep(message, properties = {}) {
    steps.push({ $message: String(message), $timestamp: nowIso(), ...properties });
    if (steps.length > 50) steps.splice(0, steps.length - 50);
  }

  async function flush() {
    if (!queue.length) return;
    const batch = queue.splice(0, queue.length);
    const body = JSON.stringify(batch);
    try {
      if (typeof navigator !== "undefined" && navigator.sendBeacon && body.length < 60000) {
        const ok = navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
        if (ok) return;
      }
      await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "X-Signal-Key": apiKey } : {}),
        },
        body,
        keepalive: true,
      });
    } catch {
      // Never crash the host app over telemetry. Requeue (bounded).
      queue.unshift(...batch.slice(-maxQueue));
    }
  }

  function scheduleFlush() {
    if (timer || typeof setInterval === "undefined") return;
    timer = setInterval(() => {
      flush();
    }, flushInterval);
    if (timer.unref) timer.unref();
  }

  function close() {
    if (timer) clearInterval(timer);
    timer = null;
    return flush();
  }

  function identify(id) {
    distinctId = String(id);
  }

  return { capture, captureException, addStep, flush, close, identify, _queue: queue };
}
