# signal98

JEV-powered semantic error tracking — the "better than Datadog and PostHog" project.

- `sdk/` — the `signal98` library. Drop it in any app: it captures errors
  (auto-capture, `wrap()`, `captureException()`) and ships them to your ingest endpoint.
- `playground/` — the trigger panel (:3000). Buttons set off real errors through
  the SDK and fire them into the desktop's ingest.
- `desktop/` — the Windows 98 monitor (:3001). Owns `/api/ingest`, judges every
  event with JEV (urgent / user-facing / novel → PAGED or SUPPRESSED), and shows
  the **Raw Feed**, **JEV Verdicts**, **Pages**, and **Recycle Bin** windows — plus
  the 8-bit ghost that routes itself to incidents and exorcises them on your say-so.

## Run everything

```bash
cd ~/signal98
npm run dev
```

Starts both apps:
- desktop backend → http://localhost:3001 (starts first)
- playground trigger panel → http://localhost:3000

Open the desktop's **Raw Feed** window, press a button in the playground, and watch
each event arrive as `judging…` before its verdict lands.

## Real JEV judgments

The desktop judges with a local heuristic out of the box. For real JEV verdicts,
paste your TypeSafe key into `desktop/.env.local` (`TYPESAFE_API_KEY=...`) and
restart. Get a key at https://console.typesafe.ai — never commit that file.
