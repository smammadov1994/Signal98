// Small pure helpers: stack parsing, normalization, fingerprinting,
// burst protection and the retry policy. Nothing in here touches globals
// beyond Date/Math/crypto, so all of it is unit-testable in plain Node.

// Chrome / V8 / Node:   "    at fn (file:10:5)"  |  "    at async file:10:5"
const V8_FRAME = /^\s*at (?:async )?(?:(.*?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
// V8 eval frames nest the real location: "at fn (eval at run (file:1:2), <anonymous>:3:4)"
const V8_EVAL = /\(eval at .*?\((.+?):(\d+):(\d+)\)/;
// Firefox and Safari share "fn@file:10:5". Safari drops "fn@" for anonymous
// frames and sometimes the column too.
const GECKO_FRAME = /^\s*(?:(.*?)@)?(.+?):(\d+)(?::(\d+))?\s*$/;
// Firefox eval frames: "fn@http://x/a.js line 5 > eval:1:1" -> a.js:5
const GECKO_EVAL = /^(\S+) line (\d+)(?: > eval line \d+)* > (?:eval|Function)/;
const LOOKS_LIKE_PATH = /^\s*(?:[\w.+-]+:\/\/|\/|[a-z]:\\)/i;

export function parseStack(stack) {
  if (!stack || typeof stack !== "string") return [];
  const frames = [];
  // Decide the dialect once per stack. Parsing line-by-line with both
  // regexes would turn a V8 message line such as "Error: GET /x:1:2" into a
  // bogus frame, because the Gecko shape is so permissive.
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
      if (!m || (m[1] === undefined && !LOOKS_LIKE_PATH.test(line))) continue;
      const ev = GECKO_EVAL.exec(m[2]);
      fn = m[1];
      [file, ln, col] = ev ? [ev[1], ev[2], 0] : [m[2], m[3], m[4]];
    }
    frames.push({
      function: (fn || "<anonymous>").trim() || "<anonymous>",
      file,
      line: Number(ln),
      column: Number(col) || 0,
    });
  }
  return frames;
}

// instanceof Error fails across realms (iframes, vm contexts) and for
// DOMException in old engines, so duck-type instead.
const isErrorLike = (v) => !!v && typeof v === "object" && typeof v.message === "string";

export function normalizeException(input) {
  if (isErrorLike(input)) {
    return {
      type: String(input.name || "Error"),
      value: String(input.message || input).slice(0, 2000),
      stack: parseStack(input.stack),
    };
  }
  if (typeof input === "string") {
    return { type: "Error", value: input.slice(0, 2000), stack: [] };
  }
  let value;
  try {
    value = JSON.stringify(input);
  } catch {
    /* circular — fall through */
  }
  return { type: "Error", value: String(value === undefined ? input : value).slice(0, 2000), stack: [] };
}

// The thrown error followed by its `cause` chain (ES2022), outermost first.
// Bounded and cycle-safe: `a.cause = a` must not hang the host app.
export function normalizeChain(input) {
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

// Stable grouping key. "Same bug" must survive things that are NOT the bug changing:
//   • line/column numbers — any edit above the throw site moves them, and a FIX moves them
//     in the very file it patches; keying on them made a regressed bug look brand new
//   • build content-hashes in chunk names (page-3f9a2c1b.js) — new on every deploy
//   • ids, amounts, urls inside the message — "user 7712 not found" is one bug, not 7712
// So: type + message TEMPLATE + top 3 frames as function@file. Same idea as Sentry's
// in-app-frame grouping. 64 bits (two independent 32-bit hashes) keeps collisions negligible.
export function messageTemplate(message) {
  return String(message == null ? "" : message)
    .split("\n")[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/https?:\/\/[^\s"')]+/g, "<url>")
    .replace(/"[^"]{0,120}"|'[^']{0,120}'/g, "<str>")
    .replace(/\$?\d+(?:[.,]\d+)*/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function frameKey(f) {
  const file = String((f && f.file) || "")
    .replace(/[?#].*$/, "")                                   // cache-busters
    .split("/").slice(-2).join("/")                            // host + deep paths are deploy detail
    .replace(/([._-])[0-9a-f]{8,}(?=[._-]|$)/gi, "")           // content hash: page-3f9a2c1b.js → page.js
    .replace(/\.(min|chunk)(?=\.)/g, "");
  return `${(f && f.function) || "?"}@${file}`;
}

function hash32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(h ^ str.charCodeAt(i), 16777619)) >>> 0; // FNV-1a
  return h.toString(16).padStart(8, "0");
}

export function fingerprintOf(n) {
  const top = (n.stack || []).slice(0, 3).map(frameKey).join("|");
  const base = `${n.type}:${messageTemplate(n.value)}|${top}`;
  return hash32(base, 2166136261) + hash32(base, 0x9e3779b9);
}

function matchesAny(patterns, text) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((p) => {
    try {
      if (typeof p === "string") return p !== "" && text.includes(p);
      if (p && typeof p.test === "function") {
        p.lastIndex = 0; // a /g regex is stateful between calls
        return p.test(text);
      }
    } catch {
      /* a weird pattern must not break capture */
    }
    return false;
  });
}

// Built-in noise filters plus the user's `ignoreErrors`.
//  - "ResizeObserver loop ..." is a benign browser notice, never actionable.
//  - "Script error." with no stack is a cross-origin script the browser has
//    redacted; there is nothing to debug. With a stack it is a real error
//    that merely has that message, so it is kept.
export function shouldIgnoreError(n, ignoreErrors) {
  if (/ResizeObserver loop/.test(n.value)) return true;
  if (!n.stack.length && /^Script error\.?$/.test(n.value)) return true;
  return matchesAny(ignoreErrors, n.value) || matchesAny(ignoreErrors, `${n.type}: ${n.value}`);
}

// Burst protection: at most `max` hits per key per window. Returns a function
// that answers "is this one over the limit?". Stops an error thrown in a
// tight loop (or a console.error in a render loop) from flooding the queue.
export function createRateLimiter(max = 10, windowMs = 10_000, now = Date.now) {
  const buckets = new Map(); // key -> { count, start }
  return (key) => {
    const t = now();
    if (buckets.size > 500) buckets.clear(); // bounded memory beats perfect accounting
    let b = buckets.get(key);
    if (!b || t - b.start > windowMs) {
      b = { count: 0, start: t };
      buckets.set(key, b);
    }
    b.count += 1;
    return b.count > max;
  };
}

// ---- retry policy (PROTOCOL.md "Ingest") ----

// status 0 = the request never got a response (offline, DNS, CORS, abort).
export function sendDecision(status) {
  if (status === 0 || status === 429 || status >= 500) return "retry";
  if (status >= 400) return "drop"; // our payload is wrong; resending cannot fix it
  return "ok";
}

// Exponential backoff with "equal jitter": 1s, 2s, 4s ... capped at 60s, and
// the real delay lands in [base/2, base] so a fleet of tabs that failed
// together does not retry together.
export function backoffDelay(attempt, random = Math.random) {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base / 2 + random() * (base / 2));
}

// Retry-After is either delta-seconds or an HTTP date. Returns ms (0 if absent
// or unparseable), capped so a confused server cannot park the queue for days.
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === "") return 0;
  const secs = Number(value);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 300_000) : 0;
}

export const nowIso = () => new Date().toISOString();

// RFC 4122 v4. The server uses it for idempotent ingest, so prefer the
// platform CSPRNG and fall back to Math.random on old engines / insecure origins.
export function uuid() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

export const stripQuery = (url) => String(url).replace(/[?#].*$/, "");

// Run fn, swallow anything it throws. The SDK's prime directive.
export function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
