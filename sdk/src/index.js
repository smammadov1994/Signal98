// signal98 — public API.
//
//   import { init, capture, captureException, wrap } from "signal98";
//
//   init({ endpoint: "https://your-server/api/ingest" });
//   // …that's it. Uncaught errors and unhandled rejections are now captured.

import { createClient } from "./client.js";
import { installBrowser } from "./browser.js";
import { installNode } from "./node.js";

// NOTE: react.js is intentionally NOT re-exported here. React is an optional
// peer dependency, so importing it from index.js would break non-React apps.
// React users import { createErrorBoundary } from "signal98/react" instead.
export { createClient, installBrowser, installNode };

let client = null;
let uninstall = null;

const isBrowser = () =>
  typeof window !== "undefined" && typeof window.document !== "undefined";
const isNode = () =>
  typeof process !== "undefined" && !!process.versions?.node;

export function init(options = {}) {
  if (client) return client; // idempotent
  client = createClient(options);
  const auto = options.autoCapture || {};
  if (isBrowser()) uninstall = installBrowser(client, auto);
  else if (isNode()) uninstall = installNode(client, auto);
  return client;
}

export function getClient() {
  if (!client) throw new Error("signal98: call init() before using the SDK");
  return client;
}

export const capture = (event, properties) => getClient().capture(event, properties);
export const captureException = (error, properties) =>
  getClient().captureException(error, properties);
export const addStep = (message, properties) => getClient().addStep(message, properties);
export const flush = () => getClient().flush();
export const identify = (id) => getClient().identify(id);

export function close() {
  const c = client;
  client = null;
  if (uninstall) {
    uninstall();
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
      getClient().captureException(err, {
        $handled: true,
        $mechanism: "wrap",
        $fn: name,
        ...(options.properties || {}),
      });
    };
    try {
      const out = fn.apply(this, args);
      if (out && typeof out.then === "function") {
        return out.catch((err) => {
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
