// Read side: everything the monitor windows ask for. Plain SQL over the events table —
// no pre-aggregation yet, which is fine into the low millions of rows with these indexes.
import { q, db, parse } from "./db.js";
import { publicIssue } from "./classify.js";
import { publicFix, publicRun } from "./ghost.js";
import { jevStatus, JEV_USD_PER_MTOK } from "./jev.js";
import { clamp } from "./util.js";

function sinceOf(params) {
  const n = Number(params.get("since"));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const HOUR = 3_600_000, DAY = 86_400_000;

export function range(params) {
  const now = Date.now();
  const presets = { "1h": HOUR, "6h": 6 * HOUR, "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };
  const span = presets[params.get("range")] || DAY;
  const to = Number(params.get("to")) || now;
  const from = Number(params.get("from")) || to - span;
  // pick a bucket that yields ~24–60 points
  const bucket = to - from <= 2 * HOUR ? 5 * 60_000 : to - from <= 2 * DAY ? HOUR : DAY;
  return { from, to, bucket };
}

function series(rows, { from, to, bucket }, keys = ["n"]) {
  const map = new Map(rows.map((r) => [r.b, r]));
  const out = [];
  for (let b = Math.floor(from / bucket) * bucket; b <= to; b += bucket) {
    const r = map.get(b);
    const point = { t: b };
    for (const k of keys) point[k] = r ? r[k] : 0;
    out.push(point);
  }
  return out;
}

// ---------------------------------------------------------------- overview
export function overview(pid, params = new URLSearchParams()) {
  const now = Date.now();
  const one = (sql, ...a) => db().prepare(sql).get(...a);
  const verdicts = q("SELECT COALESCE(verdict, 'judging') v, COUNT(*) n FROM issues WHERE project_id = ? AND status = 'open' AND merged_into IS NULL GROUP BY v").all(pid);
  const usage = q("SELECT * FROM jev_usage WHERE project_id = ? ORDER BY day DESC LIMIT 30").all(pid);
  const today = usage.find((u) => u.day === new Date().toISOString().slice(0, 10)) || { requests: 0, input_tokens: 0, failures: 0, heuristic: 0 };
  const totalTokens = usage.reduce((s, u) => s + u.input_tokens, 0);
  // What per-event judging would have cost: every issue-linked event would be a request.
  const linked = one("SELECT COUNT(*) n FROM events WHERE project_id = ? AND issue_id IS NOT NULL", pid).n;
  const requests = usage.reduce((s, u) => s + u.requests, 0);
  const result = {
    events_last_minute: one("SELECT COUNT(*) n FROM events WHERE project_id = ? AND ts >= ?", pid, now - 60_000).n,
    events_24h: one("SELECT COUNT(*) n FROM events WHERE project_id = ? AND ts >= ?", pid, now - DAY).n,
    users_24h: one("SELECT COUNT(DISTINCT distinct_id) n FROM events WHERE project_id = ? AND ts >= ?", pid, now - DAY).n,
    sessions_24h: one("SELECT COUNT(*) n FROM sessions WHERE project_id = ? AND last_at >= ?", pid, now - DAY).n,
    open_issues: Object.fromEntries(verdicts.map((v) => [v.v, v.n])),
    unread_pages: one("SELECT COUNT(*) n FROM issues WHERE project_id = ? AND status = 'open' AND verdict = 'page' AND merged_into IS NULL", pid).n,
    jev: {
      ...jevStatus(),
      today,
      tokens_30d: totalTokens,
      cost_30d_usd: (totalTokens / 1e6) * JEV_USD_PER_MTOK,
      requests_30d: requests,
      events_covered: linked,
      // the efficiency headline: judgments served per JEV request
      leverage: requests ? linked / requests : null,
    },
  };
  const since = sinceOf(params);
  if (since) {
    const verdicts = q("SELECT COALESCE(verdict, 'judging') v, COUNT(*) n FROM issues WHERE project_id = ? AND status = 'open' AND merged_into IS NULL AND id IN (SELECT issue_id FROM events WHERE project_id = ? AND received_at >= ?) GROUP BY v").all(pid, pid, since);
    result.open_issues = Object.fromEntries(verdicts.map(v => [v.v, v.n]));
    result.unread_pages = result.open_issues.page || 0;
    const counts = q("SELECT COUNT(*) events, COUNT(DISTINCT distinct_id) users, COUNT(DISTINCT session_id) sessions FROM events WHERE project_id = ? AND received_at >= ?").get(pid, since);
    result.events_24h = counts.events;
    result.users_24h = counts.users;
    result.sessions_24h = counts.sessions;
    result.since = since;
  }
  return result;
}

// ---------------------------------------------------------------- events
export function listEvents(pid, params) {
  const where = ["project_id = ?"], args = [pid];
  const add = (sql, v) => { where.push(sql); args.push(v); };
  if (params.get("before")) add("id < ?", Number(params.get("before")));
  if (params.get("event")) add("event = ?", params.get("event"));
  if (params.get("session")) add("session_id = ?", params.get("session"));
  if (params.get("person")) add("distinct_id = ?", params.get("person"));
  if (params.get("issue")) add("issue_id = ?", Number(params.get("issue")));
  if (params.get("kind") === "errors") where.push("issue_id IS NOT NULL");
  if (params.get("kind") === "custom") where.push("event NOT LIKE '$%'");
  if (params.get("q")) add("(message LIKE ? OR event LIKE ?)", `%${params.get("q")}%`), args.push(`%${params.get("q")}%`);
  const limit = clamp(Number(params.get("limit")) || 100, 1, 500);
  const rows = db().prepare(
    `SELECT e.*, i.verdict i_verdict, i.category i_category, i.severity i_severity, i.judge_status i_judge_status, i.judged_by i_judged_by, i.status i_status
     FROM (SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${limit}) e
     LEFT JOIN issues i ON i.id = e.issue_id ORDER BY e.id DESC`
  ).all(...args);
  const full = params.get("full") === "1";
  return rows.map((r) => {
    const p = parse(r.props, {});
    const base = {
      id: r.id, ts: r.ts, event: r.event, message: r.message, distinct_id: r.distinct_id, session_id: r.session_id, issue_id: r.issue_id,
      service: r.service, environment: r.environment, pathname: r.pathname, level: r.level, browser: r.browser, os: r.os, device: r.device,
      mechanism: p.$exception_list?.[0]?.mechanism?.type, handled: p.$exception_list?.[0]?.mechanism?.handled,
      issue: r.issue_id ? { id: r.issue_id, verdict: r.i_verdict, category: r.i_category, severity: r.i_severity, judge_status: r.i_judge_status, judged_by: r.i_judged_by, status: r.i_status } : null,
    };
    return full ? { ...base, props: p } : base;
  });
}

// ---------------------------------------------------------------- issues
export function listIssues(pid, params) {
  const since = sinceOf(params);
  const where = ["project_id = ?", "merged_into IS NULL"], args = [pid];
  if (since) { where.push("id IN (SELECT issue_id FROM events WHERE project_id = ? AND received_at >= ?)"); args.push(pid, since); }
  const status = params.get("status") || "open";
  if (status !== "all") { where.push("status = ?"); args.push(status); }
  for (const k of ["verdict", "category", "kind", "cause"]) if (params.get(k)) { where.push(`${k} = ?`); args.push(params.get(k)); }
  if (params.get("q")) { where.push("(title LIKE ? OR type LIKE ? OR culprit LIKE ?)"); const s = `%${params.get("q")}%`; args.push(s, s, s); }
  const sort = { priority: "priority DESC, last_seen DESC", last_seen: "last_seen DESC", first_seen: "first_seen DESC", count: "count DESC", severity: "severity DESC" }[params.get("sort")] || "priority DESC, last_seen DESC";
  const issues = db().prepare(`SELECT * FROM issues WHERE ${where.join(" AND ")} ORDER BY ${sort} LIMIT 200`).all(...args).map(publicIssue);
  if (!issues.length) return issues;
  // sparkline: last 24 h in hourly buckets, one query for all listed issues
  const now = Date.now(), from = now - DAY;
  const ids = issues.map((i) => i.id);
  const rows = db().prepare(
    `SELECT issue_id, (ts / ${HOUR}) * ${HOUR} b, COUNT(*) n, COUNT(DISTINCT distinct_id) u FROM events
     WHERE issue_id IN (${ids.map(() => "?").join(",")}) AND ts >= ? GROUP BY issue_id, b`
  ).all(...ids, from);
  const users = db().prepare(`SELECT issue_id, COUNT(DISTINCT distinct_id) u FROM events WHERE issue_id IN (${ids.map(() => "?").join(",")}) GROUP BY issue_id`).all(...ids);
  const uMap = new Map(users.map((r) => [r.issue_id, r.u]));
  const marks = ids.map(() => "?").join(",");
  const fixed = new Set(db().prepare(`SELECT DISTINCT issue_id FROM fixes WHERE issue_id IN (${marks})`).all(...ids).map((r) => r.issue_id));
  const runs = new Map(db().prepare(
    `SELECT id, issue_id, status, attempt, trigger, created_at FROM agent_runs
     WHERE id IN (SELECT MAX(id) FROM agent_runs WHERE issue_id IN (${marks}) GROUP BY issue_id)`
  ).all(...ids).map((r) => [r.issue_id, r]));
  const rng = { from, to: now, bucket: HOUR };
  for (const i of issues) {
    i.spark = series(rows.filter((r) => r.issue_id === i.id), rng).map((p) => p.n);
    i.users = uMap.get(i.id) || 0;
    i.has_fix = fixed.has(i.id);
    i.run = publicRun(runs.get(i.id));
  }
  if (since) {
    const counts = q("SELECT issue_id, COUNT(*) n, COUNT(DISTINCT distinct_id) users, MAX(ts) last_seen FROM events WHERE project_id = ? AND received_at >= ? GROUP BY issue_id").all(pid, since);
    const byId = new Map(counts.map(r => [r.issue_id, r]));
    for (const issue of issues) {
      const recent = byId.get(issue.id);
      issue.total_count = issue.count;
      issue.count = recent?.n || 0;
      issue.users = recent?.users || 0;
      issue.last_seen = recent?.last_seen || issue.last_seen;
      if (issue.run && issue.run.created_at < since) issue.run = null;
    }
  }
  return issues;
}

export function issueDetail(pid, id) {
  const issue = publicIssue(q("SELECT * FROM issues WHERE id = ? AND project_id = ?").get(id, pid));
  if (!issue) return null;
  const events = q("SELECT * FROM events WHERE issue_id = ? ORDER BY ts DESC LIMIT 25").all(id).map((r) => ({ ...r, props: parse(r.props, {}) }));
  const now = Date.now();
  const rng = { from: now - DAY, to: now, bucket: HOUR };
  const rows = q(`SELECT (ts / ${HOUR}) * ${HOUR} b, COUNT(*) n FROM events WHERE issue_id = ? AND ts >= ? GROUP BY b`).all(id, rng.from);
  const breakdown = (col) => db().prepare(`SELECT ${col} k, COUNT(*) n FROM events WHERE issue_id = ? AND ${col} IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT 6`).all(id);
  return {
    issue,
    users: q("SELECT COUNT(DISTINCT distinct_id) n FROM events WHERE issue_id = ?").get(id).n,
    sessions: q("SELECT COUNT(DISTINCT session_id) n FROM events WHERE issue_id = ?").get(id).n,
    series: series(rows, rng),
    events,
    breakdowns: { browser: breakdown("browser"), os: breakdown("os"), pathname: breakdown("pathname"), release: breakdown("release"), environment: breakdown("environment") },
    affected: q(
      `SELECT e.distinct_id, COUNT(*) n, MAX(e.ts) last_ts, p.props, p.is_identified FROM events e
       LEFT JOIN persons p ON p.project_id = e.project_id AND p.distinct_id = e.distinct_id
       WHERE e.issue_id = ? AND e.distinct_id IS NOT NULL GROUP BY e.distinct_id ORDER BY n DESC LIMIT 10`
    ).all(id).map((r) => ({ ...r, props: parse(r.props, {}) })),
    similar: issue.similar_to ? publicIssue(q("SELECT id, type, title, status, verdict FROM issues WHERE id = ?").get(issue.similar_to)) : null,
    merged: q("SELECT id, type, title, count FROM issues WHERE merged_into = ?").all(id),
    fixes: q("SELECT * FROM fixes WHERE issue_id = ? ORDER BY id DESC LIMIT 5").all(id).map(publicFix),
    runs: q("SELECT * FROM agent_runs WHERE issue_id = ? ORDER BY id DESC LIMIT 10").all(id).map(publicRun),
    notifications: q("SELECT id, channel_type, target, subject, status, error, created_at FROM notifications WHERE issue_id = ? ORDER BY id DESC LIMIT 10").all(id),
  };
}

// ---------------------------------------------------------------- insights
const MATH = {
  total: "COUNT(*)",
  users: "COUNT(DISTINCT distinct_id)",
  sessions: "COUNT(DISTINCT session_id)",
};
const BREAKDOWN_COLS = new Set(["browser", "os", "device", "pathname", "referrer_domain", "service", "environment", "release", "event"]);

export function trend(pid, params) {
  const rng = range(params);
  const event = params.get("event") || "$pageview";
  const math = MATH[params.get("math")] || MATH.total;
  const by = params.get("breakdown");
  const evWhere = event === "*" ? "" : "AND event = ?";
  const evArgs = event === "*" ? [] : [event];
  if (by) {
    // breakdown by a column, or by a JSON property (prop:plan)
    const expr = by.startsWith("prop:") ? "json_extract(props, ?)" : BREAKDOWN_COLS.has(by) ? by : null;
    if (!expr) return { bucket: rng.bucket, total: 0, series: [], breakdown: [] };
    const pre = by.startsWith("prop:") ? ["$." + by.slice(5).replace(/[^\w$]/g, "")] : [];
    const top = db().prepare(`SELECT ${expr} k, ${math} n FROM events WHERE project_id = ? ${evWhere} AND ts BETWEEN ? AND ? GROUP BY k ORDER BY n DESC LIMIT 6`)
      .all(...pre, pid, ...evArgs, rng.from, rng.to);
    const rows = db().prepare(`SELECT ${expr} k, (ts / ${rng.bucket}) * ${rng.bucket} b, ${math} n FROM events WHERE project_id = ? ${evWhere} AND ts BETWEEN ? AND ? GROUP BY k, b`)
      .all(...pre, pid, ...evArgs, rng.from, rng.to);
    return { bucket: rng.bucket, total: top.reduce((s, t) => s + t.n, 0), breakdown: top.map((t) => ({ key: t.k ?? "(none)", total: t.n, series: series(rows.filter((r) => r.k === t.k), rng) })) };
  }
  const rows = db().prepare(`SELECT (ts / ${rng.bucket}) * ${rng.bucket} b, ${math} n FROM events WHERE project_id = ? ${evWhere} AND ts BETWEEN ? AND ? GROUP BY b`)
    .all(pid, ...evArgs, rng.from, rng.to);
  const total = db().prepare(`SELECT ${math} n FROM events WHERE project_id = ? ${evWhere} AND ts BETWEEN ? AND ?`).get(pid, ...evArgs, rng.from, rng.to).n;
  return { bucket: rng.bucket, total, series: series(rows, rng) };
}

// Ordered funnel, per person, steps must happen in order within the window.
export function funnel(pid, { steps = [], range: r = "7d", windowMinutes = 60 * 24 }) {
  const rng = range(new URLSearchParams({ range: r }));
  steps = steps.filter((s) => s && s.event).slice(0, 8);
  if (steps.length < 2) return { steps: [] };
  const match = (s) => (s.pathname ? "event = ? AND pathname = ?" : "event = ?");
  const margs = (s) => (s.pathname ? [s.event, s.pathname] : [s.event]);
  const rows = db().prepare(
    `SELECT distinct_id, ts, event, pathname FROM events WHERE project_id = ? AND ts BETWEEN ? AND ? AND distinct_id IS NOT NULL
     AND (${steps.map((s) => `(${match(s)})`).join(" OR ")}) ORDER BY distinct_id, ts`
  ).all(pid, rng.from, rng.to, ...steps.flatMap(margs));
  const reached = steps.map(() => 0);
  const times = steps.map(() => []);
  const is = (row, s) => row.event === s.event && (!s.pathname || row.pathname === s.pathname);
  let cur = null, idx = 0, t0 = 0, tPrev = 0;
  let best = steps.map(() => false); // per person: the deepest each step was ever reached
  const flush = () => { for (let i = 0; i < idx; i++) best[i] = true; best.forEach((b, i) => { if (b) reached[i]++; }); best = steps.map(() => false); };
  for (const row of rows) {
    if (row.distinct_id !== cur) { if (cur !== null) flush(); cur = row.distinct_id; idx = 0; }
    if (idx >= steps.length) continue;
    if (idx > 0 && row.ts - t0 > windowMinutes * 60_000) {
      // Window expired. Progress already made still counts as "reached" (it happened in time);
      // from here the person starts over, so later steps must fit a NEW window.
      for (let i = 0; i < idx; i++) best[i] = true;
      idx = 0;
      if (!is(row, steps[0])) continue;
    }
    if (is(row, steps[idx])) {
      if (idx === 0) t0 = row.ts; else times[idx].push(row.ts - tPrev);
      tPrev = row.ts;
      idx++;
    }
  }
  if (cur !== null) flush();
  const med = (a) => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  return {
    steps: steps.map((s, i) => ({
      ...s, count: reached[i],
      conversion: reached[0] ? reached[i] / reached[0] : 0,
      step_conversion: i === 0 ? 1 : reached[i - 1] ? reached[i] / reached[i - 1] : 0,
      median_ms: med(times[i]),
    })),
  };
}

// Weekly-cohort style retention on days: of the people first seen on day D, who came back on D+n?
export function retention(pid, params) {
  const days = clamp(Number(params.get("days")) || 8, 2, 14);
  const now = Date.now();
  const start = Math.floor((now - (days - 1) * DAY) / DAY) * DAY;
  const rows = db().prepare(
    `SELECT e.distinct_id d, (e.ts / ${DAY}) day, (p.first_seen / ${DAY}) first FROM events e
     JOIN persons p ON p.project_id = e.project_id AND p.distinct_id = e.distinct_id
     WHERE e.project_id = ? AND e.ts >= ? AND p.first_seen >= ? GROUP BY d, day`
  ).all(pid, start, start);
  const cohorts = new Map();
  for (const r of rows) {
    const c = cohorts.get(r.first) || { day: r.first * DAY, size: new Set(), back: new Map() };
    c.size.add(r.d);
    const n = r.day - r.first;
    if (!c.back.has(n)) c.back.set(n, new Set());
    c.back.get(n).add(r.d);
    cohorts.set(r.first, c);
  }
  return {
    days,
    cohorts: [...cohorts.values()].sort((a, b) => a.day - b.day).map((c) => ({
      day: c.day, size: c.size.size,
      values: Array.from({ length: days }, (_, n) => (c.day + n * DAY > now ? null : (c.back.get(n)?.size || 0) / c.size.size)),
    })),
  };
}

export function eventDefs(pid) {
  return q("SELECT * FROM event_defs WHERE project_id = ? ORDER BY count DESC LIMIT 200").all(pid).map((r) => ({ ...r, classification: parse(r.classification, null), sample_props: parse(r.sample_props, {}) }));
}

// Lifecycle view: custom events rolled up by the stage JEV assigned to each event name.
export function lifecycle(pid, params) {
  const rng = range(params);
  return q(
    `SELECT COALESCE(d.stage, 'unclassified') stage, COUNT(*) n, COUNT(DISTINCT e.distinct_id) users FROM events e
     LEFT JOIN event_defs d ON d.project_id = e.project_id AND d.name = e.event
     WHERE e.project_id = ? AND e.event NOT LIKE '$%' AND e.ts BETWEEN ? AND ? GROUP BY stage ORDER BY n DESC`
  ).all(pid, rng.from, rng.to);
}

// ---------------------------------------------------------------- web analytics
export function web(pid, params) {
  const rng = range(params);
  const a = [pid, rng.from, rng.to];
  const top = (col, event = "$pageview", limit = 8) =>
    db().prepare(`SELECT ${col} k, COUNT(*) n, COUNT(DISTINCT distinct_id) u FROM events WHERE project_id = ? AND event = ? AND ts BETWEEN ? AND ? AND ${col} IS NOT NULL AND ${col} != '' GROUP BY k ORDER BY n DESC LIMIT ${limit}`)
      .all(pid, event, rng.from, rng.to);
  const totals = q("SELECT COUNT(*) pageviews, COUNT(DISTINCT distinct_id) visitors, COUNT(DISTINCT session_id) sessions FROM events WHERE project_id = ? AND event = '$pageview' AND ts BETWEEN ? AND ?").get(...a);
  const sess = q("SELECT COUNT(*) n, SUM(pageviews <= 1) bounced, AVG(last_at - started_at) dur FROM sessions WHERE project_id = ? AND started_at BETWEEN ? AND ? AND pageviews > 0").get(...a);
  const pv = q(`SELECT (ts / ${rng.bucket}) * ${rng.bucket} b, COUNT(*) n, COUNT(DISTINCT distinct_id) u FROM events WHERE project_id = ? AND event = '$pageview' AND ts BETWEEN ? AND ? GROUP BY b`).all(...a);
  // p75 per vital, computed in JS (SQLite has no percentile)
  const vit = q("SELECT json_extract(props, '$.$metric') m, json_extract(props, '$.$value') v FROM events WHERE project_id = ? AND event = '$web_vitals' AND ts BETWEEN ? AND ? LIMIT 20000").all(...a);
  const byMetric = {};
  for (const r of vit) if (r.m && typeof r.v === "number") (byMetric[r.m] ||= []).push(r.v);
  const GOOD = { LCP: [2500, 4000], INP: [200, 500], CLS: [0.1, 0.25], FCP: [1800, 3000], TTFB: [800, 1800] };
  const vitals = Object.entries(byMetric).map(([m, vals]) => {
    vals.sort((x, y) => x - y);
    const p75 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.75))];
    const [g, ni] = GOOD[m] || [Infinity, Infinity];
    return { metric: m, p75, samples: vals.length, rating: p75 <= g ? "good" : p75 <= ni ? "needs-improvement" : "poor" };
  });
  return {
    range: rng,
    totals: { ...totals, bounce_rate: sess.n ? (sess.bounced || 0) / sess.n : null, avg_session_ms: sess.dur || null },
    series: series(pv, rng, ["n", "u"]),
    pages: top("pathname"),
    // "$direct" is the SDK's sentinel for "no referrer" (PostHog's convention), not a domain
    referrers: top("referrer_domain").map((r) => (r.k === "$direct" ? { ...r, k: "(direct / none)" } : r)),
    browsers: top("browser"), os: top("os"), devices: top("device"),
    entry_pages: db().prepare("SELECT entry_path k, COUNT(*) n FROM sessions WHERE project_id = ? AND started_at BETWEEN ? AND ? AND entry_path IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT 8").all(...a),
    utm: db().prepare("SELECT utm_source k, COUNT(*) n FROM sessions WHERE project_id = ? AND started_at BETWEEN ? AND ? AND utm_source IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT 8").all(...a),
    vitals,
  };
}

// ---------------------------------------------------------------- sessions & persons
export function listSessions(pid, params) {
  const where = ["s.project_id = ?"], args = [pid];
  if (params.get("intent")) { where.push("s.intent = ?"); args.push(params.get("intent")); }
  if (params.get("outcome")) { where.push("s.outcome = ?"); args.push(params.get("outcome")); }
  if (params.get("person")) { where.push("s.distinct_id = ?"); args.push(params.get("person")); }
  if (params.get("frustrated") === "1") where.push("s.frustration >= 1.5");
  const sort = params.get("sort") === "frustration" ? "s.frustration DESC, s.last_at DESC" : "s.last_at DESC";
  return db().prepare(
    `SELECT s.*, p.props person_props, p.is_identified FROM sessions s
     LEFT JOIN persons p ON p.project_id = s.project_id AND p.distinct_id = s.distinct_id
     WHERE ${where.join(" AND ")} ORDER BY ${sort} LIMIT 150`
  ).all(...args).map((r) => ({ ...r, classification: parse(r.classification, null), person_props: parse(r.person_props, {}) }));
}

export function sessionDetail(pid, id) {
  const s = q("SELECT * FROM sessions WHERE project_id = ? AND id = ?").get(pid, id);
  if (!s) return null;
  const events = q("SELECT * FROM events WHERE project_id = ? AND session_id = ? ORDER BY ts LIMIT 1000").all(pid, id).map((r) => ({ ...r, props: parse(r.props, {}) }));
  const person = s.distinct_id ? q("SELECT * FROM persons WHERE project_id = ? AND distinct_id = ?").get(pid, s.distinct_id) : null;
  return { session: { ...s, classification: parse(s.classification, null) }, events, person: person ? { ...person, props: parse(person.props, {}) } : null };
}

export function listPersons(pid, params) {
  const where = ["project_id = ?"], args = [pid];
  if (params.get("q")) { where.push("(distinct_id LIKE ? OR props LIKE ?)"); const s = `%${params.get("q")}%`; args.push(s, s); }
  if (params.get("identified") === "1") where.push("is_identified = 1");
  return db().prepare(`SELECT * FROM persons WHERE ${where.join(" AND ")} ORDER BY last_seen DESC LIMIT 200`).all(...args).map((r) => ({ ...r, props: parse(r.props, {}) }));
}

export function personDetail(pid, distinctId) {
  const p = q("SELECT * FROM persons WHERE project_id = ? AND distinct_id = ?").get(pid, distinctId);
  if (!p) return null;
  return {
    person: { ...p, props: parse(p.props, {}) },
    sessions: listSessions(pid, new URLSearchParams({ person: distinctId })).slice(0, 20),
    issues: q(
      `SELECT i.id, i.type, i.title, i.verdict, i.status, i.judge_status, i.judged_by, COUNT(*) n FROM events e JOIN issues i ON i.id = e.issue_id
       WHERE e.project_id = ? AND e.distinct_id = ? AND i.merged_into IS NULL GROUP BY i.id ORDER BY n DESC LIMIT 20`
    ).all(pid, distinctId),
    events: listEvents(pid, new URLSearchParams({ person: distinctId, limit: "60" })),
  };
}

// Dashboard totals and hourly activity share an explicit event-time window and demo scope.
export function monitoring(pid, params) {
  const span = params.get('range') === '7d' ? 7 * DAY : DAY;
  const to = Date.now(), from = to-span, since = sinceOf(params);
  const bucket = span>DAY ? 6*HOUR : HOUR;
  const filter = 'project_id = ? AND ts >= ? AND ts <= ?' + (since ? ' AND received_at >= ?' : '');
  const args=[pid,from,to,...(since?[since]:[])];
  const points=db().prepare(`SELECT (ts / ${bucket}) * ${bucket} b, COUNT(*) events, SUM(CASE WHEN issue_id IS NOT NULL THEN 1 ELSE 0 END) errors FROM events WHERE ${filter} GROUP BY b`).all(...args);
  const totals=db().prepare(`SELECT COUNT(*) events, SUM(CASE WHEN issue_id IS NOT NULL THEN 1 ELSE 0 END) errors, COUNT(DISTINCT CASE WHEN issue_id IS NOT NULL THEN distinct_id END) affected FROM events WHERE ${filter}`).get(...args);
  const iw='project_id = ? AND merged_into IS NULL' + (since ? ' AND id IN (SELECT issue_id FROM events WHERE project_id = ? AND received_at >= ?)' : '');
  const ia=[pid,...(since?[pid,since]:[])];
  const states=db().prepare(`SELECT status, COALESCE(verdict,'pending') verdict, COUNT(*) n FROM issues WHERE ${iw} GROUP BY status,verdict`).all(...ia);
  return {from,to,bucket,since,series:series(points,{from,to,bucket},['events','errors']),totals:{...totals,errors:totals.errors || 0},states};
}
