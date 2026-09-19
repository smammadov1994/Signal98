# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

signal98 is a PostHog/Datadog-style monitoring product (error tracking, product + web analytics, sessions, persons, feature flags, alerts) whose classification engine is **JEV**, TypeSafe's System One model, instead of volume thresholds. A "ghost" assistant (Clippy for production) proposes fixes and can dispatch coding agents.

Three independent npm packages, no workspace tooling (each has its own `node_modules`), all plain JavaScript ESM:

- `sdk/` — the `signal98` capture library. Zero runtime dependencies. Consumed as source (`exports` → `src/`) or as the IIFE script-tag bundle.
- `desktop/` — Next.js 15 on **:3001**: the backend (`/api/*`) and the Windows 98 monitor UI.
- `playground/` — Next.js 15 on **:3000**: "ghost mart", a demo shop wrapped with the SDK (`"signal98": "file:../sdk"`; browser half in `app/signal.jsx`, server half in `instrumentation.js`) containing deliberate, genuine bugs (listed in `playground/README.md`) for the ghost to fix.

Contracts live in `docs/`: `PROTOCOL.md` (SDK ↔ backend wire format, PostHog-shaped) and `UI.md` (window manager ↔ window components, shared UI kit). Change the doc together with the code.

## Commands

```bash
npm run dev                         # repo root: builds the SDK bundle, starts desktop (:3001) then playground (:3000)
cd sdk && npm test                  # node --test test/*.test.js   (single file: node --test test/transport.test.js)
cd sdk && npm run build             # esbuild → dist/signal98.min.js + .esm.js, and copies the IIFE to desktop/public/s98.js
cd desktop && npm test              # backend end-to-end through the real router, in-memory DB, JEV stubbed via fetch
cd desktop && node --test --test-name-pattern="regression" "test/*.test.js"   # single test
cd desktop && npm run build         # production build check (do not run while `next dev` is up: both write .next/)
```

No linter is configured. Tests use only `node:test`; do not add test dependencies.

## JEV (the classifier)

- `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`, body `{ model, state, questions }`. Docs index: https://docs.typesafe.ai/llms.txt
- Question types: `noul` (yes/no → `.noul` 0–1), `choice` (one of N → `.choice`, `.probabilities`, `.confidence`), `score` (ordered rubric → `.score`, `.confidence`). All questions in a request are answered in parallel against the one `state`; pricing is per input token.
- JEV is literal and cannot count, do arithmetic, compare dates or generate text. So in `desktop/lib/questions.js`: exact conditions with boundary cases in `criteria`, one judgment per question, magnitudes handed over as words ("seen dozens of times"), a small named state object (never the raw event), and all composites (`verdictOf`, `priorityOf`) computed in code. Generative work (fix reports, agents) goes to a different model in `lib/ghost.js`.
- **Honesty rule:** without a key (or when JEV is unreachable) a keyword heuristic produces the same answer shape and is stored as `judged_by: "heuristic…"`. The UI shows this via `<JudgedBy>`. Never present heuristic output as JEV's. When a key appears, the sweeper upgrades heuristic verdicts in the background.

## Backend architecture (`desktop/lib`)

- **One router.** `app/api/[...path]/route.js` forwards every request to `lib/api.js → handle(req, segments)`. This keeps server state in one bundle and makes the API testable with plain `Request` objects. Public routes (any origin): `POST ingest`, `GET flags`. Everything else is admin, open locally and gated by `SIGNAL98_ADMIN_TOKEN` (cookie or Bearer) when set.
- **Persistence** is Node's built-in `node:sqlite`, loaded with `process.getBuiltinModule` so the bundler never sees it (`lib/db.js`). `node:sqlite` rejects `undefined` bindings — always pass `null`. Statements are cached via `q(sql)`; dynamic SQL uses `db().prepare`. The file is `desktop/data/signal98.db` (gitignored); `SIGNAL98_DB=:memory:` in tests.
- **All long-lived server state sits on `globalThis`** (`__s98_db`, `__s98_bus`, `__s98_classify`, `__s98_jev`, `__s98_ghost`): dev-mode HMR re-evaluates modules, and Next bundles `lib/` per route.
- **Ingest → issue → verdict** (`lib/ingest.js`, `lib/classify.js`): a batch is authenticated, bounded, clock-skew corrected and written in one transaction; `$exception`, `$network_error`, error-level `$log` and rage/dead clicks are grouped into `issues` by fingerprint. The response never waits for classification. The queue **is** the database (`issues.judge_status = 'pending'`), pumped by `kick()` with 4 workers, so restarts lose nothing.
- **Efficiency model:** JEV judges issues, not events; repeat occurrences inherit the verdict for free. Re-judging happens only on regression (resolved issue fires again) or when volume crosses 10× the count at last judgment. Sessions are judged after going idle; custom event names once. `jev_usage` tracks requests/tokens; the overview reports `leverage` (events covered per request).
- `lib/jev.js` owns concurrency, requests-per-minute pacing, timeout, backoff with `Retry-After`, answer validation and the circuit breaker (trips immediately on 401/403, after 5 failures otherwise; 422 never trips it).
- **Alerts** (`lib/alerts.js`): rules decide when, channels decide where (web push via `web-push` with self-generated VAPID keys in `kv`; email via Resend or SMTP; Slack; webhook). Every dispatch is recorded in `notifications`, including `dry_run` with the reason, which is what the Outbox window shows. Cooldown is per rule+subject in `alert_state`; resolving an issue clears it so a regression alerts again.
- **Ghost** (`lib/ghost.js`): `proposeFix` writes a report; `startAgentRun` runs the Claude Code CLI headless (`--restricted`, no shell, Read/Grep/Glob/Edit/Write) in a **git worktree on its own branch** under `desktop/data/worktrees`, commits there, stores the diff; `ghost-worktree.js` snapshots current working files with a private Git index and a baseline commit, including non-ignored untracked files while preserving the user’s staging and branch. `applyRun` checks and applies only the agent diff to working files (without `--3way` or `--index`), preserving staging and rejecting conflicts, then resolves the issue. Saved branches include the snapshot; use Apply fix to bring back only the fix. Auto mode (`maybeAutoFix`) is gated by JEV's `is_actionable` / `fix_complexity` / `is_noise` plus attempt and daily budgets. Recursion is driven by reality: a fix that does not hold causes a regression, which re-judges and re-dispatches with earlier diffs in the prompt.
- Live updates: `lib/bus.js` pub/sub → `GET /api/stream` (SSE). Publish only after the transaction commits.

## Monitor UI (`desktop/app`, `desktop/apps`, `desktop/components`)

`app/page.jsx` is the window manager; `APPS` maps app ids to components in `apps/`, which receive `{ wm, params, nonce }` (see `docs/UI.md`). Use the shared kit — `lib/client.js` (`api`, `useApi`, the single shared `useStream` EventSource, formatters, `VERDICTS`, `SERIES`) and `components/charts.jsx` — and the Win98 classes in `app/globals.css` (shell chrome in `app/shell.css`). No UI or chart libraries, no `alert`/`confirm`. `components/GhostAssistant.jsx` is the Clippy behaviour: it reacts to `verdict` and `agent` stream messages.

## Things that look optional and are not

- **SSR apps need the server half of the integration.** A crash during Next's server render (or in a route handler) returns a 500 before any browser code runs, so the browser SDK never sees it. `playground/instrumentation.js` (`register` + `onRequestError`) is what reports those, with the real server stack. Without it the monitor is blind to "this page is down for everyone".
- **Grouping is a contract.** `sdk/src/util.js → fingerprintOf` keys on type + message *template* + top-3 `function@file` — deliberately NOT line numbers or build content-hashes, because a fix moves lines in the very file it patches and a regressed bug must land on the same issue (that is what drives the ghost's retry loop). The server's `templatePath` applies the same hash-blindness to network issues. Golden values are pinned in `sdk/test/util.test.js`; changing them needs a server-side migration that aliases old fingerprints.
- **The keyword heuristic reads WHAT broke from the error only** (type, title, culprit, path). Breadcrumbs describe what the user did beforehand and must never pick the category. UX signals (rage/dead clicks) never page on their own. Do not tune the heuristic to make a demo look good; it is a labelled stand-in, JEV is the classifier.
- **`desktop/test` has an enforced network boundary**: `globalThis.fetch` is replaced for the whole process and the last test asserts nothing escaped. A judging job outliving a per-test fetch stub once sent a real request to api.typesafe.ai. Keep new JEV tests inside `jevHandler`, and drain the judging queue before clearing it.
- **Never stop a process by port.** `dev.sh` only kills listeners whose cwd is inside this checkout, and the SDK example server takes an OS-assigned loopback port. Popular ports belong to other projects.
- **Driving the demo from automation:** programmatic `.click()` has `event.detail === 0`, which the SDK intentionally excludes from rage-click detection; use real pointer input to demonstrate one. Wait for hydration before clicking (SSR'd buttons exist before their handlers do), and verify outcomes against `/api/events`, not screenshots.

## SDK invariants (`sdk/src`)

Never throw into the host app; patched globals (fetch, XHR, History, console) preserve behaviour and are restored on uninstall; no `window` access at import time; never report requests to the signal98 host itself (feedback loop); input values are never captured. `sendBeacon` cannot set headers, which is why the project key travels in the query string and body.
