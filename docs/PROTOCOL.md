# signal98 wire protocol

The contract between the SDK (`sdk/`), the backend (`desktop/app/api`, `desktop/lib`) and the monitor UI.
Shapes deliberately mirror PostHog so that people arriving from it recognise everything.

## Ingest

```
POST {host}/api/ingest?key=<PROJECT_KEY>
Content-Type: application/json   (text/plain is also accepted — sendBeacon cannot always set JSON)

{ "api_key": "<PROJECT_KEY>", "sent_at": "<iso>", "batch": [ Event, ... ] }
```

- The key travels in the query string **and** the body because `navigator.sendBeacon` cannot set headers.
  `X-Signal-Key` header is accepted too. A bare JSON array of events (legacy SDK 0.1) is still accepted.
- Limits: 1 MB per request, 200 events per batch, 64 KB per event (oversized events are truncated, not rejected).
- Responses: `200 { ok: true, received, dropped }` · `400` bad JSON · `401` unknown key · `413` too large ·
  `429` rate limited (honour `Retry-After` seconds). The SDK retries on network failure / 429 / 5xx with
  exponential backoff and drops the batch on any other 4xx.

## Event

```json
{
  "uuid": "client generated, used for idempotent ingest",
  "event": "$pageview",
  "timestamp": "2026-09-18T12:00:00.000Z",
  "distinct_id": "anonymous uuid or identified user id",
  "properties": { "...": "..." }
}
```

### Properties attached to every browser event

`$session_id`, `$window_id`, `$current_url`, `$pathname`, `$host`, `$referrer`, `$referring_domain`, `$title`,
`$screen_width`, `$screen_height`, `$viewport_width`, `$viewport_height`, `$user_agent`, `$locale`, `$timezone`,
`$lib`, `$lib_version`, `$release`, `$environment`, `$service` (logical app name, default host name),
and `utm_source|medium|campaign|term|content` when present on the landing URL.
Node events carry `$lib`, `$lib_version`, `$release`, `$environment`, `$service`, `$node_version`, `$hostname`.

Sessions: a `$session_id` rotates after 30 minutes of inactivity or 24 hours total (stored in `sessionStorage` +
`localStorage` so tabs share it). `distinct_id` persists in `localStorage` (`s98_did`).

### Event catalogue

| event | extra properties |
|---|---|
| `$pageview` | — (fired on load and on every History API navigation) |
| `$pageleave` | `$prev_pageview_duration` (seconds), `$scroll_depth` (0–1) |
| `$autocapture` | `$event_type` (`click`/`submit`/`change`), `$el_tag`, `$el_text` (≤80 chars, never input values), `$el_selector`, `$el_href`, `$el_attrs` (`id`, `name`, `type`, `role`, `data-s98-*`) |
| `$rageclick` | same element fields + `$click_count` (≥3 clicks within 1 s inside 30 px) |
| `$dead_click` | element fields; click on an interactive element followed by no DOM mutation/navigation within 2.5 s |
| `$exception` | `$exception_list[0] = { type, value, stacktrace: { frames: [{ function, file, line, column }] }, mechanism: { handled, type } }`, `$exception_fingerprint`, `$exception_steps` (breadcrumbs, newest last, ≤50), `$exception_level` (`error`/`fatal`) |
| `$web_vitals` | `$metric` (`LCP`/`CLS`/`INP`/`FCP`/`TTFB`), `$value` (ms, unitless for CLS), `$rating` (`good`/`needs-improvement`/`poor`) |
| `$network_error` | `$method`, `$url` (query string stripped), `$status` (0 = network failure), `$duration_ms` — emitted for status ≥ 500, status 0, or duration above `slowRequestMs` (`$slow: true`) |
| `$log` | `$level` (`debug`/`info`/`warn`/`error`), `$message`, plus user properties |
| `$identify` | `$anon_distinct_id`, `$set`, `$set_once` |
| `$feature_flag_called` | `$feature_flag`, `$feature_flag_response` |
| anything else | custom product event, free-form properties |

Breadcrumb ("step") shape: `{ $message, $timestamp, $category: "ui"|"navigation"|"network"|"console"|"custom", ...props }`.

Privacy defaults: input values are never captured; elements (or ancestors) with `data-s98-mask` or class
`s98-mask` have their text replaced with `***`; elements with `data-s98-ignore` are skipped; URLs lose their
query string in network events; `respectDNT: true` disables everything when the browser sends Do Not Track.

## Feature flags

`GET {host}/api/flags?key=<PROJECT_KEY>&distinct_id=<id>` → `{ flags: { "<flag-key>": true | false | "<variant>" } }`.
Rollout bucketing is a stable hash of `flag-key + distinct_id`, so the same user always lands in the same bucket.

## Script tag

```html
<script src="{host}/s98.js" data-key="<PROJECT_KEY>" data-host="{host}" defer></script>
```

The IIFE build exposes `window.signal98` and auto-initialises from the `data-*` attributes
(`data-key`, `data-host`, optional `data-environment`, `data-release`, `data-service`).
Calls made before the script loads can be queued with the stub: `window.signal98 = window.signal98 || { _q: [] }`
then `signal98._q.push(["capture", "event", { ... }])`.

## Live stream

`GET {host}/api/stream` — Server-Sent Events. Message types (`event:` field):
`event` (a stored event row), `verdict` (issue classified / re-classified), `issue` (issue created or changed),
`notification` (alert dispatched), `agent` (ghost agent run progress), `ping` (every 15 s).

## Fresh demo view (admin queries)

`GET /api/issues?since=<unix_ms>` and `GET /api/overview?since=<unix_ms>` limit the view to events received at or after that timestamp. This does not delete or resolve any history. A repeated error can keep its original issue id and verdict. Issue list `count` and `users` describe the selected interval; `total_count` preserves the lifetime occurrence count. Older agent runs are omitted from the scoped issue list. Issue detail still shows the complete history.

Overview returns `since` when scoped; its event/user/session counters describe that interval, overriding the usual last-24-hour scope. JEV usage remains project-wide. The modern dashboard labels these as demo counters. Clearing the browser’s demo filter restores saved history.

## Issue conversations and monitoring dashboard

Admin-only `GET /api/conversations` provides one inbox entry per unmerged grouped issue, including JEV's selected Ghost, bounded last-message preview, total, offset, and has_more. Supports `q`, `status`, `verdict`, `since`, and `offset`; pages contain 50 entries. Demo counts are scoped; `total_count` preserves lifetime occurrences. It creates no model jobs.

`GET /api/issues/:id/conversation` returns issue context, specialist, provider, and the latest 100 saved messages. `before=<message id>` pages through earlier messages. `POST` to the same route accepts `{message, request_id}` (1–8,000 characters, stable 8–100-character request id) and persists the user message and queued reply atomically. Replaying a request id never invokes the model twice. One pending reply per issue, two model jobs globally, and at most 50 queued/active replies per project. A `chat` SSE event plus polling updates the client. Replies use the existing Ghost provider with read-only source tools; no template response is presented as model output. On restart, interrupted replies become visibly failed and can be retried with `POST /issues/:id/conversation-retry {message_id}`. Only the latest failed response can be retried. Pending queued replies resume on conversation access. Conversation history is project scoped and moves with merged issues; project reset removes it.

`POST /issues/:id/agent` remains the explicit Prepare fix action. Its isolated coding run now receives the last 30 completed discussion messages as context. Chat itself cannot edit files. Reviewing and applying a proposed diff use the existing agent run endpoints.

`GET /api/monitoring?range=24h|7d&since=<optional demo timestamp>` returns real event/error totals, distinct affected people, grouped issue state totals, and hourly or six-hour event/error buckets. Event metrics are windowed and optionally demo scoped; issue status totals cover all issues in the selected demo/history scope. No projected counts or synthetic comparison percentages are generated.

## First-run setup

Newly seeded projects record `setup:<project_id>` in server-side `kv`. `GET meta` includes `{setup:{required,status,step}}`. New/started guides open automatically; pre-existing databases without this record keep their current workspace. `GET /api/setup` returns the public project key, setup choices, configured-provider status, SDK package path, and proof of a matching test error. No private credential is ever returned.

Admin `POST /api/setup` saves `service`, `framework` (`react|next|script`), `host`, step (0–4), and optional repository path. Actions `begin`, `later`, and `complete` start a fresh proof marker, defer setup, or finish it. Finishing does not imply verified capture. Beginning setup or changing the target service replaces the test marker. Verification requires a new issue-linked event in the same project and service with `properties.signal98_setup` equal to this marker. Old events, unrelated services, and untagged events cannot satisfy it.

Admin `POST /api/setup/jev {key}` checks a candidate against TypeSafe using a small Noul question with explicit instructions and true/false criteria. Only a successful response allows replacing the server credential. With an empty body, it tests the existing server key without reading it into the browser. Provider errors are reduced to safe status messages. Credentials are atomically saved with mode 0600 in `credentials.json` under the server data directory (`SIGNAL98_SETUP_DIR` can override the credential location). Saved credentials override `TYPESAFE_API_KEY` on server startup. Tests using an in-memory database never read local credential files unless an explicit isolated setup directory is supplied. Setup mutations reject cross-origin browser requests and use the existing admin authentication.

The SDK build emits `desktop/public/downloads/signal98-0.2.0.tgz`; it is a public, credential-free npm package generated from the package allowlist with lifecycle scripts disabled during packing. Setup uses this download instead of assuming npm publication.
