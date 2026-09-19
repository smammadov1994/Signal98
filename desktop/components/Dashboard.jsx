"use client";
import { useState } from "react";
import { useApi, ago, fmtNum } from "../lib/client";
import { useDemoSession } from "../lib/demo-session";
import { JevSpotlight } from "./JevResult";
import IssueDetail from "../apps/IssueDetail";

const urgency = { page: "Needs attention", notify: "Investigate", ticket: "Can wait", ignore: "Low priority" };
export function issueWords(i) {
  if (/^Demo checkout:/.test(i.title)) return { title: "Your test error was captured", impact: "The checkout error you triggered reached Signal 98 through the SDK.", next: "Open the result to see the captured error and its classification." };
  if (i.category === "payments" && i.kind === "network") return { title: "The payment service returned an error", impact: "A payment request received an error response from the shop.", next: "Check the underlying checkout error before treating this as a separate problem." };
  if (i.category === "payments" && /payment failed/i.test(i.title)) return { title: "Checkout showed a payment error", impact: "A visitor saw the payment fail in their browser.", next: "Review the payment service error to find the underlying cause." };
  if (/Invalid discount/i.test(i.title)) return { title: "A coupon could not be applied", impact: "The shop failed to calculate a discount for a coupon.", next: "Check the coupon configuration and how its discount is calculated." };
  if (i.category === "payments") return { title: "Checkout is failing", impact: "A customer trying to pay encountered an error.", next: "Review the payment error and its suggested fix before changing the shop." };
  if (i.category === "rendering") return { title: "A page could not load", impact: "Someone encountered an error while opening a page.", next: "Check which page failed and review the code behind it." };
  if (i.kind === "ux") return { title: /rage/i.test(i.type || i.title) ? "A button was clicked repeatedly" : "A click had no visible response", impact: "Someone may have been stuck while using the app.", next: "Check the affected button and confirm that its action works." };
  return { title: i.title, impact: "This problem was captured while someone used the app.", next: "Open the details to see what happened and decide whether it needs a fix." };
}
const judged = (i) => !i.judged_by ? "Classification pending" : i.judged_by.startsWith("heuristic") ? "Rule-based assessment · not JEV" : `Assessed by ${i.judged_by}`;
export function Dashboard({ wm, overview, meta }) {
  const session = useDemoSession();
  const scoped = useApi(session.since ? `overview?since=${session.since}` : null, { every: 10000, on: ["event", "issue", "verdict"] });
  const issues = useApi(`issues?status=open&sort=priority${session.since ? `&since=${session.since}` : ""}`, { every: 15000, on: ["issue", "verdict", "agent"] });
  const rows = issues.data?.issues || [];
  const o = session.since ? scoped.data : overview.data;
  const waiting = rows.filter(i => i.run?.status === "succeeded");
  const problem = issues.error || (session.since ? scoped.error : overview.error);
  const demo = !!session.since || /playground$/.test(meta.data?.project?.settings?.ghost?.repoPath || "") || rows.some(i => i.service === "ghost-mart" || i.environment === "playground");
  const connection = overview.data?.jev || meta.data?.jev;
  return <div className="monitor-overview">
    <header className="overview-heading">
      <div><div className="overview-project">{demo ? "Ghost Mart" : meta.data?.project?.name || "Your application"}<span>{demo ? "Demo workspace" : "Monitoring"}</span></div><h1>Overview</h1></div>
      <div className="overview-scope"><span>{session.since ? "Current demo" : "Saved history"}</span>{demo && <button onClick={session.since ? session.history : session.start}>{session.since ? "View history" : "Start fresh"}<span aria-hidden="true">↗</span></button>}</div>
    </header>

    {problem && <div className="dash-warning" role="alert"><strong>Couldn’t refresh monitoring data.</strong><p>{issues.data || o ? "Showing the last available results." : "Check that the monitor is running."}</p><button className="dash-link" onClick={() => { issues.reload(); overview.reload(); scoped.reload(); }}>Try again</button></div>}
    <div className={`overview-workspace${demo ? " with-demo" : ""}`}>
      <JevSpotlight wm={wm} since={session.since} connection={connection} demo={demo} />
      {demo && <aside className="demo-guide" aria-label="Try the demo">
        <div className="demo-guide-heading"><span className="section-kicker">THE PLAYGROUND</span><span className="demo-guide-tag">Live demo</span></div>
        <h2>See an error.<br />Understand its impact.</h2>
        <p>Trigger a checkout error in Ghost Mart. Follow its assessment here.</p>
        <ol className="demo-steps"><li><span>01</span><div><strong>Trigger an error</strong><p>Use the demo’s checkout control.</p></div></li><li><span>02</span><div><strong>Read JEV’s assessment</strong><p>The result appears automatically.</p></div></li><li><span>03</span><div><strong>Choose what happens next</strong><p>Investigate or ask Ghost for a fix.</p></div></li></ol>
        <a className="overview-button" href="http://localhost:3000/demo" target="_blank" rel="noreferrer">Open playground <span aria-hidden="true">↗</span></a>
        <div className="demo-reset"><button onClick={session.start}>{session.since ? "Restart demo" : "Start with an empty demo"}</button><span>Earlier results stay in history.</span></div>
      </aside>}
    </div>

    <dl className="overview-numbers" aria-label="Monitoring totals">
      <div><dt>Open issues</dt><dd>{o ? fmtNum(Object.entries(o.open_issues || {}).filter(([k]) => k !== "ignore").reduce((s,[,n]) => s+n,0)) : "—"}</dd><span>{session.since ? "In this demo" : "Across all time"}</span></div>
      <div><dt>People reached</dt><dd>{fmtNum(o?.users_24h)}</dd><span>{session.since ? "In this demo" : "Last 24 hours"}</span></div>
      <div><dt>Fixes to review</dt><dd>{issues.data ? waiting.length : "—"}</dd><button onClick={() => wm.open("runs")}>View fix activity ↗</button></div>
    </dl>

    <section className="overview-issues" aria-label="Open issues">
      <header><div><h2>Issues</h2><span>{session.since ? "Captured in this demo" : "Open issues from saved history"}</span></div><button className="overview-text-button" onClick={() => wm.open("issues")}>View all issues <span aria-hidden="true">→</span></button></header>
      {!issues.data ? <p className="overview-empty" role="status">{issues.error ? "Issues are unavailable. Try refreshing above." : "Loading issues…"}</p> : !rows.length ? <div className="overview-empty"><strong>No open issues{session.since ? " in this demo" : ""}.</strong><span>{demo ? "Trigger an error in the playground to see it here." : "New problems will appear here as they are captured."}</span></div> : <div className="overview-issue-table"><table><thead><tr><th scope="col">Issue</th><th scope="col">Priority</th><th scope="col">People</th><th scope="col">Last seen</th><th scope="col"><span className="overview-sr-only">Actions</span></th></tr></thead><tbody>{rows.slice(0,5).map(i => <tr key={i.id}><td><button className="overview-issue-title" onClick={() => wm.open("issue", { id:i.id })}>{/^Demo checkout:/.test(i.title) ? "Checkout · payment service unavailable" : issueWords(i).title}</button><span className="overview-issue-meta">#{i.id} · {judged(i)}</span></td><td><span className={`overview-priority ${i.verdict}`}><i aria-hidden="true" />{urgency[i.verdict] || "Under review"}</span></td><td>{fmtNum(i.users)}</td><td>{ago(i.last_seen)}</td><td><button className="overview-result-link" onClick={() => wm.open("judgment", {id:i.id})} aria-label={`View classification for issue ${i.id}`}>Result <span aria-hidden="true">↗</span></button></td></tr>)}</tbody></table></div>}
    </section>
    <footer className="overview-footer"><span>Ghost suggests code fixes for issues you choose.</span><button className="overview-text-button" onClick={() => waiting.length ? wm.open("run", {id:waiting[0].run.id}) : wm.open("runs")}>{waiting.length ? "Review a suggested fix" : "Open fix assistant"} →</button></footer>
  </div>;
}

export function IssueBrief({ wm, params }) {
  const session = useDemoSession();
  const result = useApi(`issues/${params.id}`, { every: 10_000, on: ["issue", "verdict", "agent"] });
  const [technical, setTechnical] = useState(false);
  const data = result.data;
  if (!data) return <div className="dash-page"><h2>{result.error ? "We couldn’t load this problem." : "Loading problem…"}</h2>{result.error && <button className="dash-button" onClick={result.reload}>Try again</button>}</div>;
  const i = data.issue, words = issueWords(i);
  const run = data.runs?.find(r => r.status === "succeeded");
  const active = data.runs?.find(r => ["queued","running"].includes(r.status));
  return <div className="brief-page"><span className={`priority-label ${i.verdict === "page" ? "urgent" : ""}`}>{i.status === "resolved" ? "Marked resolved" : urgency[i.verdict] || "Under review"}</span><h2>{words.title}</h2><p className="brief-lede">{words.impact}</p><small>{judged(i)} · Issue #{i.id}</small>{result.error && <p className="dash-warning">Showing saved results. The latest refresh failed.</p>}<button className="dash-button primary brief-jev-link" onClick={() => wm.open("judgment", { id: i.id })}>{i.judged_by && !i.judged_by.startsWith("heuristic") ? "View JEV result" : "View classification result"} →</button><section className="brief-section"><h3>What happened</h3>{session.since && i.first_seen < session.since && <p>This issue also occurred in earlier demos. The details below show its complete history.</p>}<p>{i.title}</p><div className="brief-facts"><div><strong>{fmtNum(data.users)}</strong><span>people affected</span></div><div><strong>{fmtNum(i.count)}</strong><span>recorded occurrences</span></div></div><p>Last seen {ago(i.last_seen)}{data.breakdowns?.pathname?.[0]?.k ? ` on ${data.breakdowns.pathname[0].k}` : ""}.</p></section><section className="brief-section"><h3>What to do next</h3><p>{words.next}</p>{run ? <><div className="ready-note">Ghost has suggested a fix. It hasn’t been applied or verified.</div><button className="dash-button primary" onClick={() => wm.open("run", { id: run.id })}>Review suggested fix →</button></> : active ? <button className="dash-button quiet" onClick={() => wm.open("run", { id: active.id })}>Watch Ghost’s progress →</button> : <p>Open technical details below for the stack trace and tools to investigate or request a fix.</p>}</section><button className="dash-link" aria-expanded={technical} onClick={() => setTechnical(v => !v)}>{technical ? "Hide" : "Show"} technical details {technical ? "−" : "+"}</button>{technical && <div className="brief-technical"><IssueDetail wm={wm} params={params} /></div>}</div>;
}

export function SimpleIssues({ wm }) {
  const session = useDemoSession();
  const [status, setStatus] = useState("open");
  const result = useApi(`issues?status=${status}&sort=priority${session.since ? `&since=${session.since}` : ""}`, { every: 15_000, on: ["issue", "verdict", "agent"] });
  return <div className="dash-page"><div className="dash-intro"><div><p className="eyebrow">PROBLEMS YOUR APP REPORTED</p><h1>Issues</h1><p>{session.since ? "Showing only issues recorded since your fresh demo started." : "Showing saved issues from all monitoring activity."}</p></div></div><div className="issue-filters">{["open", "resolved"].map(s => <button key={s} className={`dash-button ${status === s ? "primary" : "quiet"}`} aria-pressed={status === s} onClick={() => setStatus(s)}>{s === "open" ? "Needs attention" : "Marked resolved"}</button>)}</div>{result.error && <p className="dash-warning">Couldn’t refresh issues. <button className="dash-link" onClick={result.reload}>Try again</button></p>}<section className="dash-card simple-list issue-list">{result.loading ? <p className="empty-copy">Loading issues…</p> : !result.data?.issues?.length ? <p className="empty-copy">No {status} issues.</p> : result.data.issues.map(i => <button key={i.id} onClick={() => wm.open("issue", { id:i.id })}><span className={`severity-dot ${i.verdict}`} /><span className="list-copy"><strong>{issueWords(i).title}</strong><small>{status === "resolved" ? "Marked resolved" : urgency[i.verdict] || "Under review"} · {i.users} people affected · {judged(i)}</small></span><span className="list-time">Last seen {ago(i.last_seen)}</span><span>→</span></button>)}</section></div>;
}
