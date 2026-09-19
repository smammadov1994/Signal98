// The script-tag build, exercised as the real artifact: dist/signal98.min.js
// is evaluated inside a vm context shaped like a browser page.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fakeWindow, fakeFetch } from "./helpers.js";

const bundle = fileURLToPath(new URL("../dist/signal98.min.js", import.meta.url));
const skip = existsSync(bundle) ? false : "run `npm run build` first";

function page({ dataset, stub } = {}) {
  const win = fakeWindow("http://app.test/landing");
  const sdkFetch = fakeFetch((n, url) => (String(url).includes("/api/flags") ? { status: 200, json: { flags: { beta: true } } } : { status: 200 }));
  win.fetch = sdkFetch; // the page's fetch at load time is what the SDK keeps for its own traffic
  win.document.currentScript = dataset ? { dataset, src: "http://s98.test/s98.js" } : null;
  if (stub) win.signal98 = stub;
  Object.assign(win, { window: win, self: win, URL, URLSearchParams, Blob, Intl, crypto: globalThis.crypto, setTimeout, clearTimeout });
  // The vm has its own `console` global; route the SDK's patching at the fake one.
  vm.createContext(win);
  vm.runInContext(readFileSync(bundle, "utf8"), win);
  return { win, sdkFetch, s98: win.signal98 };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("script tag: auto-initialises from data-* attributes and drains the stub queue", { skip }, async () => {
  const stub = {
    _q: [
      ["identify", "user_7", { plan: "pro" }],
      ["capture", "queued_before_load", { n: 1 }],
      ["nonsense", 1],
      "not even an array",
      ["capture"],
    ],
  };
  const { win, s98, sdkFetch } = page({
    dataset: { key: "proj_cdn", host: "http://s98.test", environment: "staging", release: "9.9.9", service: "web" },
    stub,
  });
  assert.equal(typeof s98.init, "function");
  assert.equal(typeof s98.capture, "function");
  assert.equal(typeof s98.log.info, "function");
  assert.notEqual(s98, stub, "the real API replaces the stub");

  s98._q.push(["capture", "queued_after_load"]); // snippet-style code keeps working
  s98.capture("direct_call");
  await s98.flush();
  await settle();
  const events = sdkFetch.events();
  assert.deepEqual(events.map((e) => e.event), ["$pageview", "$identify", "queued_before_load", "queued_after_load", "direct_call"]);
  assert.equal(sdkFetch.ingests()[0].url, "http://s98.test/api/ingest?key=proj_cdn");
  const p = events[2].properties;
  assert.deepEqual([p.$environment, p.$release, p.$service, p.n], ["staging", "9.9.9", "web", 1]);
  assert.equal(events[2].distinct_id, "user_7");
  assert.equal(s98.isFeatureEnabled("beta"), true, "flags were loaded from {host}/api/flags");
  assert.equal(s98.init({ host: "http://elsewhere.test" }), s98.getClient(), "a second init() is a no-op");
  await s98.close();
  void win;
});

test("script tag: host defaults to the script's own origin", { skip }, async () => {
  const { s98, sdkFetch } = page({ dataset: { key: "k" } });
  await s98.flush();
  assert.equal(sdkFetch.ingests()[0].url, "http://s98.test/api/ingest?key=k");
  await s98.close();
});

test("script tag: without data attributes nothing starts until init() is called", { skip }, async () => {
  const { s98, sdkFetch, win } = page({ stub: { _q: [["init", { host: "http://manual.test", apiKey: "m" }], ["capture", "after_manual_init"]] } });
  await s98.flush();
  assert.deepEqual(sdkFetch.ingests().map((c) => c.url), ["http://manual.test/api/ingest?key=m"]);
  assert.ok(sdkFetch.events().some((e) => e.event === "after_manual_init"));
  await s98.close();

  const idle = page();
  assert.equal(idle.sdkFetch.calls.length, 0);
  assert.equal(idle.win.listenerCount() + idle.win.document.listenerCount(), 0, "no hooks without configuration");
  assert.doesNotThrow(() => idle.s98.capture("ignored"));
  void win;
});
