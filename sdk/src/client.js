// The client: builds events (identity, session, context, super-properties),
// applies sampling / beforeSend / burst protection, and hands them to the
// transport. Every public method is wrapped so that a bug in here — or in a
// user-supplied hook — can never surface in the host application.

import { normalizeChain, fingerprintOf, uuid, createRateLimiter, shouldIgnoreError, safe } from "./util.js";
import { safeStorage } from "./storage.js";
import { createIdentity } from "./session.js";
import { createTransport } from "./transport.js";
import { createFlags } from "./flags.js";
import { staticContext, pageContext, dntEnabled } from "./context.js";

export const LIB = "signal98";
export const LIB_VERSION = "0.2.0";

// Events worth waking the network for right away, so the live feed feels live.
const URGENT = { $exception: 1, $rageclick: 1 };

// Everything the client needs from the outside world, injectable for tests
// (`options._env`). `fetch` is captured here, before browser.js patches
// window.fetch, so the SDK's own traffic never runs through its own hooks.
function resolveEnv(e = {}) {
  const g = globalThis;
  const win = "win" in e ? e.win : typeof window !== "undefined" && window.document ? window : null;
  const nativeFetch = g.fetch; // the reference, not a late lookup — see above
  return {
    win,
    fetch: e.fetch || (typeof nativeFetch === "function" ? (...a) => nativeFetch.apply(g, a) : null),
    setTimeout: e.setTimeout || ((fn, ms) => setTimeout(fn, ms)),
    clearTimeout: e.clearTimeout || ((t) => clearTimeout(t)),
    now: e.now || Date.now,
    random: e.random || Math.random,
    localStorage: e.localStorage,
    sessionStorage: e.sessionStorage,
  };
}

// JSON.stringify with cycles, BigInts and throwing getters defused. Only used
// when the plain stringify fails, so the common path pays nothing extra.
function decycle(value) {
  const seen = new WeakSet();
  return JSON.parse(
    JSON.stringify(value, (k, v) => {
      if (typeof v === "bigint") return String(v);
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    })
  );
}

export function createClient(options) {
  const o = options || {};
  const env = resolveEnv(o._env);
  const dbg = (...a) => {
    if (o.debug) safe(() => console.log("[signal98]", ...a)); // console.log is never patched by us
  };

  const host = o.host != null ? String(o.host).replace(/\/+$/, "") : null;
  const endpoint = o.endpoint || (host != null ? `${host}/api/ingest` : "");
  // Legacy `endpoint`-only configs still get flags if the URL has the standard shape.
  const m = /^(.*)\/api\/ingest\/?$/.exec(endpoint);
  const base = host != null ? host : m ? m[1] : null;

  let disabled = false;
  if (!endpoint) {
    disabled = true;
    safe(() => console.warn("signal98: init() needs `host` (or `endpoint`) - capture is disabled"));
  } else if (o.respectDNT && env.win && dntEnabled(env.win)) {
    disabled = true;
    dbg("Do Not Track is on - capture is disabled");
  }

  // A disabled client keeps everything in memory: no ids written, no queue read.
  const disk = !disabled && o.persistence !== "memory";
  const store = safeStorage(disk ? () => env.localStorage || (env.win && env.win.localStorage) : null);
  const tabStore = safeStorage(disk ? () => env.sessionStorage || (env.win && env.win.sessionStorage) : null);

  const sampleRate = typeof o.sampleRate === "number" ? o.sampleRate : 1;
  const beforeSend = typeof o.beforeSend === "function" ? o.beforeSend : null;
  const identity = createIdentity(store, tabStore, env.now);
  const limited = createRateLimiter(10, 10_000, env.now);
  const steps = []; // breadcrumb buffer; newest at the end
  let superProps = store.getJSON("s98_props") || {};
  let closed = false;

  // Static context. installNode() adds $hostname / $node_version here.
  const ctx = {
    $release: o.release,
    $environment: o.environment || "production",
    $service: o.service || (env.win ? safe(() => env.win.location.hostname) : undefined),
    ...(env.win ? safe(() => staticContext(env.win, tabStore), {}) : {}),
  };

  const transport = createTransport({
    endpoint,
    apiKey: o.apiKey,
    // A disabled client must leave no trace in the page — not even an `online` listener.
    env: disabled ? { ...env, win: null } : env,
    store,
    maxQueue: o.maxQueue > 0 ? o.maxQueue : 500,
    flushInterval: o.flushInterval > 0 ? o.flushInterval : 3000,
    flushAt: o.flushAt > 0 ? o.flushAt : 20,
    log: dbg,
  });

  function capture(event, properties) {
    try {
      if (disabled || closed || !event) return;
      // $identify links two people together; sampling it out would corrupt identity.
      if (event !== "$identify" && env.random() >= sampleRate) return;
      let evt = {
        uuid: uuid(),
        event: String(event),
        timestamp: new Date(env.now()).toISOString(),
        distinct_id: identity.getDistinctId(),
        properties: {
          ...(env.win
            ? { $session_id: identity.getSessionId(), $window_id: identity.getWindowId(), ...pageContext(env.win) }
            : {}),
          ...ctx,
          ...superProps,
          ...properties, // explicit properties win ($pageleave overrides $current_url, for one)
          $lib: LIB,
          $lib_version: LIB_VERSION,
        },
      };
      if (beforeSend) {
        let out = evt;
        try {
          out = beforeSend(evt);
        } catch (err) {
          dbg("beforeSend threw - sending the event unmodified", err);
        }
        if (!out) return; // dropped by the hook
        if (typeof out === "object") evt = out;
      }
      // One poison event (circular props, BigInt) must not wedge the queue
      // forever, so prove it serializes before it is allowed in.
      try {
        JSON.stringify(evt);
      } catch {
        evt = decycle(evt);
      }
      if (!evt.uuid) evt.uuid = uuid();
      dbg("capture", evt.event, evt);
      transport.enqueue(evt, !!URGENT[evt.event]);
    } catch (err) {
      dbg("capture failed", err);
    }
  }

  function captureException(input, properties) {
    try {
      if (disabled || closed) return;
      const props = { ...properties };
      const chain = normalizeChain(input);
      const n = chain[0];
      if (shouldIgnoreError(n, o.ignoreErrors)) return;
      const fingerprint = props.$exception_fingerprint || fingerprintOf(n);
      if (limited(fingerprint)) return;
      const handled = props.$handled === undefined ? true : !!props.$handled;
      const mechanism = { handled, synthetic: false, type: props.$mechanism || "manual" };
      capture("$exception", {
        ...props,
        // [0] is the error that was thrown; the rest is its `cause` chain.
        $exception_list: chain.map((c, i) => ({
          type: c.type,
          value: c.value,
          stacktrace: { frames: c.stack },
          mechanism: i ? { ...mechanism, type: "cause" } : mechanism,
        })),
        $exception_fingerprint: fingerprint,
        $exception_level: props.$exception_level || (handled ? "error" : "fatal"),
        $exception_steps: steps.slice(),
      });
    } catch (err) {
      dbg("captureException failed", err);
    }
  }

  function addStep(message, properties) {
    try {
      steps.push({
        $message: String(message).slice(0, 300),
        $timestamp: new Date(env.now()).toISOString(),
        $category: "custom",
        ...properties,
      });
      if (steps.length > 50) steps.splice(0, steps.length - 50);
    } catch (err) {
      dbg("addStep failed", err);
    }
  }

  const flags = createFlags({
    url: base != null ? `${base}/api/flags` : null,
    apiKey: o.apiKey,
    env,
    store,
    tabStore,
    identity,
    capture,
    log: dbg,
  });

  function identify(id, $set, $set_once) {
    try {
      if (id == null || id === "") return;
      id = String(id);
      const changed = id !== identity.getDistinctId();
      if (!changed && !$set && !$set_once) return; // same person, nothing new to say
      const props = { $set, $set_once };
      // Link the anonymous history to this person — but never when switching
      // straight from user A to user B, which would merge two real people.
      if (!changed || !identity.isIdentified()) props.$anon_distinct_id = identity.getAnonId();
      identity.setDistinctId(id);
      capture("$identify", props);
      if (changed) flags.reload(); // rollouts are bucketed per distinct_id
    } catch (err) {
      dbg("identify failed", err);
    }
  }

  function reset() {
    try {
      identity.reset();
      superProps = {};
      store.remove("s98_props");
      steps.length = 0;
      flags.clear();
      flags.reload();
    } catch (err) {
      dbg("reset failed", err);
    }
  }

  function register(props) {
    safe(() => {
      superProps = { ...superProps, ...props };
      store.setJSON("s98_props", superProps);
    });
  }

  function unregister(key) {
    safe(() => {
      delete superProps[key];
      store.setJSON("s98_props", superProps);
    });
  }

  const log = {};
  for (const level of ["debug", "info", "warn", "error"]) {
    log[level] = (message, props) => {
      // Same burst protection as exceptions: a log line in a hot loop is one signal, not 10,000.
      if (safe(() => limited(`$log|${level}|${message}`), true)) return;
      capture("$log", { ...props, $level: level, $message: String(message) });
    };
  }

  const flush = () => safe(() => transport.flush(true), Promise.resolve());

  function close() {
    if (closed) return Promise.resolve();
    const done = safe(() => transport.close(), Promise.resolve());
    closed = true;
    return done;
  }

  if (!disabled && env.win && o.featureFlags !== false) flags.reload();

  return {
    capture,
    captureException,
    addStep,
    identify,
    reset,
    register,
    unregister,
    getDistinctId: () => identity.getDistinctId(),
    getSessionId: () => safe(() => identity.getSessionId()),
    log,
    isFeatureEnabled: (key) => safe(() => flags.isFeatureEnabled(key), false),
    getFeatureFlag: (key) => safe(() => flags.getFeatureFlag(key)),
    onFeatureFlags: (cb) => flags.onFeatureFlags(cb),
    reloadFeatureFlags: () => flags.reload(),
    flush,
    close,
    disabled,
    // Internals shared with browser.js / node.js / tests. Not public API.
    _queue: transport.queue,
    _steps: steps,
    _ctx: ctx,
    _env: env,
    _log: dbg,
    _flushBeacon: () => transport.flushBeacon(),
    _config: { endpoint, host: base, slowRequestMs: o.slowRequestMs > 0 ? o.slowRequestMs : 4000 },
  };
}
