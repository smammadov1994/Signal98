// Browser auto-capture. Mirrors PostHog's behaviour: hook the runtime's
// global channels so the host app's code runs untouched — nothing is literally
// "wrapped" unless you use wrap().
//
// Two rules hold for every hook in this folder:
//  1. It runs inside `guard`, so its own failure is swallowed (and logged in
//     debug mode) instead of reaching the host app.
//  2. It is undone by the function installBrowser() returns. Wrappers that
//     cannot be removed safely (see patch.js) go inert via the `active` flag.

import { patch } from "./patch.js";
import { installNetwork } from "./network.js";
import { installPageviews } from "./pageview.js";
import { installAutocapture } from "./autocapture.js";
import { installVitals } from "./vitals.js";

const DEFAULTS = {
  errors: true, // window 'error' events (uncaught exceptions)
  rejections: true, // 'unhandledrejection' events
  console: false, // report console.error calls as exceptions
  steps: true, // breadcrumbs: ui clicks, navigation, network, console.warn/error
  pageviews: true,
  clicks: true,
  rageClicks: true,
  deadClicks: true,
  webVitals: true,
  network: true,
};

function describe(arg) {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg.message === "string") return arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export function installBrowser(client, options) {
  const win = (client && client._env && client._env.win) || (typeof window !== "undefined" ? window : null);
  if (!win || !win.document || !client || client.disabled) return () => {};

  const opts = {};
  for (const k of Object.keys(DEFAULTS)) opts[k] = options && options[k] !== undefined ? !!options[k] : DEFAULTS[k];

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
  // `activity` lets the navigation hook tell the dead-click watcher "something happened".
  const hooks = { client, win, opts, guard, cleanups, activity: { n: 0 }, onPageHide: [], onHidden: [] };
  const doc = win.document;
  const listen = (target, type, fn) => {
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };

  if (opts.errors) {
    listen(win, "error", (event) =>
      guard(() => {
        let err = event.error;
        if (err == null) {
          // No error object: cross-origin "Script error." or a very old browser.
          // Build a stack only from what the event really knows, so that a
          // redacted cross-origin error stays stackless and gets filtered.
          const at = event.filename ? `    at ${event.filename}:${event.lineno || 0}:${event.colno || 0}` : "";
          err = { name: "Error", message: event.message || "Unknown error", stack: at };
        }
        client.captureException(err, { $handled: false, $mechanism: "onerror" });
      })
    );
  }

  if (opts.rejections) {
    listen(win, "unhandledrejection", (event) =>
      guard(() => client.captureException(event.reason, { $handled: false, $mechanism: "unhandledrejection" }))
    );
  }

  if (opts.steps || opts.console) {
    let busy = false; // our own debug logging must not recurse into the hook
    for (const level of ["warn", "error"]) {
      patch(
        win.console,
        level,
        (orig) =>
          function (...args) {
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

  // The page is going away (or might be: mobile browsers often kill hidden
  // tabs without another event). Order matters: finish the events first, then
  // hand the queue to sendBeacon.
  const run = (list) => list.forEach((fn) => guard(fn));
  listen(doc, "visibilitychange", () =>
    guard(() => {
      if (doc.visibilityState !== "hidden") return;
      run(hooks.onHidden);
      client._flushBeacon();
    })
  );
  listen(win, "pagehide", () =>
    guard(() => {
      run(hooks.onPageHide);
      run(hooks.onHidden);
      client._flushBeacon();
    })
  );

  return () => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* keep unhooking */
      }
    }
    active = false;
  };
}
