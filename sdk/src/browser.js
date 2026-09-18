// Browser auto-capture. Mirrors PostHog's `capture_exceptions` behavior:
// hook the runtime's global error channels so the host app's code runs
// untouched — nothing is literally "wrapped" unless you use wrap().

export function installBrowser(client, opts = {}) {
  const {
    errors = true, // window 'error' events (uncaught exceptions)
    rejections = true, // 'unhandledrejection' events
    console: consoleErrors = false, // console.error calls
    steps = true, // auto breadcrumb steps for fetch()
  } = opts;

  if (typeof window === "undefined") return () => {};
  const cleanups = [];

  if (errors) {
    const onError = (event) => {
      const err = event.error || new Error(event.message || "Unknown error");
      client.captureException(err, {
        $handled: false,
        $mechanism: "onerror",
        $url: window.location.href,
      });
    };
    window.addEventListener("error", onError);
    cleanups.push(() => window.removeEventListener("error", onError));
  }

  if (rejections) {
    const onRej = (event) => {
      client.captureException(event.reason, {
        $handled: false,
        $mechanism: "unhandledrejection",
        $url: window.location.href,
      });
    };
    window.addEventListener("unhandledrejection", onRej);
    cleanups.push(() => window.removeEventListener("unhandledrejection", onRej));
  }

  if (consoleErrors) {
    const orig = console.error;
    console.error = (...args) => {
      try {
        const first = args[0];
        client.captureException(
          first instanceof Error ? first : new Error(args.map(String).join(" ")),
          { $handled: true, $mechanism: "console.error" }
        );
      } finally {
        orig.apply(console, args);
      }
    };
    cleanups.push(() => {
      console.error = orig;
    });
  }

  if (steps && typeof window.fetch === "function") {
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const req = args[0];
      const url = typeof req === "string" ? req : req?.url;
      const method = args[1]?.method || "GET";
      const t0 = Date.now();
      try {
        const res = await origFetch.apply(window, args);
        client.addStep(`fetch ${method} ${url}`, {
          status: res.status,
          duration_ms: Date.now() - t0,
        });
        return res;
      } catch (err) {
        client.addStep(`fetch ${method} ${url} failed`, {
          duration_ms: Date.now() - t0,
        });
        throw err;
      }
    };
    cleanups.push(() => {
      window.fetch = origFetch;
    });
  }

  // Best-effort flush so the last events survive navigation/close.
  const onHide = () => {
    client.flush();
  };
  window.addEventListener("pagehide", onHide);
  cleanups.push(() => window.removeEventListener("pagehide", onHide));

  return () => cleanups.forEach((fn) => fn());
}
