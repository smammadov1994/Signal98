import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStack,
  normalizeException,
  normalizeChain,
  fingerprintOf,
  shouldIgnoreError,
  createRateLimiter,
  sendDecision,
  backoffDelay,
  parseRetryAfter,
  uuid,
  stripQuery,
} from "../src/util.js";

const CHROME = `TypeError: Cannot read properties of undefined (reading 'id')
    at renderProfile (http://localhost:3000/static/app.js:120:15)
    at async loadUser (http://localhost:3000/static/app.js:88:5)
    at new Widget (webpack-internal:///./src/widget.js:12:9)
    at http://localhost:3000/static/vendor.js:9:1001
    at Array.map (<anonymous>)
    at Object.<anonymous> (/srv/app/server.js:10:3)
    at run (eval at compile (http://localhost:3000/static/tpl.js:4:7), <anonymous>:1:30)`;

const FIREFOX = `renderProfile@http://localhost:3000/static/app.js:120:15
loadUser/<@http://localhost:3000/static/app.js:88:5
@http://localhost:3000/static/vendor.js:9:1001
run@http://localhost:3000/static/tpl.js line 4 > eval:1:30`;

const SAFARI = `renderProfile@http://localhost:3000/static/app.js:120:15
forEach@[native code]
http://localhost:3000/static/vendor.js:9:1001
global code@http://localhost:3000/static/app.js:200`;

test("parseStack: Chrome / V8 / Node", () => {
  const f = parseStack(CHROME);
  assert.deepEqual(f[0], {
    function: "renderProfile",
    file: "http://localhost:3000/static/app.js",
    line: 120,
    column: 15,
  });
  assert.equal(f[1].function, "loadUser", "the async prefix is not part of the name");
  assert.equal(f[2].function, "new Widget");
  assert.equal(f[2].file, "webpack-internal:///./src/widget.js");
  assert.deepEqual(f[3], { function: "<anonymous>", file: "http://localhost:3000/static/vendor.js", line: 9, column: 1001 });
  assert.equal(f[4].function, "Object.<anonymous>", "frames without a location (Array.map) are skipped");
  assert.equal(f[4].file, "/srv/app/server.js");
  assert.deepEqual(f[5], { function: "run", file: "http://localhost:3000/static/tpl.js", line: 4, column: 7 });
  assert.equal(f.length, 6);
});

test("parseStack: a V8 message line that looks like a location is not a frame", () => {
  const f = parseStack("Error: GET http://x.test/api:80:1 failed\n    at go (http://x.test/a.js:1:2)");
  assert.equal(f.length, 1);
  assert.equal(f[0].function, "go");
});

test("parseStack: Firefox", () => {
  const f = parseStack(FIREFOX);
  assert.equal(f.length, 4);
  assert.deepEqual(f[0], { function: "renderProfile", file: "http://localhost:3000/static/app.js", line: 120, column: 15 });
  assert.equal(f[1].function, "loadUser/<");
  assert.equal(f[2].function, "<anonymous>");
  assert.deepEqual(f[3], { function: "run", file: "http://localhost:3000/static/tpl.js", line: 4, column: 0 });
});

test("parseStack: Safari", () => {
  const f = parseStack(SAFARI);
  assert.equal(f.length, 3, "[native code] is skipped");
  assert.equal(f[0].function, "renderProfile");
  assert.deepEqual(f[1], { function: "<anonymous>", file: "http://localhost:3000/static/vendor.js", line: 9, column: 1001 });
  assert.deepEqual(f[2], { function: "global code", file: "http://localhost:3000/static/app.js", line: 200, column: 0 });
});

test("parseStack: garbage in, empty out", () => {
  for (const v of [null, undefined, 42, {}, "", "just a sentence", "note: see 12:30"]) assert.deepEqual(parseStack(v), []);
  assert.ok(parseStack(Array(100).fill("    at f (a.js:1:1)").join("\n")).length <= 30);
});

test("normalizeException: errors, error-likes, strings, objects, circulars", () => {
  const n = normalizeException(new RangeError("too big"));
  assert.equal(n.type, "RangeError");
  assert.equal(n.value, "too big");
  assert.ok(n.stack.length > 0);
  assert.deepEqual(normalizeException("plain"), { type: "Error", value: "plain", stack: [] });
  assert.equal(normalizeException({ name: "ApiError", message: "503" }).type, "ApiError");
  assert.equal(normalizeException({ code: 7 }).value, '{"code":7}');
  assert.equal(normalizeException(undefined).value, "undefined");
  const circular = {};
  circular.self = circular;
  assert.equal(normalizeException(circular).value, "[object Object]");
});

test("normalizeChain walks error.cause, bounded and cycle-safe", () => {
  const root = new Error("db down");
  const mid = new Error("query failed", { cause: root });
  const top = new TypeError("render failed", { cause: mid });
  assert.deepEqual(normalizeChain(top).map((n) => n.value), ["render failed", "query failed", "db down"]);
  const a = new Error("a");
  a.cause = a;
  assert.equal(normalizeChain(a).length, 1);
  let deep = new Error("0");
  for (let i = 1; i < 20; i++) deep = new Error(String(i), { cause: deep });
  assert.equal(normalizeChain(deep).length, 5);
  assert.equal(normalizeChain(new Error("x", { cause: "string cause" }))[1].value, "string cause");
});

test("fingerprint: stable for the same crash, different for different crashes", () => {
  const a = { type: "TypeError", value: "x is undefined\nsecond line differs 1", stack: parseStack(CHROME) };
  const b = { type: "TypeError", value: "x is undefined\nsecond line differs 2", stack: parseStack(CHROME) };
  assert.equal(fingerprintOf(a), fingerprintOf(b), "only the first message line counts");
  assert.match(fingerprintOf(a), /^[0-9a-f]+$/);
  assert.notEqual(fingerprintOf(a), fingerprintOf({ ...a, type: "RangeError" }));
  assert.notEqual(fingerprintOf(a), fingerprintOf({ ...a, stack: parseStack(FIREFOX).slice(1) }));
  // Frames below the top three do not affect grouping.
  assert.equal(fingerprintOf(a), fingerprintOf({ ...a, stack: a.stack.slice(0, 3) }));
  // GROUPING IS A CONTRACT. v0.2 deliberately broke v0.1's hashes once (v0.1 keyed on line
  // numbers, so every deploy — and every FIX — regrouped issues; and v0.1 persisted nothing, so
  // there was no history to orphan). From here on these values must not change without a
  // server-side migration that aliases old fingerprints to new ones.
  assert.equal(fingerprintOf({ type: "Error", value: "boom", stack: [] }), "d6ae3dc654c68902");
  const twoFrames = [{ function: "pay", file: "a.js", line: 1 }, { function: "run", file: "b.js", line: 2 }];
  assert.equal(fingerprintOf({ type: "TypeError", value: "x", stack: twoFrames }), "ac7ac9c9a7924a45");
});

test("fingerprint: survives what is NOT the bug changing (lines, build hashes, ids in the message)", () => {
  const at = (fn, file, line) => ({ function: fn, file, line, column: 1 });
  const base = { type: "TypeError", value: "Cannot read properties of undefined (reading 'weight')", stack: [at("Product", "http://shop.test/_next/static/chunks/app/product/page-3f9a2c1b9d.js", 23), at("render", "http://shop.test/_next/static/chunks/main-77aa01ffee.js", 900)] };
  // an edit above the throw site — or the ghost's own fix — moves line numbers
  const moved = { ...base, stack: [at("Product", base.stack[0].file, 31), at("render", base.stack[1].file, 912)] };
  assert.equal(fingerprintOf(moved), fingerprintOf(base), "line numbers must not regroup an issue");
  // a new deploy renames every chunk
  const redeployed = { ...base, stack: [at("Product", "http://shop.test/_next/static/chunks/app/product/page-0c55e1d2aa.js?v=9", 23), at("render", "http://cdn.shop.test/_next/static/chunks/main-b1b2b3b4c5.js", 900)] };
  assert.equal(fingerprintOf(redeployed), fingerprintOf(base), "build content-hashes must not regroup an issue");
  // one bug, many users / amounts
  const msg = (v) => fingerprintOf({ type: "Error", value: v, stack: base.stack });
  assert.equal(msg("user 7712 not found"), msg("user 9 not found"));
  assert.equal(msg("payment failed: card declined for $4200"), msg("payment failed: card declined for $19.00"));
  assert.equal(msg("order 1f0e2d3c-aaaa-4bbb-8ccc-1234567890ab is locked"), msg("order 9a8b7c6d-eeee-4fff-8000-abcdefabcdef is locked"));
  // …but genuinely different bugs still separate
  assert.notEqual(msg("user 7712 not found"), msg("user 7712 is banned"));
  assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, stack: [at("Cart", base.stack[0].file, 23), base.stack[1]] }), "a different function is a different bug");
  assert.equal(fingerprintOf(base).length, 16, "64-bit key");
});

test("shouldIgnoreError: built-in noise and user patterns", () => {
  const e = (value, stack = [], type = "Error") => ({ type, value, stack });
  const frame = [{ function: "f", file: "a.js", line: 1, column: 1 }];
  assert.equal(shouldIgnoreError(e("ResizeObserver loop limit exceeded", frame)), true);
  assert.equal(shouldIgnoreError(e("ResizeObserver loop completed with undelivered notifications.")), true);
  assert.equal(shouldIgnoreError(e("Script error.")), true);
  assert.equal(shouldIgnoreError(e("Script error.", frame)), false, "with a stack it is a real error");
  assert.equal(shouldIgnoreError(e("boom")), false);
  assert.equal(shouldIgnoreError(e("Network request failed"), ["request failed"]), true);
  assert.equal(shouldIgnoreError(e("Network request failed"), [/^network/i]), true);
  assert.equal(shouldIgnoreError(e("x", [], "AbortError"), [/^AbortError:/]), true, "patterns also see 'Type: message'");
  const sticky = /boom/g;
  assert.equal(shouldIgnoreError(e("boom"), [sticky]), true);
  assert.equal(shouldIgnoreError(e("boom"), [sticky]), true, "a /g regex must not alternate");
  assert.equal(shouldIgnoreError(e("boom"), [null, 5, "", {}]), false, "junk patterns are harmless");
  assert.equal(shouldIgnoreError(e("boom"), "boom"), false, "a non-array is ignored, not a crash");
});

test("rate limiter: allows a burst of `max`, then blocks until the window passes", () => {
  let t = 0;
  const limited = createRateLimiter(10, 10_000, () => t);
  const results = Array.from({ length: 12 }, () => limited("fp"));
  assert.deepEqual(results, [...Array(10).fill(false), true, true]);
  assert.equal(limited("other"), false, "keys are independent");
  t = 10_001;
  assert.equal(limited("fp"), false, "a new window starts");
  for (let i = 0; i < 2000; i++) limited(`k${i}`); // must stay bounded, not throw
});

test("retry policy decisions", () => {
  assert.equal(sendDecision(200), "ok");
  assert.equal(sendDecision(204), "ok");
  for (const s of [0, 429, 500, 502, 503, 599]) assert.equal(sendDecision(s), "retry", String(s));
  for (const s of [400, 401, 403, 404, 413]) assert.equal(sendDecision(s), "drop", String(s));
});

test("backoff: 1s doubling to a 60s cap, jitter within [base/2, base]", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 20].map((a) => backoffDelay(a, () => 1)), [
    1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
  ]);
  assert.equal(backoffDelay(1, () => 0), 500);
  assert.equal(backoffDelay(10, () => 0), 30000);
  for (let i = 0; i < 100; i++) {
    const d = backoffDelay(3);
    assert.ok(d >= 2000 && d <= 4000, String(d));
  }
});

test("parseRetryAfter: seconds, HTTP dates, junk, cap", () => {
  const now = Date.parse("2026-09-18T12:00:00Z");
  assert.equal(parseRetryAfter("7", now), 7000);
  assert.equal(parseRetryAfter("Fri, 18 Sep 2026 12:00:30 GMT", now), 30000);
  assert.equal(parseRetryAfter("99999", now), 300000);
  for (const v of [null, undefined, "", "soon", "-5", "0"]) assert.equal(parseRetryAfter(v, now), 0);
});

test("uuid and stripQuery", () => {
  const ids = new Set(Array.from({ length: 500 }, uuid));
  assert.equal(ids.size, 500);
  assert.match([...ids][0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(stripQuery("https://x.test/a/b?token=secret#frag"), "https://x.test/a/b");
  assert.equal(stripQuery("/a"), "/a");
});
