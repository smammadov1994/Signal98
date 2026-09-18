// JEV is the router. It does not fix anything itself — it looks at the
// semantic judgments of a set of events and picks which ghost to summon.
import { GHOSTS } from "./ghosts";

function features(events) {
  const peak = (k) => Math.max(...events.map((e) => e.judgments[k]));
  return {
    count: events.length,
    maxUrgency: peak("is_urgent"),
    maxUser: peak("is_user_facing"),
    maxNovelty: peak("is_novel"),
    maxSeverity: peak("severity"),
    anyPaged: events.some((e) => e.paged),
    allSuppressed: events.every((e) => !e.paged),
  };
}

export function routeGhost(events) {
  const f = features(events);
  let best = GHOSTS[0];
  let bestScore = -Infinity;
  for (const g of GHOSTS) {
    const s = g.match(f);
    if (s > bestScore) {
      bestScore = s;
      best = g;
    }
  }
  return { ghost: best, score: bestScore, reason: best.explain(f), features: f };
}
