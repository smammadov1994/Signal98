"use client";
// Pages (app id `pages`) — the on-call view: open issues whose verdict is `page`, as big cards
// with the receipts (why it paged), and the notifications that actually went out for them.
import { useMemo, useRef, useState } from "react";
import { api, useApi, useStream, ago, fmtNum, label } from "../lib/client";
import { Meter, Spark, VerdictTag, JudgedBy } from "../components/charts";
import { IssueTags, patchIssue, headline } from "./Issues";

const ON_CALL = "on-call";
const REASONS = [["is_urgent", "urgent"], ["is_user_facing", "user-facing"], ["revenue_impact", "revenue impact"], ["data_risk", "data risk"], ["security_relevant", "security"]];

// Severity plus the three strongest yes/no answers: the judgments that made it a page.
function topReasons(c) {
  if (!c) return [];
  return REASONS.map(([k, name]) => ({ k, name, v: c[k] })).filter((r) => typeof r.v === "number").sort((a, b) => b.v - a.v).slice(0, 3);
}

function Card({ issue, ghostLine, busy, onAct, wm }) {
  const c = issue.classification || null;
  const acked = !!issue.assignee;
  const who = String(issue.judged_by || "").startsWith("heuristic") ? "the heuristic" : "JEV";
  return (
    <div className={`pg-card raised-thin${acked ? " acked" : ""}`}>
      <div className="top">
        <VerdictTag issue={issue} /><JudgedBy by={issue.judged_by} />
        <span>priority <b>{issue.priority == null ? "–" : Math.round(issue.priority)}</b></span>
        <span className="muted">{label(issue.category) || "uncategorised"}{issue.service ? ` · ${issue.service}` : ""}</span>
        <IssueTags issue={issue} />
        <span className="iw-spacer" />
        <span className="muted">#{issue.id}</span>
      </div>
      <h3 className="selectable">{headline(issue)}</h3>
      {issue.culprit ? <div className="mono muted selectable">{issue.culprit}</div> : null}
      <div className="body">
        <div>
          <div className="muted" style={{ marginBottom: 2 }}>why {who} paged</div>
          <Meter label="severity" value={c?.severity ?? issue.severity} max={4} digits={1} />
          {topReasons(c).map((r) => <Meter key={r.k} label={r.name} value={r.v} />)}
        </div>
        <dl className="counts">
          <dt>paging for</dt><dd><b>{issue.first_seen ? ago(issue.first_seen).replace(" ago", "").replace("just now", "a few seconds") : "–"}</b></dd>
          <dt>last seen</dt><dd>{issue.last_seen ? ago(issue.last_seen) : "–"}</dd>
          <dt>events</dt><dd>{fmtNum(issue.count)}</dd>
          <dt>users</dt><dd>{fmtNum(issue.users)}</dd>
          <dt>24 h</dt><dd><Spark values={issue.spark || []} color="#d03b3b" /></dd>
        </dl>
      </div>
      <div className="btns">
        <button className="btn98 small" disabled={!!busy || acked} onClick={() => onAct(issue, "ack")}>{acked ? `Acknowledged by ${issue.assignee}` : "Acknowledge"}</button>
        <button className="btn98 small" disabled={!!busy} onClick={() => onAct(issue, "resolve")}>Resolve</button>
        <button className="btn98 small" onClick={() => wm?.open?.("issue", { id: issue.id })}>Open</button>
        <button className="btn98 small" disabled={!!busy} onClick={() => onAct(issue, "ghost")} title="read-only fix report; can take a few minutes">{busy === "ghost" ? "The ghost is thinking…" : issue.has_fix ? "Ask ghost again" : "Ask ghost"}</button>
        {issue.has_fix ? <button className="iw-link" onClick={() => wm?.open?.("issue", { id: issue.id, tab: "ghost" })}>read the fix report</button> : null}
        {ghostLine ? <span className="muted mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>{ghostLine}</span> : null}
      </div>
    </div>
  );
}

export default function Pages({ wm }) {
  const { data, error, loading, reload } = useApi("issues?status=open&verdict=page&sort=priority", { on: ["verdict", "issue", "event", "agent"], every: 15000 });
  const notes = useApi("alerts/notifications", { on: ["notification", "verdict"], every: 30000 });
  const [busy, setBusy] = useState({});         // issue id → "ack" | "resolve" | "ghost"
  const [ghostLines, setGhostLines] = useState({});
  const [note, setNote] = useState(null);
  const wmRef = useRef(wm); wmRef.current = wm;

  // A page only counts once it is judged; rows still re-judging keep their last verdict server-side.
  const issues = useMemo(() => (Array.isArray(data?.issues) ? data.issues : []), [data]);
  const ids = useMemo(() => new Set(issues.map((i) => i.id)), [issues]);
  const sent = useMemo(() => (notes.data?.notifications || []).filter((n) => ids.has(n.issue_id)).slice(0, 12), [notes.data, ids]);

  useStream((msg) => {
    if (msg.type !== "agent" || msg.data?.issue_id == null || !msg.data.line) return;
    setGhostLines((g) => ({ ...g, [msg.data.issue_id]: `[${msg.data.phase || "ghost"}] ${msg.data.line}` }));
  });

  const onAct = async (issue, kind) => {
    if (busy[issue.id]) return;
    setBusy((b) => ({ ...b, [issue.id]: kind })); setNote(null);
    try {
      if (kind === "ack") { await patchIssue(issue.id, { assignee: ON_CALL }); setNote(`#${issue.id} acknowledged — assigned to ${ON_CALL}`); }
      else if (kind === "resolve") { await patchIssue(issue.id, { status: "resolved" }); setNote(`#${issue.id} resolved — if it fires again it regresses and pages again`); }
      else { await api(`issues/${issue.id}/fix`, { method: "POST" }); wmRef.current?.open?.("issue", { id: issue.id, tab: "ghost" }); }
      reload();
    } catch (err) { setNote(`#${issue.id}: ${err.message}`); }
    finally { setBusy((b) => { const n = { ...b }; delete n[issue.id]; return n; }); }
  };

  const unacked = issues.filter((i) => !i.assignee).length;
  return (
    <div className="iw-root">
      <div className="toolbar">
        <b style={{ color: issues.length ? "#a00000" : "#006300" }}>{issues.length} open page{issues.length === 1 ? "" : "s"}</b>
        {issues.length ? <span className="muted">{unacked} waiting for an acknowledgement</span> : null}
        <span className="iw-spacer" />
        <button className="tool-btn" onClick={() => wm?.open?.("alerts")}>Alert rules…</button>
        <button className="tool-btn" onClick={() => wm?.open?.("issues")}>All issues…</button>
      </div>
      <div className="grow scroll">
        {issues.map((i) => <Card key={i.id} issue={i} wm={wm} busy={busy[i.id] || false} ghostLine={ghostLines[i.id]} onAct={onAct} />)}
        {!issues.length && (
          error ? <div className="err">Cannot load pages: {error}. Retrying…</div>
          : loading ? <div className="iw-empty">…</div>
          : <div className="pg-calm"><b>Nobody needs to wake up.</b>No open issue is severe, user-facing and urgent enough to page.<br />
              <span className="muted">Set off the checkout error in the playground at :3000 to see one land here.</span></div>
        )}
        {issues.length ? (
          <div className="panel sunken-thin"><h4>Notifications sent for these pages</h4>
            {sent.length ? (
              <table className="t98"><thead><tr><th>When</th><th>Issue</th><th>Channel</th><th>Target</th><th>Status</th><th>Subject</th></tr></thead>
                <tbody>{sent.map((n) => (
                  <tr key={n.id} title={n.error || ""}>
                    <td>{n.created_at ? ago(n.created_at) : "–"}</td>
                    <td><button className="iw-link" onClick={() => wm?.open?.("issue", { id: n.issue_id })}>#{n.issue_id}</button></td>
                    <td>{n.channel_type}</td><td>{n.target || "–"}</td>
                    <td><span className={`tag${n.status === "failed" ? " regressed" : ""}`} title={n.status === "dry_run" ? "nothing left the building: the channel is not configured" : ""}>{label(n.status)}</span></td>
                    <td className="iw-fill" title={n.subject || ""}>{n.subject}{n.error ? <span className="muted"> — {n.error}</span> : null}</td>
                  </tr>
                ))}</tbody></table>
            ) : <div className="muted pad">{notes.error ? `cannot load notifications: ${notes.error}` : "Nothing was sent for these issues — check Alerts → Rules and Channels."}</div>}
          </div>
        ) : null}
      </div>
      <div className="statusbar">
        <div className="cell grow sunken-thin" style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
          {error && issues.length ? <span style={{ color: "#a00000" }}>API unreachable, showing last known pages — {error}</span> : note || "drag the ghost onto this window to unleash it"}
        </div>
        <div className="cell sunken-thin">{issues.length} page(s)</div>
      </div>
    </div>
  );
}
