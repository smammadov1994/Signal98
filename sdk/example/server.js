// Tiny example signal98 host (zero dependencies).
//
//   GET  /                     the browser demo page (example/browser.html)
//   GET  /s98.js               the script-tag build (dist/signal98.min.js — run `npm run build` first)
//   POST /api/ingest?key=...   receives SDK batches, judges each event, logs the verdict
//   GET  /api/flags?key=...    a couple of demo feature flags
//
// In production, judgeEvent() is where the JEV call goes: send the event to
// the TypeSafe System One API (model "jev-latest"), get back typed
// judgments — is_urgent? / is_user_facing? / is_novel? / severity — and page
// when urgent ≥ 0.70, user-facing ≥ 0.60, novelty ≥ 0.55.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// No hardcoded port: whatever number we pick is somebody's. (Both 8787 and 8790 turned out to be
// other services on the author's machine — and on macOS `listen()` can "succeed" next to a process
// holding the same port on another address family, so EADDRINUSE cannot be trusted either.)
// PORT=… forces one; otherwise the OS hands out a free port, loopback only, and we print it.
const FORCED = Number(process.env.PORT) || 0;
let PORT = FORCED;
const file = (rel) => fileURLToPath(new URL(rel, import.meta.url));

// The SDK may live on another origin than the app it monitors.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Signal-Key",
};

// Toy stand-in for a real JEV judgment. Replace with a TypeSafe API call.
function judgeEvent(evt) {
  const first = evt.properties?.$exception_list?.[0];
  const text = `${first?.type || ""} ${first?.value || ""} ${evt.event}`.toLowerCase();
  const urgent = /uncaught|unhandled|crash|failed|timeout|declined|rageclick|network_error|5\d\d/.test(text) ? 0.8 : 0.4;
  const userFacing = /user|checkout|payment|login|render|click|profile|upload/.test(text) ? 0.8 : 0.3;
  const novelty = 0.6; // a real JEV call scores this per event
  const paged = urgent >= 0.7 && userFacing >= 0.6 && novelty >= 0.55;
  return { urgent, userFacing, novelty, paged };
}

function describe(evt) {
  const p = evt.properties || {};
  const first = p.$exception_list?.[0];
  if (first) return `${first.type}: ${first.value}`;
  if (evt.event === "$web_vitals") return `$web_vitals ${p.$metric}=${p.$value} (${p.$rating})`;
  if (evt.event === "$network_error") return `$network_error ${p.$method} ${p.$url} -> ${p.$status}`;
  if (evt.event === "$log") return `$log [${p.$level}] ${p.$message}`;
  if (p.$el_selector) return `${evt.event} ${p.$event_type || ""} ${p.$el_selector}`;
  if (evt.event === "$pageview" || evt.event === "$pageleave") return `${evt.event} ${p.$pathname}`;
  return evt.event;
}

async function serve(res, rel, type, transform) {
  try {
    const body = transform ? transform(await readFile(file(rel), "utf8")) : await readFile(file(rel));
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); // after the read: a missing file must still 404
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`${rel} not found - run \`npm run build\` in sdk/ first\n`);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  // the page learns this server's real origin at serve time
  if (req.method === "GET" && url.pathname === "/")
    return serve(res, "./browser.html", "text/html; charset=utf-8", (html) => html.replaceAll("__ORIGIN__", `http://localhost:${PORT}`));
  if (req.method === "GET" && url.pathname === "/s98.js") return serve(res, "../dist/signal98.min.js", "text/javascript");
  if (req.method === "GET" && url.pathname === "/api/flags") {
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ flags: { "demo-banner": true, "button-color": "teal" } }));
  }
  if (req.method === "GET" && url.pathname === "/api/flaky") {
    res.writeHead(503, { ...CORS, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "demo endpoint that always fails" }));
  }

  if (req.method === "POST" && url.pathname === "/api/ingest") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      let received = 0;
      try {
        // Envelope { api_key, sent_at, batch } (SDK 0.2) or a bare array (SDK 0.1).
        // sendBeacon posts it as text/plain, so never trust the content type.
        const parsed = JSON.parse(body);
        const batch = Array.isArray(parsed) ? parsed : parsed.batch || [parsed];
        for (const evt of batch) {
          const j = judgeEvent(evt);
          const verdict = j.paged ? "PAGED     " : "suppressed";
          console.log(
            `${verdict} [u=${j.urgent.toFixed(2)} f=${j.userFacing.toFixed(2)} n=${j.novelty.toFixed(2)}] ${String(describe(evt)).slice(0, 100)}`
          );
          received++;
        }
      } catch (e) {
        console.log("bad batch:", e.message);
        res.writeHead(400, { ...CORS, "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "bad json" }));
      }
      res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, received, dropped: 0 }));
    });
    return;
  }

  res.writeHead(404, CORS);
  res.end("not found");
});

server.listen(FORCED, "127.0.0.1", () => {
  PORT = server.address().port;
  console.log(`signal98 example host on http://localhost:${PORT}  (open it in a browser for the demo page)`);
  console.log(`node demo:  SIGNAL98_HOST=http://localhost:${PORT} node example/node-demo.js`);
});
