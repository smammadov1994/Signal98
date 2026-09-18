# signal98

A tiny, zero-dependency error & event capture SDK with a twist: events are meant
to be **semantically judged at ingest** (by JEV), so paging is a rule over
*meaning* — urgent ≥ 0.70, user-facing ≥ 0.60, novelty ≥ 0.55 — instead of
hand-tuned metric thresholds.

## Install

```bash
npm install signal98
```

No runtime dependencies. Works in browsers, Node 18+, and React (peer dep).

## Quickstart

```js
import { init } from "signal98";

init({
  endpoint: "https://your-server/api/ingest", // where events go
});
```

That's it. Uncaught errors and unhandled promise rejections are now captured
automatically. In Node, `uncaughtException` / `unhandledRejection`. In the
browser, `window.onerror` / `unhandledrejection`.

## API

### `init(options)`

| option | default | what it does |
|---|---|---|
| `endpoint` | *(required)* | URL that receives JSON batches via POST |
| `apiKey` | — | sent as `X-Signal-Key` header |
| `release` / `environment` | `production` | attached to every event |
| `sampleRate` | `1.0` | 0–1, fraction of events to keep |
| `beforeSend(event)` | — | inspect/mutate events; return `null` to drop |
| `autoCapture.errors` | `true` | uncaught errors |
| `autoCapture.rejections` | `true` | unhandled promise rejections |
| `autoCapture.console` | `false` | also capture `console.error` calls |
| `autoCapture.steps` | `true` | auto breadcrumb steps for `fetch()` (browser) |

### `capture(event, properties)`

Send a custom event: `capture("checkout_completed", { total: 4200 })`.

### `captureException(error, properties)`

Manually report a caught error. Normalizes type, message, and stack frames,
computes a stable `$exception_fingerprint` for grouping, and attaches the
breadcrumb buffer as `$exception_steps`.

```js
try {
  await saveSettings();
} catch (err) {
  captureException(err, { where: "settings-save" });
}
```

### `wrap(fn, { name, properties })`

The literal "wrap the code" helper. Returns a function that reports anything
`fn` throws (sync or async) and then rethrows, so behavior is unchanged:

```js
const checkout = wrap(processPayment, { name: "processPayment" });
```

### `addStep(message, properties)`

Breadcrumb-style checkpoints attached to the next exception:

```js
addStep("checkout started", { cart_total: 12900 });
```

### `identify(id)`, `flush()`, `close()`

Attach a user id; force-send the queue; shut down (unhooks everything, flushes).

### React

```jsx
import { init, getClient } from "signal98";
import { createErrorBoundary } from "signal98/react";

init({ endpoint: "https://your-server/api/ingest" });
const SignalBoundary = createErrorBoundary(getClient());

<SignalBoundary fallback={<p>Something broke.</p>}>
  <App />
</SignalBoundary>;
```

(`getClient()` returns the client created by `init()`.)

## How it differs from PostHog

PostHog's `posthog-js` does the same install-and-`init()` dance — it hooks
`window.onerror` / `onunhandledrejection`, sends `$exception` events with
type/value/stacktrace/fingerprint, groups them into issues server-side, and
alerts on volume. signal98 mirrors that capture pipeline (same global-handler
mechanism, same fingerprint grouping, same burst protection), but the backend
judges each event **semantically** with JEV instead of counting occurrences:
an error pages you because JEV says it's urgent *and* user-facing *and* novel,
not because it happened N times.

## Local demo

```bash
node example/server.js      # ingest + JEV-style judging on :8787
node example/node-demo.js   # throws four different errors at it
```

Watch the server log print `PAGED` vs `suppressed` verdicts per event.
