# Monitor UI contract (desktop/)

The monitor defaults to a conversation inbox (`components/ModernShell.jsx` and `components/Conversations.jsx`), with a separate monitoring dashboard (`components/MonitoringDashboard.jsx`). Windows 98 remains available through a persistent style switch. `app/page.jsx` selects the shell; both support the same `wm` interface. Modern mode shows one main view, plain-language issue summaries, and details on demand. Advanced tools stay behind More tools. The modern stylesheet lives in `app/modern.css`.

## App component props

```jsx
export default function MyApp({ wm, params }) { ... }
```

- `params` — whatever the opener passed (e.g. `{ id: 12 }`). Always treat as optional.
- `wm.open(appId, params?)` — open or focus a window. Multi-instance apps (`issue`, `session`, `person`, `run`)
  are keyed by `params.id`, so `wm.open("issue", { id: 12 })` twice focuses the same window.
- `wm.close()` — close this window. `wm.setTitle(text)` — change this window's title bar.

## App ids → files

| id | file | what |
|---|---|---|
| `feed` | `apps/LiveFeed.jsx` | live event stream (SSE) |
| `issues` / `issue` | `apps/Issues.jsx` / `apps/IssueDetail.jsx` | error tracking list / one issue |
| `pages` | `apps/Pages.jsx` | open issues whose verdict is `page` |
| `recycle` | `apps/RecycleBin.jsx` | what JEV said to ignore + ignored/resolved issues |
| `insights` | `apps/Insights.jsx` | trends, funnels, retention, lifecycle |
| `web` | `apps/WebAnalytics.jsx` | web analytics |
| `sessions` / `session` | `apps/Sessions.jsx` / `apps/SessionDetail.jsx` | sessions list / timeline |
| `persons` / `person` | `apps/Persons.jsx` / `apps/PersonDetail.jsx` | people |
| `alerts` | `apps/Alerts.jsx` | rules, channels, outbox, push |
| `settings` | `apps/Settings.jsx` | install snippet, JEV status, thresholds, ghost, flags, projects |
| `runs` / `run` | `apps/GhostRuns.jsx` / `apps/RunDetail.jsx` | ghost agent runs / one run with diff |
| `readme` | `apps/Readme.jsx` | notepad |

## Shared kit — use it, do not reinvent it

- `desktop/lib/client.js`: `api(path, { method, body })`, `useApi(path, { every, on })` (`on` = stream message
  types that trigger a reload), `useStream(fn)` (one shared EventSource; messages are `{ type, data }`),
  `useStreamStatus()`, formatters (`fmtTime`, `fmtDateTime`, `ago`, `fmtNum`, `fmtPct`, `fmtDuration`, `fmtUsd`,
  `label`), `VERDICTS`, `SERIES`.
- `desktop/components/charts.jsx`: `LineChart`, `Spark`, `BarList`, `Meter`, `StatTile`, `FunnelChart`, `Legend`,
  `VerdictTag`, `JudgedBy`, `useWidth`.
- `desktop/app/globals.css`: bevels `raised` / `sunken` / `sunken-thin`; window chrome `menubar`, `toolbar`,
  `tool-btn` (`.on`), `addrbar`, `statusbar` + `.cell` (`.grow`); `btn98` (`.small`); v0.2 kit: `tabs`/`tab`/`tab-body`,
  `in98`, `field`, `group98`, `check98`, `t98` table (`tr.sel`, `td.num`, `td.wrap`), `vtag`, `tag` (`.new`, `.regressed`),
  `judgedby`, `panel`, `grid2`/`grid3`, `stats`, `split`, `pane`, `col`/`row`/`grow`/`scroll`, `muted`, `pad`, `mono`,
  `selectable`, `pre.code`, `pre.diff` (`.add`/`.del`/`.hunk`), `err`.
  Add new CSS only when the kit has no answer, in a clearly named block at the end of `globals.css`.

## Rules

- Every window: a `toolbar` on top where it has actions/filters, scrolling content in the middle (the window body is
  a flex column — give the content `className="grow scroll"` or `pane`), a `statusbar` at the bottom.
- Handle all three states everywhere: loading ("…"), empty (say what to do to get data, e.g. "fire the playground
  at :3000"), and error (`<div className="err">`). Never render `undefined`/`NaN`; classification fields can be
  null while an issue is still `judging`.
- Honesty rule: wherever a verdict/classification is shown, show who judged it with `<JudgedBy by={...} />`.
  Heuristic output must never be labelled as JEV.
- Text is selectable only where copying is useful (`selectable`): stack traces, snippets, ids.
- Win98 mode uses 11px Tahoma. Modern mode uses readable system typography, clear spacing, and progressive disclosure. Do not add floating Ghost prompts to the modern dashboard.
- Charts: one y-axis, a legend when ≥ 2 series, hover tooltip, labels in ink colours. Status colours (`VERDICTS`)
  always ship with their word.
- The API is same-origin under `/api/…`; read `desktop/lib/api.js` (routes) and `desktop/lib/queries.js`
  (response shapes) — they are the source of truth. `docs/PROTOCOL.md` describes event properties.

## Settings and guided demos

Modern Settings uses a section sidebar and setup overview. JEV status distinguishes no key, configured without a successful response, connection failure, and a verified response. Never equate `enabled` with a successful live connection.

The dashboard labels saved demo history and offers a reversible fresh-demo filter stored in `s98_demo_since`. Dashboard counters, issue lists, and sidebar badges share that scope. `/demo` in the playground lets the user deliberately trigger one handled exception through the SDK without crashing the page. Demo verification must preserve saved history; keep the user’s selected scope unless testing a reset deliberately.

## Prominent JEV results

`components/JevResult.jsx` provides the `judgment` detail view. Each issue conversation shows its JEV verdict prominently and links directly to the full model assessment, with severity, urgency, and actionability. The button opens the full classification directly. Keyword fallbacks and pending results must never be labelled as completed JEV results. A fresh demo stays empty until a new error arrives. Previous results are available through View history, never inserted into the fresh assessment. The priority is computed from the recorded assessment and configured rules; model scores are not user-impact percentages.

## Conversation-first workspace

The modern shell now opens `conversations` by default. Preserve the existing ghost brand and sidebar, adding Conversations before Dashboard. An inbox contains searchable, paginated grouped issues with their JEV-selected specialist. Selecting an issue keeps it stable while updates arrive. Each chat includes current JEV/fallback provenance, captured context, saved user/model messages, retry state, a composer, and a separate Prepare fix control. Fix run state appears in the conversation with a direct link to review the diff and apply. Both chats and generated code use the configured Ghost model, not JEV text generation. The prepared code run includes the user's discussion. Chat history spans demos for the same issue; counts in the chat explicitly say total occurrences.

`MonitoringDashboard.jsx` hosts the distinct Dashboard navigation view: four actual monitoring totals, a dot chart of captured error occurrences with explicit aggregation units and inspectable counts, priority issues, an issue table linked to conversations, and the Ghost entry point. Lavender and mint accents follow the user's visual reference; no invented revenue, forecasts, or activity. Range selectors and demo/history filters share the backend scope. Narrow screens show either the inbox or the chat with a Back button, keeping the composer reachable; the dashboard stacks naturally. Legacy Windows 98 remains available via the existing switch.

## First-run walkthrough

`SetupWizard.jsx` is a five-step modal: identify the app and public project key, privately connect JEV, set Ghost source context, install a downloadable SDK with framework-specific snippets, and verify a tagged error from the target app. A new database opens it automatically; existing workspaces can open it from Settings → Setup walkthrough. Progress, defer, and completion live on the server, not in browser storage. The TypeSafe key exists only in the password input until submitted; it is cleared after success and never reloaded into the input. Existing keys can be checked without exposing them.

The guide provides a React render boundary and both browser/server capture for Next.js Node runtime. Test snippets contain a fresh setup marker and never trigger an error from the monitor itself. A completion without a matching test must remain labelled unverified. The underlying workspace is inert while the modal is open; Tab stays inside the guide. On mobile the progress rail becomes a compact step indicator and the content scrolls independently of the footer.
