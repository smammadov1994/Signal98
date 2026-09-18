# playground — the trigger panel

A tiny React app for setting off errors through the real `signal98` SDK.

- Buttons trigger different errors: auto-capture, `wrap()`, manual
  `captureException`, `console.error`, custom events.
- The SDK fires them into the **Win98 desktop's ingest**
  (`http://localhost:3001/api/ingest`) — that's where JEV judges them.
- The right panel shows what you fired and its verdict; the desktop's
  **Raw Feed** window shows the full live stream.

## Run

```bash
cd ~/signal98
npm run dev
```

That boots the desktop (:3001, the backend) and this playground (:3000, the
trigger panel). The judging key (`TYPESAFE_API_KEY`) lives in
`../desktop/.env.local` now, since the desktop does the judging.
Without it, a local heuristic judges instead.
