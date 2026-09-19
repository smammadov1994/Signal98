// The classification pipeline: everything JEV judges flows through here.
//
// Efficiency model — this is what makes JEV cheap enough to sit on the ingest path:
//   • JEV judges ISSUES (fingerprints), not events. The 10,000th occurrence of a known
//     error costs zero tokens: it inherits the issue's verdict at insert time.
//   • An issue is re-judged only when its story changes: it regresses, or its volume
//     crosses an order of magnitude (the state describes volume in words).
//   • Sessions are judged once they go quiet; custom event names once, ever.
//   • The queue is the database (`judge_status = 'pending'`), so a restart loses nothing.
import { q, parse, getProject, bumpUsage, listProjects } from "./db.js";
import { ask, jevEnabled, jevStatus, JevUnavailable } from "./jev.js";
import { publish } from "./bus.js";
import {
  issueQuestions, issueState, flattenIssueAnswers, heuristicIssueAnswers, verdictOf, priorityOf,
  duplicateQuestions, sessionQuestions, sessionState, flattenSessionAnswers, heuristicSessionAnswers,
  eventDefQuestions, heuristicEventDefAnswers,
} from "./questions.js";
import { evaluateIssueAlerts, evaluateSessionAlerts, evaluateTimedAlerts } from "./alerts.js";
import { maybeAutoFix } from "./ghost.js";

const WORKERS = 4;
const MAX_JEV_ATTEMPTS = 3;

function st() {
  return (globalThis.__s98_classify ||= { inflight: new Set(), retryAt: new Map(), timer: null, lastSweep: 0, lastPrune: 0 });
}

const rowToEvent = (r) => (r ? { ...r, props: parse(r.props, {}) } : null);

// ---------------------------------------------------------------- issues
export async function judgeIssue(issueId) {
  const issue = q("SELECT * FROM issues WHERE id = ?").get(issueId);
  if (!issue) return null;
  const project = getProject(issue.project_id);
  const sample = rowToEvent(
    q("SELECT * FROM events WHERE issue_id = ? ORDER BY ts DESC LIMIT 1").get(issueId) ||
    q("SELECT * FROM events WHERE id = ?").get(issue.sample_event_id)
  );
  const users = q("SELECT COUNT(DISTINCT distinct_id) n FROM events WHERE issue_id = ?").get(issueId).n;
  const isNew = !issue.judged_at;

  let flat, judgedBy, similar = null, latencyMs = null;
  const useJev = jevEnabled() && issue.judge_attempts < MAX_JEV_ATTEMPTS;
  if (useJev) {
    try {
      const r = await ask(issueState(issue, sample, { users, isNew }), issueQuestions(), { projectId: issue.project_id });
      flat = flattenIssueAnswers(r.answers);
      judgedBy = r.model || "jev";
      latencyMs = r.latencyMs;
      if (isNew) similar = await findSemanticDuplicate(issue, sample).catch(() => null);
    } catch (err) {
      if (!(err instanceof JevUnavailable)) {
        // Never swallow this: an operator staring at "judging…" needs to know why.
        console.warn(`[signal98] JEV could not judge issue #${issueId} (attempt ${issue.judge_attempts + 1}/${MAX_JEV_ATTEMPTS}): ${err?.message || err}`);
        q("UPDATE issues SET judge_attempts = judge_attempts + 1 WHERE id = ?").run(issueId);
        if (issue.judge_attempts + 1 < MAX_JEV_ATTEMPTS) {
          // leave it pending and come back later; the UI keeps showing "judging…"
          st().retryAt.set(`i${issueId}`, Date.now() + 5000 * (issue.judge_attempts + 1));
          q("UPDATE issues SET judge_status = 'pending' WHERE id = ?").run(issueId);
          return null;
        }
      }
      flat = null;
    }
  }
  if (!flat) {
    flat = heuristicIssueAnswers(issue, sample);
    // Honest labelling: a heuristic verdict must never be presented as JEV's.
    judgedBy = jevEnabled() ? "heuristic (JEV unavailable)" : "heuristic";
    bumpUsage(issue.project_id, { heuristic: 1 });
  }

  const verdict = verdictOf(flat, project.settings.thresholds);
  const priority = priorityOf(flat, issue);
  const now = Date.now();
  q(`UPDATE issues SET judge_status = 'judged', judged_by = ?, judged_at = ?, judged_count = count,
       classification = ?, category = ?, cause = ?, severity = ?, priority = ?, verdict = ?,
       similar_to = COALESCE(?, similar_to), similar_p = COALESCE(?, similar_p)
     WHERE id = ?`)
    .run(judgedBy, now, JSON.stringify({ ...flat, latencyMs }), flat.category, flat.cause, flat.severity, priority, verdict,
      similar?.id ?? null, similar?.p ?? null, issueId);

  const fresh = q("SELECT * FROM issues WHERE id = ?").get(issueId);
  publish("verdict", { project_id: issue.project_id, issue: publicIssue(fresh), previous_verdict: issue.verdict, is_new: isNew });
  // Alerts and the ghost react to verdicts; neither may break the judging loop.
  evaluateIssueAlerts(fresh, { isNew, previousVerdict: issue.verdict }).catch((e) => console.error("[signal98] alerts:", e));
  maybeAutoFix(fresh, isNew ? "auto" : "regression").catch((e) => console.error("[signal98] ghost:", e));
  return fresh;
}

// "Is this the same bug wearing a different stack trace?" — a Choice over recent open issues.
async function findSemanticDuplicate(issue, sample) {
  const candidates = q(
    `SELECT id, type, title, culprit FROM issues
     WHERE project_id = ? AND id != ? AND status = 'open' AND merged_into IS NULL AND kind = ?
     ORDER BY last_seen DESC LIMIT 12`
  ).all(issue.project_id, issue.id, issue.kind);
  if (!candidates.length) return null;
  const state = { new_problem: issueState(issue, sample).problem };
  const r = await ask(state, duplicateQuestions(candidates), { projectId: issue.project_id });
  const a = r.answers.same_as;
  if (a.choice === "none") return null;
  const p = a.probabilities?.[a.choice] ?? 0;
  if (p < 0.8) return null; // suggest only when JEV is clear; merging stays a human decision
  return { id: Number(a.choice.replace("issue_", "")), p };
}

export function publicIssue(r) {
  if (!r) return null;
  return { ...r, classification: parse(r.classification, null) };
}

export function requestRejudge(issueId) {
  q("UPDATE issues SET judge_status = 'pending', judge_attempts = 0 WHERE id = ?").run(issueId);
  st().retryAt.delete(`i${issueId}`);
  const row = q("SELECT project_id FROM issues WHERE id = ?").get(issueId);
  if (row) publish("issue", { project_id: row.project_id, issue_id: issueId }); // windows flip to "judging…" at once
  kick();
}

// ---------------------------------------------------------------- sessions
async function judgeSession(projectId, sessionId) {
  const session = q("SELECT * FROM sessions WHERE project_id = ? AND id = ?").get(projectId, sessionId);
  if (!session) return;
  const events = q("SELECT * FROM events WHERE project_id = ? AND session_id = ? ORDER BY ts LIMIT 400").all(projectId, sessionId).map(rowToEvent);
  let flat, judgedBy;
  if (jevEnabled()) {
    try {
      const r = await ask(sessionState(session, events), sessionQuestions(), { projectId });
      flat = flattenSessionAnswers(r.answers);
      judgedBy = r.model || "jev";
    } catch { /* fall through to heuristic */ }
  }
  if (!flat) {
    flat = heuristicSessionAnswers(session, events);
    judgedBy = jevEnabled() ? "heuristic (JEV unavailable)" : "heuristic";
    bumpUsage(projectId, { heuristic: 1 });
  }
  q(`UPDATE sessions SET judge_status = 'judged', judged_by = ?, judged_at = ?, judged_count = event_count,
       classification = ?, intent = ?, outcome = ?, frustration = ? WHERE project_id = ? AND id = ?`)
    .run(judgedBy, Date.now(), JSON.stringify(flat), flat.intent, flat.outcome, flat.frustration, projectId, sessionId);
  const fresh = q("SELECT * FROM sessions WHERE project_id = ? AND id = ?").get(projectId, sessionId);
  publish("session", { project_id: projectId, session: { ...fresh, classification: flat } });
  evaluateSessionAlerts(fresh, flat).catch((e) => console.error("[signal98] alerts:", e));
}

// ---------------------------------------------------------------- event definitions
async function judgeEventDef(projectId, name) {
  const def = q("SELECT * FROM event_defs WHERE project_id = ? AND name = ?").get(projectId, name);
  if (!def) return;
  let flat, judgedBy;
  if (jevEnabled()) {
    try {
      const state = { event_name: name, example_properties: parse(def.sample_props, {}) };
      const r = await ask(state, eventDefQuestions(), { projectId });
      flat = { stage: r.answers.stage.choice, stage_conf: r.answers.stage.confidence ?? null, is_conversion: r.answers.is_conversion.noul };
      judgedBy = r.model || "jev";
    } catch { /* heuristic below */ }
  }
  if (!flat) {
    flat = heuristicEventDefAnswers(name);
    judgedBy = jevEnabled() ? "heuristic (JEV unavailable)" : "heuristic";
  }
  q("UPDATE event_defs SET judge_status = 'judged', judged_by = ?, classification = ?, stage = ?, is_conversion = ? WHERE project_id = ? AND name = ?")
    .run(judgedBy, JSON.stringify(flat), flat.stage, flat.is_conversion, projectId, name);
}

// ---------------------------------------------------------------- the pump
async function pump() {
  const s = st();
  const now = Date.now();
  while (s.inflight.size < WORKERS) {
    const rows = q("SELECT id FROM issues WHERE judge_status = 'pending' AND merged_into IS NULL ORDER BY id LIMIT 20").all();
    const next = rows.find((r) => !s.inflight.has(`i${r.id}`) && (s.retryAt.get(`i${r.id}`) || 0) <= now);
    if (!next) break;
    const tag = `i${next.id}`;
    s.inflight.add(tag);
    q("UPDATE issues SET judge_status = 'judging' WHERE id = ?").run(next.id);
    judgeIssue(next.id)
      .catch((err) => {
        console.error("[signal98] judgeIssue failed:", err);
        q("UPDATE issues SET judge_status = 'pending', judge_attempts = judge_attempts + 1 WHERE id = ?").run(next.id);
        s.retryAt.set(tag, Date.now() + 10_000);
      })
      .finally(() => {
        s.inflight.delete(tag);
        kick();
      });
  }
}

export function kick() {
  // microtask-ish debounce so a 200-event batch triggers one pump, not 200
  const s = st();
  if (s.kicked) return;
  s.kicked = true;
  setTimeout(() => {
    s.kicked = false;
    pump().catch((e) => console.error("[signal98] pump:", e));
  }, 5);
}

async function sweep() {
  const s = st();
  const now = Date.now();
  for (const project of listProjects()) {
    const idleMs = Math.max(0.25, Number(project.settings.sessionIdleMinutes) || 2) * 60_000;
    const sessions = q(
      `SELECT id FROM sessions WHERE project_id = ? AND last_at < ? AND event_count > judged_count AND event_count >= 3
       ORDER BY last_at DESC LIMIT 8`
    ).all(project.id, now - idleMs);
    for (const row of sessions) await judgeSession(project.id, row.id).catch((e) => console.error("[signal98] session:", e));

    const defs = q("SELECT name FROM event_defs WHERE project_id = ? AND judge_status = 'pending' LIMIT 8").all(project.id);
    for (const d of defs) await judgeEventDef(project.id, d.name).catch((e) => console.error("[signal98] eventdef:", e));

    // A key was added (or JEV recovered): upgrade heuristic verdicts to real ones, gently.
    if (jevEnabled() && jevStatus().circuit === "closed") {
      q(`UPDATE issues SET judge_status = 'pending', judge_attempts = 0
         WHERE id IN (SELECT id FROM issues WHERE project_id = ? AND judge_status = 'judged' AND judged_by LIKE 'heuristic%' ORDER BY last_seen DESC LIMIT 10)`)
        .run(project.id);
      q(`UPDATE sessions SET judged_count = 0 WHERE project_id = ? AND judge_status = 'judged' AND judged_by LIKE 'heuristic%'
         AND id IN (SELECT id FROM sessions WHERE project_id = ? ORDER BY last_at DESC LIMIT 5)`).run(project.id, project.id);
      q("UPDATE event_defs SET judge_status = 'pending' WHERE project_id = ? AND judged_by LIKE 'heuristic%'").run(project.id);
    }

    if (now - s.lastPrune > 3_600_000) {
      const cutoff = now - (Number(project.settings.retentionDays) || 30) * 86_400_000;
      q("DELETE FROM events WHERE project_id = ? AND ts < ?").run(project.id, cutoff);
      q("DELETE FROM sessions WHERE project_id = ? AND last_at < ?").run(project.id, cutoff);
      q("DELETE FROM notifications WHERE project_id = ? AND created_at < ?").run(project.id, cutoff);
    }
  }
  if (now - s.lastPrune > 3_600_000) s.lastPrune = now;
  await evaluateTimedAlerts().catch((e) => console.error("[signal98] timed alerts:", e));
  kick();
}

// Called lazily by the API layer; safe to call many times.
export function boot() {
  const s = st();
  if (s.timer) return;
  // Anything that was mid-flight when the process died goes back in the queue.
  q("UPDATE issues SET judge_status = 'pending' WHERE judge_status = 'judging'").run();
  s.timer = setInterval(() => sweep().catch((e) => console.error("[signal98] sweep:", e)), 15_000);
  s.timer.unref?.();
  kick();
}
