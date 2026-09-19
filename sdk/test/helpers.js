// Test harness: fake clock, fake fetch, fake storage, and a just-big-enough
// fake window/DOM. No dependencies — everything the SDK needs from the outside
// world is injected through `options._env`.

import { createClient } from "../src/client.js";

const settle = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};

export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms = 0) {
      const id = ++seq;
      timers.set(id, { id, fn, at: t + Math.max(0, ms) });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    pending: () => [...timers.values()].map((x) => x.at - t).sort((a, b) => a - b),
    settle,
    // Advance time, running due timers in order and letting promises settle in between.
    async tick(ms) {
      const end = t + ms;
      for (;;) {
        await settle();
        const next = [...timers.values()].filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        timers.delete(next.id);
        t = next.at;
        next.fn();
      }
      t = end;
      await settle();
    },
  };
}

// responder(callNumber, url, init) -> { status, headers?, json? } | Error (thrown as a network failure)
export function fakeFetch(responder = () => ({ status: 200 })) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : null };
    calls.push(call);
    const r = await responder(calls.length, url, init);
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      type: r.type || "basic",
      headers: { get: (k) => (r.headers && r.headers[k] !== undefined ? String(r.headers[k]) : null) },
      json: async () => r.json,
    };
  };
  fn.calls = calls;
  fn.ingests = () => calls.filter((c) => String(c.url).includes("/api/ingest"));
  fn.events = () => calls.flatMap((c) => (c.body && c.body.batch) || []);
  return fn;
}

export function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

// A client wired to fakes. Returns the fakes too.
export function testClient(options = {}, envOverrides = {}) {
  const clock = envOverrides.clock || fakeClock();
  const fetch = envOverrides.fetch || fakeFetch();
  const localStorage = envOverrides.localStorage || fakeStorage();
  const sessionStorage = envOverrides.sessionStorage || fakeStorage();
  const client = createClient({
    host: "http://s98.test",
    apiKey: "proj_key",
    ...options,
    _env: {
      win: envOverrides.win || null,
      fetch,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      random: envOverrides.random || (() => 0.5),
      localStorage,
      sessionStorage,
    },
  });
  return { client, clock, fetch, localStorage, sessionStorage };
}

// ---- fake DOM ----

export class FakeElement {
  constructor(tagName, attrs = {}, text = "") {
    this.tagName = tagName.toUpperCase();
    this._attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this._text = text;
  }
  get id() {
    return this._attrs.id || "";
  }
  get attributes() {
    return Object.entries(this._attrs).map(([name, value]) => ({ name, value }));
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  getAttribute(name) {
    return name in this._attrs ? this._attrs[name] : null;
  }
  append(...kids) {
    for (const k of kids) {
      k.parentElement = this;
      this.children.push(k);
    }
    return this;
  }
  // Only understands the SDK's mask selector — enough for the masking tests.
  querySelector() {
    const hit = (el) => el.getAttribute("data-s98-mask") != null || /\bs98-mask\b/.test(el.getAttribute("class") || "");
    const walk = (el) => el.children.find((c) => hit(c) || walk(c)) || null;
    return walk(this);
  }
}

export const el = (tag, attrs, text) => new FakeElement(tag, attrs, text);

function fakeTarget(extra = {}) {
  const listeners = new Map();
  return Object.assign(extra, {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    fire(type, event = {}) {
      for (const fn of [...(listeners.get(type) || [])]) fn({ type, ...event });
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  });
}

export function fakeWindow(href = "http://app.test/home?utm_source=newsletter") {
  let url = new URL(href);
  class History {
    pushState(state, title, next) {
      url = new URL(next, url);
    }
    replaceState(state, title, next) {
      url = new URL(next, url);
    }
  }
  class XHR {
    constructor() {
      Object.assign(this, fakeTarget());
      this.status = 0;
      XHR.instances.push(this);
    }
    open(method, u) {
      this.opened = [method, u];
    }
    send(body) {
      this.sent = body === undefined ? null : body;
      return "sent";
    }
    respond(status) {
      this.status = status;
      this.fire("loadend");
    }
  }
  XHR.instances = [];
  class MutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.active = false;
      MutationObserver.instances.push(this);
    }
    observe() {
      this.active = true;
    }
    disconnect() {
      this.active = false;
    }
    static mutate() {
      for (const mo of MutationObserver.instances) if (mo.active) mo.cb([{}]);
    }
  }
  MutationObserver.instances = [];
  class PerformanceObserver {
    constructor(cb) {
      this.cb = cb;
      PerformanceObserver.instances.push(this);
    }
    observe(o) {
      this.type = o.type;
    }
    disconnect() {
      this.type = null;
    }
    static emit(type, entries) {
      for (const po of PerformanceObserver.instances) if (po.type === type) po.cb({ getEntries: () => entries });
    }
  }
  PerformanceObserver.instances = [];

  const consoleCalls = [];
  const beacons = [];
  const doc = fakeTarget({
    title: "Home",
    referrer: "https://news.example/story",
    visibilityState: "visible",
    documentElement: { scrollHeight: 2000 },
    body: { scrollHeight: 2000 },
    querySelector: () => null,
  });
  const win = fakeTarget({
    document: doc,
    location: {
      get href() {
        return url.href;
      },
      get pathname() {
        return url.pathname;
      },
      get search() {
        return url.search;
      },
      get hash() {
        return url.hash;
      },
      get host() {
        return url.host;
      },
      get hostname() {
        return url.hostname;
      },
      get origin() {
        return url.origin;
      },
    },
    history: new History(),
    History,
    navigator: {
      userAgent: "FakeBrowser/1.0",
      language: "en-GB",
      onLine: true,
      sendBeacon(u, blob) {
        beacons.push({ url: u, blob });
        return true;
      },
    },
    screen: { width: 1920, height: 1080 },
    innerWidth: 1200,
    innerHeight: 800,
    scrollY: 0,
    console: {
      warn: function (...a) {
        consoleCalls.push(["warn", this, a]);
      },
      error: function (...a) {
        consoleCalls.push(["error", this, a]);
      },
    },
    consoleCalls,
    beacons,
    XMLHttpRequest: XHR,
    MutationObserver,
    PerformanceObserver,
    performance: { getEntriesByType: () => [{ responseStart: 120, activationStart: 0 }] },
    localStorage: fakeStorage(),
    sessionStorage: fakeStorage(),
  });
  win.fetch = fakeFetch();
  return win;
}

export const byEvent = (queue, name) => queue.filter((e) => e.event === name);
