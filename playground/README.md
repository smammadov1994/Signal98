# playground — ghost mart

A small Next.js shop wrapped with the `signal98` SDK: `app/signal.jsx` (browser) and `instrumentation.js` (server — without it, crashes during server rendering and in route handlers are invisible).
It fires into the monitor's ingest at `http://localhost:3001` with the local dev key.

Genuine bugs, left in on purpose so the ghost has something to fix:

| where | what happens |
|---|---|
| `app/product/[id]/page.jsx` | **Fog in a Can** has no `specs` → `TypeError` during the **server** render → HTTP 500. No browser code runs, so only `instrumentation.js` (`onRequestError`) can report it; a client-side navigation to the same page is caught by the error boundary instead |
| `app/cart/page.jsx` → `discountFor` | coupon **GHOST10** is stored as `"10%"` → `NaN` → throws; the button appears to do nothing (rage-click it) |
| `app/cart/page.jsx` | **Compare prices** has no handler → dead click |
| `app/api/pay/route.js` | totals over $100 read `config.fraud.reviewer` → 500 → failed payment |
| `app/api/recommendations/route.js` | ~5 s response → slow-request report |

`/chaos` has one-click triggers for pages, tickets, noise, product events and an error flood.

Run the whole stack from the repo root with `npm run dev`. Point the SDK elsewhere with
`NEXT_PUBLIC_SIGNAL98_HOST` / `NEXT_PUBLIC_SIGNAL98_KEY`.
