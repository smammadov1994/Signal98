import { pushEvent, updateEvent } from "../../../lib/store.js";
import { judgeEvent } from "../../../lib/judge.js";
import { withCors, optionsResponse } from "../../../lib/cors.js";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return optionsResponse();
}

// Convert one raw signal98 SDK event into the desktop's canonical shape.
function toDesktopEvent(sdkEvt) {
  const first = sdkEvt.properties?.$exception_list?.[0];
  const message = first
    ? `${first.type}: ${first.value}`.slice(0, 220)
    : String(sdkEvt.event || "event");
  return {
    ts: new Date().toISOString(),
    service: "playground",
    level: sdkEvt.event === "$exception" ? "ERROR" : "INFO",
    message,
    mechanism: first?.mechanism?.type || "manual",
    judgments: null,
    paged: false,
    status: "judging",
    judgedBy: null,
  };
}

// Fill in the verdict once JEV (or the heuristic) answers.
// severity is derived from the three scores on the bundle's 0–3 scale.
function finalize(j) {
  const sev = +(((j.urgent + j.userFacing + j.novelty) / 3) * 3).toFixed(1);
  return {
    judgments: {
      is_urgent: j.urgent,
      is_user_facing: j.userFacing,
      is_novel: j.novelty,
      severity: sev,
    },
    paged: j.verdict === "paged",
    status: "judged",
    judgedBy: j.judgedBy,
  };
}

// Receives signal98 SDK batches (the playground fires these). Each event is
// stored immediately as "judging", judged without blocking the response,
// then updated with its verdict.
export async function POST(req) {
  let batch;
  try {
    batch = await req.json();
  } catch {
    return withCors(Response.json({ ok: false, error: "bad json" }, { status: 400 }));
  }
  const list = Array.isArray(batch) ? batch : [batch];
  for (const sdkEvt of list) {
    const entry = pushEvent(toDesktopEvent(sdkEvt));
    judgeEvent(sdkEvt).then((j) => updateEvent(entry.id, finalize(j)));
  }
  return withCors(Response.json({ ok: true, received: list.length }));
}
