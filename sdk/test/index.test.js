import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as s98 from "../src/index.js";
import { fakeClock, fakeFetch } from "./helpers.js";

let lastFetch;
function env(fetch = fakeFetch()) {
  const clock = fakeClock();
  lastFetch = fetch;
  return { win: null, fetch, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now };
}
const start = (options = {}) => s98.init({ host: "http://s98.test", autoCapture: false, flushAt: 1000, _env: env(), ...options });

afterEach(() => s98.close());

test("public API surface", () => {
  const fns = [
    "init", "capture", "captureException", "wrap", "addStep", "identify", "reset", "register", "unregister",
    "getDistinctId", "getSessionId", "isFeatureEnabled", "getFeatureFlag", "onFeatureFlags", "reloadFeatureFlags",
    "flush", "close", "getClient", "createClient", "installBrowser", "installNode", "errorHandler", "requestHandler",
  ]; // prettier-ignore
  for (const name of fns) assert.equal(typeof s98[name], "function", name);
  for (const level of ["debug", "info", "warn", "error"]) assert.equal(typeof s98.log[level], "function");
});

test("every call before init() is a safe no-op", async () => {
  assert.doesNotThrow(() => {
    s98.capture("e");
    s98.captureException(new Error("x"));
    s98.addStep("s");
    s98.identify("u");
    s98.reset();
    s98.register({ a: 1 });
    s98.log.error("x");
    s98.getClient().capture("e");
  });
  assert.equal(s98.isFeatureEnabled("x"), false);
  assert.equal(s98.getFeatureFlag("x"), undefined);
  assert.equal(s98.getDistinctId(), undefined);
  assert.equal(typeof s98.onFeatureFlags(() => {}), "function");
  await assert.doesNotReject(s98.flush());
  await assert.doesNotReject(s98.reloadFeatureFlags());
  await assert.doesNotReject(s98.close());
  assert.equal(await s98.wrap(async () => 5)(), 5, "wrap works uninitialised too");
});

test("init() is idempotent; close() allows a fresh init", async () => {
  const a = start();
  const b = start({ environment: "ignored" });
  assert.equal(a, b);
  assert.equal(s98.getClient(), a);
  await s98.close();
  const c = start();
  assert.notEqual(c, a);
});

test("init() never throws, even on hostile options", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => s98.init());
    s98.close();
    assert.doesNotThrow(() => s98.init({ host: { toString() { throw new Error("nope"); } } })); // prettier-ignore
    assert.doesNotThrow(() => s98.capture("after a failed init"));
  } finally {
    console.warn = warn;
  }
});

test("wrap(): sync — returns the value, reports and rethrows the same error", () => {
  const client = start();
  const add = s98.wrap((a, b) => a + b);
  assert.equal(add(2, 3), 5);
  const err = new RangeError("sync failure");
  const risky = s98.wrap(function namedFn() { throw err; }, { properties: { area: "billing" } }); // prettier-ignore
  assert.throws(() => risky(), (e) => e === err);
  assert.equal(risky.name, "signal98_wrapped_namedFn");
  const p = client._queue[0].properties;
  assert.equal(p.$exception_list[0].type, "RangeError");
  assert.deepEqual([p.$mechanism, p.$fn, p.area, p.$handled], ["wrap", "namedFn", "billing", true]);
});

test("wrap(): async — resolves untouched, reports and re-rejects the same error", async () => {
  const client = start();
  assert.equal(await s98.wrap(async (x) => x * 2)(21), 42);
  const err = new Error("async failure");
  const risky = s98.wrap(async () => { throw err; }, { name: "saveSettings" }); // prettier-ignore
  const pending = risky();
  await assert.rejects(pending, (e) => e === err);
  // (the exception triggered an immediate flush, so look at what was sent)
  await client.flush();
  const sent = lastFetch.events();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].properties.$fn, "saveSettings");
});

test("wrap(): preserves `this` and arguments", () => {
  start();
  const obj = { base: 10, add: s98.wrap(function (n) { return this.base + n; }) }; // prettier-ignore
  assert.equal(obj.add(5), 15);
});

test("wrap(): a failure inside the SDK still rethrows the original error", () => {
  start({ beforeSend() { throw new Error("hook bug"); } }); // prettier-ignore
  const err = new Error("original");
  assert.throws(s98.wrap(() => { throw err; }), (e) => e === err); // prettier-ignore
});

test("top-level helpers delegate to the client", () => {
  const client = start();
  s98.register({ plan: "pro" });
  s98.identify("user_1", { name: "Ada" });
  s98.addStep("step");
  s98.capture("custom", { a: 1 });
  s98.log.info("hello");
  s98.captureException(new Error("boom"));
  assert.deepEqual(client._queue.map((e) => e.event), ["$identify", "custom", "$log", "$exception"]);
  assert.equal(s98.getDistinctId(), "user_1");
  assert.equal(client._queue[1].properties.plan, "pro");
  assert.equal(client._queue[3].properties.$exception_steps[0].$message, "step");
});
