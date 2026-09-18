import { listEvents, clearEvents } from "../../../lib/store.js";
import { withCors, optionsResponse } from "../../../lib/cors.js";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return optionsResponse();
}

export async function GET() {
  return withCors(
    Response.json({
      mode: process.env.TYPESAFE_API_KEY ? "jev" : "heuristic",
      rule: "page when urgent ≥ 0.70 and user-facing ≥ 0.60 and novel ≥ 0.55",
      events: listEvents(),
    })
  );
}

// Truly empty the feed.
export async function DELETE() {
  clearEvents();
  return withCors(Response.json({ ok: true }));
}
