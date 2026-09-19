// Ingest: authenticate → bound → normalise → store → group into issues → queue for JEV.
// The response never waits for classification.
import { q, tx, parse, projectByKey } from "./db.js";
import { publish } from "./bus.js";
import { kick, boot } from "./classify.js";
import { clip, sha1, templateOf, templatePath, hostOf, parseUA, makeRateLimiter, HttpError } from "./util.js";

const MAX_BODY = 1_000_000;
const MAX_BATCH = 200;
const MAX_EVENT_BYTES = 64_000;

// Per key+IP. Generous for real apps, tight enough that a runaway loop cannot fill the disk.
const takeToken = (globalThis.__s98_ingest_rl ||= makeRateLimiter({ capacity: 2000, refillPerSec: 200 }));

function truncateProps(props) {
  const out = {};
  let budget = MAX_EVENT_BYTES;
  for (const [k, v] of Object.entries(props || {})) {
    if (k.length > 200) continue;
    let val = v;
    if (typeof v === "string") val = clip(v, 8000);
    const size = JSON.stringify(val)?.length || 0;
    if (size > budget) continue; // drop the fat property, keep the event
    budget -= size;
    out[k] = val;
  }
  return out;
}

function messageOf(evt, p) {
  const ex = p.$exception_list?.[0];
  switch (evt.event) {
    case "$exception": return ex ? `${ex.type || "Error"}: ${ex.value || ""}` : "Error";
    case "$network_error": return `${p.$method || "GET"} ${templatePath(p.$url)} → ${p.$status === 0 ? "network failure" : p.$status}${p.$slow ? ` (slow, ${p.$duration_ms} ms)` : ""}`;
    case "$log": return String(p.$message ?? "");
    case "$rageclick": return `Rage click on "${p.$el_text || p.$el_selector || p.$el_tag}"`;
    case "$dead_click": return `Dead click on "${p.$el_text || p.$el_selector || p.$el_tag}"`;
    case "$pageview": return p.$pathname || p.$current_url || "/";
    case "$autocapture": return `${p.$event_type || "click"} ${p.$el_tag || ""} "${p.$el_text || p.$el_selector || ""}"`;
    case "$web_vitals": return `${p.$metric} ${p.$value} (${p.$rating})`;
    default: return evt.event;
  }
}

// Which events open (or bump) an issue, and how they group.
function issueKeyOf(evt, p, message) {
  const ex = p.$exception_list?.[0];
  if (evt.event === "$exception") {
    const top = ex?.stacktrace?.frames?.[0];
    const fp = p.$exception_fingerprint || sha1(`${ex?.type}|${templateOf(ex?.value)}|${top?.file}:${top?.function}`);
    return {
      kind: "error", fingerprint: `e:${fp}`, type: ex?.type || "Error", title: clip(ex?.value || "Error", 400),
      culprit: top ? clip(`${top.function || "<anonymous>"} (${String(top.file || "").split("/").slice(-2).join("/")}:${top.line})`, 200) : null,
      level: p.$exception_level || (ex?.mechanism?.handled === false ? "fatal" : "error"),
    };
  }
  if (evt.event === "$network_error") {
    const path = templatePath(p.$url);
    const host = hostOf(p.$url);
    return {
      kind: "network", fingerprint: `n:${sha1(`${p.$method}|${host}${path}|${p.$slow ? "slow" : p.$status}`)}`,
      type: p.$slow ? "SlowRequest" : p.$status === 0 ? "NetworkFailure" : `HTTP ${p.$status}`, title: clip(message, 400),
      culprit: host || null, level: p.$slow ? "warn" : "error",
    };
  }
  if (evt.event === "$log" && (p.$level === "error" || p.$level === "fatal")) {
    return { kind: "log", fingerprint: `l:${sha1(templateOf(message))}`, type: "LogError", title: clip(message, 400), culprit: p.logger || null, level: "error" };
  }
  if (evt.event === "$rageclick" || evt.event === "$dead_click") {
    return {
      kind: "ux", fingerprint: `u:${sha1(`${evt.event}|${p.$pathname}|${p.$el_selector}`)}`,
      type: evt.event === "$rageclick" ? "RageClick" : "DeadClick", title: clip(message, 400),
      culprit: p.$pathname || null, level: "warn",
    };
  }
  return null;
}

function upsertIssue(project, key, row, now) {
  const existing = q("SELECT * FROM issues WHERE project_id = ? AND fingerprint = ?").get(project.id, key.fingerprint);
  if (!existing) {
    const id = q(
      `INSERT INTO issues (project_id, fingerprint, kind, type, title, culprit, service, level, first_seen, last_seen, count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(project.id, key.fingerprint, key.kind, key.type, key.title, key.culprit, row.service, key.level, row.ts, row.ts).lastInsertRowid;
    return { id: Number(id), created: true, target: Number(id) };
  }
  // Events on a merged issue are attributed to the issue it was merged into.
  const target = existing.merged_into || existing.id;
  const t = target === existing.id ? existing : q("SELECT * FROM issues WHERE id = ?").get(target) || existing;
  const count = t.count + 1;
  // A resolved issue that fires again is a regression: reopen and have JEV look again.
  const regress = t.status === "resolved" && row.ts > (t.resolved_at || 0) + 5000;
  // Volume crossing an order of magnitude changes the story JEV is told.
  const grew = t.judge_status === "judged" && count >= 10 && count >= Math.max(1, t.judged_count) * 10;
  q(`UPDATE issues SET count = ?, last_seen = MAX(last_seen, ?),
       status = CASE WHEN ? THEN 'open' ELSE status END,
       regressed = CASE WHEN ? THEN 1 ELSE regressed END,
       assignee = CASE WHEN ? THEN NULL ELSE assignee END,
       judge_status = CASE WHEN ? THEN 'pending' ELSE judge_status END,
       judge_attempts = CASE WHEN ? THEN 0 ELSE judge_attempts END
     WHERE id = ?`)
    .run(count, row.ts, regress ? 1 : 0, regress ? 1 : 0, regress ? 1 : 0, regress || grew ? 1 : 0, regress || grew ? 1 : 0, t.id);
  return { id: t.id, created: false, regress, target: t.id };
}

function touchPerson(project, evt, p, ts) {
  const did = evt.distinct_id;
  if (!did) return;
  if (evt.event === "$identify") {
    const anon = p.$anon_distinct_id;
    if (anon && anon !== did) {
      q("INSERT OR REPLACE INTO person_aliases (project_id, anon_id, distinct_id) VALUES (?, ?, ?)").run(project.id, anon, did);
      // fold the anonymous history into the identified person
      q("UPDATE events SET distinct_id = ? WHERE project_id = ? AND distinct_id = ?").run(did, project.id, anon);
      q("UPDATE sessions SET distinct_id = ? WHERE project_id = ? AND distinct_id = ?").run(did, project.id, anon);
      const old = q("SELECT * FROM persons WHERE project_id = ? AND distinct_id = ?").get(project.id, anon);
      if (old) {
        q("DELETE FROM persons WHERE id = ?").run(old.id);
        q(`INSERT INTO persons (project_id, distinct_id, is_identified, props, first_seen, last_seen, event_count) VALUES (?, ?, 1, ?, ?, ?, ?)
           ON CONFLICT(project_id, distinct_id) DO UPDATE SET first_seen = MIN(first_seen, excluded.first_seen), event_count = event_count + excluded.event_count`)
          .run(project.id, did, old.props, old.first_seen, ts, old.event_count);
      }
    }
  }
  const existing = q("SELECT id, props FROM persons WHERE project_id = ? AND distinct_id = ?").get(project.id, did);
  const set = { ...(p.$set || {}) };
  const setOnce = p.$set_once || {};
  if (!existing) {
    q("INSERT INTO persons (project_id, distinct_id, is_identified, props, first_seen, last_seen, event_count) VALUES (?, ?, ?, ?, ?, ?, 1)")
      .run(project.id, did, evt.event === "$identify" ? 1 : 0, JSON.stringify(truncateProps({ ...setOnce, ...set })), ts, ts);
  } else {
    const hasProps = Object.keys(set).length || Object.keys(setOnce).length;
    const props = hasProps ? JSON.stringify(truncateProps({ ...setOnce, ...parse(existing.props, {}), ...set })) : existing.props;
    q("UPDATE persons SET last_seen = MAX(last_seen, ?), event_count = event_count + 1, props = ?, is_identified = MAX(is_identified, ?) WHERE id = ?")
      .run(ts, props, evt.event === "$identify" ? 1 : 0, existing.id);
  }
}

function touchSession(project, row, p) {
  if (!row.session_id) return;
  const isPv = row.event === "$pageview" ? 1 : 0;
  const isErr = row.event === "$exception" || row.event === "$network_error" ? 1 : 0;
  const isRage = row.event === "$rageclick" ? 1 : 0;
  q(`INSERT INTO sessions (id, project_id, distinct_id, started_at, last_at, event_count, pageviews, errors, rage_clicks,
        entry_path, exit_path, referrer_domain, utm_source, browser, os, device)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, id) DO UPDATE SET
       distinct_id = excluded.distinct_id,
       started_at = MIN(started_at, excluded.started_at), last_at = MAX(last_at, excluded.last_at),
       event_count = event_count + 1, pageviews = pageviews + excluded.pageviews,
       errors = errors + excluded.errors, rage_clicks = rage_clicks + excluded.rage_clicks,
       exit_path = COALESCE(excluded.exit_path, exit_path),
       entry_path = COALESCE(entry_path, excluded.entry_path)`)
    // Entry and exit page are defined by PAGEVIEWS. A session often opens with the tail of the
    // previous page (a late $pageleave or $web_vitals), or with an $identify; taking the path
    // from "whatever arrived first" reported the wrong landing page.
    .run(row.session_id, project.id, row.distinct_id, row.ts, row.ts, isPv, isErr, isRage,
      isPv ? row.pathname : null, isPv ? row.pathname : null, row.referrer_domain, p.utm_source || null, row.browser, row.os, row.device);
}

function touchEventDef(project, row, p) {
  if (row.event.startsWith("$")) return;
  const sample = {};
  for (const [k, v] of Object.entries(p)) if (!k.startsWith("$") && Object.keys(sample).length < 8) sample[k] = typeof v === "string" ? clip(v, 60) : v;
  q(`INSERT INTO event_defs (project_id, name, first_seen, last_seen, count, sample_props) VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(project_id, name) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen), count = count + 1`)
    .run(project.id, row.event, row.ts, row.ts, JSON.stringify(sample));
}

export const publicEvent = (r) => ({ ...r, props: typeof r.props === "string" ? parse(r.props, {}) : r.props });

export function ingestBatch(project, list, { sentAt, userAgent, now = Date.now() } = {}) {
  // Correct for client clock skew the way PostHog does: trust the gap between the
  // client's own timestamp and its sent_at, anchored to the server clock.
  const skew = sentAt && Number.isFinite(Date.parse(sentAt)) ? now - Date.parse(sentAt) : 0;
  const ua = parseUA(userAgent);
  const stored = [];
  let dropped = 0;

  tx(() => {
    for (const evt of list) {
      if (!evt || typeof evt !== "object" || typeof evt.event !== "string" || !evt.event) { dropped++; continue; }
      const p = truncateProps(evt.properties);
      let ts = Date.parse(evt.timestamp);
      ts = Number.isFinite(ts) ? ts + (Math.abs(skew) > 2000 ? skew : 0) : now;
      if (ts > now + 60_000 || ts < now - 7 * 86_400_000) ts = now;
      const message = clip(messageOf(evt, p), 1000);
      const evUA = p.$user_agent ? parseUA(p.$user_agent) : ua;
      const row = {
        uuid: clip(evt.uuid || `${ts}-${Math.random().toString(36).slice(2)}`, 80),
        ts, event: clip(evt.event, 200),
        distinct_id: evt.distinct_id ? clip(evt.distinct_id, 200) : null,
        session_id: p.$session_id ? clip(p.$session_id, 80) : null,
        service: clip(p.$service || hostOf(p.$current_url) || "app", 80),
        environment: p.$environment ? clip(p.$environment, 40) : null,
        release: p.$release ? clip(p.$release, 80) : null,
        url: p.$current_url ? clip(p.$current_url, 1000) : null,
        pathname: p.$pathname ? clip(p.$pathname, 400) : null,
        referrer_domain: p.$referring_domain ? clip(p.$referring_domain, 200) : null,
        browser: evUA.browser, os: evUA.os, device: evUA.device,
        level: evt.event === "$log" ? clip(p.$level || "info", 10) : null,
        message,
      };
      // alias lookups keep pre-login events attached to the identified person
      if (row.distinct_id && evt.event !== "$identify") {
        const alias = q("SELECT distinct_id FROM person_aliases WHERE project_id = ? AND anon_id = ?").get(project.id, row.distinct_id);
        if (alias) row.distinct_id = alias.distinct_id;
      }

      const key = issueKeyOf(evt, p, message);
      let issue = null;
      if (key) {
        if (key.level && !row.level) row.level = key.level;
        issue = upsertIssue(project, key, row, now);
      }
      const res = q(
        `INSERT OR IGNORE INTO events (uuid, project_id, ts, received_at, event, distinct_id, session_id, issue_id, service, environment, release,
           url, pathname, referrer_domain, browser, os, device, level, message, props)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(row.uuid, project.id, row.ts, now, row.event, row.distinct_id, row.session_id, issue?.id ?? null, row.service, row.environment, row.release,
        row.url, row.pathname, row.referrer_domain, row.browser, row.os, row.device, row.level, row.message, JSON.stringify(p));
      if (!res.changes) {
        // duplicate delivery (SDK retry after a lost response): undo the issue bump
        if (issue && !issue.created) q("UPDATE issues SET count = MAX(0, count - 1) WHERE id = ?").run(issue.id);
        dropped++;
        continue;
      }
      const id = Number(res.lastInsertRowid);
      if (issue?.created) q("UPDATE issues SET sample_event_id = ? WHERE id = ?").run(id, issue.id);
      touchPerson(project, { ...evt, distinct_id: row.distinct_id }, p, ts);
      touchSession(project, row, p);
      touchEventDef(project, row, p);
      stored.push({ id, project_id: project.id, ...row, issue_id: issue?.id ?? null, props: p, issue_created: !!issue?.created, issue_regressed: !!issue?.regress });
    }
  });

  // Publish after commit so subscribers never see rows that might roll back.
  for (const e of stored) {
    let issue = null;
    if (e.issue_id) {
      const r = q("SELECT id, status, verdict, category, severity, priority, judge_status, judged_by, count, regressed, kind FROM issues WHERE id = ?").get(e.issue_id);
      issue = r || null;
    }
    publish("event", { project_id: project.id, event: slim(e), issue });
  }
  if (stored.some((e) => e.issue_id)) kick();
  return { received: stored.length, dropped };
}

// The live feed does not need full props for every click; details are fetched on demand.
function slim(e) {
  const p = e.props || {};
  return {
    id: e.id, ts: e.ts, event: e.event, message: e.message, distinct_id: e.distinct_id, session_id: e.session_id,
    issue_id: e.issue_id, service: e.service, environment: e.environment, pathname: e.pathname, level: e.level,
    browser: e.browser, os: e.os, device: e.device,
    mechanism: p.$exception_list?.[0]?.mechanism?.type, handled: p.$exception_list?.[0]?.mechanism?.handled,
    issue_created: e.issue_created, issue_regressed: e.issue_regressed,
  };
}

export async function handleIngest(req) {
  boot();
  const url = new URL(req.url);
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) throw new HttpError(413, "payload too large");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "payload too large");
  let body;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, "bad json"); }

  const legacy = Array.isArray(body);
  const list = legacy ? body : Array.isArray(body?.batch) ? body.batch : body?.event ? [body] : null;
  if (!list) throw new HttpError(400, "expected { api_key, batch: [...] }");

  const key = url.searchParams.get("key") || req.headers.get("x-signal-key") || body?.api_key;
  // Legacy 0.1 SDKs send a bare array with no key; accept them into the default project
  // only while it still uses the predictable local-dev key.
  const project = key ? projectByKey(key) : legacy ? projectByKey("s98_pk_local_dev") : null;
  if (!project) throw new HttpError(401, "unknown project key");

  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
  const rl = takeToken(`${project.id}:${ip}`, Math.max(1, list.length));
  if (!rl.ok) throw new HttpError(429, "rate limited", { "Retry-After": String(rl.retryAfter) });

  const accepted = list.slice(0, MAX_BATCH);
  const out = ingestBatch(project, accepted, { sentAt: body?.sent_at, userAgent: req.headers.get("user-agent") });
  return { ok: true, received: out.received, dropped: out.dropped + (list.length - accepted.length) };
}
