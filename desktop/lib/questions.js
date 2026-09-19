// What signal98 asks JEV, and the heuristic stand-ins used when no key is configured.
//
// Writing rules learnt from docs.typesafe.ai/model-jaggedness (JEV is literal):
//   • each question states the exact condition; boundary cases live in the criteria
//   • one judgment per question — composites (verdict, priority) are computed in code
//   • nothing numeric is asked: counts, rates and "is this new" are computed in code and
//     handed over as words ("first time seen", "hundreds of times")
//   • the state is a small named object, never the raw event (irrelevant state costs accuracy and money)
import { clip } from "./util.js";
import { GHOSTS } from "./ghosts.js";

export const CATEGORIES = {
  payments: "Checkout, billing, card charges, payouts, refunds, subscriptions, invoices",
  auth: "Login, signup, sessions, tokens, passwords, permissions, access control",
  rendering: "UI failed to render or crashed: undefined property access in a view, component or template errors, hydration",
  data: "Bad, missing or unparsable data: validation, JSON/schema parsing, serialization, unexpected null records",
  network: "A request between client and the application's own API failed: timeouts, connection resets, 5xx, CORS",
  third_party: "A failure inside an external vendor or integration: payment provider, email service, analytics, CDN, OAuth provider",
  database: "Queries, connections, pools, deadlocks, migrations, cache or storage engines",
  performance: "Slowness rather than failure: slow requests, poor web vitals, memory pressure, long tasks",
  infrastructure: "Hosts, disks, containers, deploys, configuration, environment variables, queues, cron and background jobs",
  security: "Attack or abuse signals: injection attempts, CSRF/XSS, forbidden access, leaked secrets, tampering",
  ux_friction: "Users struggling without a thrown error: rage clicks, dead clicks, repeated failed submits",
  noise: "Not the application's fault: browser extensions, bots, ad blockers, cancelled requests, user went offline",
};

export const CAUSES = {
  code_defect: "A bug in the application's own code (unhandled null, wrong assumption, bad logic, missing guard)",
  bad_deploy_or_config: "A recent release, migration, feature flag, or configuration/environment mistake",
  dependency_outage: "An external service or vendor the application depends on is failing",
  capacity: "Resource exhaustion: disk, memory, connections, rate limits, queue backlog",
  bad_input: "A user or client sent invalid, unexpected or malicious input",
  client_environment: "The user's own browser, extension, device or connectivity",
  unknown: "The evidence does not point at any of the above",
};

export const SEVERITY_LEVELS = [
  "Noise: no functional impact; cosmetic, expected, or not caused by the application",
  "Minor: a non-critical feature is degraded, or the failure was handled and the user could continue",
  "Moderate: a feature is broken for the users who reach it, but core flows still work",
  "Major: a core flow is broken — login, signup, checkout, payment, saving or loading the user's data",
  "Critical: outage, data loss or corruption, money being lost or mis-charged, or a security breach",
];

export const FIX_LEVELS = [
  "Trivial: a null/undefined guard, a typo, a wrong constant, a missing await or default value",
  "Small: a localized logic fix inside one function or component",
  "Medium: changes across a few files, or error handling and retries around one integration",
  "Large: needs a design decision, schema or API change, or coordination with another team or vendor",
  "Not fixable in this codebase: the cause is outside the application's code",
];

const noul = (instructions, yes, no) => ({ type: "noul", instructions, criteria: { true: yes, false: no } });

export function issueQuestions() {
  const responder = {};
  for (const g of GHOSTS) responder[g.id] = `${g.name}: ${g.specialty}`;
  return {
    category: { type: "choice", instructions: "Which single area of the system does `problem` belong to?", criteria: CATEGORIES },
    cause: { type: "choice", instructions: "What is the most likely kind of root cause of `problem`?", criteria: CAUSES },
    severity: { type: "score", instructions: "How severe is the impact of `problem` on the product and its users?", criteria: SEVERITY_LEVELS },
    fix_complexity: { type: "score", instructions: "How large a code change would a developer need to make to fix `problem`?", criteria: FIX_LEVELS },
    is_urgent: noul(
      "Does `problem` need a human to act right now rather than during normal working hours?",
      "Something important is actively failing and every hour of delay hurts users or revenue",
      "It can wait for working hours, is already handled, is routine, or is noise"
    ),
    is_user_facing: noul(
      "Do end users directly experience `problem`?",
      "A user sees a broken page, a failed action (pay, log in, sign up, save), an error message or a crash",
      "Only internal, background, scheduled or logging code is affected; users notice nothing"
    ),
    is_actionable: noul(
      "Is `problem` caused by a defect in the application's own source code that a developer could fix with a code change?",
      "The stack, message or context points at the application's own code or logic",
      "The cause is a vendor outage, infrastructure capacity, the user's browser or network, or a bot"
    ),
    is_noise: noul(
      "Is `problem` noise that nobody should spend time on?",
      "Browser extension, bot or crawler, ad blocker, cancelled/aborted request, user offline, expected validation of bad input, deprecation warning",
      "A real malfunction of the product or its infrastructure"
    ),
    revenue_impact: noul(
      "Does `problem` directly stop the business from taking money or stop customers from getting what they paid for?",
      "Payments, checkout, subscriptions, payouts, order fulfilment or paid features are failing",
      "No direct effect on money changing hands"
    ),
    data_risk: noul(
      "Does `problem` risk losing, corrupting or leaking data?",
      "Writes may be lost or duplicated, records corrupted, or private data exposed to the wrong party",
      "No data integrity or privacy consequence"
    ),
    security_relevant: noul(
      "Is `problem` a sign of an attack, abuse or a security weakness?",
      "Injection, forged or replayed requests, authorization bypass, secrets exposed, suspicious probing",
      "An ordinary functional failure with no security angle"
    ),
    responder: {
      type: "choice",
      instructions: "Which responder is the best fit to handle `problem` first?",
      criteria: responder,
    },
  };
}

// Words instead of numbers: JEV is unreliable with magnitudes, fine with phrases.
const volumeWords = (n) =>
  n <= 1 ? "seen once" : n < 10 ? "seen a handful of times" : n < 100 ? "seen dozens of times" : n < 1000 ? "seen hundreds of times" : "seen thousands of times";
const usersWords = (n) =>
  n <= 1 ? "one user affected" : n < 10 ? "a few users affected" : n < 100 ? "dozens of users affected" : "hundreds of users or more affected";

export function issueState(issue, sample, stats = {}) {
  const p = sample?.props || {};
  const ex = p.$exception_list?.[0];
  const frames = (ex?.stacktrace?.frames || [])
    .slice(0, 5)
    .map((f) => `${f.function || "<anonymous>"} (${clip(String(f.file || "").replace(/^.*\/(?=[^/]+\/[^/]+$)/, ""), 60)}:${f.line})`);
  const steps = (p.$exception_steps || []).slice(-6).map((s) => clip(s.$message, 90));
  const problem = {
    kind:
      issue.kind === "network" ? "failed or slow network request"
      : issue.kind === "log" ? "application log entry"
      : issue.kind === "ux" ? "user frustration signal (no exception was thrown)"
      : "exception",
    error_type: issue.type || undefined,
    message: clip(issue.title, 300),
    thrown_at: issue.culprit || undefined,
    top_stack_frames: frames.length ? frames : undefined,
    how_it_was_caught:
      issue.kind !== "error" ? undefined
      : ex?.mechanism?.handled === false ? "unhandled — it escaped the application's own error handling"
      : "handled — the application caught it and carried on",
    what_the_user_did_before: steps.length ? steps : undefined,
    page: sample?.pathname || undefined,
    service: issue.service || undefined,
    environment: sample?.environment || undefined,
    log_level: issue.level || undefined,
    history: issue.regressed ? "was marked resolved earlier and has come back" : stats.isNew ? "first time this has ever been seen" : "known, recurring problem",
    volume: volumeWords(issue.count),
    reach: usersWords(stats.users || 1),
  };
  // undefined keys disappear in JSON.stringify, keeping the state tight.
  return { problem: JSON.parse(JSON.stringify(problem)) };
}

// ---------- composite verdict + priority: arithmetic stays in code ----------
export function verdictOf(a, t) {
  if (a.is_noise >= t.noise && a.severity < 3) return "ignore";
  const pages =
    (a.severity >= t.pageSeverity && a.is_user_facing >= t.pageUserFacing && a.is_urgent >= t.pageUrgent) ||
    (a.security_relevant >= 0.8 && a.severity >= 2) ||
    (a.data_risk >= 0.8 && a.severity >= 2) ||
    (a.revenue_impact >= 0.8 && a.is_urgent >= t.pageUrgent);
  if (pages) return "page";
  if (a.severity >= t.notifySeverity || a.is_urgent >= 0.6) return "notify";
  if (a.is_actionable >= 0.5 || a.severity >= 1) return "ticket";
  return "ignore";
}

export function priorityOf(a, issue) {
  const volume = Math.min(1, Math.log10((issue.count || 1) + 1) / 3); // 1000 events ≈ 1.0
  const p =
    (a.severity / 4) * 40 + a.is_urgent * 15 + a.is_user_facing * 12 + a.revenue_impact * 10 +
    Math.max(a.data_risk, a.security_relevant) * 8 + volume * 10 + (issue.regressed ? 5 : 0) - a.is_noise * 25;
  return Math.round(Math.max(0, Math.min(100, p)));
}

// Flatten JEV answers into the numbers/labels the rest of the system uses.
export function flattenIssueAnswers(ans) {
  return {
    category: ans.category.choice, category_conf: ans.category.confidence ?? null,
    cause: ans.cause.choice, cause_conf: ans.cause.confidence ?? null,
    severity: ans.severity.score, severity_conf: ans.severity.confidence ?? null,
    fix_complexity: ans.fix_complexity.score,
    is_urgent: ans.is_urgent.noul, is_user_facing: ans.is_user_facing.noul,
    is_actionable: ans.is_actionable.noul, is_noise: ans.is_noise.noul,
    revenue_impact: ans.revenue_impact.noul, data_risk: ans.data_risk.noul,
    security_relevant: ans.security_relevant.noul,
    responder: ans.responder.choice, responder_conf: ans.responder.confidence ?? null,
  };
}

// ---------- heuristic stand-in (no key, or JEV down). Always labelled as such. ----------
const RX = {
  payments: /pay|checkout|card|charge|billing|invoice|stripe|refund|payout|subscription|order/i,
  auth: /login|log in|signin|sign in|signup|sign up|auth|token|session|password|forbidden|unauthori[sz]ed|permission|\b401\b|\b403\b/i,
  security: /injection|xss|csrf|tamper|forged|exploit|secret leaked|suspicious/i,
  database: /sql|postgres|mysql|mongo|redis|deadlock|connection pool|query|migration/i,
  third_party: /stripe|twilio|sendgrid|mailgun|webhook|oauth|s3|cloudfront|third[- ]party|provider|upstream/i,
  infrastructure: /disk|memory|oom|cron|job|queue|worker|deploy|config|env|container|kubernetes|\/tmp/i,
  performance: /slow|timeout|timed out|latency|lcp|inp|cls|long task/i,
  data: /json|parse|unexpected token|schema|validation|invalid|serialize|nan\b/i,
  rendering: /cannot read propert|undefined is not|is not a function|is not defined|render|hydrat|component|null \(reading/i,
  network: /fetch|network|econn|socket|5\d\d|bad gateway|unavailable|cors|failed to load/i,
  noise: /extension|resizeobserver|script error|aborted|cancell?ed|deprecated|bot\b|crawler|offline/i,
};

export function heuristicIssueAnswers(issue, sample) {
  const ex = sample?.props?.$exception_list?.[0];
  // WHAT broke is read from the error itself. Breadcrumbs describe what the user did
  // beforehand ("click Double charge…"): letting them vote once filed an unrelated crash
  // under payments and paged for it. They only inform who-felt-it, further down.
  const about = `${issue.type || ""} ${issue.title} ${issue.culprit || ""} ${sample?.pathname || ""}`;
  const text = `${about} ${(sample?.props?.$exception_steps || []).map((s) => s.$message).join(" ")}`;
  const has = (k) => RX[k].test(about);
  // A rage/dead click is friction whatever the button is labelled; a slow request is performance.
  const category =
    issue.kind === "ux" ? "ux_friction"
    : issue.type === "SlowRequest" ? "performance"
    // a failed request is about the REQUEST: "GET /config.json → 503" is not a data-parsing bug
    : issue.kind === "network" ? (["noise", "security", "payments", "auth", "third_party"].find(has) || "network")
    : ["noise", "security", "payments", "auth", "third_party", "database", "infrastructure", "rendering", "data", "performance", "network"].find(has)
      || "rendering";
  const unhandled = ex?.mechanism?.handled === false;
  const background = /job|cron|worker|nightly|queue|webhook|batch|report/i.test(text) && !/page|checkout|login|profile/i.test(text);
  const isNoise = category === "noise" ? 0.85 : issue.level === "warn" ? 0.45 : 0.1;
  let severity = 1.4;
  if (category === "payments" || category === "auth") severity = 3.1;
  else if (category === "security") severity = 3.4;
  else if (category === "rendering" && unhandled) severity = 2.7;
  else if (category === "database" || category === "third_party") severity = 2.4;
  else if (category === "ux_friction") severity = 1.6;
  if (background) severity = Math.min(severity, 1.7);
  if (!unhandled && issue.kind === "error") severity -= 0.4;
  if (category === "noise") severity = 0.3;
  if (/crash|outage|down|data loss|corrupt/i.test(about)) severity += 0.6;
  if (issue.kind === "ux") severity = Math.min(severity, 1.6); // friction alone is never an incident
  // 1.4 - 0.4 is 0.9999999999999999 in IEEE-754; verdict thresholds use >=, so round first
  severity = Math.round(Math.max(0, Math.min(4, severity)) * 100) / 100;
  const userFacing = background ? 0.2 : /page|click|checkout|login|profile|signup|render|cart|form/i.test(text) || issue.kind === "ux" ? 0.85 : sample?.browser && sample.browser !== "Node" ? 0.65 : 0.35;
  const actionable = ["rendering", "data"].includes(category) ? 0.85 : ["third_party", "infrastructure", "noise"].includes(category) ? 0.25 : 0.55;
  const a = {
    category, category_conf: null,
    cause: category === "noise" ? "client_environment" : category === "third_party" ? "dependency_outage" : category === "infrastructure" ? "capacity" : actionable > 0.6 ? "code_defect" : "unknown",
    cause_conf: null,
    severity, severity_conf: null,
    fix_complexity: ["rendering", "data"].includes(category) ? 0.7 : category === "third_party" || category === "infrastructure" ? 3.4 : 1.8,
    is_urgent: Math.min(0.97, severity / 4 + (unhandled ? 0.15 : 0) + (issue.regressed ? 0.1 : 0)),
    is_user_facing: userFacing,
    is_actionable: actionable,
    is_noise: isNoise,
    revenue_impact: category === "payments" ? 0.9 : 0.1,
    data_risk: /data loss|corrupt|duplicate|leak/i.test(about) ? 0.8 : 0.08,
    security_relevant: category === "security" ? 0.9 : 0.05,
    responder_conf: null,
  };
  a.responder =
    a.severity >= 3.2 ? "GHOST-09" : category === "noise" ? "GHOST-08" : a.is_actionable >= 0.6 ? "GHOST-02"
    : category === "third_party" ? "GHOST-05" : a.is_user_facing >= 0.7 ? "GHOST-07" : "GHOST-01";
  return a;
}

// ---------- semantic duplicate detection ----------
export function duplicateQuestions(candidates) {
  const criteria = {};
  for (const c of candidates) criteria[`issue_${c.id}`] = clip(`${c.type ? c.type + ": " : ""}${c.title}${c.culprit ? ` — at ${c.culprit}` : ""}`, 200);
  criteria.none = "`new_problem` has a different root cause from every listed issue";
  return {
    same_as: {
      type: "choice",
      instructions:
        "Which existing issue has the same underlying root cause as `new_problem`, such that one code fix would resolve both? Choose `none` unless the match is clear.",
      criteria,
    },
  };
}

// ---------- sessions ----------
export const INTENTS = {
  browsing: "Looking around with no clear goal: landing pages, content, a few casual clicks",
  evaluating: "Researching whether to buy or sign up: pricing, features, docs, comparison",
  purchasing: "Trying to buy or pay: cart, checkout, payment, upgrade",
  onboarding: "Signing up, setting up an account, first-run configuration",
  using_product: "Doing routine work inside the product as an existing user",
  managing_account: "Settings, profile, billing details, team or password management",
  troubleshooting: "Trying to get past a problem: retrying, help pages, support contact",
  automated: "A bot, crawler, monitor or scripted client rather than a person",
};
export const OUTCOMES = {
  succeeded: "The visitor visibly completed what they came to do",
  blocked_by_error: "The visitor was stopped by an error or failure and gave up or left",
  abandoned: "The visitor left partway through without any error being visible",
  unclear: "Too little evidence to tell, or the visit was just browsing",
};
export const FRUSTRATION_LEVELS = [
  "Smooth: no friction at all",
  "Mild: a small hiccup such as one retry or one slow page",
  "Frustrated: repeated retries, rage clicks, or errors interrupting the task",
  "Severe: the visitor fought the product and failed — repeated errors, rage clicks and abandonment",
];

export function sessionQuestions() {
  return {
    intent: { type: "choice", instructions: "What was the visitor mainly trying to do in `session`?", criteria: INTENTS },
    outcome: { type: "choice", instructions: "How did `session` end for the visitor?", criteria: OUTCOMES },
    frustration: { type: "score", instructions: "How frustrated was the visitor during `session`?", criteria: FRUSTRATION_LEVELS },
    churn_risk: noul(
      "Is this visitor at risk of giving up on the product because of what happened in `session`?",
      "They hit blocking problems or strong friction on something that mattered to them",
      "Nothing in the session would push a reasonable person away"
    ),
    hit_blocking_bug: noul(
      "Did a product malfunction stop the visitor from completing their task in `session`?",
      "An error, failed request or dead control prevented the visitor from finishing",
      "Any problems were cosmetic, recovered from, or absent"
    ),
  };
}

export function sessionState(session, events) {
  const t0 = session.started_at;
  const line = (e) => {
    const s = Math.round((e.ts - t0) / 1000);
    const at = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    const p = e.props || {};
    switch (e.event) {
      case "$pageview": return `${at} viewed page ${e.pathname || "/"}`;
      case "$pageleave": return null;
      case "$autocapture": return `${at} ${p.$event_type || "click"} on ${p.$el_tag || "element"} "${clip(p.$el_text || p.$el_selector || "", 40)}"`;
      case "$rageclick": return `${at} RAGE-CLICKED "${clip(p.$el_text || p.$el_selector || "", 40)}"`;
      case "$dead_click": return `${at} clicked "${clip(p.$el_text || p.$el_selector || "", 40)}" and nothing happened`;
      case "$exception": return `${at} ERROR: ${clip(e.message, 120)}`;
      case "$network_error": return `${at} REQUEST FAILED: ${clip(e.message, 100)}`;
      case "$web_vitals": return p.$rating === "poor" ? `${at} page felt slow (${p.$metric} poor)` : null;
      case "$identify": return `${at} logged in`;
      case "$log": return e.level === "error" ? `${at} app logged error: ${clip(e.message, 100)}` : null;
      default: return e.event.startsWith("$") ? null : `${at} did "${e.event}"`;
    }
  };
  const timeline = events.map(line).filter(Boolean);
  // Keep the head and the tail: how it started and how it ended matter most.
  const trimmed = timeline.length > 60 ? [...timeline.slice(0, 20), "…", ...timeline.slice(-39)] : timeline;
  return {
    session: {
      entry_page: session.entry_path || "/",
      came_from: session.referrer_domain || "direct",
      device: [session.device, session.browser, session.os].filter(Boolean).join(" / ") || undefined,
      timeline: trimmed,
    },
  };
}

export function heuristicSessionAnswers(session, events) {
  const text = events.map((e) => `${e.event} ${e.pathname || ""} ${e.message || ""} ${e.props?.$el_text || ""}`).join(" ").toLowerCase();
  const errs = session.errors, rage = session.rage_clicks;
  const intent =
    /bot|crawler/.test(String(session.browser).toLowerCase()) ? "automated"
    : /checkout|cart|pay|purchase|upgrade/.test(text) ? "purchasing"
    : /signup|sign up|onboard|welcome/.test(text) ? "onboarding"
    : /pricing|features|docs|compare/.test(text) ? "evaluating"
    : /settings|profile|billing|account/.test(text) ? "managing_account"
    : /help|support|retry/.test(text) ? "troubleshooting"
    : session.pageviews <= 2 ? "browsing" : "using_product";
  const converted = /purchase|order_completed|checkout_completed|signed_up|subscribed|completed/.test(text);
  const frustration = Math.min(3, errs * 0.8 + rage * 1.0 + (text.includes("$dead_click") ? 0.5 : 0));
  return {
    intent, intent_conf: null,
    outcome: converted ? "succeeded" : errs > 0 ? "blocked_by_error" : session.pageviews > 2 ? "abandoned" : "unclear",
    outcome_conf: null,
    frustration,
    churn_risk: Math.min(0.95, frustration / 3.2),
    hit_blocking_bug: errs > 0 && !converted ? 0.75 : 0.1,
  };
}

export function flattenSessionAnswers(ans) {
  return {
    intent: ans.intent.choice, intent_conf: ans.intent.confidence ?? null,
    outcome: ans.outcome.choice, outcome_conf: ans.outcome.confidence ?? null,
    frustration: ans.frustration.score,
    churn_risk: ans.churn_risk.noul, hit_blocking_bug: ans.hit_blocking_bug.noul,
  };
}

// ---------- custom event taxonomy (asked once per event NAME, then cached forever) ----------
export const STAGES = {
  acquisition: "A visitor arriving or showing first interest: landing, campaign click, newsletter signup",
  activation: "A new user reaching first value: account created, onboarding finished, first project or item made",
  engagement: "Routine product usage by an existing user: viewing, searching, creating, editing, sharing",
  revenue: "Money-related: checkout started or completed, plan upgraded, subscription renewed, purchase",
  retention: "Returning or re-engaging behaviour: came back, reactivated, streak, renewed interest",
  referral: "Inviting or sharing the product with other people",
  churn_signal: "Leaving behaviour: cancelled, downgraded, deleted account, unsubscribed, exported data to leave",
  system: "Internal or technical event not performed by a person: job ran, sync finished, webhook received",
};

export function eventDefQuestions() {
  return {
    stage: { type: "choice", instructions: "Which customer-lifecycle stage does the product analytics event `event_name` represent?", criteria: STAGES },
    is_conversion: noul(
      "Is `event_name` a conversion — the moment a business goal is achieved?",
      "A signup, purchase, subscription, upgrade or other goal completion",
      "A step on the way, routine usage, or a technical event"
    ),
  };
}

export function heuristicEventDefAnswers(name) {
  const n = name.toLowerCase();
  const stage =
    /cancel|churn|downgrad|delete_account|unsubscrib/.test(n) ? "churn_signal"
    : /purchase|order|checkout|paid|payment|upgrade|subscri|revenue/.test(n) ? "revenue"
    : /invite|refer|share/.test(n) ? "referral"
    : /signed_up|signup|sign_up|onboard|created_account|activated|first_/.test(n) ? "activation"
    : /landing|campaign|newsletter|lead/.test(n) ? "acquisition"
    : /returned|reactivat|streak/.test(n) ? "retention"
    : /job|sync|webhook|cron|system/.test(n) ? "system"
    : "engagement";
  return { stage, stage_conf: null, is_conversion: /signed_up|signup|purchase|order_completed|checkout_completed|subscribed|upgraded/.test(n) ? 0.9 : 0.1 };
}
