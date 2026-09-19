import { test } from "node:test";
import assert from "node:assert/strict";
import { testClient, fakeClock, fakeFetch, fakeStorage, byEvent } from "./helpers.js";
import { createClient } from "../src/client.js";
import { createIdentity, SESSION_IDLE_MS, SESSION_MAX_MS } from "../src/session.js";
import { safeStorage } from "../src/storage.js";

test("beforeSend can mutate, replace and drop events", () => {
  const { client } = testClient({
    flushAt: 1000,
    beforeSend(evt) {
      if (evt.event === "secret") return null;
      if (evt.event === "replace") return { ...evt, event: "replaced" };
      if (evt.properties.email) evt.properties.email = "[redacted]";
      return evt;
    },
  });
  client.capture("signup", { email: "a@b.c" });
  client.capture("secret");
  client.capture("replace");
  assert.deepEqual(client._queue.map((e) => e.event), ["signup", "replaced"]);
  assert.equal(client._queue[0].properties.email, "[redacted]");
  assert.ok(client._queue[1].uuid);
});

test("a throwing beforeSend never propagates and the event is still sent", () => {
  const { client } = testClient({
    flushAt: 1000,
    beforeSend() {
      throw new Error("bug in the host's hook");
    },
  });
  assert.doesNotThrow(() => client.capture("e"));
  assert.doesNotThrow(() => client.captureException(new Error("boom")));
  assert.doesNotThrow(() => client.log.error("x"));
  assert.deepEqual(client._queue.map((e) => e.event), ["e", "$exception", "$log"]);
});

test("sampling keeps roughly sampleRate of events, never drops $identify", () => {
  let i = 0;
  const random = () => (i++ % 10) / 10; // 0, .1, .2 ... .9
  const { client } = testClient({ sampleRate: 0.3, flushAt: 10_000 }, { random });
  for (let n = 0; n < 100; n++) client.capture("e");
  assert.equal(client._queue.length, 30);

  const none = testClient({ sampleRate: 0, flushAt: 10_000 });
  none.client.capture("e");
  none.client.captureException(new Error("x"));
  none.client.identify("user_1");
  assert.deepEqual(none.client._queue.map((e) => e.event), ["$identify"]);

  const all = testClient({ sampleRate: 1, flushAt: 10_000 }, { random: () => 0.999 });
  all.client.capture("e");
  assert.equal(all.client._queue.length, 1);
});

test("$exception shape: list, cause chain, mechanism, level, fingerprint, steps", () => {
  const { client } = testClient({ flushAt: 1000 });
  client.addStep("opened cart", { items: 2 });
  client.addStep("clicked pay", { $category: "ui" });
  const err = new TypeError("render failed", { cause: new Error("db down") });
  client.captureException(err, { where: "checkout" });
  client.captureException(err, { $handled: false, $mechanism: "onerror" });
  const [handled, unhandled] = client._queue;
  const p = handled.properties;
  assert.equal(p.$exception_list.length, 2);
  assert.equal(p.$exception_list[0].type, "TypeError");
  assert.equal(p.$exception_list[0].value, "render failed");
  assert.ok(p.$exception_list[0].stacktrace.frames.length > 0);
  assert.deepEqual(Object.keys(p.$exception_list[0].stacktrace.frames[0]), ["function", "file", "line", "column"]);
  assert.deepEqual(p.$exception_list[0].mechanism, { handled: true, synthetic: false, type: "manual" });
  assert.equal(p.$exception_list[1].value, "db down");
  assert.equal(p.$exception_list[1].mechanism.type, "cause");
  assert.equal(p.$exception_level, "error");
  assert.equal(p.where, "checkout");
  assert.match(p.$exception_fingerprint, /^[0-9a-f]+$/);
  assert.deepEqual(p.$exception_steps.map((s) => [s.$message, s.$category]), [["opened cart", "custom"], ["clicked pay", "ui"]]);
  assert.equal(p.$exception_steps[0].items, 2);
  assert.ok(p.$exception_steps[0].$timestamp);
  assert.equal(unhandled.properties.$exception_level, "fatal");
  assert.equal(unhandled.properties.$exception_list[0].mechanism.handled, false);
  assert.equal(unhandled.properties.$exception_fingerprint, p.$exception_fingerprint);
});

test("breadcrumb buffer keeps the newest 50", () => {
  const { client } = testClient();
  for (let i = 0; i < 80; i++) client.addStep(`step ${i}`);
  client.captureException(new Error("x"));
  const steps = client._queue[0].properties.$exception_steps;
  assert.equal(steps.length, 50);
  assert.equal(steps[49].$message, "step 79");
});

test("burst protection: at most 10 identical exceptions per 10 s window", async () => {
  const { client, clock } = testClient({ flushAt: 10_000 }, { fetch: fakeFetch(() => new TypeError("offline")) });
  const boom = () => client.captureException({ name: "Error", message: "loop", stack: "    at f (a.js:1:1)" });
  for (let i = 0; i < 500; i++) boom();
  assert.equal(byEvent(client._queue, "$exception").length, 10);
  client.captureException(new Error("a different error"));
  assert.equal(byEvent(client._queue, "$exception").length, 11, "other fingerprints are unaffected");
  await clock.tick(10_001);
  boom();
  assert.equal(byEvent(client._queue, "$exception").length, 12);
  for (let i = 0; i < 500; i++) client.log.warn("hot loop");
  assert.equal(byEvent(client._queue, "$log").length, 10);
});

test("ignoreErrors and built-in noise filters", () => {
  const { client } = testClient({ flushAt: 1000, ignoreErrors: ["Non-Error promise rejection", /^ChunkLoadError/] });
  client.captureException(new Error("Non-Error promise rejection captured"));
  client.captureException({ name: "ChunkLoadError", message: "Loading chunk 7 failed" });
  client.captureException({ name: "Error", message: "ResizeObserver loop limit exceeded", stack: "" });
  client.captureException({ name: "Error", message: "Script error.", stack: "" });
  assert.equal(client._queue.length, 0);
  client.captureException(new Error("Script error.")); // has a real stack
  client.captureException(new Error("a real one"));
  assert.equal(client._queue.length, 2);
});

test("identify / reset / getDistinctId", () => {
  const localStorage = fakeStorage();
  const { client } = testClient({ flushAt: 1000 }, { localStorage });
  const anon = client.getDistinctId();
  assert.match(anon, /^[0-9a-f-]{36}$/);
  assert.equal(localStorage.getItem("s98_did"), anon);

  client.capture("before");
  client.identify("user_42", { plan: "pro" }, { first_seen: "2026-09-18" });
  client.capture("after");
  const [before, ident, after] = client._queue;
  assert.equal(before.distinct_id, anon);
  assert.equal(ident.event, "$identify");
  assert.equal(ident.distinct_id, "user_42");
  assert.equal(ident.properties.$anon_distinct_id, anon);
  assert.deepEqual(ident.properties.$set, { plan: "pro" });
  assert.deepEqual(ident.properties.$set_once, { first_seen: "2026-09-18" });
  assert.equal(after.distinct_id, "user_42");
  assert.equal(client.getDistinctId(), "user_42");
  assert.equal(localStorage.getItem("s98_did"), "user_42");

  client.identify("user_42"); // same person, nothing new: no event
  client.identify(null);
  client.identify("");
  assert.equal(byEvent(client._queue, "$identify").length, 1);
  client.identify("user_42", { plan: "team" }); // property update
  assert.equal(byEvent(client._queue, "$identify").length, 2);
  client.identify(7); // A -> B without reset must not merge the two people
  const last = client._queue[client._queue.length - 1];
  assert.equal(last.distinct_id, "7");
  assert.equal("$anon_distinct_id" in last.properties, false);

  // The identified id survives a reload...
  assert.equal(testClient({}, { localStorage }).client.getDistinctId(), "7");
  // ...and reset() starts a fresh anonymous person.
  const session = client.getSessionId();
  client.register({ team: "red" });
  client.reset();
  const fresh = client.getDistinctId();
  assert.notEqual(fresh, "7");
  assert.notEqual(fresh, anon);
  assert.match(fresh, /^[0-9a-f-]{36}$/);
  assert.notEqual(client.getSessionId(), session);
  client.capture("post-reset");
  assert.equal(client._queue[client._queue.length - 1].properties.team, undefined, "super-properties are cleared");
  client.identify("user_99");
  assert.equal(client._queue[client._queue.length - 1].properties.$anon_distinct_id, fresh);
});

test("register() super-properties ride on every event and persist", () => {
  const localStorage = fakeStorage();
  const { client } = testClient({ flushAt: 1000 }, { localStorage });
  client.register({ plan: "pro", team: "red" });
  client.register({ team: "blue" });
  client.capture("a", { team: "explicit wins" });
  client.capture("b");
  client.unregister("plan");
  client.capture("c");
  assert.equal(client._queue[0].properties.team, "explicit wins");
  assert.deepEqual([client._queue[1].properties.plan, client._queue[1].properties.team], ["pro", "blue"]);
  assert.equal(client._queue[2].properties.plan, undefined);
  const reloaded = testClient({ flushAt: 1000 }, { localStorage }).client;
  reloaded.capture("d");
  assert.equal(reloaded._queue[reloaded._queue.length - 1].properties.team, "blue");
});

test("session rotates after 30 min idle or 24 h total, and is shared through storage", () => {
  let t = 1_700_000_000_000;
  const now = () => t;
  const local = fakeStorage();
  const tabA = createIdentity(safeStorage(() => local), safeStorage(() => fakeStorage()), now);
  const s1 = tabA.getSessionId();
  t += SESSION_IDLE_MS - 1;
  assert.equal(tabA.getSessionId(), s1, "activity just inside the idle window keeps the session");
  t += SESSION_IDLE_MS + 1;
  const s2 = tabA.getSessionId();
  assert.notEqual(s2, s1, "idle for more than 30 minutes");

  // Constant activity still ends the session at 24 h.
  const start = t;
  while (t - start <= SESSION_MAX_MS - 600_000) {
    t += 600_000;
    assert.equal(tabA.getSessionId(), s2);
  }
  t += 600_001;
  const s3 = tabA.getSessionId();
  assert.notEqual(s3, s2, "older than 24 hours");

  // A second tab over the same localStorage joins the session; window ids differ.
  const tabB = createIdentity(safeStorage(() => local), safeStorage(() => fakeStorage()), now);
  assert.equal(tabB.getSessionId(), s3);
  assert.equal(tabB.getDistinctId(), tabA.getDistinctId());
  assert.notEqual(tabB.getWindowId(), tabA.getWindowId());
  // When B rotates it, A follows rather than forking.
  t += SESSION_IDLE_MS + 1;
  const s4 = tabB.getSessionId();
  assert.notEqual(s4, s3);
  assert.equal(tabA.getSessionId(), s4);
});

test("log API emits $log events", () => {
  const { client } = testClient({ flushAt: 1000 });
  client.log.debug("d");
  client.log.info("cart synced", { items: 3 });
  client.log.warn("slow");
  client.log.error("failed", { code: 7 });
  assert.deepEqual(client._queue.map((e) => [e.event, e.properties.$level, e.properties.$message]), [
    ["$log", "debug", "d"],
    ["$log", "info", "cart synced"],
    ["$log", "warn", "slow"],
    ["$log", "error", "failed"],
  ]);
  assert.equal(client._queue[1].properties.items, 3);
});

test("feature flags: load, cache, callbacks, $feature_flag_called once per session", async () => {
  const localStorage = fakeStorage();
  const fetch = fakeFetch((n, url) =>
    url.includes("/api/flags") ? { status: 200, json: { flags: { "new-checkout": true, theme: "dark", off: false } } } : { status: 200 }
  );
  const { client, clock } = testClient({ flushAt: 1000 }, { fetch, localStorage });
  assert.equal(client.isFeatureEnabled("new-checkout"), false, "unknown until loaded");
  assert.equal(client._queue.length, 0, "and not reported while unknown");
  const seen = [];
  const off = client.onFeatureFlags((flags) => seen.push(flags));
  client.onFeatureFlags(() => {
    throw new Error("bad listener");
  });
  await client.reloadFeatureFlags();
  assert.equal(
    fetch.calls[0].url,
    `http://s98.test/api/flags?key=proj_key&distinct_id=${client.getDistinctId()}`
  );
  assert.equal(fetch.calls[0].init.method, "GET");
  assert.equal(seen.length, 1);
  assert.equal(client.isFeatureEnabled("new-checkout"), true);
  assert.equal(client.isFeatureEnabled("new-checkout"), true);
  assert.equal(client.getFeatureFlag("theme"), "dark");
  assert.equal(client.isFeatureEnabled("off"), false);
  assert.equal(client.isFeatureEnabled("missing"), false);
  assert.equal(client.getFeatureFlag("missing"), undefined);
  const called = byEvent(client._queue, "$feature_flag_called").map((e) => [e.properties.$feature_flag, e.properties.$feature_flag_response]);
  assert.deepEqual(called, [["new-checkout", true], ["theme", "dark"], ["off", false], ["missing", false]]);

  // A new session reports again.
  await clock.tick(31 * 60_000);
  client.isFeatureEnabled("theme");
  client.isFeatureEnabled("theme");
  // (the first four were delivered by the interval flush while the clock advanced)
  assert.equal(byEvent(fetch.events(), "$feature_flag_called").length, 4);
  assert.equal(byEvent(client._queue, "$feature_flag_called").length, 1);

  off();
  await client.reloadFeatureFlags();
  assert.equal(seen.length, 1, "unsubscribed");

  // Next page load: flags are available synchronously from the cache.
  const next = testClient({}, { localStorage, fetch: fakeFetch(() => new TypeError("offline")) });
  assert.equal(next.client.getFeatureFlag("theme"), "dark");
  let immediate = null;
  next.client.onFeatureFlags((f) => (immediate = f));
  assert.equal(immediate.theme, "dark");
});

test("feature flag failures are silent", async () => {
  for (const responder of [() => new TypeError("offline"), () => ({ status: 500 }), () => ({ status: 200, json: "nonsense" })]) {
    const { client } = testClient({}, { fetch: fakeFetch(responder) });
    await assert.doesNotReject(client.reloadFeatureFlags());
    assert.equal(client.isFeatureEnabled("x"), false);
  }
  const broken = testClient({}, { fetch: () => { throw new Error("sync"); } }); // prettier-ignore
  await assert.doesNotReject(broken.client.reloadFeatureFlags());
});

test("unserializable properties cannot wedge the queue", async () => {
  const { client, fetch } = testClient({ flushAt: 1000 });
  const circular = { name: "loop" };
  circular.self = circular;
  assert.doesNotThrow(() => client.capture("poison", { circular, big: 10n }));
  client.capture("fine");
  await client.flush();
  assert.deepEqual(fetch.events().map((e) => e.event), ["poison", "fine"]);
  assert.equal(fetch.events()[0].properties.circular.self, "[Circular]");
  assert.equal(fetch.events()[0].properties.big, "10");
});

test("missing host disables capture instead of throwing; respectDNT disables everything", () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  let client;
  try {
    assert.doesNotThrow(() => (client = createClient({})));
    assert.doesNotThrow(() => createClient());
  } finally {
    console.warn = warn;
  }
  assert.equal(client.disabled, true);
  assert.match(warnings[0], /host/);
  client.capture("e");
  client.captureException(new Error("x"));
  assert.equal(client._queue.length, 0);

  const win = { document: {}, navigator: { doNotTrack: "1" }, location: { hostname: "x", search: "" } };
  const localStorage = fakeStorage({ s98_queue: JSON.stringify([{ uuid: "u", event: "old" }]) });
  const dnt = testClient({ respectDNT: true }, { win, localStorage });
  dnt.client.capture("e");
  dnt.client.identify("u1");
  assert.equal(dnt.client.disabled, true);
  assert.equal(dnt.client._queue.length, 0, "nothing captured, nothing recovered");
  assert.equal(localStorage.map.size, 1, "and nothing written");
});
