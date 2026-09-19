import { test } from "node:test";
import assert from "node:assert/strict";
import { installBrowser } from "../src/browser.js";
import { rateVital, createClsTracker, createInpTracker } from "../src/vitals.js";
import { testClient, fakeWindow, fakeFetch, el, byEvent } from "./helpers.js";

// A browser-shaped client: fake window, SDK on a different origin than the app.
function boot(autoCapture = {}, options = {}, win = fakeWindow()) {
  const appFetch = win.fetch;
  const t = testClient({ flushAt: 1000, ...options }, { win, localStorage: win.localStorage, sessionStorage: win.sessionStorage });
  const uninstall = installBrowser(t.client, autoCapture);
  // Everything captured so far: already delivered (the fake clock also drives
  // the flush interval) plus still queued, de-duplicated by uuid.
  const all = () => {
    const seen = new Map();
    for (const e of [...t.fetch.events(), ...t.client._queue]) seen.set(e.uuid, e);
    return [...seen.values()];
  };
  return { ...t, win, doc: win.document, appFetch, uninstall, all, q: (name) => byEvent(all(), name) };
}

test("every browser event carries the protocol's context properties", () => {
  const { client, q } = boot();
  const p = q("$pageview")[0].properties;
  const expected = {
    $current_url: "http://app.test/home?utm_source=newsletter",
    $pathname: "/home",
    $host: "app.test",
    $referrer: "https://news.example/story",
    $referring_domain: "news.example",
    $title: "Home",
    $screen_width: 1920,
    $screen_height: 1080,
    $viewport_width: 1200,
    $viewport_height: 800,
    $user_agent: "FakeBrowser/1.0",
    $locale: "en-GB",
    $lib: "signal98",
    $lib_version: "0.2.0",
    $environment: "production",
    $service: "app.test",
    utm_source: "newsletter",
  };
  for (const [k, v] of Object.entries(expected)) assert.equal(p[k], v, k);
  assert.equal(p.$session_id, client.getSessionId());
  assert.match(p.$window_id, /^[0-9a-f-]{36}$/);
  assert.equal(typeof p.$timezone, "string");
});

test("patched globals are restored exactly by uninstall", () => {
  const win = fakeWindow();
  const before = {
    fetch: win.fetch,
    open: win.XMLHttpRequest.prototype.open,
    send: win.XMLHttpRequest.prototype.send,
    warn: win.console.warn,
    error: win.console.error,
  };
  const { uninstall, doc } = boot({ console: true }, {}, win);
  assert.notEqual(win.fetch, before.fetch);
  assert.notEqual(win.history.pushState, win.History.prototype.pushState);
  assert.ok(win.listenerCount() > 0 && doc.listenerCount() > 0);
  uninstall();
  assert.equal(win.fetch, before.fetch);
  assert.equal(win.XMLHttpRequest.prototype.open, before.open);
  assert.equal(win.XMLHttpRequest.prototype.send, before.send);
  assert.equal(win.console.warn, before.warn);
  assert.equal(win.console.error, before.error);
  // pushState was inherited, so it must be inherited again — not an own copy.
  assert.equal(Object.prototype.hasOwnProperty.call(win.history, "pushState"), false);
  assert.equal(win.history.pushState, win.History.prototype.pushState);
  assert.equal(win.listenerCount(), 1, "only the transport's `online` listener remains (removed by close())");
  assert.equal(doc.listenerCount(), 0);
  assert.doesNotThrow(uninstall, "uninstall twice is fine");
});

test("if someone else patched after us, uninstall leaves their patch alone and ours goes inert", async () => {
  const { win, uninstall, client, appFetch } = boot();
  const ours = win.fetch;
  const theirs = (...a) => ours(...a);
  win.fetch = theirs;
  uninstall();
  assert.equal(win.fetch, theirs);
  const steps = client._steps.length;
  await win.fetch("http://api.test/x");
  assert.equal(appFetch.calls.length, 1, "still reaches the real fetch");
  assert.equal(client._steps.length, steps, "but records nothing");
});

test("fetch wrapper returns the original promise and passes everything through", () => {
  const win = fakeWindow();
  const original = Promise.resolve({ status: 200, type: "basic" });
  let seen;
  win.fetch = function (...args) {
    seen = { self: this, args };
    return original;
  };
  boot({}, {}, win);
  const init = { method: "PUT", body: "{}" };
  const ctx = { custom: true };
  const out = win.fetch.call(ctx, "/api/thing", init);
  assert.equal(out, original, "the very same promise object, not a wrapper");
  assert.equal(seen.self, ctx);
  assert.deepEqual(seen.args, ["/api/thing", init]);
});

test("fetch failures still reject for the caller, exactly once, with the same error", async () => {
  const win = fakeWindow();
  const boom = new TypeError("Failed to fetch");
  win.fetch = () => Promise.reject(boom);
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const { client, q } = boot({}, {}, win);
  await assert.rejects(win.fetch("https://api.test/orders?id=1"), (e) => e === boom);
  await new Promise((r) => setImmediate(r));
  process.removeListener("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, [], "our observing branch never creates an unhandled rejection");
  const ne = q("$network_error")[0].properties;
  assert.deepEqual([ne.$method, ne.$url, ne.$status], ["GET", "https://api.test/orders", 0]);
  assert.equal(typeof ne.$duration_ms, "number");
  assert.equal(client._steps.at(-1).$message, "GET https://api.test/orders -> failed");
});

test("$network_error: 5xx and slow yes; 2xx/4xx, aborts and opaque no; query strings stripped", async () => {
  const win = fakeWindow();
  const script = [{ status: 503 }, { status: 200 }, { status: 404 }, { status: 0, type: "opaque" }, { status: 200 }];
  let n = 0;
  let clock;
  win.fetch = async (url) => {
    if (String(url).includes("slow")) await clock.tick(4500);
    if (String(url).includes("abort")) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return script[n++];
  };
  const b = boot({}, { slowRequestMs: 4000 }, win);
  clock = b.clock;
  await win.fetch("/api/a?token=secret", { method: "post" });
  await win.fetch("/api/b");
  await win.fetch("/api/c");
  await win.fetch("https://cdn.test/pixel", { mode: "no-cors" });
  await win.fetch("/api/abort").catch(() => {});
  await win.fetch("/api/slow");
  await clock.settle();
  const errs = b.q("$network_error").map((e) => e.properties);
  assert.deepEqual(errs.map((p) => [p.$method, p.$url, p.$status, p.$slow]), [
    ["POST", "http://app.test/api/a", 503, undefined],
    ["GET", "http://app.test/api/slow", 200, true],
  ]);
  assert.ok(errs[1].$duration_ms >= 4500);
  const crumbs = b.client._steps.filter((s) => s.$category === "network").map((s) => s.$message);
  assert.deepEqual(crumbs, [
    "POST http://app.test/api/a -> 503",
    "GET http://app.test/api/b -> 200",
    "GET http://app.test/api/c -> 404",
    "GET https://cdn.test/pixel -> opaque",
    "GET http://app.test/api/abort -> aborted",
    "GET http://app.test/api/slow -> 200",
  ]);
  assert.equal(JSON.stringify(b.all()).includes("secret"), false);
});

test("requests to the signal98 host are never observed (no feedback loop)", async () => {
  const { win, client, q, appFetch } = boot();
  const steps = client._steps.length;
  appFetch.calls.length = 0;
  await win.fetch("http://s98.test/api/ingest?key=proj_key", { method: "POST" });
  await win.fetch("http://s98.test/api/feed");
  const xhr = new win.XMLHttpRequest();
  xhr.open("GET", "http://s98.test/api/stream");
  xhr.send();
  xhr.respond(500);
  assert.equal(appFetch.calls.length, 2, "they pass through");
  assert.equal(client._steps.length, steps);
  assert.equal(q("$network_error").length, 0);

  // The SDK's own delivery does not run through the patched fetch at all.
  client.capture("e");
  await client.flush();
  assert.equal(appFetch.calls.length, 2);
});

test("same-origin signal98: only its own endpoints are exempt", async () => {
  const win = fakeWindow("http://app.test/");
  win.fetch = fakeFetch(() => ({ status: 500 }));
  const { q } = boot({}, { host: "http://app.test" }, win);
  await win.fetch("/api/ingest?key=k");
  await win.fetch("/api/flags?key=k&distinct_id=x");
  await win.fetch("/api/orders");
  assert.deepEqual(q("$network_error").map((e) => e.properties.$url), ["http://app.test/api/orders"]);
});

test("XMLHttpRequest: behaviour preserved, failures reported, aborts not", () => {
  const { win, q, client } = boot();
  const xhr = new win.XMLHttpRequest();
  assert.equal(xhr.open("post", "/api/pay?card=4242"), undefined);
  assert.deepEqual(xhr.opened, ["post", "/api/pay?card=4242"]);
  assert.equal(xhr.send("body"), "sent", "return value passes through");
  assert.equal(xhr.sent, "body");
  xhr.respond(502);
  const ok = new win.XMLHttpRequest();
  ok.open("GET", "/api/ok");
  ok.send();
  ok.respond(200);
  const aborted = new win.XMLHttpRequest();
  aborted.open("GET", "/api/aborted");
  aborted.send();
  aborted.fire("abort");
  aborted.respond(0);
  const dead = new win.XMLHttpRequest();
  dead.open("GET", "/api/dead");
  dead.send();
  dead.respond(0);
  assert.deepEqual(q("$network_error").map((e) => [e.properties.$method, e.properties.$url, e.properties.$status]), [
    ["POST", "http://app.test/api/pay", 502],
    ["GET", "http://app.test/api/dead", 0],
  ]);
  assert.equal(client._steps.filter((s) => s.$category === "network").length, 4);
});

test("$pageview / $pageleave follow the History API", async () => {
  const { win, clock, q, client } = boot();
  assert.equal(q("$pageview").length, 1, "on load");
  win.scrollY = 700; // 700 + 800 viewport of 2000 => 0.75
  await clock.tick(12_340);
  const state = { id: 1 };
  assert.equal(win.history.pushState(state, "", "/pricing?plan=pro"), undefined);
  assert.equal(win.location.pathname, "/pricing", "the real pushState still ran");
  assert.equal(q("$pageview").length, 2);
  assert.equal(q("$pageview")[1].properties.$pathname, "/pricing");
  const leave = q("$pageleave")[0].properties;
  assert.equal(leave.$pathname, "/home", "the leave event describes the page that was left");
  assert.equal(leave.$current_url, "http://app.test/home?utm_source=newsletter");
  assert.equal(leave.$prev_pageview_duration, 12.34);
  assert.equal(leave.$scroll_depth, 0.75);

  win.history.replaceState(state, "", "/pricing?plan=pro"); // same URL: not a navigation
  assert.equal(q("$pageview").length, 2);
  win.history.replaceState(state, "", "/pricing?plan=team");
  assert.equal(q("$pageview").length, 3);
  win.history.pushState(null, "", "/docs#intro");
  win.fire("popstate"); // URL unchanged since the last view: ignored
  assert.equal(q("$pageview").length, 4);
  const nav = client._steps.filter((s) => s.$category === "navigation").map((s) => s.$message);
  assert.deepEqual(nav, ["navigate /home -> /pricing", "navigate /pricing -> /pricing", "navigate /pricing -> /docs#intro"]);

  win.fire("pagehide");
  win.fire("pagehide");
  const leaves = new Set([...q("$pageleave"), ...byEvent(await beaconEvents(win), "$pageleave")].map((e) => e.uuid));
  assert.equal(leaves.size, 4, "one leave per view, even if pagehide repeats");
});

async function beaconEvents(win) {
  const out = [];
  for (const b of win.beacons) out.push(...JSON.parse(typeof b.blob === "string" ? b.blob : await b.blob.text()).batch);
  return out;
}

test("hidden / pagehide: web vitals are reported once and the queue goes out by sendBeacon", async () => {
  const { win, doc, client, fetch } = boot();
  const PO = win.PerformanceObserver;
  PO.emit("paint", [{ name: "first-paint", startTime: 300 }, { name: "first-contentful-paint", startTime: 900.4 }]);
  PO.emit("largest-contentful-paint", [{ startTime: 1200 }, { startTime: 2600 }]);
  PO.emit("layout-shift", [{ value: 0.05, startTime: 1000 }, { value: 0.1, startTime: 1500 }, { value: 0.9, startTime: 1600, hadRecentInput: true }]);
  PO.emit("event", [{ interactionId: 1, duration: 120 }, { interactionId: 1, duration: 560 }, { interactionId: 0, duration: 9000 }]);
  client.capture("queued before hide");

  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  assert.equal(fetch.ingests().length, 0, "fetch is not used while the page is going away");
  assert.equal(win.beacons.length, 1);
  assert.equal(win.beacons[0].url, "http://s98.test/api/ingest?key=proj_key");
  assert.equal(win.beacons[0].blob.type, "text/plain", "a CORS-simple content type: no preflight during unload");
  const events = await beaconEvents(win);
  const vitals = Object.fromEntries(byEvent(events, "$web_vitals").map((e) => [e.properties.$metric, [e.properties.$value, e.properties.$rating]]));
  assert.deepEqual(vitals, {
    LCP: [2600, "needs-improvement"],
    CLS: [0.15, "needs-improvement"],
    INP: [560, "poor"],
    FCP: [900, "good"],
    TTFB: [120, "good"],
  });
  assert.ok(events.some((e) => e.event === "queued before hide"));
  assert.equal(client._queue.length, 0, "handed to the beacon");

  doc.fire("visibilitychange");
  win.fire("pagehide");
  assert.equal(byEvent(await beaconEvents(win), "$web_vitals").length, 5, "vitals are reported once");
});

test("a refused beacon keeps the events (persisted for the next load)", () => {
  const win = fakeWindow();
  win.navigator.sendBeacon = () => false;
  const { client, fetch } = boot({}, {}, win);
  win.fire("pagehide");
  assert.ok(fetch.ingests().length >= 1, "falls back to a keepalive fetch");
  assert.ok(JSON.parse(win.localStorage.getItem("s98_queue")).length >= 2);
  void client;
});

test("web vitals helpers: ratings and CLS session windows", () => {
  assert.deepEqual([rateVital("LCP", 2500), rateVital("LCP", 2501), rateVital("LCP", 4001)], ["good", "needs-improvement", "poor"]);
  assert.deepEqual([rateVital("CLS", 0.1), rateVital("CLS", 0.25), rateVital("CLS", 0.26)], ["good", "needs-improvement", "poor"]);
  assert.deepEqual([rateVital("INP", 200), rateVital("INP", 500), rateVital("INP", 501)], ["good", "needs-improvement", "poor"]);
  assert.deepEqual([rateVital("FCP", 1800), rateVital("FCP", 3001)], ["good", "poor"]);
  assert.deepEqual([rateVital("TTFB", 800), rateVital("TTFB", 1801)], ["good", "poor"]);
  assert.equal(rateVital("???", 1), undefined);
  const cls = createClsTracker();
  cls({ value: 0.1, startTime: 0 });
  cls({ value: 0.1, startTime: 500 });
  assert.ok(Math.abs(cls({ value: 0.05, startTime: 5000 }) - 0.2) < 1e-9, "a gap > 1 s starts a new window; the worst window wins");
  const inp = createInpTracker();
  assert.equal(inp.value(), undefined);
  for (let i = 1; i <= 60; i++) inp.add({ interactionId: i, duration: i * 10 });
  assert.equal(inp.value(), 590, "with 50+ interactions the single worst one is treated as an outlier");
});

test("uncaught errors and unhandled rejections", () => {
  const { win, q } = boot();
  const err = new TypeError("x is not a function");
  win.fire("error", { error: err, message: "Uncaught TypeError: x is not a function" });
  win.fire("unhandledrejection", { reason: new Error("avatar upload failed") });
  win.fire("unhandledrejection", { reason: undefined });
  win.fire("error", { error: null, message: "Script error.", filename: "", lineno: 0 }); // cross-origin: dropped
  win.fire("error", { error: null, message: "ResizeObserver loop limit exceeded", filename: "http://app.test/a.js", lineno: 1 });
  win.fire("error", { error: null, message: "Uncaught SyntaxError: bad token", filename: "http://app.test/a.js", lineno: 7, colno: 3 });
  const list = q("$exception").map((e) => e.properties);
  assert.deepEqual(list.map((p) => [p.$exception_list[0].value, p.$mechanism, p.$exception_level]), [
    ["x is not a function", "onerror", "fatal"],
    ["avatar upload failed", "unhandledrejection", "fatal"],
    ["undefined", "unhandledrejection", "fatal"],
    ["Uncaught SyntaxError: bad token", "onerror", "fatal"],
  ]);
  assert.deepEqual(list[3].$exception_list[0].stacktrace.frames, [{ function: "<anonymous>", file: "http://app.test/a.js", line: 7, column: 3 }]);
  assert.equal(list[0].$exception_list[0].mechanism.handled, false);
});

test("console: original always called with the same this/args; breadcrumbs by default, exceptions on opt-in", () => {
  const a = boot();
  const obj = { a: 1 };
  a.win.console.warn("careful", obj);
  a.win.console.error("it broke", new Error("inner"));
  assert.deepEqual(a.win.consoleCalls.map((c) => [c[0], c[1] === a.win.console, c[2][0]]), [["warn", true, "careful"], ["error", true, "it broke"]]);
  assert.equal(a.win.consoleCalls[0][2][1], obj);
  const crumbs = a.client._steps.filter((s) => s.$category === "console");
  assert.deepEqual(crumbs.map((s) => [s.level, s.$message]), [["warn", 'careful {"a":1}'], ["error", "it broke inner"]]);
  assert.equal(a.q("$exception").length, 0, "console capture is off by default");

  const b = boot({ console: true });
  b.win.console.error("it broke");
  b.win.console.error(new RangeError("as an error object"));
  b.win.console.warn("warnings are never exceptions");
  const ex = b.q("$exception").map((e) => e.properties);
  assert.deepEqual(ex.map((p) => [p.$exception_list[0].type, p.$exception_list[0].value, p.$mechanism]), [
    ["Error", "it broke", "console.error"],
    ["RangeError", "as an error object", "console.error"],
  ]);
  assert.equal(b.win.consoleCalls.length, 3);
});

test("clicks: $autocapture, ui breadcrumb, masking, ignore", () => {
  const { doc, q, client } = boot();
  const btn = el("button", { id: "save", "data-s98-feature": "settings" }, "Save changes");
  const icon = el("svg");
  btn.append(icon);
  doc.fire("click", { target: icon, clientX: 10, clientY: 10, detail: 1 });
  const p = q("$autocapture")[0].properties;
  assert.deepEqual(
    [p.$event_type, p.$el_tag, p.$el_text, p.$el_selector, p.$el_attrs],
    ["click", "button", "Save changes", "#save", { id: "save", "data-s98-feature": "settings" }]
  );
  assert.deepEqual(client._steps.at(-1).$message, 'click #save "Save changes"');
  assert.equal(client._steps.at(-1).$category, "ui");

  doc.fire("click", { target: el("p", {}, "just text"), clientX: 500, clientY: 500, detail: 1 });
  assert.equal(q("$autocapture").length, 1, "clicks on non-interactive elements are breadcrumbs only");
  assert.equal(client._steps.at(-1).$message, 'click p "just text"');

  const secret = el("div", { "data-s98-mask": "" }).append(el("button", {}, "jane@example.com"));
  doc.fire("click", { target: secret.children[0], clientX: 900, clientY: 10, detail: 1 });
  assert.equal(q("$autocapture")[1].properties.$el_text, "***");
  assert.equal(JSON.stringify(client._steps).includes("jane@"), false);

  const hidden = el("div", { "data-s98-ignore": "" }).append(el("button", {}, "invisible to us"));
  const steps = client._steps.length;
  doc.fire("click", { target: hidden.children[0], clientX: 10, clientY: 900, detail: 1 });
  assert.equal(q("$autocapture").length, 2);
  assert.equal(client._steps.length, steps);

  assert.doesNotThrow(() => doc.fire("click", { target: null }));
  assert.doesNotThrow(() => doc.fire("click", {}));
  assert.doesNotThrow(() => doc.fire("click", { target: { tagName: "X", getAttribute() { throw new Error("hostile DOM"); } } })); // prettier-ignore
});

test("submit and change are captured without values", () => {
  const { doc, q } = boot();
  const form = el("form", { id: "login" }, "lots of text");
  const input = el("input", { name: "email", type: "email" });
  input.value = "jane@example.com";
  form.append(input);
  doc.fire("change", { target: input });
  doc.fire("submit", { target: form });
  doc.fire("change", { target: el("div") }); // not a form field
  const list = q("$autocapture").map((e) => e.properties);
  assert.deepEqual(list.map((p) => [p.$event_type, p.$el_tag, p.$el_selector, p.$el_text]), [
    ["change", "input", '#login > input[name="email"]', ""],
    ["submit", "form", "#login", ""],
  ]);
  assert.equal(JSON.stringify(list).includes("jane@"), false);
});

test("$rageclick fires on the third quick click and flushes immediately", async () => {
  const { doc, q, clock, fetch } = boot();
  const btn = el("button", { id: "buy" }, "Buy");
  for (let i = 0; i < 3; i++) {
    doc.fire("click", { target: btn, clientX: 100 + i, clientY: 100, detail: 1 });
    await clock.tick(200);
  }
  const sent = byEvent(fetch.events(), "$rageclick");
  assert.equal(q("$rageclick").length, 1, "once per burst");
  assert.equal(sent.length, 1, "sent without waiting for the interval");
  assert.deepEqual([sent[0].properties.$click_count, sent[0].properties.$el_selector], [3, "#buy"]);
  for (let i = 0; i < 3; i++) doc.fire("click", { target: btn, clientX: 0, clientY: 0, detail: 0 });
  assert.equal(q("$rageclick").length, 1, "keyboard activations are not rage");
});

test("$dead_click: no mutation or navigation within 2.5 s", async () => {
  const { doc, win, q, clock } = boot();
  const click = (target, extra) => doc.fire("click", { target, clientX: 5, clientY: 5, detail: 1, ...extra });
  const btn = el("button", { id: "noop" }, "Does nothing");

  click(btn);
  await clock.tick(2499);
  assert.equal(q("$dead_click").length, 0);
  await clock.tick(1);
  assert.equal(q("$dead_click").length, 1);
  assert.equal(q("$dead_click")[0].properties.$el_selector, "#noop");

  click(btn); // the DOM reacts
  await clock.tick(100);
  win.MutationObserver.mutate();
  await clock.tick(3000);
  click(btn); // the URL reacts
  win.history.pushState(null, "", "/next");
  await clock.tick(3000);
  click(btn); // the page scrolls
  win.fire("scroll");
  await clock.tick(3000);
  assert.equal(q("$dead_click").length, 1, "live clicks are not dead");

  click(el("input", { type: "text" })); // focusing a field changes nothing, legitimately
  click(el("a", { href: "/x", target: "_blank" }));
  click(el("a", { href: "mailto:hi@example.com" }));
  click(btn, { metaKey: true });
  click(el("p", {}, "plain text"));
  await clock.tick(3000);
  assert.equal(q("$dead_click").length, 1);
  assert.ok(win.MutationObserver.instances.every((mo) => !mo.active), "no observer left running");
});

test("autoCapture flags switch features off individually", async () => {
  const off = { errors: false, rejections: false, steps: false, pageviews: false, clicks: false, rageClicks: false, deadClicks: false, webVitals: false, network: false };
  const win = fakeWindow();
  const originalFetch = win.fetch;
  const { client, doc, clock } = boot(off, {}, win);
  assert.equal(win.fetch, originalFetch, "nothing patched when nothing needs it");
  assert.equal(win.PerformanceObserver.instances.length, 0);
  win.fire("error", { error: new Error("x") });
  win.fire("unhandledrejection", { reason: new Error("x") });
  for (let i = 0; i < 3; i++) doc.fire("click", { target: el("button"), clientX: 1, clientY: 1, detail: 1 });
  win.history.pushState(null, "", "/elsewhere");
  await clock.tick(5000);
  assert.equal(client._queue.length, 0);
  assert.equal(client._steps.length, 0);

  const only = boot({ ...off, pageviews: true });
  assert.deepEqual(only.client._queue.map((e) => e.event), ["$pageview"]);
});

test("a disabled (DNT) client installs nothing", () => {
  const win = fakeWindow();
  win.navigator.doNotTrack = "1";
  const fetchBefore = win.fetch;
  const { client, uninstall } = boot({}, { respectDNT: true }, win);
  assert.equal(client.disabled, true);
  assert.equal(win.fetch, fetchBefore);
  assert.equal(win.listenerCount() + win.document.listenerCount(), 0);
  assert.equal(win.localStorage.map.size + win.sessionStorage.map.size, 0, "no identifiers stored");
  assert.doesNotThrow(uninstall);
});

test("hooks survive a client that throws", async () => {
  const win = fakeWindow();
  const { client } = boot({}, {}, win);
  client.capture = client.captureException = client.addStep = () => {
    throw new Error("SDK bug");
  };
  assert.doesNotThrow(() => win.fire("error", { error: new Error("x") }));
  assert.doesNotThrow(() => win.document.fire("click", { target: el("button"), detail: 1 }));
  assert.doesNotThrow(() => win.history.pushState(null, "", "/x"));
  assert.doesNotThrow(() => win.console.error("x"));
  await assert.doesNotReject(win.fetch("/api/x"));
  assert.doesNotThrow(() => win.fire("pagehide"));
});

test("$network_error: a framework's dev tooling (HMR polls, overlays) is never reported", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/network.js", import.meta.url), "utf8"));
  const re = new RegExp(src.match(/const TOOLING = \/(.+)\/;/)[1]);
  for (const u of [
    "http://localhost:3000/_next/static/webpack/4a57442373b707a3.webpack.hot-update.json",
    "http://localhost:3000/_next/webpack-hmr", "http://localhost:3000/__nextjs_original-stack-frames",
    "http://localhost:5173/@vite/client", "http://localhost:8080/sockjs-node/info", "http://localhost:3000/main.abc123.hot-update.js",
  ]) assert.ok(re.test(u), `should skip ${u}`);
  for (const u of ["http://localhost:3000/api/pay", "https://shop.test/_next/data/build/cart.json", "https://shop.test/api/hot-updates", "https://shop.test/vite-pricing"])
    assert.ok(!re.test(u), `must still report ${u}`);
});
