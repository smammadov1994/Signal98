// Node auto-capture: uncaughtException + unhandledRejection, graceful flush,
// and Express-style middleware.

import { resolveClient } from "./hub.js";
import { stripQuery } from "./util.js";

const EXIT_WAIT_MS = 2000;

// `os` without an import statement: this file is reachable from the package
// root, and a static `node:os` import breaks browser bundlers (webpack: "
// UnhandledSchemeError"). process.getBuiltinModule is Node >= 20.16 / 22.3.
function hostname() {
  try {
    const os = process.getBuiltinModule && process.getBuiltinModule("os");
    if (os) return os.hostname();
  } catch {
    /* fall through */
  }
  return process.env.HOSTNAME || process.env.COMPUTERNAME;
}

export function installNode(client, opts = {}) {
  if (typeof process === "undefined" || typeof process.on !== "function" || !client || client.disabled) {
    return () => {};
  }
  const { errors = true, rejections = true, exitOnUncaught = true } = opts;
  const cleanups = [];
  const on = (event, fn) => {
    process.on(event, fn);
    cleanups.push(() => process.removeListener(event, fn));
  };

  try {
    const ctx = client._ctx || {};
    ctx.$node_version = process.version;
    ctx.$hostname = hostname();
    if (!ctx.$service) ctx.$service = process.env.npm_package_name || ctx.$hostname;
  } catch {
    /* context is best effort */
  }

  // Bounded wait for the queue to drain. The timer is deliberately not
  // unref'd: it is what keeps the process alive long enough to deliver.
  const flushThen = (fn) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      fn();
    };
    setTimeout(finish, EXIT_WAIT_MS);
    Promise.resolve(client.flush()).then(finish, finish);
  };

  // Registering either listener switches off Node's default "print and exit
  // with code 1". A monitoring SDK must not quietly turn crashes into a zombie
  // process, so when we are the only listener we finish the job Node would
  // have done — after the report is out. If the app has its own handler, the
  // app is in charge and we only observe.
  const fatal = (event, mechanism) => (err) => {
    try {
      client.captureException(err, { $handled: false, $mechanism: mechanism });
    } catch {
      /* never make a crash worse */
    }
    if (!exitOnUncaught || process.listenerCount(event) > 1) return;
    try {
      console.error(err);
    } catch {
      /* ignore */
    }
    flushThen(() => process.exit(1));
  };
  if (errors) on("uncaughtException", fatal("uncaughtException", "uncaughtException"));
  if (rejections) on("unhandledRejection", fatal("unhandledRejection", "unhandledRejection"));

  // beforeExit: the loop is empty, so an async flush is allowed to finish and
  // Node exits afterwards.
  let exitFlush = false;
  on("beforeExit", () => {
    try {
      if (!client._queue.length || exitFlush) return;
      exitFlush = true;
      // If the attempt fails the latch stays set: beforeExit fires again once
      // the failed request settles, and a dead endpoint must not hold the process.
      Promise.resolve(client.flush()).then(() => (exitFlush = client._queue.length > 0));
    } catch {
      /* ignore */
    }
  });

  // SIGTERM: a listener cancels the default termination, so after flushing we
  // re-deliver the signal with our listener gone — unless the app handles
  // SIGTERM itself, in which case it decides when to exit.
  const onTerm = () => {
    flushThen(() => {
      try {
        if (process.listenerCount("SIGTERM") > 1) return;
        process.removeListener("SIGTERM", onTerm);
        process.kill(process.pid, "SIGTERM");
      } catch {
        /* ignore */
      }
    });
  };
  on("SIGTERM", onTerm);

  return () => cleanups.forEach((fn) => fn());
}

const pathOf = (req) => stripQuery(req.originalUrl || req.url || "");

// app.use(requestHandler()) — first middleware. One breadcrumb per request, so
// an exception report shows what the server was doing just before. Note the
// breadcrumb buffer is per process, not per request: under concurrency the
// steps of different requests interleave.
export function requestHandler(client) {
  return function signal98RequestHandler(req, res, next) {
    try {
      const c = resolveClient(client);
      if (c) c.addStep(`${req.method} ${pathOf(req)}`, { $category: "network", method: req.method, url: pathOf(req) });
    } catch {
      /* never block a request */
    }
    next();
  };
}

// app.use(errorHandler()) — after all routes, before your own error handler.
// Reports and passes the error on; it never responds itself.
export function errorHandler(client) {
  return function signal98ErrorHandler(err, req, res, next) {
    try {
      const c = resolveClient(client);
      const status = (err && (err.status || err.statusCode)) || 500;
      // 4xx are the client's mistakes (404, validation); reporting them would bury real faults.
      if (c && status >= 500) {
        c.captureException(err, {
          $handled: false,
          $mechanism: "express",
          $method: req && req.method,
          $url: req && pathOf(req),
          $status: status,
        });
      }
    } catch {
      /* fall through to next(err) */
    }
    next(err);
  };
}
