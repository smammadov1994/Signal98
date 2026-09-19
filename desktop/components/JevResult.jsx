"use client";
import { useApi, ago, fmtDateTime, label } from "../lib/client";
import { explainVerdict } from "../apps/IssueDetail";

const VERDICTS = {
  page: { title: "Act now", text: "This issue needs immediate attention." },
  notify: { title: "Investigate soon", text: "Let the team know and investigate. An immediate page isn’t required." },
  ticket: { title: "Can wait", text: "Plan a fix during normal working hours. This doesn’t need an immediate response." },
  ignore: { title: "No action needed", text: "This was assessed as low-priority noise. Keep it for reference." },
};
const real = (i) => !!i?.judged_by && !i.judged_by.startsWith("heuristic");
const percent = v => typeof v === "number" && Number.isFinite(v) ? `${Math.round(v * 100)}%` : "—";
const score = v => typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(1)} / 4` : "—";
const state = (i) => i && i.judge_status === "judged" && i.verdict && i.classification;

function Signals({ issue }) {
  const c = issue.classification || {};
  return <div className="jev-key-signals"><div><span>Severity</span><strong>{score(c.severity)}</strong></div><div><span>Urgency score</span><strong>{percent(c.is_urgent)}</strong></div><div><span>Fixable in your code</span><strong>{percent(c.is_actionable)}</strong></div></div>;
}

export function JevSpotlight({ wm, since, connection, demo }) {
  const current = useApi(`issues?status=all&sort=last_seen${since ? `&since=${since}` : ""}`, { every: 10000, on: ["issue", "verdict"] });
  const issue = current.data?.issues?.[0];
  const ready = state(issue);
  const actualJev = ready && real(issue);
  const verdict = VERDICTS[issue?.verdict];
  const connected = connection?.enabled && connection?.lastOkAt && connection?.circuit !== "open";
  return <section className={`assessment ${ready ? issue.verdict : "waiting"}`} aria-label="Latest classification result" aria-live="polite">
    <header className="assessment-heading"><h2>JEV assessment</h2><button onClick={() => wm.open("settings", {tab:"jev"})} className={`assessment-connection${connected ? " connected" : ""}`}><i aria-hidden="true" />{!connection ? "Checking connection" : connected ? "Connected" : connection?.circuit === "open" ? "Connection error" : connection?.enabled ? "Awaiting response" : "Set up JEV"}<span aria-hidden="true">↗</span></button></header>
    {current.error && <p className="assessment-warning" role="alert">Couldn’t refresh. {issue ? "Showing the last saved result." : "The result is unavailable."} <button onClick={current.reload}>Retry</button></p>}
    {issue ? <>
      <div className="assessment-verdict"><p className="section-kicker">{actualJev ? "LATEST RESULT" : ready ? "KEYWORD FALLBACK · NOT JEV" : "ASSESSMENT IN PROGRESS"}{!since && <span> / SAVED HISTORY</span>}</p><h3>{ready ? verdict?.title || label(issue.verdict) : "Assessing the error…"}</h3><p>{ready ? verdict?.text : "JEV’s scores will appear as soon as the assessment is complete."}</p></div>
      <button className="assessment-subject" onClick={() => wm.open("issue", {id:issue.id})}><span className="assessment-issue-id">#{issue.id}</span><span>{issue.title}</span><span aria-hidden="true">↗</span></button>
      {ready && <Signals issue={issue} />}
      <div className="assessment-actions"><button className="overview-button dark" onClick={() => wm.open("judgment", {id:issue.id})}>{actualJev ? "View full JEV result" : ready ? "View fallback result" : "View assessment progress"}<span aria-hidden="true">→</span></button><span>{actualJev ? issue.judged_by : ready ? "Keyword rules" : "Pending"}{ready && issue.judged_at ? ` · ${ago(issue.judged_at)}` : ""}</span></div>
      <p className="assessment-footnote">Scores inform the priority; your rules decide the response.</p>
    </> : <div className="assessment-empty"><span className="section-kicker">{current.loading ? "LOADING" : "WAITING FOR AN ERROR"}</span><h3>{current.error ? "Result unavailable." : current.loading ? "Loading assessment…" : "Nothing to assess. Yet."}</h3><p>{current.error ? "Try refreshing the result above." : demo ? "Trigger an error in the playground. JEV’s assessment will take this spot." : "Once your app reports an error, its assessment will appear here."}</p><div className="assessment-placeholder" aria-hidden="true"><span>Severity <b>—</b></span><span>Urgency <b>—</b></span><span>Actionability <b>—</b></span></div>{!connection?.enabled && !current.loading && <button className="overview-text-button" onClick={() => wm.open("settings", {tab:"jev"})}>Connect JEV →</button>}</div>}
  </section>;
}

const ANSWERS = [
  ["is_urgent", "Needs an immediate response"], ["is_user_facing", "Experienced by end users"],
  ["is_actionable", "Fixable in your code"], ["revenue_impact", "Affects payments or revenue"],
  ["data_risk", "Risk to data"], ["security_relevant", "Security concern"], ["is_noise", "Likely noise"],
];
export default function JevResult({ wm, params }) {
  const result = useApi(`issues/${params.id}`, { every: 10000, on: ["issue", "verdict"] });
  const meta = useApi("meta", { on:["settings"] });
  const issue = result.data?.issue;
  if (!issue) return <div className="brief-page"><h2>{result.error ? "Couldn’t load this result." : "Loading classification…"}</h2>{result.error && <button className="dash-button quiet" onClick={result.reload}>Try again</button>}</div>;
  const c = issue.classification || {};
  const ready = state(issue), actualJev = ready && real(issue);
  const t = { pageSeverity:2.6, pageUserFacing:.6, pageUrgent:.7, notifySeverity:1.8, noise:.6, ...meta.data?.project?.settings?.thresholds };
  return <div className="jev-detail"><p className="eyebrow">{actualJev ? "JEV RESULT" : ready ? "KEYWORD FALLBACK · NOT JEV" : "CLASSIFICATION IN PROGRESS"}</p><h2>{ready ? VERDICTS[issue.verdict]?.title || label(issue.verdict) : "Waiting for the assessment…"}</h2><p className="jev-recommendation">{ready ? VERDICTS[issue.verdict]?.text : "This panel will update automatically when classification finishes."}</p><div className="jev-provenance"><strong>{ready ? issue.judged_by : "No completed result"}</strong><span>{ready && issue.judged_at ? fmtDateTime(issue.judged_at) : ""}{ready && c.latencyMs != null ? ` · ${c.latencyMs} ms` : ""}</span></div>{result.error && <p className="dash-warning">The latest refresh failed. Showing the saved result.</p>}<div className="jev-subject"><span>ASSESSED ISSUE #{issue.id}</span><p>{issue.title}</p><button className="dash-link" onClick={() => wm.open("issue", { id:issue.id })}>Open issue details →</button></div>{ready && <><h3>The assessment at a glance</h3><Signals issue={issue} /><dl className="jev-categories"><div><dt>Area</dt><dd>{label(c.category) || "—"}</dd></div><div><dt>Likely cause</dt><dd>{label(c.cause) || "—"}</dd></div><div><dt>Fix complexity</dt><dd>{score(c.fix_complexity)}</dd></div></dl><h3>{actualJev ? "What JEV assessed" : "What the keyword rules assessed"}</h3><p className="jev-score-note">Percentages are assessment scores, not the percentage of affected users.</p><div className="jev-answer-list">{ANSWERS.map(([key,title]) => <div key={key}><span>{title}</span><div className="jev-score-track"><i style={{width:`${Math.max(0, Math.min(100, (c[key] || 0) * 100))}%`}} /></div><strong>{percent(c[key])}</strong></div>)}</div><details className="settings-details"><summary>How this becomes a priority</summary><p>{explainVerdict(issue,c,t)}</p></details><details className="settings-details"><summary>All recorded classification fields</summary><pre className="code">{JSON.stringify(c,null,2)}</pre></details></>}</div>;
}
