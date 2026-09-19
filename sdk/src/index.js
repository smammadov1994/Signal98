// signal98 — public API.
//
//   import { init, capture, captureException, wrap } from "signal98";
//
//   init({ host: "https://signal98.example.com", apiKey: "proj_..." });
//   // …that's it. Errors, pageviews, clicks, web vitals and failed requests
//   // are now captured.
//
// Nothing here touches `window` at import time (SSR safe), and nothing here
// throws: calling any function before init() is a quiet no-op.

import { createClient } from "./client.js";
import { installBrowser } from "./browser.js";
import { installNode, errorHandler, requestHandler } from "./node.js";
import { hub } from "./hub.js";

// NOTE: react.js is intentionally NOT re-exported here. React is an optional
// peer dependency, so importing it from index.js would break non-React apps.
// React users import { createErrorBoundary } from "signal98/react" instead.
export { createClient, installBrowser, installNode, errorHandler, requestHandler };

let uninstall = null;

const isBrowser = () => typeof window !== "undefined" && typeof window.document !== "undefined";
const isNode = () => typeof process !== "undefined" && !!(process.versions && process.versions.node);

export function init(options = {}) {
  if (hub.client) return hub.client; // idempotent: React StrictMode, HMR, double script tags
  try {
    const client = createClient(options);
    hub.client = client;
    const auto = options.autoCapture === false ? null : options.autoCapture || {};
    if (auto && isBrowser()) uninstall = installBrowser(client, auto);
    else if (auto && isNode()) uninstall = installNode(client, auto);
    return client;
  } catch (err) {
    // A monitoring library that takes the app down on startup is worse than none.
    try {
      console.warn("signal98: init failed", err);
    } catch {
      /* no console */
    }
    return (hub.client = null), noop;
  }
}

// Stand-in used before init(): same shape, does nothing, so
// `getClient().capture(...)` is always safe to write.
const nothing = () => {};
const noop = {
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
  log: { debug: nothing, info: nothing, warn: nothing, error: nothing },
};

export const getClient = () => hub.client || noop;

export const capture = (event, properties) => getClient().capture(event, properties);
export const captureException = (error, properties) => getClient().captureException(error, properties);
export const addStep = (message, properties) => getClient().addStep(message, properties);
export const identify = (id, $set, $set_once) => getClient().identify(id, $set, $set_once);
export const reset = () => getClient().reset();
export const register = (properties) => getClient().register(properties);
export const unregister = (key) => getClient().unregister(key);
export const getDistinctId = () => getClient().getDistinctId();
export const getSessionId = () => getClient().getSessionId();
export const isFeatureEnabled = (key) => getClient().isFeatureEnabled(key);
export const getFeatureFlag = (key) => getClient().getFeatureFlag(key);
export const onFeatureFlags = (callback) => getClient().onFeatureFlags(callback);
export const reloadFeatureFlags = () => getClient().reloadFeatureFlags();
export const flush = () => getClient().flush();

// log.info("cart synced", { items: 3 }) -> $log event.
const logAt = (level) => (message, properties) => getClient().log[level](message, properties);
export const log = { debug: logAt("debug"), info: logAt("info"), warn: logAt("warn"), error: logAt("error") };

export function close() {
  const c = hub.client;
  hub.client = null;
  if (uninstall) {
    try {
      uninstall();
    } catch {
      /* ignore */
    }
    uninstall = null;
  }
  return c ? c.close() : Promise.resolve();
}

// wrap(fn) — the literal "wrap the code" helper. Runs fn, captures anything
// it throws (sync or async), then rethrows so behavior is unchanged.
export function wrap(fn, options = {}) {
  const name = options.name || fn.name || "anonymous";
  const wrapped = function (...args) {
    const report = (err) => {
      try {
        getClient().captureException(err, {
          $handled: true,
          $mechanism: "wrap",
          $fn: name,
          ...(options.properties || {}),
        });
      } catch {
        /* the caller must see the original error, not ours */
      }
    };
    try {
      const out = fn.apply(this, args);
      if (out && typeof out.then === "function") {
        return out.then(undefined, (err) => {
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
