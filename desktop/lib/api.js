// One router for the whole HTTP API. `app/api/[...path]/route.js` forwards every request
// here, which keeps all server state in a single bundle and makes the API testable
// with plain `Request` objects (see desktop/test).
//
// Two audiences:
//   • public, called by SDKs from any origin:  POST /api/ingest · GET /api/flags
//   • admin, called by the monitor UI:         everything else (same-origin; protected by
//     SIGNAL98_ADMIN_TOKEN when it is set)
import crypto from "node:crypto";
import { q, db, parse, getProject, listProjects, createProject, rotateProjectKey, saveProjectSettings, projectByKey, DEFAULT_SETTINGS } from "./db.js";
import { json, HttpError, clip, clamp } from "./util.js";
import { sseResponse } from "./bus.js";
import { handleIngest } from "./ingest.js";
import { boot, requestRejudge, publicIssue } from "./classify.js";
import { jevStatus } from "./jev.js";
import * as Q from "./queries.js";
import { proposeFix, startAgentRun, applyRun, publicRun, ghostProvider } from "./ghost.js";
import { sendTest, vapidPublicKey } from "./alerts.js";
import { publish } from "./bus.js";
import { CATEGORIES, CAUSES, INTENTS, OUTCOMES, STAGES } from "./questions.js";
import { listConversations, conversation, sendMessage, retryMessage } from "./conversations.js";
import { loadSetupCredentials, setupSummary, setupStatus, saveSetup, saveJevKey } from "./setup.js";
import { GHOSTS } from "./ghosts.js";

const PUBLIC_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Signal-Key",
  "Access-Control-Max-Age": "86400",
};

function isAdmin(req) {
  const token = process.env.SIGNAL98_ADMIN_TOKEN;
  if (!token) return true; // local development: open
  const given =
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    (req.headers.get("cookie") || "").match(/(?:^|;\s*)s98_admin=([^;]+)/)?.[1] || "";
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Stable 0–99 bucket so a user never flips between flag variants.
function bucketOf(flagKey, distinctId) {
  return parseInt(crypto.createHash("sha1").update(`${flagKey}.${distinctId}`).digest("hex").slice(0, 8), 16) % 100;
}

function evalFlags(project, distinctId) {
  const out = {};
  for (const f of q("SELECT * FROM flags WHERE project_id = ?").all(project.id)) {
    if (!f.enabled) { out[f.key] = false; continue; }
    const on = bucketOf(f.key, distinctId) < f.rollout;
    const variants = parse(f.variants, null);
    if (on && Array.isArray(variants) && variants.length) out[f.key] = variants[bucketOf(f.key + ":variant", distinctId) % variants.length];
    else out[f.key] = on;
  }
  return out;
}

async function body(req) {
  try { return (await req.json()) || {}; } catch { throw new HttpError(400, "bad json"); }
}

function projectFor(params) {
  const p = getProject(Number(params.get("project")) || undefined);
  if (!p) throw new HttpError(404, "no such project");
  return p;
}

const publicProject = (p) => ({ id: p.id, name: p.name, api_key: p.api_key, created_at: p.created_at, settings: p.settings });

export async function handle(req, segments) {
  loadSetupCredentials();
  const url = new URL(req.url);
  const params = url.searchParams;
  const [a, b, c] = segments;
  const route = `${req.method} ${segments.join("/")}`;

  // ------------------------------------------------------------ public
  if (a === "ingest" || a === "flags") {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: PUBLIC_CORS });
    try {
      if (a === "ingest" && req.method === "POST") return json(await handleIngest(req), { headers: PUBLIC_CORS });
      if (a === "flags" && req.method === "GET") {
        const project = projectByKey(params.get("key"));
        if (!project) throw new HttpError(401, "unknown project key");
        return json({ flags: evalFlags(project, params.get("distinct_id") || "") }, { headers: PUBLIC_CORS });
      }
      throw new HttpError(405, "method not allowed");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error("[signal98] ingest error:", err);
      return json({ ok: false, error: status === 500 ? "internal error" : err.message }, { status, headers: { ...PUBLIC_CORS, ...(err.headers || {}) } });
    }
  }

  // ------------------------------------------------------------ admin
  try {
    if (route === "POST login") {
      const { token } = await body(req);
      if (!process.env.SIGNAL98_ADMIN_TOKEN || token !== process.env.SIGNAL98_ADMIN_TOKEN) throw new HttpError(401, "wrong token");
      return json({ ok: true }, { headers: { "Set-Cookie": `s98_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000` } });
    }
    if (!isAdmin(req)) throw new HttpError(401, "admin token required");
    boot();
    const project = projectFor(params);
    const pid = project.id;

    if (a === "setup" && req.method === "POST") {
      const origin=req.headers.get("origin");
      if(origin && origin!==url.origin) throw new HttpError(403,"Setup changes must come from this monitor.");
      if(route === "POST setup") return json(saveSetup(pid,await body(req)));
      if(route === "POST setup/jev") return json(await saveJevKey(pid,await body(req)));
    }
    switch (route) {
      case "GET setup": return json(await setupStatus(pid));
      case "GET stream": return sseResponse(req, { projectId: pid });
      case "GET conversations": return json(listConversations(pid, params));
      case "GET monitoring": return json(Q.monitoring(pid, params));
      case "GET overview": return json(Q.overview(pid, params));
      case "GET meta":
        return json({
          setup: setupSummary(pid), project: publicProject(project), projects: listProjects().map(publicProject),
          jev: jevStatus(), ghost_provider: await ghostProvider(), ghosts: GHOSTS.map(({ id, name, color, permissions, specialty }) => ({ id, name, color, permissions, specialty })),
          taxonomy: { categories: CATEGORIES, causes: CAUSES, intents: INTENTS, outcomes: OUTCOMES, stages: STAGES },
          admin_protected: !!process.env.SIGNAL98_ADMIN_TOKEN,
          mail_transport: process.env.RESEND_API_KEY ? "resend" : process.env.SMTP_URL ? "smtp" : null,
        });
      case "GET events": return json({ events: Q.listEvents(pid, params) });
      case "DELETE events": {
        // "Clear" in the Live Feed: wipes captured data, keeps configuration.
        for (const t of ["events", "issues", "sessions", "persons", "person_aliases", "event_defs", "fixes", "agent_runs", "issue_messages", "notifications"]) db().prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(pid);
        q("DELETE FROM alert_state WHERE rule_id IN (SELECT id FROM alert_rules WHERE project_id = ?)").run(pid);
        publish("reset", { project_id: pid });
        return json({ ok: true });
      }
      case "GET issues": return json({ issues: Q.listIssues(pid, params) });
      case "GET insights/trend": return json(Q.trend(pid, params));
      case "POST insights/funnel": return json(Q.funnel(pid, await body(req)));
      case "GET insights/retention": return json(Q.retention(pid, params));
      case "GET insights/lifecycle": return json({ stages: Q.lifecycle(pid, params) });
      case "GET insights/events": return json({ events: Q.eventDefs(pid) });
      case "GET web": return json(Q.web(pid, params));
      case "GET sessions": return json({ sessions: Q.listSessions(pid, params) });
      case "GET persons": return json({ persons: Q.listPersons(pid, params) });
      case "GET agent/runs":
        return json({ runs: q("SELECT r.*, i.title issue_title, i.type issue_type FROM agent_runs r LEFT JOIN issues i ON i.id = r.issue_id WHERE r.project_id = ? ORDER BY r.id DESC LIMIT 50").all(pid).map((r) => ({ ...publicRun(r), diff: undefined, has_diff: !!r.diff })) });
      case "GET alerts/rules": return json({ rules: q("SELECT * FROM alert_rules WHERE project_id = ? ORDER BY id").all(pid).map((r) => ({ ...r, config: parse(r.config, {}), channel_ids: parse(r.channel_ids, []) })) });
      case "GET alerts/channels": return json({ channels: q("SELECT * FROM channels WHERE project_id = ? ORDER BY id").all(pid).map((r) => ({ ...r, config: parse(r.config, {}) })), push_subscribers: q("SELECT COUNT(*) n FROM push_subs WHERE project_id = ?").get(pid).n });
      case "GET alerts/notifications": return json({ notifications: q("SELECT * FROM notifications WHERE project_id = ? ORDER BY id DESC LIMIT 100").all(pid) });
      case "GET push/key": return json({ key: await vapidPublicKey() });
      case "GET feature-flags": return json({ flags: q("SELECT * FROM flags WHERE project_id = ? ORDER BY id").all(pid).map((f) => ({ ...f, variants: parse(f.variants, null) })) });
    }

    if (route === "POST alerts/rules") {
      const r = await body(req);
      if (!r.name || !r.kind) throw new HttpError(400, "name and kind are required");
      const id = q("INSERT INTO alert_rules (project_id, name, kind, config, channel_ids, cooldown_s, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(pid, clip(r.name, 120), clip(r.kind, 40), JSON.stringify(r.config || {}), JSON.stringify(r.channel_ids || []), clamp(Number.isFinite(Number(r.cooldown_s)) && r.cooldown_s !== null && r.cooldown_s !== "" ? Number(r.cooldown_s) : 900, 0, 604800), r.enabled === false ? 0 : 1).lastInsertRowid;
      return json({ id: Number(id) });
    }
    if (a === "alerts" && b === "rules" && c) {
      const id = Number(c);
      if (req.method === "DELETE") { q("DELETE FROM alert_rules WHERE id = ? AND project_id = ?").run(id, pid); return json({ ok: true }); }
      if (req.method === "PATCH") {
        const r = await body(req);
        const cur = q("SELECT * FROM alert_rules WHERE id = ? AND project_id = ?").get(id, pid);
        if (!cur) throw new HttpError(404, "no such rule");
        q("UPDATE alert_rules SET name = ?, enabled = ?, config = ?, channel_ids = ?, cooldown_s = ? WHERE id = ?")
          .run(clip(r.name ?? cur.name, 120), r.enabled === undefined ? cur.enabled : r.enabled ? 1 : 0, JSON.stringify(r.config ?? parse(cur.config, {})),
            JSON.stringify(r.channel_ids ?? parse(cur.channel_ids, [])), clamp(Number(r.cooldown_s ?? cur.cooldown_s), 0, 604800), id);
        return json({ ok: true });
      }
    }
    if (route === "POST alerts/channels") {
      const r = await body(req);
      if (!["email", "webhook", "slack", "push"].includes(r.type)) throw new HttpError(400, "bad channel type");
      const id = q("INSERT INTO channels (project_id, type, name, config) VALUES (?, ?, ?, ?)").run(pid, r.type, clip(r.name || r.type, 80), JSON.stringify(r.config || {})).lastInsertRowid;
      return json({ id: Number(id) });
    }
    if (a === "alerts" && b === "channels" && c) {
      const id = Number(c);
      if (req.method === "DELETE") {
        q("DELETE FROM channels WHERE id = ? AND project_id = ?").run(id, pid);
        // no dangling ids left behind in the rules that pointed at it
        for (const rule of q("SELECT id, channel_ids FROM alert_rules WHERE project_id = ?").all(pid)) {
          const ids = parse(rule.channel_ids, []);
          if (ids.includes(id)) q("UPDATE alert_rules SET channel_ids = ? WHERE id = ?").run(JSON.stringify(ids.filter((x) => x !== id)), rule.id);
        }
        return json({ ok: true });
      }
      if (req.method === "PATCH") {
        const r = await body(req);
        const cur = q("SELECT * FROM channels WHERE id = ? AND project_id = ?").get(id, pid);
        if (!cur) throw new HttpError(404, "no such channel");
        q("UPDATE channels SET name = ?, config = ?, enabled = ? WHERE id = ?")
          .run(clip(r.name ?? cur.name, 80), JSON.stringify(r.config ?? parse(cur.config, {})), r.enabled === undefined ? cur.enabled : r.enabled ? 1 : 0, id);
        return json({ ok: true });
      }
      if (req.method === "POST" && segments[3] === "test") {
        const ch = q("SELECT enabled FROM channels WHERE id = ? AND project_id = ?").get(id, pid);
        if (!ch) throw new HttpError(404, "no such channel");
        if (!ch.enabled) throw new HttpError(409, "this channel is disabled — enable it to send a test");
        return json({ notifications: await sendTest(pid, id) });
      }
    }
    if (route === "POST push/subscribe") {
      const s = await body(req);
      if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth) throw new HttpError(400, "not a push subscription");
      q("INSERT INTO push_subs (project_id, endpoint, keys, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, project_id = excluded.project_id")
        .run(pid, s.endpoint, JSON.stringify(s.keys), Date.now());
      return json({ ok: true });
    }
    if (route === "POST push/unsubscribe") {
      const s = await body(req);
      q("DELETE FROM push_subs WHERE endpoint = ?").run(String(s.endpoint || ""));
      return json({ ok: true });
    }

    if (a === "issues" && b) {
      const id = Number(b);
      const exists = q("SELECT * FROM issues WHERE id = ? AND project_id = ?").get(id, pid);
      if (!exists) throw new HttpError(404, "no such issue");
      if (c === "conversation" && req.method === "GET") return json(await conversation(pid, exists, params));
      if (c === "conversation" && req.method === "POST") return json(sendMessage(pid, exists, await body(req)));
      if (c === "conversation-retry" && req.method === "POST") return json(retryMessage(pid, exists, (await body(req)).message_id));
      if (!c && req.method === "GET") return json(Q.issueDetail(pid, id));
      if (!c && req.method === "PATCH") {
        const r = await body(req);
        if (r.status) {
          if (!["open", "resolved", "ignored"].includes(r.status)) throw new HttpError(400, "bad status");
          q("UPDATE issues SET status = ?, resolved_at = ?, regressed = CASE WHEN ? = 'resolved' THEN 0 ELSE regressed END WHERE id = ?")
            .run(r.status, r.status === "resolved" ? Date.now() : null, r.status, id);
          // resolving re-arms the alerts for this issue, so a regression notifies again
          if (r.status !== "open") q("DELETE FROM alert_state WHERE subject = ?").run(`issue:${id}`);
        }
        if (r.assignee !== undefined) q("UPDATE issues SET assignee = ? WHERE id = ?").run(r.assignee ? clip(r.assignee, 80) : null, id);
        if (r.merge_into) {
          const target = q("SELECT id FROM issues WHERE id = ? AND project_id = ? AND merged_into IS NULL").get(Number(r.merge_into), pid);
          if (!target || target.id === id) throw new HttpError(400, "bad merge target");
          q("UPDATE issues SET merged_into = ? WHERE id = ?").run(target.id, id);
          q("UPDATE events SET issue_id = ? WHERE issue_id = ?").run(target.id, id);
          q("UPDATE issues SET count = count + ?, first_seen = MIN(first_seen, ?), last_seen = MAX(last_seen, ?) WHERE id = ?").run(exists.count, exists.first_seen, exists.last_seen, target.id);
          // the history travels with the events, so nothing is stranded on a hidden issue
          for (const t of ["fixes", "agent_runs", "issue_messages", "notifications"]) db().prepare(`UPDATE ${t} SET issue_id = ? WHERE issue_id = ?`).run(target.id, id);
          q("UPDATE issues SET similar_to = NULL, similar_p = NULL WHERE similar_to = ?").run(id);
          publish("issue", { project_id: pid, issue_id: target.id });
        }
        publish("issue", { project_id: pid, issue_id: id });
        return json({ issue: publicIssue(q("SELECT * FROM issues WHERE id = ?").get(id)) });
      }
      if (c === "rejudge" && req.method === "POST") { requestRejudge(id); return json({ ok: true }); }
      if (c === "fix" && req.method === "POST") return json({ fix: await proposeFix(id) });
      if (c === "agent" && req.method === "POST") return json({ run: await startAgentRun(id, "manual") });
    }
    if (a === "agent" && b === "runs" && c) {
      const run = q("SELECT * FROM agent_runs WHERE id = ? AND project_id = ?").get(Number(c), pid);
      if (!run) throw new HttpError(404, "no such run");
      if (req.method === "GET") {
        const issue = q("SELECT type, title FROM issues WHERE id = ?").get(run.issue_id);
        return json({ run: { ...publicRun(run), diff: run.diff, issue_title: issue?.title ?? null, issue_type: issue?.type ?? null } });
      }
      if (req.method === "POST" && segments[3] === "apply") return json({ run: await applyRun(run.id) });
    }
    if (a === "sessions" && b && req.method === "GET") {
      const d = Q.sessionDetail(pid, b);
      if (!d) throw new HttpError(404, "no such session");
      return json(d);
    }
    if (a === "persons" && b && req.method === "GET") {
      const d = Q.personDetail(pid, b);
      if (!d) throw new HttpError(404, "no such person");
      return json(d);
    }

    if (route === "POST feature-flags") {
      const r = await body(req);
      const key = String(r.key || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 60);
      if (!key) throw new HttpError(400, "key is required");
      if (q("SELECT 1 x FROM flags WHERE project_id = ? AND key = ?").get(pid, key)) throw new HttpError(409, `a flag named "${key}" already exists`);
      q("INSERT INTO flags (project_id, key, name, enabled, rollout, variants, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(pid, key, clip(r.name || key, 120), r.enabled === false ? 0 : 1, clamp(Number(r.rollout ?? 100), 0, 100), r.variants?.length ? JSON.stringify(r.variants) : null, Date.now());
      return json({ ok: true });
    }
    if (a === "feature-flags" && b) {
      const id = Number(b);
      if (req.method === "DELETE") { q("DELETE FROM flags WHERE id = ? AND project_id = ?").run(id, pid); return json({ ok: true }); }
      if (req.method === "PATCH") {
        const r = await body(req);
        const cur = q("SELECT * FROM flags WHERE id = ? AND project_id = ?").get(id, pid);
        if (!cur) throw new HttpError(404, "no such flag");
        q("UPDATE flags SET enabled = ?, rollout = ? WHERE id = ?").run(r.enabled === undefined ? cur.enabled : r.enabled ? 1 : 0, clamp(Number(r.rollout ?? cur.rollout), 0, 100), id);
        return json({ ok: true });
      }
    }

    if (route === "PATCH settings") {
      const r = await body(req);
      const cur = project.settings;
      const next = {
        ...cur,
        retentionDays: clamp(Number(r.retentionDays ?? cur.retentionDays), 1, 3650),
        sessionIdleMinutes: clamp(Number(r.sessionIdleMinutes ?? cur.sessionIdleMinutes), 0.25, 120),
        thresholds: { ...cur.thresholds, ...numeric(r.thresholds, DEFAULT_SETTINGS.thresholds) },
        ghost: { ...cur.ghost, ...ghostPatch(r.ghost) },
      };
      saveProjectSettings(pid, next);
      if (r.name) q("UPDATE projects SET name = ? WHERE id = ?").run(clip(r.name, 80), pid);
      publish("settings", { project_id: pid });
      return json({ project: publicProject(getProject(pid)) });
    }
    if (route === "POST projects") return json({ project: publicProject(createProject((await body(req)).name || "new project")) });
    if (route === "POST projects/rotate-key") return json({ api_key: rotateProjectKey(pid) });

    throw new HttpError(404, `no route: ${route}`);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(`[signal98] ${route}:`, err);
    return json({ ok: false, error: status === 500 ? clip(err?.message || "internal error", 300) : err.message }, { status });
  }
}

// Thresholds live on JEV's scales: severities are 0–4, probabilities 0–1.
const RANGES = { pageSeverity: [0, 4], notifySeverity: [0, 4], pageUserFacing: [0, 1], pageUrgent: [0, 1], noise: [0, 1] };
function numeric(patch, shape) {
  const out = {};
  for (const k of Object.keys(shape)) {
    if (!patch || patch[k] === null || patch[k] === "" || !Number.isFinite(Number(patch[k]))) continue;
    const [lo, hi] = RANGES[k] || [-Infinity, Infinity];
    out[k] = clamp(Number(patch[k]), lo, hi);
  }
  return out;
}

function ghostPatch(g) {
  if (!g) return {};
  const out = {};
  if (g.autoMode !== undefined) out.autoMode = !!g.autoMode;
  if (g.autoApply !== undefined) out.autoApply = !!g.autoApply;
  if (g.repoPath !== undefined) out.repoPath = clip(String(g.repoPath || "").trim(), 500);
  const G = { maxAttemptsPerIssue: [1, 10], maxRunsPerDay: [0, 200], minActionable: [0, 1], maxFixComplexity: [0, 4] };
  for (const [k, [lo, hi]] of Object.entries(G)) if (g[k] !== null && g[k] !== "" && Number.isFinite(Number(g[k]))) out[k] = clamp(Number(g[k]), lo, hi);
  return out;
}
