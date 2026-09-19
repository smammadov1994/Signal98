// Network visibility: every fetch / XMLHttpRequest becomes a breadcrumb, and
// the bad ones (5xx, no response, slower than `slowRequestMs`) become
// $network_error events. The patched functions return exactly what the
// originals return — we only observe on a side branch of the promise.

import { patch } from "./patch.js";
import { stripQuery, createRateLimiter, safe } from "./util.js";

export function installNetwork({ client, win, opts, guard, cleanups }) {
  const cfg = client._config;
  const now = client._env.now;
  // A dead polling endpoint would otherwise report itself every second.
  const limited = createRateLimiter(10, 60_000, now);

  const resolve = (url) => safe(() => new URL(url, win.location.href).href, String(url));

  // Never observe the SDK's own traffic: reporting a failed ingest call would
  // enqueue an event, whose delivery fails, which enqueues an event...
  // If signal98 lives on another origin, its whole origin is off limits (the
  // monitor UI polls it too); same-origin, only the SDK's two endpoints are.
  const endpointAbs = stripQuery(resolve(cfg.endpoint));
  const hostAbs = cfg.host ? resolve(`${cfg.host}/`) : null;
  const foreign = !!hostAbs && safe(() => new URL(hostAbs).origin !== win.location.origin, false);
  const isOwn = (abs) => {
    if (foreign) return abs.indexOf(hostAbs) === 0;
    const bare = stripQuery(abs);
    return bare === endpointAbs || bare === endpointAbs.replace(/ingest\/?$/, "flags");
  };
  // Hot-reload polls and dev overlays fail whenever a dev server restarts. They are the
  // framework talking to itself, never the product failing, so they are not reported at all.
  const TOOLING = /\/_next\/static\/webpack\/|\.hot-update\.(?:json|js)\b|\/_next\/webpack-hmr|\/__nextjs_|\/__webpack_hmr|\/sockjs-node\/|\/@vite\/|\/@react-refresh|\/__vite_ping/;
  const skip = (abs) => isOwn(abs) || TOOLING.test(abs);

  // status: >0 HTTP status, 0 no response, -1 opaque (no-cors) response.
  function done(method, abs, status, t0, aborted) {
    const url = stripQuery(abs);
    const ms = now() - t0;
    if (opts.steps) {
      const label = status > 0 ? status : status ? "opaque" : aborted ? "aborted" : "failed";
      client.addStep(`${method} ${url} -> ${label}`, { $category: "network", method, url, status, duration_ms: ms });
    }
    if (!opts.network || aborted) return; // an abort is the app changing its mind, not a failure
    const slow = ms > cfg.slowRequestMs;
    if (!(status >= 500 || status === 0 || slow)) return;
    if (limited(`${method} ${url} ${status}`)) return;
    const props = { $method: method, $url: url, $status: Math.max(status, 0), $duration_ms: ms };
    if (slow) props.$slow = true;
    client.capture("$network_error", props);
  }

  patch(
    win,
    "fetch",
    (orig) =>
      function (input, init) {
        const p = orig.apply(this, arguments);
        guard(() => {
          const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
          const abs = resolve(typeof input === "string" ? input : (input && input.url) || String(input));
          if (skip(abs)) return;
          const t0 = now();
          // A side branch: the caller's own promise chain is untouched, and
          // because this branch handles the rejection it can never surface as
          // an "unhandled rejection" of our making.
          p.then(
            (res) => guard(() => done(method, abs, res.type === "opaque" ? -1 : res.status, t0)),
            (err) => guard(() => done(method, abs, 0, t0, !!err && err.name === "AbortError"))
          );
        });
        return p;
      },
    cleanups
  );

  const proto = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
  if (proto) {
    const meta = new WeakMap();
    patch(
      proto,
      "open",
      (orig) =>
        function (method, url) {
          guard(() => meta.set(this, { method: String(method).toUpperCase(), abs: resolve(url) }));
          return orig.apply(this, arguments);
        },
      cleanups
    );
    patch(
      proto,
      "send",
      (orig) =>
        function () {
          guard(() => {
            const m = meta.get(this);
            if (!m || skip(m.abs)) return;
            const t0 = now();
            let aborted = false;
            // once: an XHR object can be re-opened and re-sent; stale listeners must not double-report.
            this.addEventListener("abort", () => (aborted = true), { once: true });
            this.addEventListener("loadend", () => guard(() => done(m.method, m.abs, this.status, t0, aborted)), {
              once: true,
            });
          });
          return orig.apply(this, arguments);
        },
      cleanups
    );
  }
}
