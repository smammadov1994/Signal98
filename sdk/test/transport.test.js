import { test } from "node:test";
import assert from "node:assert/strict";
import { testClient, fakeClock, fakeFetch, fakeStorage } from "./helpers.js";

test("envelope, URL and event shape follow PROTOCOL.md", async () => {
  const { client, fetch, clock } = testClient({ release: "1.2.3", environment: "staging", service: "checkout" });
  client.capture("signup", { plan: "pro" });
  assert.equal(fetch.calls.length, 0, "a single ordinary event waits for the flush interval");
  await clock.tick(3000);
  assert.equal(fetch.calls.length, 1);
  const { url, init, body } = fetch.calls[0];
  assert.equal(url, "http://s98.test/api/ingest?key=proj_key");
  assert.equal(init.method, "POST");
  assert.equal(init.keepalive, true);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.deepEqual(Object.keys(body), ["api_key", "sent_at", "batch"]);
  assert.equal(body.api_key, "proj_key");
  assert.ok(!Number.isNaN(Date.parse(body.sent_at)));
  const evt = body.batch[0];
  assert.deepEqual(Object.keys(evt), ["uuid", "event", "timestamp", "distinct_id", "properties"]);
  assert.match(evt.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(evt.event, "signup");
  assert.equal(evt.distinct_id, client.getDistinctId());
  assert.deepEqual(
    { ...evt.properties },
    { $release: "1.2.3", $environment: "staging", $service: "checkout", plan: "pro", $lib: "signal98", $lib_version: "0.2.0" }
  );
  assert.equal(client._queue.length, 0);
});

test("legacy `endpoint` option still works", async () => {
  const { client, fetch } = testClient({ host: undefined, endpoint: "http://old.test/api/ingest", apiKey: undefined });
  client.capture("x");
  await client.flush();
  assert.equal(fetch.calls[0].url, "http://old.test/api/ingest");
});

test("flushAt events trigger an immediate flush; so do $exception and $rageclick", async () => {
  const a = testClient({ flushAt: 5 });
  for (let i = 0; i < 4; i++) a.client.capture("e");
  await a.clock.settle();
  assert.equal(a.fetch.calls.length, 0);
  a.client.capture("e");
  await a.clock.settle();
  assert.equal(a.fetch.calls.length, 1);
  assert.equal(a.fetch.calls[0].body.batch.length, 5);

  const b = testClient();
  b.client.captureException(new Error("boom"));
  await b.clock.settle();
  assert.equal(b.fetch.calls.length, 1, "exceptions do not wait for the interval");

  const c = testClient();
  c.client.capture("$rageclick", { $click_count: 3 });
  await c.clock.settle();
  assert.equal(c.fetch.calls.length, 1);
});

test("queue is bounded and drops the oldest", () => {
  const { client } = testClient({ maxQueue: 5, flushAt: 1000 });
  for (let i = 0; i < 12; i++) client.capture("e", { i });
  assert.equal(client._queue.length, 5);
  assert.deepEqual(client._queue.map((e) => e.properties.i), [7, 8, 9, 10, 11]);
});

test("only one flush is in flight at a time, and it drains what arrives meanwhile", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const fetch = fakeFetch(async (n) => {
    if (n === 1) await gate;
    return { status: 200 };
  });
  const { client, clock } = testClient({}, { fetch });
  client.capture("first");
  const p1 = client.flush();
  client.capture("second");
  const p2 = client.flush();
  client.captureException(new Error("urgent while busy"));
  await clock.settle();
  assert.equal(fetch.calls.length, 1, "no second request while the first is pending");
  assert.equal(p1, p2, "concurrent flushes share the in-flight promise");
  release();
  await p1;
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(fetch.calls[1].body.batch.map((e) => e.event), ["second", "$exception"]);
  assert.equal(client._queue.length, 0);
});

test("network failure: batch is kept and retried with exponential backoff", async () => {
  const fetch = fakeFetch((n) => (n <= 3 ? new TypeError("Failed to fetch") : { status: 200 }));
  const { client, clock } = testClient({}, { fetch, random: () => 0.999999 }); // top of the jitter range: delay == base
  client.capture("keep-me");
  await client.flush();
  assert.equal(fetch.calls.length, 1);
  assert.equal(client._queue.length, 1, "not lost");
  assert.deepEqual(clock.pending(), [1000]);

  client.captureException(new Error("during backoff"));
  await clock.settle();
  assert.equal(fetch.calls.length, 1, "urgent events respect the backoff window");

  await clock.tick(999);
  assert.equal(fetch.calls.length, 1);
  await clock.tick(1);
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(clock.pending(), [2000]);
  await clock.tick(2000);
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(clock.pending(), [4000]);
  await clock.tick(4000);
  assert.equal(fetch.calls.length, 4);
  assert.equal(client._queue.length, 0, "delivered on the 4th attempt");
  assert.deepEqual(fetch.calls[3].body.batch.map((e) => e.event), ["keep-me", "$exception"]);
  // Same uuid on every attempt: the server can de-duplicate.
  assert.equal(fetch.calls[0].body.batch[0].uuid, fetch.calls[3].body.batch[0].uuid);

  // Success resets the backoff.
  fetch.calls.length = 0;
  client.capture("later");
  await clock.tick(3000);
  assert.equal(fetch.calls.length, 1);
});

test("429 honours Retry-After; 5xx retries; other 4xx drops", async () => {
  const a = testClient({}, { fetch: fakeFetch((n) => (n === 1 ? { status: 429, headers: { "Retry-After": 7 } } : { status: 200 })) });
  a.client.capture("e");
  await a.client.flush();
  assert.equal(a.client._queue.length, 1);
  assert.deepEqual(a.clock.pending(), [7000], "Retry-After (7s) beats the 1s backoff");
  await a.clock.tick(7000);
  assert.equal(a.fetch.calls.length, 2);
  assert.equal(a.client._queue.length, 0);

  const b = testClient({}, { fetch: fakeFetch((n) => ({ status: n === 1 ? 503 : 200 })) });
  b.client.capture("e");
  await b.client.flush();
  assert.equal(b.client._queue.length, 1, "503 keeps the batch");
  await b.clock.tick(1000);
  assert.equal(b.client._queue.length, 0);

  for (const status of [400, 401, 403, 404]) {
    const c = testClient({}, { fetch: fakeFetch(() => ({ status })) });
    c.client.capture("e");
    await c.client.flush();
    assert.equal(c.client._queue.length, 0, `${status} drops the batch`);
    assert.deepEqual(c.clock.pending(), [], `${status} schedules no retry`);
    assert.equal(c.fetch.calls.length, 1);
  }
});

test("413 splits the batch instead of dropping everything", async () => {
  const fetch = fakeFetch((n, url, init) => ({ status: JSON.parse(init.body).batch.length > 2 ? 413 : 200 }));
  const { client } = testClient({ flushAt: 1000 }, { fetch });
  for (let i = 0; i < 8; i++) client.capture("e", { i });
  await client.flush();
  assert.equal(client._queue.length, 0);
  const delivered = fetch.calls.filter((c) => c.body.batch.length <= 2).flatMap((c) => c.body.batch.map((e) => e.properties.i));
  assert.deepEqual(delivered, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("the unsent queue is persisted and recovered by the next page load", async () => {
  const localStorage = fakeStorage();
  const down = fakeFetch(() => new TypeError("offline"));
  const first = testClient({}, { localStorage, fetch: down });
  first.client.capture("survivor", { n: 1 });
  first.client.captureException(new Error("crash before reload"));
  await first.clock.tick(300);
  const saved = JSON.parse(localStorage.getItem("s98_queue"));
  assert.deepEqual(saved.map((e) => e.event), ["survivor", "$exception"]);

  // "Reload": a new client over the same storage, network is back.
  const second = testClient({}, { localStorage });
  assert.deepEqual(second.client._queue.map((e) => e.event), ["survivor", "$exception"]);
  assert.equal(second.client.getDistinctId(), first.client.getDistinctId(), "identity survives too");
  await second.clock.tick(1000);
  assert.deepEqual(second.fetch.events().map((e) => e.uuid), saved.map((e) => e.uuid));
  assert.equal(localStorage.getItem("s98_queue"), null, "cleared once delivered");
});

test("persisted queue is size-bounded (~200 KB) and keeps the newest events", async () => {
  const localStorage = fakeStorage();
  const { client, clock } = testClient({ flushAt: 10_000 }, { localStorage, fetch: fakeFetch(() => new TypeError("offline")) });
  for (let i = 0; i < 100; i++) client.capture("big", { i, blob: "x".repeat(10_000) });
  await clock.tick(250);
  const raw = localStorage.getItem("s98_queue");
  assert.ok(raw.length <= 200_000, `persisted ${raw.length} chars`);
  const saved = JSON.parse(raw);
  assert.ok(saved.length >= 15 && saved.length < 25);
  assert.equal(saved[saved.length - 1].properties.i, 99, "newest kept");
});

test('persistence: "memory" touches no storage; corrupted storage is survivable', () => {
  const localStorage = fakeStorage();
  const sessionStorage = fakeStorage();
  const { client } = testClient({ persistence: "memory" }, { localStorage, sessionStorage });
  client.capture("e");
  client.identify("u1");
  client.register({ plan: "pro" });
  assert.equal(localStorage.map.size + sessionStorage.map.size, 0);

  const junk = fakeStorage({ s98_queue: "{not json", s98_sid: "[]", s98_props: "null", s98_flags: '"x"' });
  const ok = testClient({}, { localStorage: junk });
  ok.client.capture("still works");
  assert.equal(ok.client._queue.length, 1);

  const hostile = {
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem() {
      throw new Error("SecurityError");
    },
  };
  const h = testClient({}, { localStorage: hostile, sessionStorage: hostile });
  h.client.capture("e");
  h.client.identify("u2", { plan: "free" });
  assert.equal(h.client.getDistinctId(), "u2");
});

test("a throwing / rejecting / hanging-up fetch never propagates", async () => {
  const sync = testClient({}, { fetch: () => { throw new Error("sync boom"); } }); // prettier-ignore
  sync.client.capture("e");
  await assert.doesNotReject(sync.client.flush());
  assert.equal(sync.client._queue.length, 1);

  const weird = testClient({}, { fetch: async () => undefined }); // resolves to garbage
  weird.client.captureException(new Error("x"));
  await assert.doesNotReject(weird.client.flush());
  assert.equal(weird.client._queue.length, 1, "treated as a network failure");

  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const rej = testClient({}, { fetch: () => Promise.reject(new Error("async boom")) });
  rej.client.captureException(new Error("y")); // fire-and-forget flush path
  await rej.clock.tick(5000);
  await new Promise((r) => setImmediate(r));
  process.removeListener("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, []);
});

test("close() flushes what is left and stops accepting events", async () => {
  const { client, fetch, clock } = testClient();
  client.capture("last words");
  await client.close();
  assert.deepEqual(fetch.events().map((e) => e.event), ["last words"]);
  client.capture("after close");
  client.captureException(new Error("after close"));
  await clock.tick(10_000);
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(clock.pending(), [], "no timers left behind");
  await assert.doesNotReject(client.close());
});
