// Node demo: exercises every capture path. Run the example server first:
//   node example/server.js
// then in another terminal:
//   node example/node-demo.js

import { init, capture, captureException, wrap, addStep, flush, log } from "../src/index.js";

// The example server picks a free port and prints this exact command. No default: guessing a
// port means POSTing test errors into whatever unrelated service happens to live there.
const HOST = process.env.SIGNAL98_HOST;
if (!HOST) {
  console.error("Set SIGNAL98_HOST (the example server prints it), e.g.\n  SIGNAL98_HOST=http://localhost:54321 node example/node-demo.js");
  process.exit(1);
}

init({
  host: HOST,
  apiKey: "demo-project",
  environment: "demo",
  release: "0.2.0",
  service: "node-demo",
  // By default signal98 lets an uncaught exception end the process, exactly as
  // Node would without it (after flushing the report). This demo wants to show
  // several crashes in one run, so it opts out.
  autoCapture: { errors: true, rejections: true, exitOnUncaught: false },
});

addStep("demo started");
capture("demo_boot", { version: "0.2.0" });
log.info("demo booted", { pid: process.pid });

// 1. manual capture of a caught error
try {
  JSON.parse("{oops");
} catch (err) {
  captureException(err, { where: "config-load" });
}

// 2. wrap() around a risky function — reports, then rethrows
const checkout = wrap(
  (total) => {
    addStep("checkout attempted", { total });
    if (total > 1000) throw new Error(`payment failed: card declined for $${total}`);
    return "ok";
  },
  { name: "checkout" }
);
try {
  checkout(4200);
} catch {
  /* caller handles it; the error was already reported */
}

// 3. unhandled rejection — auto-captured
setTimeout(() => {
  Promise.reject(new Error("webhook delivery timed out after 3 retries"));
}, 100);

// 4. uncaught exception — auto-captured (keep this last)
setTimeout(() => {
  throw new Error("render crashed: undefined is not an object (user profile page)");
}, 200);

setTimeout(async () => {
  await flush();
  console.log("demo done — check the server log for verdicts");
  process.exit(0);
}, 1500);
