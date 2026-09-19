// Script-tag build entry (-> dist/signal98.min.js, global `signal98`).
//
//   <script src="{host}/s98.js" data-key="<PROJECT_KEY>" data-host="{host}" defer></script>
//
// Optional stub, so calls can be made before the script has loaded:
//   window.signal98 = window.signal98 || { _q: [] };
//   signal98._q.push(["capture", "signup_clicked", { plan: "pro" }]);

import * as api from "./index.js";

export * from "./index.js";

function run(call) {
  try {
    const fn = Array.isArray(call) && api[call[0]];
    if (typeof fn === "function") fn(...call.slice(1));
  } catch {
    /* a bad queued call must not stop the rest */
  }
}

// Once loaded, `_q.push([...])` runs the call straight away, so snippet-style
// code keeps working whether it executes before or after this script.
export const _q = { push: (...calls) => calls.forEach(run) };

try {
  // The bundler assigns the global only after this module body has run, so
  // `window.signal98` is still the page's stub (if any) at this point.
  const stub = window.signal98;
  const script =
    document.currentScript || document.querySelector("script[data-key][data-host],script[data-key][src*='s98']");
  const data = (script && script.dataset) || {};
  if (data.key || data.host) {
    api.init({
      apiKey: data.key,
      // The script is served by the signal98 host, so its origin is the default host.
      host: data.host || new URL(script.src, location.href).origin,
      environment: data.environment,
      release: data.release,
      service: data.service,
      debug: data.debug === "true",
    });
  }
  if (stub && Array.isArray(stub._q)) stub._q.forEach(run);
} catch {
  /* auto-init is best effort; signal98.init() can still be called by hand */
}
