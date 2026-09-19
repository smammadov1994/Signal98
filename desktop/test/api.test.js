// End-to-end tests of the backend through its real HTTP router, against an in-memory
// database. JEV is exercised through a stubbed `fetch`, so no key or network is needed.
//
//   cd desktop && npm test
process.env.SIGNAL98_DB = ":memory:";
process.env.SIGNAL98_GHOST_PROVIDER = "none";
delete process.env.TYPESAFE_API_KEY;

import test from "node:test";
import assert from "node:assert/strict";

// HARD NETWORK BOUNDARY. This suite must never talk to the outside world: an earlier version
// leaked a real request to api.typesafe.ai (a judging job outlived the fetch stub it was started
// under). Every outbound request now goes through this guard for the life of the process; tests
// that need JEV install a handler with `withJev()`. Anything unexpected is recorded and fails loudly.
const leaks = [];
let jevHandler = null;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (jevHandler && /typesafe\.ai\/v1\/systemone/.test(u)) return jevHandler(u, init);
  leaks.push(u);
  throw new Error(`test suite attempted a real network request: ${u}`);
};

const { handle } = await import("../lib/api.js");
const { q } = await import("../lib/db.js");
const { issueQuestions, verdictOf } = await import("../lib/questions.js");
const { DEFAULT_SETTINGS } = await import("../lib/db.js");

const KEY = "s98_pk_local_dev";
const call = async (method, path, body, headers = {}) => {
  const [p, qs] = path.split("?");
  const req = new Request(`http://localhost:3001/api/${p}${qs ? "?" + qs : ""}`, {
    method, headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Next percent-decodes `params.path` before the router sees it (verified against the dev server)
  const res = await handle(req, p.split("/").map(decodeURIComponent));
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
};

let n = 0;
const exception = (type, value, { handled = false, file = "app/checkout.js", line = 10, fn = "pay", did = "u1", session = "s1", path = "/checkout", uuid } = {}) => ({
  uuid: uuid || `t-${++n}`, event: "$exception", timestamp: new Date().toISOString(), distinct_id: did,
  properties: {
    $session_id: session, $pathname: path, $current_url: `http://shop.test${path}`, $service: "shop",
    $exception_list: [{ type, value, stacktrace: { frames: [{ function: fn, file, line, column: 1 }] }, mechanism: { handled, type: handled ? "manual" : "onerror" } }],
    $exception_steps: [{ $message: "click button \"Pay now\"", $category: "ui" }],
  },
});
const ingest = (batch, key = KEY) => call("POST", `ingest?key=${key}`, { api_key: key, sent_at: new Date().toISOString(), batch });
const settle = async (pred, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
};

test("ingest rejects unknown keys and bad JSON", async () => {
  assert.equal((await ingest([exception("Error", "x")], "nope")).status, 401);
  const res = await handle(new Request("http://localhost:3001/api/ingest?key=" + KEY, { method: "POST", body: "{oops" }), ["ingest"]);
  assert.equal(res.status, 400);
});

test("CORS preflight is open for SDK endpoints", async () => {
  const res = await handle(new Request("http://localhost:3001/api/ingest", { method: "OPTIONS" }), ["ingest"]);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("exceptions group into one issue, judged once, labelled heuristic without a key", async () => {
  const r = await ingest([
    exception("Error", "payment failed: card declined for $4200"),
    exception("Error", "payment failed: card declined for $4200"),
    exception("Error", "payment failed: card declined for $4200", { did: "u2", session: "s2" }),
  ]);
  assert.deepEqual([r.status, r.json.received, r.json.dropped], [200, 3, 0]);
  assert.ok(await settle(() => q("SELECT judge_status s FROM issues WHERE id = 1").get()?.s === "judged"));
  const { json } = await call("GET", "issues");
  assert.equal(json.issues.length, 1);
  const issue = json.issues[0];
  assert.equal(issue.count, 3);
  assert.equal(issue.users, 2);
  assert.equal(issue.judged_by, "heuristic");
  assert.equal(issue.category, "payments");
  assert.equal(issue.verdict, "page");
  assert.ok(issue.priority > 60);
});

test("duplicate delivery (same uuid) is ignored", async () => {
  const e = exception("Error", "payment failed: card declined for $4200", { uuid: "dup-1" });
  await ingest([e]);
  const r = await ingest([e]);
  assert.deepEqual([r.json.received, r.json.dropped], [0, 1]);
  assert.equal(q("SELECT count c FROM issues WHERE id = 1").get().c, 4);
});

test("a page verdict records notifications (dry run without credentials)", async () => {
  assert.ok(await settle(() => q("SELECT COUNT(*) n FROM notifications WHERE issue_id = 1").get().n >= 2));
  const { json } = await call("GET", "alerts/notifications");
  const kinds = json.notifications.filter((x) => x.issue_id === 1).map((x) => `${x.channel_type}:${x.status}`).sort();
  assert.deepEqual(kinds, ["email:dry_run", "push:dry_run"]);
  assert.match(json.notifications[0].subject, /PAGE/);
});

test("noise is ignored, background failures do not page", async () => {
  await ingest([
    exception("Error", "ResizeObserver loop limit exceeded", { file: "chrome-extension://abc/x.js", fn: "observe" }),
    exception("Error", "nightly report job failed: /tmp full", { handled: true, file: "jobs/report.js", fn: "run", path: "/" }),
  ]);
  assert.ok(await settle(() => q("SELECT COUNT(*) n FROM issues WHERE judge_status != 'judged'").get().n === 0));
  const rows = q("SELECT title, verdict FROM issues ORDER BY id").all();
  assert.equal(rows.find((r) => /ResizeObserver/.test(r.title)).verdict, "ignore");
  assert.notEqual(rows.find((r) => /nightly/.test(r.title)).verdict, "page");
});

test("resolve → recurrence is a regression, reopened and re-alerted", async () => {
  await call("PATCH", "issues/1", { status: "resolved" });
  q("UPDATE issues SET resolved_at = resolved_at - 10000 WHERE id = 1").run();
  const before = q("SELECT COUNT(*) n FROM notifications WHERE issue_id = 1").get().n;
  await ingest([exception("Error", "payment failed: card declined for $4200")]);
  assert.ok(await settle(() => q("SELECT COUNT(*) n FROM notifications WHERE issue_id = 1").get().n > before));
  const i = q("SELECT status, regressed FROM issues WHERE id = 1").get();
  assert.deepEqual([i.status, i.regressed], ["open", 1]);
  const last = q("SELECT subject FROM notifications WHERE issue_id = 1 ORDER BY id DESC").get();
  assert.match(last.subject, /REGRESSION/);
});

test("network errors, rage clicks and error logs become issues of their own kind", async () => {
  await ingest([
    { uuid: "n1", event: "$network_error", distinct_id: "u1", properties: { $method: "POST", $url: "http://shop.test/api/orders/8812", $status: 503, $duration_ms: 120, $session_id: "s1" } },
    { uuid: "n2", event: "$network_error", distinct_id: "u2", properties: { $method: "POST", $url: "http://shop.test/api/orders/17", $status: 503, $duration_ms: 90, $session_id: "s2" } },
    { uuid: "r1", event: "$rageclick", distinct_id: "u1", properties: { $el_text: "Apply coupon", $el_selector: "button#coupon", $pathname: "/cart", $click_count: 5, $session_id: "s1" } },
    { uuid: "l1", event: "$log", distinct_id: "u1", properties: { $level: "error", $message: "inventory sync failed for sku 8831" } },
    { uuid: "l2", event: "$log", distinct_id: "u1", properties: { $level: "info", $message: "hello" } },
  ]);
  const kinds = q("SELECT kind, count FROM issues WHERE kind != 'error' ORDER BY kind").all();
  assert.deepEqual(kinds.map((k) => `${k.kind}:${k.count}`), ["log:1", "network:2", "ux:1"]); // /orders/:id templated together
});

test("identify folds the anonymous person into the identified one", async () => {
  await ingest([
    { uuid: "p1", event: "$pageview", distinct_id: "anon-9", properties: { $pathname: "/", $session_id: "s9" } },
    { uuid: "p2", event: "$identify", distinct_id: "ada@example.com", properties: { $anon_distinct_id: "anon-9", $set: { plan: "pro", name: "Ada" }, $session_id: "s9" } },
    { uuid: "p3", event: "$pageview", distinct_id: "anon-9", properties: { $pathname: "/pricing", $session_id: "s9" } },
  ]);
  const { json } = await call("GET", `persons/${encodeURIComponent("ada@example.com")}`);
  assert.equal(json.person.props.plan, "pro");
  assert.equal(json.person.is_identified, 1);
  assert.equal(q("SELECT COUNT(*) n FROM events WHERE distinct_id = 'anon-9'").get().n, 0);
});

test("funnels, trends, web analytics and the lifecycle taxonomy answer", async () => {
  const pv = (did, path, i) => ({ uuid: `f-${did}-${i}`, event: "$pageview", distinct_id: did, timestamp: new Date(Date.now() - 60_000 + i * 1000).toISOString(), properties: { $pathname: path, $session_id: `fs-${did}`, $referring_domain: "news.ycombinator.com" } });
  const ev = (did, name, i) => ({ uuid: `f-${did}-${i}`, event: name, distinct_id: did, timestamp: new Date(Date.now() - 60_000 + i * 1000).toISOString(), properties: { $session_id: `fs-${did}`, plan: "pro" } });
  await ingest([
    pv("a", "/", 1), pv("a", "/cart", 2), ev("a", "order_completed", 3),
    pv("b", "/", 1), pv("b", "/cart", 2),
    pv("c", "/", 1),
  ]);
  const f = await call("POST", "insights/funnel", { range: "24h", steps: [{ event: "$pageview", pathname: "/" }, { event: "$pageview", pathname: "/cart" }, { event: "order_completed" }] });
  assert.deepEqual(f.json.steps.map((s) => s.count), [4, 2, 1]); // anon-9/ada also viewed "/"
  const t = await call("GET", "insights/trend?event=$pageview&range=24h&math=users");
  assert.ok(t.json.total >= 4);
  const b = await call("GET", "insights/trend?event=order_completed&range=24h&breakdown=prop:plan");
  assert.equal(b.json.breakdown[0].key, "pro");
  const w = await call("GET", "web?range=24h");
  assert.equal(w.json.referrers[0].k, "news.ycombinator.com");
  assert.ok(w.json.totals.pageviews >= 6);
  assert.ok(w.json.browsers.some((x) => x.k === "Chrome"));
  assert.equal(q("SELECT judge_status s FROM event_defs WHERE name = 'order_completed'").get().s, "pending");
});

test("feature flags bucket users stably", async () => {
  await call("POST", "feature-flags", { key: "new-checkout", rollout: 50 });
  const ask = (id) => call("GET", `flags?key=${KEY}&distinct_id=${id}`).then((r) => r.json.flags["new-checkout"]);
  const first = await Promise.all(["a", "b", "c", "d", "e", "f", "g", "h"].map(ask));
  const again = await Promise.all(["a", "b", "c", "d", "e", "f", "g", "h"].map(ask));
  assert.deepEqual(first, again);
  assert.ok(first.includes(true) && first.includes(false));
});

test("verdict rule: security and data risk page even when not user-facing", () => {
  const base = { severity: 2.2, is_urgent: 0.3, is_user_facing: 0.1, is_actionable: 0.5, is_noise: 0.05, revenue_impact: 0.1, data_risk: 0.1, security_relevant: 0.1 };
  const t = DEFAULT_SETTINGS.thresholds;
  assert.equal(verdictOf(base, t), "notify");
  assert.equal(verdictOf({ ...base, security_relevant: 0.9 }, t), "page");
  assert.equal(verdictOf({ ...base, severity: 0.4, is_noise: 0.9 }, t), "ignore");
});

test("with a key, JEV answers are used, retried on 429, and labelled with the model id", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  let calls = 0, sawState = null;
  jevHandler = async (url, init) => {
    calls++;
    if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    const body = JSON.parse(init.body);
    sawState ||= body.state;
    const answers = {};
    for (const [id, qn] of Object.entries(body.questions)) {
      if (qn.type === "noul") answers[id] = { type: "noul", noul: id === "is_noise" ? 0.02 : 0.91 };
      if (qn.type === "score") answers[id] = { type: "score", score: id === "severity" ? 3.4 : 0.6, confidence: 0.8, probabilities: {}, legend: {} };
      if (qn.type === "choice") { const k = Object.keys(qn.criteria)[0]; answers[id] = { type: "choice", choice: k === "issue_1" ? "none" : k, confidence: 0.88, probabilities: { [k]: 0.9 } }; }
    }
    return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 420, output_tokens: 0 } });
  };
  try {
    await ingest([exception("TypeError", "Cannot read properties of undefined (reading 'name')", { file: "app/profile.jsx", fn: "Profile", path: "/profile" })]);
    assert.ok(await settle(() => q("SELECT judged_by b FROM issues ORDER BY id DESC LIMIT 1").get()?.b === "jev-1.13.0", 8000));
    const i = q("SELECT * FROM issues ORDER BY id DESC LIMIT 1").get();
    assert.equal(i.verdict, "page");
    assert.equal(i.category, Object.keys(issueQuestions().category.criteria)[0]);
    assert.ok(calls >= 2, "429 was retried");
    // the state is a small named object in words — never the raw event
    assert.equal(sawState.problem.history, "first time this has ever been seen");
    assert.equal(sawState.problem.volume, "seen once");
    assert.ok(JSON.stringify(sawState).length < 1500);
    const o = await call("GET", "overview");
    assert.ok(o.json.jev.today.input_tokens >= 420);
  } finally {
    // Nothing may still be judging when the handler goes away: a job in flight has already
    // read the key and would otherwise reach for the network.
    await settle(() => q("SELECT COUNT(*) n FROM issues WHERE judge_status != 'judged'").get().n === 0, 8000);
    delete process.env.TYPESAFE_API_KEY;
    jevHandler = null;
  }
});

test("admin API is locked when SIGNAL98_ADMIN_TOKEN is set; ingest stays public", async () => {
  process.env.SIGNAL98_ADMIN_TOKEN = "sekret";
  try {
    assert.equal((await call("GET", "issues")).status, 401);
    assert.equal((await call("GET", "issues", undefined, { authorization: "Bearer sekret" })).status, 200);
    assert.equal((await ingest([exception("Error", "still public")])).status, 200);
  } finally {
    delete process.env.SIGNAL98_ADMIN_TOKEN;
  }
});

// ---- regressions found while running the live demo (each of these was green-but-wrong before) ----
const { attemptsSoFar } = await import("../lib/ghost.js");

test("heuristic: a breadcrumb never picks the category (unrelated click on a 'charge' button)", async () => {
  const e = exception("Error", "widget tree failed to mount in sidebar", { file: "app/sidebar.jsx", fn: "Sidebar", path: "/dashboard", did: "u7", session: "s7" });
  e.properties.$exception_steps = [{ $message: 'click button "Double charge detected — money and data are involved"', $category: "ui" }];
  await ingest([e]);
  assert.ok(await settle(() => q("SELECT judge_status s FROM issues WHERE title LIKE 'widget tree%'").get()?.s === "judged"));
  const i = q("SELECT category, verdict, severity FROM issues WHERE title LIKE 'widget tree%'").get();
  assert.notEqual(i.category, "payments");
  assert.equal(i.category, "rendering");
});

test("heuristic: rage/dead clicks are ux_friction and never page, whatever the button says", async () => {
  await ingest([
    { uuid: "ux-pay-1", event: "$dead_click", distinct_id: "u7", properties: { $el_text: "Pay now — checkout payment card charge", $el_selector: "button#pay-now", $pathname: "/checkout", $session_id: "s7" } },
    { uuid: "slow-1", event: "$network_error", distinct_id: "u7", properties: { $method: "GET", $url: "http://shop.test/api/recommendations", $status: 200, $duration_ms: 5200, $slow: true, $session_id: "s7" } },
  ]);
  const settled = await settle(() => q("SELECT COUNT(*) n FROM issues WHERE judge_status != 'judged'").get().n === 0);
  assert.ok(settled, "issues stuck un-judged: " + JSON.stringify(q("SELECT id, type, judge_status, judge_attempts FROM issues WHERE judge_status != 'judged'").all()));
  const ux = q("SELECT category, verdict, severity FROM issues WHERE type = 'DeadClick' AND culprit = '/checkout'").get();
  assert.equal(ux.category, "ux_friction");
  assert.notEqual(ux.verdict, "page");
  assert.ok(ux.severity <= 1.6);
  assert.equal(q("SELECT category c FROM issues WHERE type = 'SlowRequest'").get().c, "performance");
});

test("ghost: applied runs count as attempts (the regression loop must not reuse attempt 1)", () => {
  const ins = (status) => q("INSERT INTO agent_runs (project_id, issue_id, trigger, status, attempt, created_at) VALUES (1, 1, 'auto', ?, 1, ?)").run(status, Date.now());
  const before = attemptsSoFar(1);
  ins("skipped"); // never went to work: does not count
  assert.equal(attemptsSoFar(1), before);
  ins("applied"); // shipped and did not hold: MUST count
  ins("failed");
  assert.equal(attemptsSoFar(1), before + 2);
  q("DELETE FROM agent_runs WHERE issue_id = 1 AND trigger = 'auto'").run();
});

test("funnel: after the window expires a person starts over; stale progress cannot complete a later step", async () => {
  const at = (min) => new Date(Date.now() - 3 * 3_600_000 + min * 60_000).toISOString();
  const pv = (i, path, min) => ({ uuid: `fw-${i}`, event: "$pageview", distinct_id: "window-walker", timestamp: at(min), properties: { $pathname: path, $session_id: "fw" } });
  await ingest([
    pv(1, "/fw-a", 0), pv(2, "/fw-b", 1),       // steps 1+2 inside the window
    pv(3, "/fw-a", 90),                          // window (30 min) long gone: starts over at step 1
    pv(4, "/fw-c", 91),                          // step 3 WITHOUT redoing step 2 → must not convert
  ]);
  const r = await call("POST", "insights/funnel", { range: "24h", windowMinutes: 30, steps: [{ event: "$pageview", pathname: "/fw-a" }, { event: "$pageview", pathname: "/fw-b" }, { event: "$pageview", pathname: "/fw-c" }] });
  assert.deepEqual(r.json.steps.map((s) => s.count), [1, 1, 0]);
});

test("api: cooldown 0 is honoured, duplicate flags are a 409, ids containing % do not 500", async () => {
  const made = await call("POST", "alerts/rules", { name: "no cooldown", kind: "issue_regression", cooldown_s: 0 });
  assert.equal(q("SELECT cooldown_s c FROM alert_rules WHERE id = ?").get(made.json.id).c, 0);
  const dup = await call("POST", "feature-flags", { key: "new-checkout" });
  assert.equal(dup.status, 409);
  await ingest([{ uuid: "pct-1", event: "$pageview", distinct_id: "50%off/user@x.com", properties: { $pathname: "/", $session_id: "pct" } }]);
  // the router receives segments already decoded by Next; pass it the raw id the same way
  const res = await handle(new Request("http://localhost:3001/api/persons/x"), ["persons", "50%off/user@x.com"]);
  assert.equal(res.status, 200);
  const bad = await call("PATCH", "settings", { thresholds: { pageSeverity: 99, noise: -3 } });
  assert.deepEqual([bad.json.project.settings.thresholds.pageSeverity, bad.json.project.settings.thresholds.noise], [4, 0]);
  // settings are shared by every test after this one: put them back (noise = 0 would IGNORE everything)
  const restored = await call("PATCH", "settings", { thresholds: DEFAULT_SETTINGS.thresholds });
  assert.deepEqual(restored.json.project.settings.thresholds, DEFAULT_SETTINGS.thresholds);
});

test("heuristic: a handled background failure lands exactly on the ticket threshold (float rounding)", async () => {
  await ingest([exception("Error", "weekly digest job failed: /tmp is full", { handled: true, file: "jobs/digest.js", fn: "run", path: "/" })]);
  assert.ok(await settle(() => q("SELECT judge_status s FROM issues WHERE title LIKE 'weekly digest%'").get()?.s === "judged"));
  const i = q("SELECT severity, verdict FROM issues WHERE title LIKE 'weekly digest%'").get();
  assert.equal(i.severity, 1);          // not 0.9999999999999999
  assert.equal(i.verdict, "ticket");    // severity >= 1 → ticket, not ignore
});

test("network issues: build hashes in a path do not split an issue, and a URL's words do not pick the category", async () => {
  const ne = (uuid, url) => ({ uuid, event: "$network_error", distinct_id: "u8", properties: { $method: "GET", $url: url, $status: 503, $duration_ms: 40, $session_id: "s8" } });
  await ingest([
    ne("h1", "https://shop.test/static/chunks/main-3f9a2c1b9d.js"), ne("h2", "https://shop.test/static/chunks/main-0c55e1d2aa.js"),
    ne("h3", "https://shop.test/assets/4a57442373b707a3.config.json"), ne("h4", "https://shop.test/assets/540e845031f35593.config.json"),
  ]);
  assert.ok(await settle(() => q("SELECT COUNT(*) n FROM issues WHERE judge_status != 'judged'").get().n === 0));
  const rows = q("SELECT title, count, category FROM issues WHERE kind = 'network' AND title LIKE '%:hash%' ORDER BY title").all();
  assert.deepEqual(rows.map((r) => r.count), [2, 2], JSON.stringify(rows));           // two deploys, ONE issue each
  assert.ok(rows.every((r) => r.category === "network"), JSON.stringify(rows));      // ".json" in a URL is not a data bug
});

test("sessions: entry and exit page come from pageviews, not from whichever event arrived first", async () => {
  const at = (s) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  const ev = (uuid, event, path, s, extra = {}) => ({ uuid, event, distinct_id: "lander", timestamp: at(s), properties: { $pathname: path, $session_id: "entry-sess", ...extra } });
  await ingest([
    ev("en1", "$pageleave", "/old-page", 0),                         // tail of the previous page, flushed late
    ev("en2", "$web_vitals", "/old-page", 0, { $metric: "LCP", $value: 900, $rating: "good" }),
    ev("en3", "$pageview", "/landing", 5),
    ev("en4", "$pageview", "/pricing", 9),
    ev("en5", "$web_vitals", "/pricing", 12, { $metric: "CLS", $value: 0, $rating: "good" }),
  ]);
  const s = q("SELECT entry_path, exit_path, pageviews FROM sessions WHERE id = 'entry-sess'").get();
  assert.deepEqual([s.entry_path, s.exit_path, s.pageviews], ["/landing", "/pricing", 2]);
  const w = await call("GET", "web?range=24h");
  assert.ok(w.json.entry_pages.some((r) => r.k === "/landing") && !w.json.entry_pages.some((r) => r.k === "/old-page"));
});

test("fresh demo view hides saved issues and counts new occurrences without deleting history", async () => {
  const since = Date.now() + 1000;
  const before = q("SELECT COUNT(*) n FROM events").get().n;
  assert.equal((await call("GET", `issues?since=${since}`)).json.issues.length, 0);
  assert.equal((await call("GET", `overview?since=${since}`)).json.events_24h, 0);
  await ingest([exception("Error", "payment failed: card declined for $4200", { uuid: "fresh-demo-test", did: "fresh-person" })]);
  q("UPDATE events SET received_at = ? WHERE uuid = 'fresh-demo-test'").run(since + 1);
  const fresh = (await call("GET", `issues?since=${since}`)).json.issues;
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].count, 1);
  assert.equal(fresh[0].users, 1);
  assert.ok(fresh[0].total_count > 1);
  assert.equal(fresh[0].run, null);
  const overview = (await call("GET", `overview?since=${since}`)).json;
  assert.equal(overview.events_24h, 1);
  assert.equal(overview.users_24h, 1);
  assert.equal(Object.values(overview.open_issues).reduce((a,b) => a+b, 0), 1);
  assert.ok((await call("GET", "issues")).json.issues.length > 1);
  assert.equal(q("SELECT COUNT(*) n FROM events").get().n, before + 1);
});

test("the suite made no real network requests", () => {
  assert.deepEqual(leaks, [], "outbound requests escaped the test boundary");
});
