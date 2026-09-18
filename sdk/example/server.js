// Tiny example ingest server (zero dependencies).
//
// Receives signal98 SDK batches at POST /api/ingest, judges each event with
// the same semantic paging rule as the signal98 demo, and logs the verdict.
//
// In production, judgeEvent() is where the JEV call goes: send the event to
// the TypeSafe System One API (model "jev-latest"), get back typed
// judgments — is_urgent? / is_user_facing? / is_novel? / severity — and page
// when urgent ≥ 0.70, user-facing ≥ 0.60, novelty ≥ 0.55.

import http from "node:http";

const PORT = 8787;

// Toy stand-in for a real JEV judgment. Replace with a TypeSafe API call.
function judgeEvent(evt) {
  const first = evt.properties?.$exception_list?.[0];
  const text = `${first?.type || ""} ${first?.value || ""} ${evt.event}`.toLowerCase();
  const urgent = /uncaught|unhandled|crash|failed|timeout|declined|5\d\d/.test(text) ? 0.8 : 0.4;
  const userFacing = /user|checkout|payment|login|render|click|profile|upload/.test(text) ? 0.8 : 0.3;
  const novelty = 0.6; // a real JEV call scores this per event
  const paged = urgent >= 0.7 && userFacing >= 0.6 && novelty >= 0.55;
  return { urgent, userFacing, novelty, paged };
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/ingest") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        const batch = JSON.parse(body);
        for (const evt of Array.isArray(batch) ? batch : [batch]) {
          const j = judgeEvent(evt);
          const first = evt.properties?.$exception_list?.[0];
          const label = first ? `${first.type}: ${first.value}` : evt.event;
          const verdict = j.paged ? "PAGED     " : "suppressed";
          console.log(
            `${verdict} [u=${j.urgent.toFixed(2)} f=${j.userFacing.toFixed(2)} n=${j.novelty.toFixed(2)}] ${String(label).slice(0, 90)}`
          );
        }
      } catch (e) {
        console.log("bad batch:", e.message);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`signal98 ingest listening on http://localhost:${PORT}/api/ingest`);
});
