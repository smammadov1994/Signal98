// Alerting: rules decide WHEN, channels decide WHERE. Every dispatch is recorded in
// `notifications` (the Outbox window), including dry runs when a channel has no credentials,
// so you can always see exactly what would have been sent.
import { q, parse, kvGet, kvSet, listProjects } from "./db.js";
import { publish } from "./bus.js";
import { clip } from "./util.js";

const PUBLIC_URL = () => (process.env.SIGNAL98_PUBLIC_URL || "http://localhost:3001").replace(/\/$/, "");
const RANK = { ignore: 0, ticket: 1, notify: 2, page: 3 };

// ---------------------------------------------------------------- cooldown
function coolingDown(rule, subject, now) {
  const row = q("SELECT fired_at FROM alert_state WHERE rule_id = ? AND subject = ?").get(rule.id, subject);
  return row && now - row.fired_at < rule.cooldown_s * 1000;
}
function markFired(rule, subject, now) {
  q("INSERT INTO alert_state (rule_id, subject, fired_at) VALUES (?, ?, ?) ON CONFLICT(rule_id, subject) DO UPDATE SET fired_at = excluded.fired_at")
    .run(rule.id, subject, now);
  q("UPDATE alert_rules SET last_fired_at = ? WHERE id = ?").run(now, rule.id);
}

const rulesFor = (projectId, kind) =>
  q("SELECT * FROM alert_rules WHERE project_id = ? AND kind = ? AND enabled = 1").all(projectId, kind)
    .map((r) => ({ ...r, config: parse(r.config, {}), channel_ids: parse(r.channel_ids, []) }));

// ---------------------------------------------------------------- message building
const pct = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`);

function issueMessage(issue, headline) {
  const c = parse(issue.classification, {}) || {};
  const url = `${PUBLIC_URL()}/?issue=${issue.id}`;
  const lines = [
    `${issue.type ? issue.type + ": " : ""}${issue.title}`,
    issue.culprit ? `at ${issue.culprit}` : null,
    "",
    `Verdict: ${String(issue.verdict).toUpperCase()}  ·  severity ${Number(issue.severity ?? 0).toFixed(1)}/4  ·  priority ${issue.priority ?? "–"}`,
    `Category: ${issue.category}  ·  likely cause: ${issue.cause}`,
    `Urgent ${pct(c.is_urgent)}  ·  user-facing ${pct(c.is_user_facing)}  ·  revenue ${pct(c.revenue_impact)}  ·  data risk ${pct(c.data_risk)}`,
    `Seen ${issue.count}× in ${issue.service || "app"}  ·  judged by ${issue.judged_by}`,
    "",
    url,
  ].filter((l) => l !== null);
  return { subject: clip(`[signal98] ${headline}: ${issue.title}`, 160), body: lines.join("\n"), url, tag: `issue-${issue.id}` };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

// The email wears the product's Windows 98 look: a title bar, a bevelled grey body.
function emailHtml(msg) {
  const body = esc(msg.body).replace(/\n/g, "<br>").replace(esc(msg.url), `<a href="${esc(msg.url)}" style="color:#000080">${esc(msg.url)}</a>`);
  return `<div style="background:#008080;padding:24px;font-family:Tahoma,'MS Sans Serif',Arial,sans-serif;font-size:13px">
<div style="max-width:560px;margin:0 auto;background:#c0c0c0;border:2px solid;border-color:#fff #404040 #404040 #fff">
<div style="background:#000080;color:#fff;font-weight:bold;padding:4px 8px">${esc(msg.subject)}</div>
<div style="padding:14px 16px;line-height:1.55;color:#000">${body}</div>
</div></div>`;
}

// ---------------------------------------------------------------- channels
async function sendEmail(to, msg) {
  if (!to) return { status: "dry_run", error: "no recipient configured — set one in Alerts → Channels" };
  const from = process.env.SIGNAL98_EMAIL_FROM || "signal98 <alerts@signal98.local>";
  if (process.env.RESEND_API_KEY) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject: msg.subject, text: msg.body, html: emailHtml(msg) }),
    });
    if (!r.ok) throw new Error(`resend ${r.status}: ${clip(await r.text(), 200)}`);
    return { status: "sent" };
  }
  if (process.env.SMTP_URL) {
    let nodemailer;
    try { nodemailer = (await import("nodemailer")).default; } catch { return { status: "dry_run", error: "SMTP_URL is set but the nodemailer package is not installed" }; }
    const transport = (globalThis.__s98_smtp ||= nodemailer.createTransport(process.env.SMTP_URL));
    await transport.sendMail({ from, to, subject: msg.subject, text: msg.body, html: emailHtml(msg) });
    return { status: "sent" };
  }
  return { status: "dry_run", error: "no mail transport — set SMTP_URL or RESEND_API_KEY in desktop/.env.local" };
}

async function postJson(url, payload) {
  if (!/^https?:\/\//.test(url || "")) return { status: "dry_run", error: "no webhook URL configured" };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: ctl.signal });
    if (!r.ok) throw new Error(`webhook ${r.status}`);
    return { status: "sent" };
  } finally {
    clearTimeout(t);
  }
}

async function webPush() {
  if (globalThis.__s98_webpush !== undefined) return globalThis.__s98_webpush;
  try {
    const wp = (await import("web-push")).default;
    let keys = kvGet("vapid");
    if (!keys) {
      keys = wp.generateVAPIDKeys();
      kvSet("vapid", keys);
    }
    wp.setVapidDetails(process.env.SIGNAL98_VAPID_SUBJECT || "mailto:alerts@signal98.local", keys.publicKey, keys.privateKey);
    globalThis.__s98_webpush = { wp, publicKey: keys.publicKey };
  } catch (err) {
    console.error("[signal98] web push unavailable:", err?.message);
    globalThis.__s98_webpush = null;
  }
  return globalThis.__s98_webpush;
}

export async function vapidPublicKey() {
  return (await webPush())?.publicKey || null;
}

async function sendPush(projectId, msg) {
  const w = await webPush();
  if (!w) return { status: "dry_run", error: "web-push package not installed" };
  const subs = q("SELECT * FROM push_subs WHERE project_id = ?").all(projectId);
  if (!subs.length) return { status: "dry_run", error: "no browser is subscribed — click “Enable push” in the Alerts window" };
  const payload = JSON.stringify({ title: msg.subject.replace("[signal98] ", ""), body: clip(msg.body.split("\n").slice(0, 4).join("\n"), 300), url: msg.url, tag: msg.tag });
  let ok = 0, lastErr = null;
  for (const s of subs) {
    try {
      await w.wp.sendNotification({ endpoint: s.endpoint, keys: parse(s.keys, {}) }, payload, { TTL: 3600, urgency: "high" });
      ok++;
    } catch (err) {
      lastErr = err;
      // 404/410: the browser dropped the subscription. Forget it.
      if (err?.statusCode === 404 || err?.statusCode === 410) q("DELETE FROM push_subs WHERE id = ?").run(s.id);
    }
  }
  if (!ok) throw new Error(`push failed: ${lastErr?.statusCode || ""} ${clip(lastErr?.body || lastErr?.message || "", 160)}`);
  return { status: "sent", target: `${ok} browser${ok === 1 ? "" : "s"}` };
}

async function deliver(channel, msg, projectId) {
  const cfg = parse(channel.config, {});
  switch (channel.type) {
    case "email": return { target: cfg.to || "(unset)", ...(await sendEmail(cfg.to, msg)) };
    case "webhook": return { target: cfg.url || "(unset)", ...(await postJson(cfg.url, { source: "signal98", ...msg, ...msg.payload })) };
    case "slack": return { target: "slack", ...(await postJson(cfg.url, { text: `*${msg.subject}*\n\`\`\`${msg.body}\`\`\`` })) };
    case "push": return { target: "browsers", ...(await sendPush(projectId, msg)) };
    default: return { status: "failed", error: `unknown channel type ${channel.type}` };
  }
}

export async function dispatch(projectId, rule, msg, { issueId = null, channelIds } = {}) {
  const ids = channelIds || rule?.channel_ids || [];
  const out = [];
  for (const id of ids) {
    const channel = q("SELECT * FROM channels WHERE id = ? AND project_id = ? AND enabled = 1").get(id, projectId);
    if (!channel) continue;
    let res;
    try { res = await deliver(channel, msg, projectId); }
    catch (err) { res = { status: "failed", error: clip(err?.message || String(err), 300), target: channel.name }; }
    const nid = q(
      `INSERT INTO notifications (project_id, rule_id, issue_id, channel_type, target, subject, body, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(projectId, rule?.id ?? null, issueId, channel.type, res.target ?? null, msg.subject, msg.body, res.status, res.error ?? null, Date.now()).lastInsertRowid;
    const n = { id: Number(nid), project_id: projectId, rule: rule?.name ?? "test", issue_id: issueId, channel_type: channel.type, subject: msg.subject, status: res.status, error: res.error ?? null, url: msg.url, created_at: Date.now() };
    publish("notification", n);
    out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------- rule evaluation
export async function evaluateIssueAlerts(issue, { isNew, previousVerdict }) {
  if (issue.status === "ignored") return;
  const now = Date.now();
  const subject = `issue:${issue.id}`;

  if (issue.regressed) {
    for (const rule of rulesFor(issue.project_id, "issue_regression")) {
      // fire once per regression: the flag is cleared when the issue is resolved again
      if (coolingDown(rule, subject, now)) continue;
      markFired(rule, subject, now);
      await dispatch(issue.project_id, rule, issueMessage(issue, "REGRESSION"), { issueId: issue.id });
    }
  }
  // Verdict rules fire for new issues and for escalations (notify → page), never for repeats.
  const escalated = !isNew && (RANK[issue.verdict] ?? 0) > (RANK[previousVerdict] ?? 0);
  if (!isNew && !escalated) return;
  for (const rule of rulesFor(issue.project_id, "issue_verdict")) {
    if (!(rule.config.verdicts || []).includes(issue.verdict)) continue;
    if (rule.config.categories?.length && !rule.config.categories.includes(issue.category)) continue;
    if (coolingDown(rule, subject, now) && !escalated) continue;
    markFired(rule, subject, now);
    const headline = issue.verdict === "page" ? "PAGE" : escalated ? "Escalated" : "New issue";
    await dispatch(issue.project_id, rule, issueMessage(issue, headline), { issueId: issue.id });
  }
}

export async function evaluateSessionAlerts(session, flat) {
  const now = Date.now();
  for (const rule of rulesFor(session.project_id, "session_frustration")) {
    if (!(flat.frustration >= (rule.config.min ?? 2.2))) continue;
    // cooldown is per person, so one struggling user does not page repeatedly
    const subject = `person:${session.distinct_id || session.id}`;
    if (coolingDown(rule, subject, now)) continue;
    markFired(rule, subject, now);
    const url = `${PUBLIC_URL()}/?session=${encodeURIComponent(session.id)}`;
    await dispatch(session.project_id, rule, {
      subject: `[signal98] Frustrated ${flat.intent.replace("_", " ")} session (${flat.outcome.replace(/_/g, " ")})`,
      body: [`Visitor ${session.distinct_id || "anonymous"} — frustration ${flat.frustration.toFixed(1)}/3, churn risk ${pct(flat.churn_risk)}`,
        `${session.errors} errors · ${session.rage_clicks} rage clicks · ${session.pageviews} pages · entered at ${session.entry_path || "/"}`, "", url].join("\n"),
      url, tag: `session-${session.id}`,
    });
  }
}

// Volume-based rules run on the sweeper, not on the ingest path.
export async function evaluateTimedAlerts() {
  const now = Date.now();
  for (const project of listProjects()) {
    for (const rule of rulesFor(project.id, "issue_spike")) {
      const w = (rule.config.windowMinutes || 5) * 60_000;
      const rows = q(
        `SELECT issue_id, SUM(ts >= ?) recent, SUM(ts < ?) prior FROM events
         WHERE project_id = ? AND issue_id IS NOT NULL AND ts >= ? GROUP BY issue_id HAVING recent >= ?`
      ).all(now - w, now - w, project.id, now - 7 * w, rule.config.minCount || 20);
      for (const r of rows) {
        const baseline = Math.max(1, r.prior / 6);
        if (r.recent < (rule.config.factor || 10) * baseline) continue;
        const subject = `issue:${r.issue_id}`;
        if (coolingDown(rule, subject, now)) continue;
        const issue = q("SELECT * FROM issues WHERE id = ?").get(r.issue_id);
        if (!issue || issue.status === "ignored") continue;
        markFired(rule, subject, now);
        await dispatch(project.id, rule, issueMessage(issue, `SPIKE ${r.recent}× in ${rule.config.windowMinutes || 5} min`), { issueId: issue.id });
      }
    }
    for (const rule of rulesFor(project.id, "metric_threshold")) {
      const c = rule.config;
      if (!c.event) continue;
      const n = q("SELECT COUNT(*) n FROM events WHERE project_id = ? AND event = ? AND ts >= ?").get(project.id, c.event, now - (c.windowMinutes || 5) * 60_000).n;
      const hit = c.op === "below" ? n < c.value : n > c.value;
      if (!hit || coolingDown(rule, "metric", now)) continue;
      markFired(rule, "metric", now);
      await dispatch(project.id, rule, {
        subject: `[signal98] ${rule.name}`,
        body: `"${c.event}" happened ${n}× in the last ${c.windowMinutes || 5} min (threshold: ${c.op === "below" ? "below" : "above"} ${c.value}).\n\n${PUBLIC_URL()}`,
        url: PUBLIC_URL(), tag: `rule-${rule.id}`,
      });
    }
  }
}

export async function sendTest(projectId, channelId) {
  return dispatch(projectId, null, {
    subject: "[signal98] Test notification",
    body: "If you can read this, the channel works.\nThe ghost says hi.\n\n" + PUBLIC_URL(),
    url: PUBLIC_URL(), tag: "test",
  }, { channelIds: [channelId] });
}
