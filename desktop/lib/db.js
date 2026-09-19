// SQLite persistence (Node's built-in `node:sqlite`, so there is nothing to install).
//
// `process.getBuiltinModule` is used instead of `import` on purpose: it keeps the
// bundler from trying to resolve `node:sqlite`, which webpack does not know about.
//
// The handle lives on globalThis so dev-mode hot reloads and the separately bundled
// API routes all share one connection (see CLAUDE.md, "Shared server state").
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, api_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, settings TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, uuid TEXT NOT NULL, project_id INTEGER NOT NULL,
  ts INTEGER NOT NULL, received_at INTEGER NOT NULL, event TEXT NOT NULL,
  distinct_id TEXT, session_id TEXT, issue_id INTEGER,
  service TEXT, environment TEXT, release TEXT,
  url TEXT, pathname TEXT, referrer_domain TEXT,
  browser TEXT, os TEXT, device TEXT,
  level TEXT, message TEXT, props TEXT NOT NULL DEFAULT '{}',
  UNIQUE (project_id, uuid)
);
CREATE INDEX IF NOT EXISTS ev_proj_ts ON events (project_id, ts);
CREATE INDEX IF NOT EXISTS ev_proj_event_ts ON events (project_id, event, ts);
CREATE INDEX IF NOT EXISTS ev_session ON events (session_id, ts);
CREATE INDEX IF NOT EXISTS ev_person ON events (project_id, distinct_id, ts);
CREATE INDEX IF NOT EXISTS ev_issue ON events (issue_id, ts);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'error',          -- error | network | log | ux
  type TEXT, title TEXT NOT NULL, culprit TEXT, service TEXT, level TEXT,
  status TEXT NOT NULL DEFAULT 'open',         -- open | resolved | ignored
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0, regressed INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER, assignee TEXT, sample_event_id INTEGER,
  judge_status TEXT NOT NULL DEFAULT 'pending', -- pending | judging | judged
  judged_by TEXT, judged_at INTEGER, judge_attempts INTEGER NOT NULL DEFAULT 0,
  judged_count INTEGER NOT NULL DEFAULT 0,      -- issue.count when last judged (re-judge on growth)
  classification TEXT,                          -- full JSON of the answers
  category TEXT, cause TEXT, severity REAL, priority REAL, verdict TEXT,
  similar_to INTEGER, similar_p REAL, merged_into INTEGER,
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS is_proj_status ON issues (project_id, status, last_seen);
CREATE INDEX IF NOT EXISTS is_pending ON issues (judge_status);

CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, distinct_id TEXT NOT NULL,
  is_identified INTEGER NOT NULL DEFAULT 0, props TEXT NOT NULL DEFAULT '{}',
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, event_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, distinct_id)
);
CREATE TABLE IF NOT EXISTS person_aliases (
  project_id INTEGER NOT NULL, anon_id TEXT NOT NULL, distinct_id TEXT NOT NULL,
  PRIMARY KEY (project_id, anon_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT NOT NULL, project_id INTEGER NOT NULL, distinct_id TEXT,
  started_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0, pageviews INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0, rage_clicks INTEGER NOT NULL DEFAULT 0,
  entry_path TEXT, exit_path TEXT, referrer_domain TEXT, utm_source TEXT,
  browser TEXT, os TEXT, device TEXT,
  judge_status TEXT NOT NULL DEFAULT 'none',   -- none | pending | judged
  judged_by TEXT, judged_at INTEGER, judged_count INTEGER NOT NULL DEFAULT 0,
  classification TEXT, intent TEXT, outcome TEXT, frustration REAL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS se_proj_last ON sessions (project_id, last_at);

CREATE TABLE IF NOT EXISTS event_defs (
  project_id INTEGER NOT NULL, name TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  sample_props TEXT, judge_status TEXT NOT NULL DEFAULT 'pending', judged_by TEXT,
  classification TEXT, stage TEXT, is_conversion REAL,
  PRIMARY KEY (project_id, name)
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, type TEXT NOT NULL, -- email | webhook | slack | push
  name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS alert_rules (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
  channel_ids TEXT NOT NULL DEFAULT '[]', cooldown_s INTEGER NOT NULL DEFAULT 900,
  last_fired_at INTEGER
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, rule_id INTEGER, issue_id INTEGER,
  channel_type TEXT NOT NULL, target TEXT, subject TEXT, body TEXT,
  status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL  -- sent | failed | dry_run
);
CREATE INDEX IF NOT EXISTS no_proj ON notifications (project_id, created_at);
CREATE TABLE IF NOT EXISTS alert_state (                        -- per rule+subject cooldown
  rule_id INTEGER NOT NULL, subject TEXT NOT NULL, fired_at INTEGER NOT NULL,
  PRIMARY KEY (rule_id, subject)
);
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, endpoint TEXT NOT NULL UNIQUE,
  keys TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fixes (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, issue_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL, provider TEXT, ghost_id TEXT,
  summary TEXT, report TEXT, status TEXT NOT NULL DEFAULT 'proposed'
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, issue_id INTEGER NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',      -- manual | auto | regression
  status TEXT NOT NULL DEFAULT 'queued',       -- queued | running | succeeded | failed | skipped
  attempt INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  started_at INTEGER, finished_at INTEGER, branch TEXT, worktree TEXT,
  summary TEXT, diff TEXT, log TEXT, cost_usd REAL
);
CREATE INDEX IF NOT EXISTS ar_issue ON agent_runs (issue_id);

CREATE TABLE IF NOT EXISTS issue_messages (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, issue_id INTEGER NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'complete',
  created_at INTEGER NOT NULL, provider TEXT, error TEXT, request_id TEXT,
  UNIQUE(project_id, issue_id, request_id, role)
);
CREATE INDEX IF NOT EXISTS im_issue ON issue_messages (project_id, issue_id, id);

CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, key TEXT NOT NULL, name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, rollout INTEGER NOT NULL DEFAULT 100,
  variants TEXT, created_at INTEGER NOT NULL, UNIQUE (project_id, key)
);

CREATE TABLE IF NOT EXISTS jev_usage (
  day TEXT NOT NULL, project_id INTEGER NOT NULL, requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0, cache_hits INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0, heuristic INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, project_id)
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export const DEFAULT_SETTINGS = {
  // Composite verdict thresholds (see lib/classify.js → verdictOf)
  thresholds: { pageSeverity: 2.6, pageUserFacing: 0.6, pageUrgent: 0.7, notifySeverity: 1.8, noise: 0.6 },
  retentionDays: 30,
  sessionIdleMinutes: 2,        // how long a session must be quiet before JEV reads it
  ghost: {
    autoMode: false,            // spawn fix agents without asking
    autoApply: false,           // also apply a successful agent diff to the working tree
    repoPath: "",               // the monitored application's git checkout
    maxAttemptsPerIssue: 3,
    maxRunsPerDay: 10,
    minActionable: 0.6,         // JEV gates: only auto-fix what is confidently a code defect…
    maxFixComplexity: 2.2,      // …and not architectural (0 trivial – 4 architectural)
  },
};

function open() {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const file =
    process.env.SIGNAL98_DB ||
    path.join(process.env.SIGNAL98_DATA_DIR || path.join(process.cwd(), "data"), "signal98.db");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;");
  db.exec(SCHEMA);
  const v = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get();
  if (!v) db.prepare("INSERT INTO kv (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  seed(db);
  return db;
}

function seed(db) {
  const n = db.prepare("SELECT COUNT(*) n FROM projects").get().n;
  if (n > 0) return;
  // The default key is predictable on purpose so `npm run dev` works with zero setup.
  // Set SIGNAL98_DEFAULT_KEY (or create a project in Settings) before exposing this to a network.
  const key = process.env.SIGNAL98_DEFAULT_KEY || "s98_pk_local_dev";
  const now = Date.now();
  const pid = db
    .prepare("INSERT INTO projects (name, api_key, created_at, settings) VALUES (?, ?, ?, ?)")
    .run("default", key, now, JSON.stringify(DEFAULT_SETTINGS)).lastInsertRowid;
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(`setup:${pid}`, JSON.stringify({status:"new",step:0,service:"my-react-app",framework:"react"}));
  const chan = (type, name, config) =>
    db.prepare("INSERT INTO channels (project_id, type, name, config) VALUES (?, ?, ?, ?)")
      .run(pid, type, name, JSON.stringify(config)).lastInsertRowid;
  const push = chan("push", "Browser push", {});
  const email = chan("email", "On-call email", { to: process.env.SIGNAL98_ALERT_EMAIL || "" });
  const rule = (name, kind, config, channels, cooldown) =>
    db.prepare("INSERT INTO alert_rules (project_id, name, kind, config, channel_ids, cooldown_s) VALUES (?, ?, ?, ?, ?, ?)")
      .run(pid, name, kind, JSON.stringify(config), JSON.stringify(channels), cooldown);
  rule("Page on-call: JEV says page", "issue_verdict", { verdicts: ["page"] }, [push, email], 900);
  rule("Heads-up: JEV says notify", "issue_verdict", { verdicts: ["notify"] }, [push], 1800);
  rule("Regression: a resolved issue came back", "issue_regression", {}, [push, email], 600);
  rule("Spike: issue volume 10× in 5 minutes", "issue_spike", { factor: 10, windowMinutes: 5, minCount: 20 }, [push], 1800);
  rule("Frustrated session", "session_frustration", { min: 2.2 }, [push], 3600);
}

export function db() {
  if (!globalThis.__s98_db) globalThis.__s98_db = open();
  return globalThis.__s98_db;
}

// Prepared-statement cache: node:sqlite re-parses on every prepare() otherwise.
export function q(sql) {
  const cache = (globalThis.__s98_stmts ||= new Map());
  let s = cache.get(sql);
  if (!s) {
    s = db().prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

export function tx(fn) {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (err) {
    try { d.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

export const parse = (s, fallback = null) => {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

export function projectByKey(key) {
  if (!key) return null;
  const cache = (globalThis.__s98_projects ||= new Map());
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.p;
  const row = q("SELECT * FROM projects WHERE api_key = ?").get(key);
  const p = row ? hydrateProject(row) : null;
  cache.set(key, { p, at: Date.now() });
  return p;
}

function hydrateProject(row) {
  const s = parse(row.settings, {});
  return {
    ...row,
    settings: {
      ...DEFAULT_SETTINGS, ...s,
      thresholds: { ...DEFAULT_SETTINGS.thresholds, ...(s.thresholds || {}) },
      ghost: { ...DEFAULT_SETTINGS.ghost, ...(s.ghost || {}) },
    },
  };
}

export function getProject(id) {
  const row = id ? q("SELECT * FROM projects WHERE id = ?").get(id) : q("SELECT * FROM projects ORDER BY id LIMIT 1").get();
  return row ? hydrateProject(row) : null;
}

export function listProjects() {
  return q("SELECT * FROM projects ORDER BY id").all().map(hydrateProject);
}

export function saveProjectSettings(id, settings) {
  q("UPDATE projects SET settings = ? WHERE id = ?").run(JSON.stringify(settings), id);
  globalThis.__s98_projects?.clear();
}

export function createProject(name) {
  const key = "s98_pk_" + crypto.randomBytes(18).toString("base64url");
  const id = q("INSERT INTO projects (name, api_key, created_at, settings) VALUES (?, ?, ?, ?)")
    .run(String(name).slice(0, 80), key, Date.now(), JSON.stringify(DEFAULT_SETTINGS)).lastInsertRowid;
  kvSet(`setup:${id}`, {status:"new",step:0,service:"my-react-app",framework:"react"});
  return getProject(id);
}

export function rotateProjectKey(id) {
  const key = "s98_pk_" + crypto.randomBytes(18).toString("base64url");
  q("UPDATE projects SET api_key = ? WHERE id = ?").run(key, id);
  globalThis.__s98_projects?.clear();
  return key;
}

export const kvGet = (key, fallback = null) => {
  const r = q("SELECT value FROM kv WHERE key = ?").get(key);
  return r ? parse(r.value, fallback) : fallback;
};
export const kvSet = (key, value) =>
  q("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));

export function bumpUsage(projectId, patch) {
  const day = new Date().toISOString().slice(0, 10);
  q(`INSERT INTO jev_usage (day, project_id, requests, input_tokens, cache_hits, failures, heuristic)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, project_id) DO UPDATE SET
       requests = requests + excluded.requests, input_tokens = input_tokens + excluded.input_tokens,
       cache_hits = cache_hits + excluded.cache_hits, failures = failures + excluded.failures,
       heuristic = heuristic + excluded.heuristic`)
    .run(day, projectId, patch.requests || 0, patch.input_tokens || 0, patch.cache_hits || 0, patch.failures || 0, patch.heuristic || 0);
}
