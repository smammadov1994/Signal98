// src/util.js
var V8_FRAME = /^\s*at (?:async )?(?:(.*?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
var V8_EVAL = /\(eval at .*?\((.+?):(\d+):(\d+)\)/;
var GECKO_FRAME = /^\s*(?:(.*?)@)?(.+?):(\d+)(?::(\d+))?\s*$/;
var GECKO_EVAL = /^(\S+) line (\d+)(?: > eval line \d+)* > (?:eval|Function)/;
var LOOKS_LIKE_PATH = /^\s*(?:[\w.+-]+:\/\/|\/|[a-z]:\\)/i;
function parseStack(stack) {
  if (!stack || typeof stack !== "string") return [];
  const frames = [];
  const v8 = /^\s*at /m.test(stack);
  for (const line of stack.split("\n")) {
    if (frames.length >= 30) break;
    let fn, file, ln, col;
    if (v8) {
      const m = V8_FRAME.exec(line);
      if (!m) continue;
      const ev = V8_EVAL.exec(line);
      fn = m[1];
      [file, ln, col] = ev ? [ev[1], ev[2], ev[3]] : [m[2], m[3], m[4]];
    } else {
      const m = GECKO_FRAME.exec(line);
      if (!m || m[1] === void 0 && !LOOKS_LIKE_PATH.test(line)) continue;
      const ev = GECKO_EVAL.exec(m[2]);
      fn = m[1];
      [file, ln, col] = ev ? [ev[1], ev[2], 0] : [m[2], m[3], m[4]];
    }
    frames.push({
      function: (fn || "<anonymous>").trim() || "<anonymous>",
      file,
      line: Number(ln),
      column: Number(col) || 0
    });
  }
  return frames;
}
var isErrorLike = (v) => !!v && typeof v === "object" && typeof v.message === "string";
function normalizeException(input) {
  if (isErrorLike(input)) {
    return {
      type: String(input.name || "Error"),
      value: String(input.message || input).slice(0, 2e3),
      stack: parseStack(input.stack)
    };
  }
  if (typeof input === "string") {
    return { type: "Error", value: input.slice(0, 2e3), stack: [] };
  }
  let value;
  try {
    value = JSON.stringify(input);
  } catch (e) {
  }
  return { type: "Error", value: String(value === void 0 ? input : value).slice(0, 2e3), stack: [] };
}
function normalizeChain(input) {
  const out = [];
  const seen = [];
  let cur = input;
  while (cur != null && out.length < 5 && !seen.includes(cur)) {
    seen.push(cur);
    out.push(normalizeException(cur));
    cur = typeof cur === "object" ? cur.cause : null;
  }
  return out.length ? out : [normalizeException(input)];
}
function messageTemplate(message) {
  return String(message == null ? "" : message).split("\n")[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>").replace(/\b0x[0-9a-f]+\b/gi, "<hex>").replace(/\b[0-9a-f]{16,}\b/gi, "<hex>").replace(/https?:\/\/[^\s"')]+/g, "<url>").replace(/"[^"]{0,120}"|'[^']{0,120}'/g, "<str>").replace(/\$?\d+(?:[.,]\d+)*/g, "<n>").replace(/\s+/g, " ").trim().slice(0, 200);
}
function frameKey(f) {
  const file = String(f && f.file || "").replace(/[?#].*$/, "").split("/").slice(-2).join("/").replace(/([._-])[0-9a-f]{8,}(?=[._-]|$)/gi, "").replace(/\.(min|chunk)(?=\.)/g, "");
  return `${f && f.function || "?"}@${file}`;
}
function hash32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16).padStart(8, "0");
}
function fingerprintOf(n) {
  const top = (n.stack || []).slice(0, 3).map(frameKey).join("|");
  const base = `${n.type}:${messageTemplate(n.value)}|${top}`;
  return hash32(base, 2166136261) + hash32(base, 2654435769);
}
function matchesAny(patterns, text) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((p) => {
    try {
      if (typeof p === "string") return p !== "" && text.includes(p);
      if (p && typeof p.test === "function") {
        p.lastIndex = 0;
        return p.test(text);
      }
    } catch (e) {
    }
    return false;
  });
}
function shouldIgnoreError(n, ignoreErrors) {
  if (/ResizeObserver loop/.test(n.value)) return true;
  if (!n.stack.length && /^Script error\.?$/.test(n.value)) return true;
  return matchesAny(ignoreErrors, n.value) || matchesAny(ignoreErrors, `${n.type}: ${n.value}`);
}
function createRateLimiter(max = 10, windowMs = 1e4, now = Date.now) {
  const buckets = /* @__PURE__ */ new Map();
  return (key) => {
    const t = now();
    if (buckets.size > 500) buckets.clear();
    let b = buckets.get(key);
    if (!b || t - b.start > windowMs) {
      b = { count: 0, start: t };
      buckets.set(key, b);
    }
    b.count += 1;
    return b.count > max;
  };
}
function sendDecision(status) {
  if (status === 0 || status === 429 || status >= 500) return "retry";
  if (status >= 400) return "drop";
  return "ok";
}
function backoffDelay(attempt, random = Math.random) {
  const base = Math.min(6e4, 1e3 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base / 2 + random() * (base / 2));
}
function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === "") return 0;
  const secs = Number(value);
  const ms = Number.isFinite(secs) ? secs * 1e3 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 3e5) : 0;
}
function uuid() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch (e) {
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : r & 3 | 8).toString(16);
  });
}
var stripQuery = (url) => String(url).replace(/[?#].*$/, "");
function safe(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    return fallback;
  }
}

// src/storage.js
function safeStorage(getBacking) {
  const mem = /* @__PURE__ */ new Map();
  let backing = null;
  try {
    backing = getBacking ? getBacking() : null;
    if (backing) {
      backing.setItem("s98_t", "1");
      backing.removeItem("s98_t");
    }
  } catch (e) {
    backing = null;
  }
  const api = {
    persistent: !!backing,
    get(key) {
      try {
        const v = backing && backing.getItem(key);
        if (v != null) return v;
      } catch (e) {
      }
      return mem.has(key) ? mem.get(key) : null;
    },
    // `diskOnly` skips the memory fallback: used for the event queue, which
    // already lives in memory, so a second copy would only waste space.
    set(key, value, diskOnly) {
      try {
        if (backing) {
          backing.setItem(key, value);
          mem.delete(key);
          return true;
        }
      } catch (e) {
      }
      if (!diskOnly) mem.set(key, value);
      return false;
    },
    remove(key) {
      mem.delete(key);
      try {
        if (backing) backing.removeItem(key);
      } catch (e) {
      }
    },
    getJSON(key) {
      try {
        const v = api.get(key);
        return v == null ? null : JSON.parse(v);
      } catch (e) {
        return null;
      }
    },
    setJSON(key, value) {
      try {
        return api.set(key, JSON.stringify(value));
      } catch (e) {
        return false;
      }
    }
  };
  return api;
}

// src/session.js
var SESSION_IDLE_MS = 30 * 6e4;
var SESSION_MAX_MS = 24 * 36e5;
var WRITE_EVERY_MS = 5e3;
function createIdentity(store, tabStore, now = Date.now) {
  let distinctId = store.get("s98_did") || uuid();
  let anonId = store.get("s98_anon") || distinctId;
  store.set("s98_did", distinctId);
  store.set("s98_anon", anonId);
  let windowId = tabStore.get("s98_wid");
  if (!windowId) tabStore.set("s98_wid", windowId = uuid());
  let cur = null;
  let lastWrite = 0;
  const valid = (s) => s && typeof s.id === "string" && s.start > 0 && s.last > 0;
  function write(t) {
    lastWrite = t;
    store.setJSON("s98_sid", cur);
    tabStore.setJSON("s98_sid", cur);
  }
  function getSessionId2() {
    const t = now();
    const stored = store.getJSON("s98_sid") || tabStore.getJSON("s98_sid");
    if (valid(stored) && (!cur || stored.start >= cur.start)) {
      cur = cur && stored.id === cur.id ? { ...stored, last: Math.max(stored.last, cur.last) } : stored;
    }
    if (!cur || t - cur.last > SESSION_IDLE_MS || t - cur.start > SESSION_MAX_MS) {
      cur = { id: uuid(), start: t, last: t };
      write(t);
    } else {
      cur.last = t;
      if (t - lastWrite > WRITE_EVERY_MS) write(t);
    }
    return cur.id;
  }
  return {
    getDistinctId: () => distinctId,
    getAnonId: () => anonId,
    getWindowId: () => windowId,
    getSessionId: getSessionId2,
    isIdentified: () => distinctId !== anonId,
    setDistinctId(id) {
      distinctId = id;
      store.set("s98_did", id);
    },
    // Logout: fresh anonymous person and a fresh session, so the next user of
    // this browser is not stitched onto the previous one.
    reset() {
      distinctId = anonId = uuid();
      store.set("s98_did", distinctId);
      store.set("s98_anon", anonId);
      cur = null;
      store.remove("s98_sid");
      tabStore.remove("s98_sid");
    }
  };
}

// src/transport.js
var QUEUE_KEY = "s98_queue";
var PERSIST_CHARS = 2e5;
var MAX_BATCH = 100;
var MAX_BODY_CHARS = 9e5;
var KEEPALIVE_CHARS = 5e4;
function createTransport({ endpoint, apiKey, env, store, maxQueue, flushInterval, flushAt, log: log2 }) {
  const url = apiKey ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}` : endpoint;
  const queue = [];
  let inflight = null;
  let flying = [];
  let timer = null;
  let persistTimer = null;
  let attempt = 0;
  let retryAt = 0;
  let batchMax = MAX_BATCH;
  let closed = false;
  const saved = store.getJSON(QUEUE_KEY);
  if (Array.isArray(saved)) {
    queue.push(...saved.filter((e) => e && e.uuid && e.event).slice(-maxQueue));
  }
  function persist() {
    if (persistTimer) env.clearTimeout(persistTimer);
    persistTimer = null;
    if (!store.persistent) return;
    try {
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
    } catch (e) {
    }
  }
  function persistSoon() {
    if (persistTimer || !store.persistent) return;
    persistTimer = env.setTimeout(persist, 200);
  }
  function schedule(delay) {
    if (closed) return;
    if (timer) env.clearTimeout(timer);
    timer = env.setTimeout(() => {
      timer = null;
      flush2(true);
    }, delay);
    if (timer && timer.unref) timer.unref();
  }
  function remove(batch) {
    for (const evt of batch) {
      const i = queue.indexOf(evt);
      if (i >= 0) queue.splice(i, 1);
    }
  }
  const envelope = (batch) => JSON.stringify({ api_key: apiKey, sent_at: new Date(env.now()).toISOString(), batch });
  async function sendBatch() {
    let n = Math.min(batchMax, queue.length);
    let batch, body;
    for (; ; ) {
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
        keepalive: body.length < KEEPALIVE_CHARS
      });
      status = res.status;
      retryAfter = parseRetryAfter(res.headers && res.headers.get && res.headers.get("Retry-After"), env.now());
    } catch (e) {
      status = 0;
    }
    flying = [];
    const verdict = sendDecision(status);
    if (verdict === "retry") {
      attempt += 1;
      const delay = Math.max(backoffDelay(attempt, env.random), retryAfter);
      retryAt = env.now() + delay;
      log2("send failed, status", status, "- retry in", delay, "ms");
      schedule(delay);
      persist();
      return false;
    }
    if (status === 413 && batch.length > 1) {
      batchMax = Math.ceil(batch.length / 2);
      return true;
    }
    if (verdict === "drop") log2("batch rejected with status", status, "- dropped", batch.length, "events");
    remove(batch);
    attempt = 0;
    retryAt = 0;
    persist();
    return true;
  }
  async function drain() {
    try {
      while (queue.length && await sendBatch()) ;
    } catch (err) {
      log2("drain error", err);
    }
    inflight = null;
    if (queue.length && !timer) schedule(flushInterval);
  }
  function flush2(force) {
    if (inflight) return inflight;
    if (!queue.length || !env.fetch) return Promise.resolve();
    if (!force && env.now() < retryAt) return Promise.resolve();
    if (env.win && env.win.navigator && env.win.navigator.onLine === false) return Promise.resolve();
    if (timer) env.clearTimeout(timer);
    timer = null;
    inflight = drain();
    return inflight;
  }
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
        const blob = typeof Blob === "undefined" ? body : new Blob([body], { type: "text/plain" });
        if (!nav.sendBeacon(url, blob)) break;
        remove(pending.slice(0, n));
        pending = pending.slice(n);
      }
      if (pending.length) flush2(true);
    } catch (err) {
      log2("beacon error", err);
    }
    persist();
  }
  function enqueue(evt, urgent) {
    if (closed) return;
    if (queue.length >= maxQueue) queue.shift();
    queue.push(evt);
    if (urgent) persist();
    else persistSoon();
    if (urgent || queue.length >= flushAt) flush2();
    else if (!timer && !inflight) schedule(flushInterval);
  }
  const onOnline = () => {
    retryAt = 0;
    attempt = 0;
    flush2(true);
  };
  if (env.win && env.win.addEventListener) env.win.addEventListener("online", onOnline);
  if (queue.length) schedule(Math.min(flushInterval, 1e3));
  function close2() {
    const done = flush2(true).then(persist);
    closed = true;
    if (timer) env.clearTimeout(timer);
    timer = null;
    if (env.win && env.win.removeEventListener) env.win.removeEventListener("online", onOnline);
    return done;
  }
  return { queue, enqueue, flush: flush2, flushBeacon, close: close2 };
}

// src/flags.js
var CACHE_KEY = "s98_flags";
function createFlags({ url, apiKey, env, store, tabStore, identity, capture: capture2, log: log2 }) {
  let flags = {};
  let loaded = false;
  const listeners = [];
  let called = { sid: null, keys: [] };
  const cached = store.getJSON(CACHE_KEY);
  if (cached && cached.id === identity.getDistinctId() && cached.flags) {
    flags = cached.flags;
    loaded = true;
  }
  function notify() {
    for (const cb of listeners.slice()) {
      try {
        cb(flags);
      } catch (err) {
        log2("onFeatureFlags callback threw", err);
      }
    }
  }
  async function reload() {
    if (!url || !env.fetch) return flags;
    try {
      const id = identity.getDistinctId();
      const res = await env.fetch(
        `${url}?key=${encodeURIComponent(apiKey || "")}&distinct_id=${encodeURIComponent(id)}`,
        { method: "GET" }
      );
      if (!res.ok) return flags;
      const data = await res.json();
      if (data && data.flags && typeof data.flags === "object" && id === identity.getDistinctId()) {
        flags = data.flags;
        loaded = true;
        store.setJSON(CACHE_KEY, { id, flags });
        notify();
      }
    } catch (err) {
      log2("flags unavailable", err);
    }
    return flags;
  }
  function getFeatureFlag2(key) {
    const value = flags[key];
    try {
      const sid = identity.getSessionId();
      if (called.sid !== sid) called = tabStore.getJSON("s98_ffc") || called;
      if (called.sid !== sid) called = { sid, keys: [] };
      if (loaded && !called.keys.includes(key)) {
        called.keys.push(key);
        tabStore.setJSON("s98_ffc", called);
        capture2("$feature_flag_called", { $feature_flag: key, $feature_flag_response: value === void 0 ? false : value });
      }
    } catch (err) {
      log2("flag bookkeeping failed", err);
    }
    return value;
  }
  return {
    reload,
    getFeatureFlag: getFeatureFlag2,
    isFeatureEnabled: (key) => {
      const v = getFeatureFlag2(key);
      return v !== void 0 && v !== false && v !== null;
    },
    onFeatureFlags(cb) {
      if (typeof cb !== "function") return () => {
      };
      listeners.push(cb);
      if (loaded) {
        try {
          cb(flags);
        } catch (err) {
          log2("onFeatureFlags callback threw", err);
        }
      }
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    clear() {
      flags = {};
      loaded = false;
      store.remove(CACHE_KEY);
    }
  };
}

// src/context.js
var UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
function staticContext(win, tabStore) {
  const nav = win.navigator || {};
  const scr = win.screen || {};
  const ctx = {
    $screen_width: scr.width,
    $screen_height: scr.height,
    $user_agent: nav.userAgent,
    $locale: nav.language,
    $timezone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  };
  let utm = tabStore.getJSON("s98_utm");
  if (!utm) {
    utm = {};
    safe(() => {
      const q = new URLSearchParams(win.location.search);
      for (const k of UTM) if (q.get(k)) utm[k] = q.get(k);
    });
    tabStore.setJSON("s98_utm", utm);
  }
  return Object.assign(ctx, utm);
}
function pageContext(win) {
  const loc = win.location || {};
  const doc = win.document || {};
  const ref = doc.referrer || "";
  return {
    $current_url: loc.href,
    $pathname: loc.pathname,
    $host: loc.host,
    // "$direct" mirrors PostHog, so existing dashboards/filters carry over.
    $referrer: ref || "$direct",
    $referring_domain: ref && safe(() => new URL(ref).host) || "$direct",
    $title: doc.title,
    $viewport_width: win.innerWidth,
    $viewport_height: win.innerHeight
  };
}
function dntEnabled(win) {
  const nav = win && win.navigator || {};
  return [nav.doNotTrack, nav.msDoNotTrack, win && win.doNotTrack].some((v) => v === "1" || v === "yes");
}

// src/client.js
var LIB = "signal98";
var LIB_VERSION = "0.2.0";
var URGENT = { $exception: 1, $rageclick: 1 };
function resolveEnv(e = {}) {
  const g = globalThis;
  const win = "win" in e ? e.win : typeof window !== "undefined" && window.document ? window : null;
  const nativeFetch = g.fetch;
  return {
    win,
    fetch: e.fetch || (typeof nativeFetch === "function" ? (...a) => nativeFetch.apply(g, a) : null),
    setTimeout: e.setTimeout || ((fn, ms) => setTimeout(fn, ms)),
    clearTimeout: e.clearTimeout || ((t) => clearTimeout(t)),
    now: e.now || Date.now,
    random: e.random || Math.random,
    localStorage: e.localStorage,
    sessionStorage: e.sessionStorage
  };
}
function decycle(value) {
  const seen = /* @__PURE__ */ new WeakSet();
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
function createClient(options) {
  const o = options || {};
  const env = resolveEnv(o._env);
  const dbg = (...a) => {
    if (o.debug) safe(() => console.log("[signal98]", ...a));
  };
  const host = o.host != null ? String(o.host).replace(/\/+$/, "") : null;
  const endpoint = o.endpoint || (host != null ? `${host}/api/ingest` : "");
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
  const disk = !disabled && o.persistence !== "memory";
  const store = safeStorage(disk ? () => env.localStorage || env.win && env.win.localStorage : null);
  const tabStore = safeStorage(disk ? () => env.sessionStorage || env.win && env.win.sessionStorage : null);
  const sampleRate = typeof o.sampleRate === "number" ? o.sampleRate : 1;
  const beforeSend = typeof o.beforeSend === "function" ? o.beforeSend : null;
  const identity = createIdentity(store, tabStore, env.now);
  const limited = createRateLimiter(10, 1e4, env.now);
  const steps = [];
  let superProps = store.getJSON("s98_props") || {};
  let closed = false;
  const ctx = {
    $release: o.release,
    $environment: o.environment || "production",
    $service: o.service || (env.win ? safe(() => env.win.location.hostname) : void 0),
    ...env.win ? safe(() => staticContext(env.win, tabStore), {}) : {}
  };
  const transport = createTransport({
    endpoint,
    apiKey: o.apiKey,
    // A disabled client must leave no trace in the page — not even an `online` listener.
    env: disabled ? { ...env, win: null } : env,
    store,
    maxQueue: o.maxQueue > 0 ? o.maxQueue : 500,
    flushInterval: o.flushInterval > 0 ? o.flushInterval : 3e3,
    flushAt: o.flushAt > 0 ? o.flushAt : 20,
    log: dbg
  });
  function capture2(event, properties) {
    try {
      if (disabled || closed || !event) return;
      if (event !== "$identify" && env.random() >= sampleRate) return;
      let evt = {
        uuid: uuid(),
        event: String(event),
        timestamp: new Date(env.now()).toISOString(),
        distinct_id: identity.getDistinctId(),
        properties: {
          ...env.win ? { $session_id: identity.getSessionId(), $window_id: identity.getWindowId(), ...pageContext(env.win) } : {},
          ...ctx,
          ...superProps,
          ...properties,
          // explicit properties win ($pageleave overrides $current_url, for one)
          $lib: LIB,
          $lib_version: LIB_VERSION
        }
      };
      if (beforeSend) {
        let out = evt;
        try {
          out = beforeSend(evt);
        } catch (err) {
          dbg("beforeSend threw - sending the event unmodified", err);
        }
        if (!out) return;
        if (typeof out === "object") evt = out;
      }
      try {
        JSON.stringify(evt);
      } catch (e) {
        evt = decycle(evt);
      }
      if (!evt.uuid) evt.uuid = uuid();
      dbg("capture", evt.event, evt);
      transport.enqueue(evt, !!URGENT[evt.event]);
    } catch (err) {
      dbg("capture failed", err);
    }
  }
  function captureException2(input, properties) {
    try {
      if (disabled || closed) return;
      const props = { ...properties };
      const chain = normalizeChain(input);
      const n = chain[0];
      if (shouldIgnoreError(n, o.ignoreErrors)) return;
      const fingerprint = props.$exception_fingerprint || fingerprintOf(n);
      if (limited(fingerprint)) return;
      const handled = props.$handled === void 0 ? true : !!props.$handled;
      const mechanism = { handled, synthetic: false, type: props.$mechanism || "manual" };
      capture2("$exception", {
        ...props,
        // [0] is the error that was thrown; the rest is its `cause` chain.
        $exception_list: chain.map((c, i) => ({
          type: c.type,
          value: c.value,
          stacktrace: { frames: c.stack },
          mechanism: i ? { ...mechanism, type: "cause" } : mechanism
        })),
        $exception_fingerprint: fingerprint,
        $exception_level: props.$exception_level || (handled ? "error" : "fatal"),
        $exception_steps: steps.slice()
      });
    } catch (err) {
      dbg("captureException failed", err);
    }
  }
  function addStep2(message, properties) {
    try {
      steps.push({
        $message: String(message).slice(0, 300),
        $timestamp: new Date(env.now()).toISOString(),
        $category: "custom",
        ...properties
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
    capture: capture2,
    log: dbg
  });
  function identify2(id, $set, $set_once) {
    try {
      if (id == null || id === "") return;
      id = String(id);
      const changed = id !== identity.getDistinctId();
      if (!changed && !$set && !$set_once) return;
      const props = { $set, $set_once };
      if (!changed || !identity.isIdentified()) props.$anon_distinct_id = identity.getAnonId();
      identity.setDistinctId(id);
      capture2("$identify", props);
      if (changed) flags.reload();
    } catch (err) {
      dbg("identify failed", err);
    }
  }
  function reset2() {
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
  function register2(props) {
    safe(() => {
      superProps = { ...superProps, ...props };
      store.setJSON("s98_props", superProps);
    });
  }
  function unregister2(key) {
    safe(() => {
      delete superProps[key];
      store.setJSON("s98_props", superProps);
    });
  }
  const log2 = {};
  for (const level of ["debug", "info", "warn", "error"]) {
    log2[level] = (message, props) => {
      if (safe(() => limited(`$log|${level}|${message}`), true)) return;
      capture2("$log", { ...props, $level: level, $message: String(message) });
    };
  }
  const flush2 = () => safe(() => transport.flush(true), Promise.resolve());
  function close2() {
    if (closed) return Promise.resolve();
    const done = safe(() => transport.close(), Promise.resolve());
    closed = true;
    return done;
  }
  if (!disabled && env.win && o.featureFlags !== false) flags.reload();
  return {
    capture: capture2,
    captureException: captureException2,
    addStep: addStep2,
    identify: identify2,
    reset: reset2,
    register: register2,
    unregister: unregister2,
    getDistinctId: () => identity.getDistinctId(),
    getSessionId: () => safe(() => identity.getSessionId()),
    log: log2,
    isFeatureEnabled: (key) => safe(() => flags.isFeatureEnabled(key), false),
    getFeatureFlag: (key) => safe(() => flags.getFeatureFlag(key)),
    onFeatureFlags: (cb) => flags.onFeatureFlags(cb),
    reloadFeatureFlags: () => flags.reload(),
    flush: flush2,
    close: close2,
    disabled,
    // Internals shared with browser.js / node.js / tests. Not public API.
    _queue: transport.queue,
    _steps: steps,
    _ctx: ctx,
    _env: env,
    _log: dbg,
    _flushBeacon: () => transport.flushBeacon(),
    _config: { endpoint, host: base, slowRequestMs: o.slowRequestMs > 0 ? o.slowRequestMs : 4e3 }
  };
}

// src/patch.js
function patch(obj, name, make, cleanups) {
  const orig = obj && obj[name];
  if (typeof orig !== "function") return;
  const own = Object.prototype.hasOwnProperty.call(obj, name);
  const patched = make(orig);
  obj[name] = patched;
  cleanups.push(() => {
    if (obj[name] !== patched) return;
    if (own) obj[name] = orig;
    else delete obj[name];
  });
}

// src/network.js
function installNetwork({ client, win, opts, guard, cleanups }) {
  const cfg = client._config;
  const now = client._env.now;
  const limited = createRateLimiter(10, 6e4, now);
  const resolve = (url) => safe(() => new URL(url, win.location.href).href, String(url));
  const endpointAbs = stripQuery(resolve(cfg.endpoint));
  const hostAbs = cfg.host ? resolve(`${cfg.host}/`) : null;
  const foreign = !!hostAbs && safe(() => new URL(hostAbs).origin !== win.location.origin, false);
  const isOwn = (abs) => {
    if (foreign) return abs.indexOf(hostAbs) === 0;
    const bare = stripQuery(abs);
    return bare === endpointAbs || bare === endpointAbs.replace(/ingest\/?$/, "flags");
  };
  const TOOLING = /\/_next\/static\/webpack\/|\.hot-update\.(?:json|js)\b|\/_next\/webpack-hmr|\/__nextjs_|\/__webpack_hmr|\/sockjs-node\/|\/@vite\/|\/@react-refresh|\/__vite_ping/;
  const skip = (abs) => isOwn(abs) || TOOLING.test(abs);
  function done(method, abs, status, t0, aborted) {
    const url = stripQuery(abs);
    const ms = now() - t0;
    if (opts.steps) {
      const label = status > 0 ? status : status ? "opaque" : aborted ? "aborted" : "failed";
      client.addStep(`${method} ${url} -> ${label}`, { $category: "network", method, url, status, duration_ms: ms });
    }
    if (!opts.network || aborted) return;
    const slow = ms > cfg.slowRequestMs;
    if (!(status >= 500 || status === 0 || slow)) return;
    if (limited(`${method} ${url} ${status}`)) return;
    const props = { $method: method, $url: url, $status: Math.max(status, 0), $duration_ms: ms };
    if (slow) props.$slow = true;
    client.capture("$network_error", props);
  }
  patch(
    win,
    "fetch",
    (orig) => function(input, init2) {
      const p = orig.apply(this, arguments);
      guard(() => {
        const method = String(init2 && init2.method || input && input.method || "GET").toUpperCase();
        const abs = resolve(typeof input === "string" ? input : input && input.url || String(input));
        if (skip(abs)) return;
        const t0 = now();
        p.then(
          (res) => guard(() => done(method, abs, res.type === "opaque" ? -1 : res.status, t0)),
          (err) => guard(() => done(method, abs, 0, t0, !!err && err.name === "AbortError"))
        );
      });
      return p;
    },
    cleanups
  );
  const proto = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
  if (proto) {
    const meta = /* @__PURE__ */ new WeakMap();
    patch(
      proto,
      "open",
      (orig) => function(method, url) {
        guard(() => meta.set(this, { method: String(method).toUpperCase(), abs: resolve(url) }));
        return orig.apply(this, arguments);
      },
      cleanups
    );
    patch(
      proto,
      "send",
      (orig) => function() {
        guard(() => {
          const m = meta.get(this);
          if (!m || skip(m.abs)) return;
          const t0 = now();
          let aborted = false;
          this.addEventListener("abort", () => aborted = true, { once: true });
          this.addEventListener("loadend", () => guard(() => done(m.method, m.abs, this.status, t0, aborted)), {
            once: true
          });
        });
        return orig.apply(this, arguments);
      },
      cleanups
    );
  }
}

// src/pageview.js
function installPageviews({ client, win, opts, guard, cleanups, activity, onPageHide }) {
  const loc = win.location;
  const doc = win.document;
  const now = client._env.now;
  let url, path, route, startedAt, maxDepth, left;
  let lastDepthCheck = 0;
  function measureDepth() {
    const de = doc.documentElement || {};
    const body = doc.body || {};
    const full = Math.max(de.scrollHeight || 0, body.scrollHeight || 0);
    const seen = (win.scrollY || win.pageYOffset || 0) + (win.innerHeight || 0);
    if (full > 0) maxDepth = Math.max(maxDepth, Math.min(1, seen / full));
  }
  function view() {
    url = loc.href;
    path = loc.pathname;
    route = loc.pathname + (loc.hash || "");
    startedAt = now();
    maxDepth = 0;
    left = false;
    if (opts.pageviews) client.capture("$pageview");
  }
  function leave() {
    if (left) return;
    left = true;
    measureDepth();
    if (!opts.pageviews) return;
    client.capture("$pageleave", {
      // The URL has usually changed already by the time we hear about it.
      $current_url: url,
      $pathname: path,
      $prev_pageview_duration: Math.round((now() - startedAt) / 10) / 100,
      $scroll_depth: Math.round(maxDepth * 100) / 100
    });
  }
  const onUrlChange = () => guard(() => {
    if (loc.href === url) return;
    const from = route;
    activity.n++;
    leave();
    view();
    if (opts.steps) client.addStep(`navigate ${from} -> ${route}`, { $category: "navigation", from, to: route });
  });
  for (const name of ["pushState", "replaceState"]) {
    patch(
      win.history,
      name,
      (orig) => function() {
        const out = orig.apply(this, arguments);
        onUrlChange();
        return out;
      },
      cleanups
    );
  }
  const listen = (target, type, fn, o) => {
    target.addEventListener(type, fn, o);
    cleanups.push(() => target.removeEventListener(type, fn, o));
  };
  listen(win, "popstate", onUrlChange);
  listen(win, "hashchange", onUrlChange);
  listen(
    win,
    "scroll",
    () => guard(() => {
      const t = now();
      if (t - lastDepthCheck < 250) return;
      lastDepthCheck = t;
      measureDepth();
    }),
    { passive: true, capture: true }
  );
  listen(win, "pageshow", (e) => guard(() => e && e.persisted && view()));
  onPageHide.push(leave);
  view();
}

// src/dom.js
var FORM_FIELDS = /^(input|textarea|select|option)$/;
var INTERACTIVE = /^(a|button|input|select|textarea|label|summary|details)$/;
var INTERACTIVE_ROLES = /^(button|link|tab|menuitem|checkbox|radio|switch|option)$/;
var UNSTABLE = /^(css|sc|jsx|jss|svelte)-|^\d|\d{4,}|[_-](?=[a-z\d]*\d)(?=[a-z\d]*[a-z])[a-z\d]{5,}$|[^\w-]/i;
var SENSITIVE_TEXT = /\d[\d\s-]{10,}\d/;
var tag = (el) => String(el.tagName || "").toLowerCase();
var attr = (el, name) => el.getAttribute ? el.getAttribute(name) : null;
function climb(el, test, max = 50) {
  for (let cur = el, i = 0; cur && i < max; cur = cur.parentElement, i++) {
    if (tag(cur) && test(cur)) return cur;
  }
  return null;
}
var isIgnored = (el) => !!climb(el, (e) => attr(e, "data-s98-ignore") != null);
var isMasked = (el) => !!climb(el, (e) => attr(e, "data-s98-mask") != null || /(^|\s)s98-mask(\s|$)/.test(attr(e, "class") || ""));
var isInteractive = (el) => INTERACTIVE.test(tag(el)) || INTERACTIVE_ROLES.test(attr(el, "role") || "") || attr(el, "onclick") != null || attr(el, "tabindex") === "0";
var interactiveTarget = (el) => climb(el, isInteractive, 6);
var MASK_SELECTOR = "[data-s98-mask],.s98-mask";
function spacedText(el, depth = 0) {
  const kids = el.children;
  if (!kids || !kids.length || depth > 3 || !el.childNodes) return el.textContent || "";
  const parts = [];
  for (const n of Array.from(el.childNodes).slice(0, 40)) {
    if (n.nodeType === 3) parts.push(n.nodeValue || "");
    else if (n.nodeType === 1) parts.push(spacedText(n, depth + 1));
  }
  return parts.join(" ");
}
function elementText(el) {
  if (isMasked(el) || el.querySelector && el.querySelector(MASK_SELECTOR)) return "***";
  const t = tag(el);
  let text = "";
  if (!FORM_FIELDS.test(t) && t !== "form" && attr(el, "contenteditable") == null) text = spacedText(el);
  text = (text || attr(el, "aria-label") || attr(el, "title") || attr(el, "alt") || "").replace(/\s+/g, " ").trim();
  if (SENSITIVE_TEXT.test(text)) return "***";
  return text.slice(0, 80);
}
var esc = (s) => String(s).replace(/["\\]/g, "\\$&");
function selectorPart(el) {
  const t = tag(el);
  for (const a of ["data-s98-id", "data-testid", "data-test", "name"]) {
    const v = attr(el, a);
    if (v) return { part: `${t}[${a}="${esc(v)}"]`, anchored: a !== "name" };
  }
  const classes = (attr(el, "class") || "").split(/\s+/).filter((c) => c && c !== "s98-mask" && !UNSTABLE.test(c)).slice(0, 2);
  let part = t + classes.map((c) => `.${c}`).join("");
  const parent = el.parentElement;
  if (parent && parent.children) {
    const same = Array.prototype.filter.call(parent.children, (c) => tag(c) === t);
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
  }
  return { part, anchored: false };
}
function cssSelector(el) {
  const parts = [];
  for (let cur = el, depth = 0; cur && tag(cur) && depth < 4; cur = cur.parentElement, depth++) {
    const t = tag(cur);
    if (t === "html" || t === "body" && parts.length) break;
    const id = attr(cur, "id");
    if (id && !UNSTABLE.test(id)) {
      parts.unshift(`#${id}`);
      break;
    }
    const { part, anchored } = selectorPart(cur);
    parts.unshift(part);
    if (anchored) break;
  }
  return parts.join(" > ");
}
function elementProps(el) {
  const attrs = {};
  for (const name of ["id", "name", "type", "role"]) {
    const v = attr(el, name);
    if (v) attrs[name] = String(v).slice(0, 100);
  }
  const all = el.attributes || [];
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    if (a && /^data-s98-(?!mask$|ignore$)/.test(a.name)) attrs[a.name] = String(a.value).slice(0, 100);
  }
  const link = climb(el, (e) => tag(e) === "a", 6);
  const href = link && attr(link, "href");
  return {
    $el_tag: tag(el),
    $el_text: elementText(el),
    $el_selector: cssSelector(el),
    $el_href: href ? stripQuery(href) : void 0,
    $el_attrs: attrs
  };
}
function createRageDetector(threshold = 3, ms = 1e3, px = 30) {
  let clicks = [];
  return (x, y, t) => {
    const last = clicks[clicks.length - 1];
    if (last && (t - last.t > ms || Math.abs(x - last.x) > px || Math.abs(y - last.y) > px)) clicks = [];
    clicks.push({ x, y, t });
    if (clicks.length < threshold) return 0;
    clicks = [];
    return threshold;
  };
}

// src/autocapture.js
var DEAD_CLICK_MS = 2500;
var tagOf = (el) => String(el.tagName || "").toLowerCase();
function deadClickExempt(el, e) {
  if (/^(input|textarea|select|option|label)$/.test(tagOf(el))) return true;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.button > 0) return true;
  if (tagOf(el) !== "a") return false;
  const get = (n) => el.getAttribute(n);
  return get("target") === "_blank" || get("download") != null || /^(mailto|tel|sms):/i.test(get("href") || "");
}
function installAutocapture({ client, win, opts, guard, cleanups, activity }) {
  const doc = win.document;
  const env = client._env;
  const rage = createRageDetector();
  let pending = null;
  function settle(report) {
    const p = pending;
    if (!p) return;
    pending = null;
    env.clearTimeout(p.timer);
    p.observer.disconnect();
    win.removeEventListener("scroll", p.onScroll, true);
    if (report && !p.alive && activity.n === p.mark) client.capture("$dead_click", p.props);
  }
  cleanups.push(() => settle(false));
  function watchDeadClick(props) {
    settle(false);
    if (!win.MutationObserver) return;
    const p = { props, alive: false, mark: activity.n };
    p.onScroll = () => p.alive = true;
    p.observer = new win.MutationObserver(() => {
      p.alive = true;
      p.observer.disconnect();
    });
    p.observer.observe(doc, { childList: true, subtree: true, attributes: true, characterData: true });
    win.addEventListener("scroll", p.onScroll, true);
    p.timer = env.setTimeout(() => guard(() => settle(true)), DEAD_CLICK_MS);
    pending = p;
  }
  const onClick = (e) => guard(() => {
    let raw = e.target;
    if (raw && !raw.tagName) raw = raw.parentElement;
    if (!raw || isIgnored(raw)) return;
    const el = interactiveTarget(raw);
    const props = elementProps(el || raw);
    if (opts.steps) {
      client.addStep(`click ${props.$el_selector}${props.$el_text ? ` "${props.$el_text}"` : ""}`, {
        $category: "ui",
        selector: props.$el_selector
      });
    }
    if (opts.clicks && el) client.capture("$autocapture", { $event_type: "click", ...props });
    if (opts.rageClicks && e.detail !== 0) {
      const count = rage(e.clientX || 0, e.clientY || 0, env.now());
      if (count) client.capture("$rageclick", { ...props, $click_count: count });
    }
    if (opts.deadClicks && el && !deadClickExempt(el, e)) watchDeadClick(props);
  });
  const onForm = (type) => (e) => guard(() => {
    const el = e.target;
    if (!opts.clicks || !el || !el.tagName || isIgnored(el)) return;
    if (type === "change" && !/^(input|select|textarea)$/.test(tagOf(el))) return;
    const props = elementProps(el);
    if (opts.steps) client.addStep(`${type} ${props.$el_selector}`, { $category: "ui", selector: props.$el_selector });
    client.capture("$autocapture", { $event_type: type, ...props });
  });
  const listen = (type, fn) => {
    doc.addEventListener(type, fn, true);
    cleanups.push(() => doc.removeEventListener(type, fn, true));
  };
  listen("click", onClick);
  listen("submit", onForm("submit"));
  listen("change", onForm("change"));
}

// src/vitals.js
var THRESHOLDS = {
  LCP: [2500, 4e3],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  FCP: [1800, 3e3],
  TTFB: [800, 1800]
};
function rateVital(metric, value) {
  const t = THRESHOLDS[metric];
  if (!t) return void 0;
  return value <= t[0] ? "good" : value <= t[1] ? "needs-improvement" : "poor";
}
function createClsTracker() {
  let max = 0;
  let sum = 0;
  let first = 0;
  let last = 0;
  return (entry) => {
    if (!entry.hadRecentInput) {
      if (sum && (entry.startTime - last > 1e3 || entry.startTime - first > 5e3)) sum = 0;
      if (!sum) first = entry.startTime;
      sum += entry.value;
      last = entry.startTime;
      max = Math.max(max, sum);
    }
    return max;
  };
}
function createInpTracker() {
  const worst = /* @__PURE__ */ new Map();
  let count = 0;
  return {
    add(entry) {
      const id = entry.interactionId;
      if (!id) return;
      if (!worst.has(id)) count++;
      worst.set(id, Math.max(worst.get(id) || 0, entry.duration));
      if (worst.size > 10) {
        let minId;
        for (const [k, v] of worst) if (minId === void 0 || v < worst.get(minId)) minId = k;
        worst.delete(minId);
      }
    },
    value() {
      if (!worst.size) return void 0;
      const sorted = Array.from(worst.values()).sort((a, b) => b - a);
      return sorted[Math.min(sorted.length - 1, Math.floor(count / 50))];
    }
  };
}
function installVitals({ client, win, guard, cleanups, onHidden }) {
  const PO = win.PerformanceObserver;
  if (!PO) return;
  const values = {};
  const cls = createClsTracker();
  const inp = createInpTracker();
  let reported = false;
  function observe(type, each, extra) {
    try {
      const po = new PO((list) => guard(() => list.getEntries().forEach(each)));
      po.observe({ type, buffered: true, ...extra });
      cleanups.push(() => po.disconnect());
      return true;
    } catch (e) {
      return false;
    }
  }
  observe("largest-contentful-paint", (e) => values.LCP = e.startTime);
  observe("paint", (e) => {
    if (e.name === "first-contentful-paint") values.FCP = e.startTime;
  });
  if (observe("layout-shift", (e) => values.CLS = cls(e))) values.CLS = 0;
  observe("event", (e) => inp.add(e), { durationThreshold: 40 });
  onHidden.push(() => {
    if (reported) return;
    reported = true;
    const nav = win.performance && win.performance.getEntriesByType && win.performance.getEntriesByType("navigation")[0];
    if (nav && nav.responseStart > 0) values.TTFB = Math.max(0, nav.responseStart - (nav.activationStart || 0));
    values.INP = inp.value();
    for (const metric of Object.keys(THRESHOLDS)) {
      const v = values[metric];
      if (typeof v !== "number" || !isFinite(v)) continue;
      const $value = metric === "CLS" ? Math.round(v * 1e4) / 1e4 : Math.round(v);
      client.capture("$web_vitals", { $metric: metric, $value, $rating: rateVital(metric, $value) });
    }
  });
}

// src/browser.js
var DEFAULTS = {
  errors: true,
  // window 'error' events (uncaught exceptions)
  rejections: true,
  // 'unhandledrejection' events
  console: false,
  // report console.error calls as exceptions
  steps: true,
  // breadcrumbs: ui clicks, navigation, network, console.warn/error
  pageviews: true,
  clicks: true,
  rageClicks: true,
  deadClicks: true,
  webVitals: true,
  network: true
};
function describe(arg) {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg.message === "string") return arg.message;
  try {
    return JSON.stringify(arg);
  } catch (e) {
    return String(arg);
  }
}
function installBrowser(client, options) {
  const win = client && client._env && client._env.win || (typeof window !== "undefined" ? window : null);
  if (!win || !win.document || !client || client.disabled) return () => {
  };
  const opts = {};
  for (const k of Object.keys(DEFAULTS)) opts[k] = options && options[k] !== void 0 ? !!options[k] : DEFAULTS[k];
  let active = true;
  const guard = (fn) => {
    if (!active) return;
    try {
      fn();
    } catch (err) {
      if (client._log) client._log("hook failed", err);
    }
  };
  const cleanups = [];
  const hooks = { client, win, opts, guard, cleanups, activity: { n: 0 }, onPageHide: [], onHidden: [] };
  const doc = win.document;
  const listen = (target, type, fn) => {
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };
  if (opts.errors) {
    listen(
      win,
      "error",
      (event) => guard(() => {
        let err = event.error;
        if (err == null) {
          const at = event.filename ? `    at ${event.filename}:${event.lineno || 0}:${event.colno || 0}` : "";
          err = { name: "Error", message: event.message || "Unknown error", stack: at };
        }
        client.captureException(err, { $handled: false, $mechanism: "onerror" });
      })
    );
  }
  if (opts.rejections) {
    listen(
      win,
      "unhandledrejection",
      (event) => guard(() => client.captureException(event.reason, { $handled: false, $mechanism: "unhandledrejection" }))
    );
  }
  if (opts.steps || opts.console) {
    let busy = false;
    for (const level of ["warn", "error"]) {
      patch(
        win.console,
        level,
        (orig) => function(...args) {
          if (!busy) {
            busy = true;
            guard(() => {
              const text = args.map(describe).join(" ").slice(0, 300);
              if (opts.steps) client.addStep(text, { $category: "console", level });
              if (opts.console && level === "error") {
                const first = args[0];
                client.captureException(
                  // Stackless on purpose: `new Error()` here would blame the SDK's own frames.
                  first && typeof first.message === "string" ? first : { name: "Error", message: text },
                  { $handled: true, $mechanism: "console.error" }
                );
              }
            });
            busy = false;
          }
          return orig.apply(this, args);
        },
        cleanups
      );
    }
  }
  if (opts.steps || opts.network) guard(() => installNetwork(hooks));
  if (opts.pageviews || opts.steps) guard(() => installPageviews(hooks));
  if (opts.clicks || opts.rageClicks || opts.deadClicks || opts.steps) guard(() => installAutocapture(hooks));
  if (opts.webVitals) guard(() => installVitals(hooks));
  const run = (list) => list.forEach((fn) => guard(fn));
  listen(
    doc,
    "visibilitychange",
    () => guard(() => {
      if (doc.visibilityState !== "hidden") return;
      run(hooks.onHidden);
      client._flushBeacon();
    })
  );
  listen(
    win,
    "pagehide",
    () => guard(() => {
      run(hooks.onPageHide);
      run(hooks.onHidden);
      client._flushBeacon();
    })
  );
  return () => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch (e) {
      }
    }
    active = false;
  };
}

// src/hub.js
var hub = { client: null };
var resolveClient = (client) => client && !client._noop ? client : hub.client;

// src/node.js
var EXIT_WAIT_MS = 2e3;
function hostname() {
  try {
    const os = process.getBuiltinModule && process.getBuiltinModule("os");
    if (os) return os.hostname();
  } catch (e) {
  }
  return process.env.HOSTNAME || process.env.COMPUTERNAME;
}
function installNode(client, opts = {}) {
  if (typeof process === "undefined" || typeof process.on !== "function" || !client || client.disabled) {
    return () => {
    };
  }
  const { errors = true, rejections = true, exitOnUncaught = true } = opts;
  const cleanups = [];
  const on = (event, fn) => {
    process.on(event, fn);
    cleanups.push(() => process.removeListener(event, fn));
  };
  try {
    const ctx = client._ctx || {};
    ctx.$node_version = process.version;
    ctx.$hostname = hostname();
    if (!ctx.$service) ctx.$service = process.env.npm_package_name || ctx.$hostname;
  } catch (e) {
  }
  const flushThen = (fn) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      fn();
    };
    setTimeout(finish, EXIT_WAIT_MS);
    Promise.resolve(client.flush()).then(finish, finish);
  };
  const fatal = (event, mechanism) => (err) => {
    try {
      client.captureException(err, { $handled: false, $mechanism: mechanism });
    } catch (e) {
    }
    if (!exitOnUncaught || process.listenerCount(event) > 1) return;
    try {
      console.error(err);
    } catch (e) {
    }
    flushThen(() => process.exit(1));
  };
  if (errors) on("uncaughtException", fatal("uncaughtException", "uncaughtException"));
  if (rejections) on("unhandledRejection", fatal("unhandledRejection", "unhandledRejection"));
  let exitFlush = false;
  on("beforeExit", () => {
    try {
      if (!client._queue.length || exitFlush) return;
      exitFlush = true;
      Promise.resolve(client.flush()).then(() => exitFlush = client._queue.length > 0);
    } catch (e) {
    }
  });
  const onTerm = () => {
    flushThen(() => {
      try {
        if (process.listenerCount("SIGTERM") > 1) return;
        process.removeListener("SIGTERM", onTerm);
        process.kill(process.pid, "SIGTERM");
      } catch (e) {
      }
    });
  };
  on("SIGTERM", onTerm);
  return () => cleanups.forEach((fn) => fn());
}
var pathOf = (req) => stripQuery(req.originalUrl || req.url || "");
function requestHandler(client) {
  return function signal98RequestHandler(req, res, next) {
    try {
      const c = resolveClient(client);
      if (c) c.addStep(`${req.method} ${pathOf(req)}`, { $category: "network", method: req.method, url: pathOf(req) });
    } catch (e) {
    }
    next();
  };
}
function errorHandler(client) {
  return function signal98ErrorHandler(err, req, res, next) {
    try {
      const c = resolveClient(client);
      const status = err && (err.status || err.statusCode) || 500;
      if (c && status >= 500) {
        c.captureException(err, {
          $handled: false,
          $mechanism: "express",
          $method: req && req.method,
          $url: req && pathOf(req),
          $status: status
        });
      }
    } catch (e) {
    }
    next(err);
  };
}

// src/index.js
var uninstall = null;
var isBrowser = () => typeof window !== "undefined" && typeof window.document !== "undefined";
var isNode = () => typeof process !== "undefined" && !!(process.versions && process.versions.node);
function init(options = {}) {
  if (hub.client) return hub.client;
  try {
    const client = createClient(options);
    hub.client = client;
    const auto = options.autoCapture === false ? null : options.autoCapture || {};
    if (auto && isBrowser()) uninstall = installBrowser(client, auto);
    else if (auto && isNode()) uninstall = installNode(client, auto);
    return client;
  } catch (err) {
    try {
      console.warn("signal98: init failed", err);
    } catch (e) {
    }
    return hub.client = null, noop;
  }
}
var nothing = () => {
};
var noop = {
  _noop: true,
  disabled: true,
  _queue: [],
  capture: nothing,
  captureException: nothing,
  addStep: nothing,
  identify: nothing,
  reset: nothing,
  register: nothing,
  unregister: nothing,
  getDistinctId: nothing,
  getSessionId: nothing,
  isFeatureEnabled: () => false,
  getFeatureFlag: nothing,
  onFeatureFlags: () => nothing,
  reloadFeatureFlags: () => Promise.resolve({}),
  flush: () => Promise.resolve(),
  close: () => Promise.resolve(),
  log: { debug: nothing, info: nothing, warn: nothing, error: nothing }
};
var getClient = () => hub.client || noop;
var capture = (event, properties) => getClient().capture(event, properties);
var captureException = (error, properties) => getClient().captureException(error, properties);
var addStep = (message, properties) => getClient().addStep(message, properties);
var identify = (id, $set, $set_once) => getClient().identify(id, $set, $set_once);
var reset = () => getClient().reset();
var register = (properties) => getClient().register(properties);
var unregister = (key) => getClient().unregister(key);
var getDistinctId = () => getClient().getDistinctId();
var getSessionId = () => getClient().getSessionId();
var isFeatureEnabled = (key) => getClient().isFeatureEnabled(key);
var getFeatureFlag = (key) => getClient().getFeatureFlag(key);
var onFeatureFlags = (callback) => getClient().onFeatureFlags(callback);
var reloadFeatureFlags = () => getClient().reloadFeatureFlags();
var flush = () => getClient().flush();
var logAt = (level) => (message, properties) => getClient().log[level](message, properties);
var log = { debug: logAt("debug"), info: logAt("info"), warn: logAt("warn"), error: logAt("error") };
function close() {
  const c = hub.client;
  hub.client = null;
  if (uninstall) {
    try {
      uninstall();
    } catch (e) {
    }
    uninstall = null;
  }
  return c ? c.close() : Promise.resolve();
}
function wrap(fn, options = {}) {
  const name = options.name || fn.name || "anonymous";
  const wrapped = function(...args) {
    const report = (err) => {
      try {
        getClient().captureException(err, {
          $handled: true,
          $mechanism: "wrap",
          $fn: name,
          ...options.properties || {}
        });
      } catch (e) {
      }
    };
    try {
      const out = fn.apply(this, args);
      if (out && typeof out.then === "function") {
        return out.then(void 0, (err) => {
          report(err);
          throw err;
        });
      }
      return out;
    } catch (err) {
      report(err);
      throw err;
    }
  };
  Object.defineProperty(wrapped, "name", { value: `signal98_wrapped_${name}` });
  return wrapped;
}
export {
  addStep,
  capture,
  captureException,
  close,
  createClient,
  errorHandler,
  flush,
  getClient,
  getDistinctId,
  getFeatureFlag,
  getSessionId,
  identify,
  init,
  installBrowser,
  installNode,
  isFeatureEnabled,
  log,
  onFeatureFlags,
  register,
  reloadFeatureFlags,
  requestHandler,
  reset,
  unregister,
  wrap
};
