import { listEvents, resetEvents } from "../../../lib/store.js";
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

// Clear back to the bundled history.
export async function DELETE() {
  resetEvents();
  return withCors(Response.json({ ok: true }));
}
