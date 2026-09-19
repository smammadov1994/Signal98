"use client";
// Issue (app id `issue`, params { id, tab? }) — one issue: what JEV judged, the stack, the trend,
// who was hit, and what the ghost did about it. Reloads only on stream messages about THIS issue.
import { useEffect, useRef, useState } from "react";
import { api, useApi, useStream, ago, fmtDateTime, fmtTime, fmtNum, label } from "../lib/client";
import { LineChart, BarList, Meter, VerdictTag, JudgedBy } from "../components/charts";
import { ConfirmDialog, IssueTags, patchIssue, headline, num } from "./Issues";

const TABS = [["jev", "JEV"], ["stack", "Stack"], ["trend", "Trend"], ["users", "Users"], ["ghost", "Ghost"]];
const SEVERITY_WORDS = ["noise", "minor", "moderate", "major", "critical"];
const FIX_WORDS = ["trivial", "small", "medium", "large", "not fixable in this codebase"];
const DEFAULT_T = { pageSeverity: 2.6, pageUserFacing: 0.6, pageUrgent: 0.7, notifySeverity: 1.8, noise: 0.6 };
const ACTIVE_PHASES = new Set(["thinking", "queued", "running"]);
const word = (list, v) => (typeof v === "number" ? list[Math.max(0, Math.min(list.length - 1, Math.round(v)))] : null);
const conf = (v) => (typeof v === "number" ? <span className="iw-conf"> (p={v.toFixed(2)})</span> : null);
const isHeuristic = (by) => String(by || "").startsWith("heuristic");

// Mirrors verdictOf() in lib/questions.js, in words. If thresholds changed since the issue was
// judged the recomputed verdict can differ from the stored one; then we say so instead of guessing.
export function explainVerdict(issue, c, t) {
  const who = isHeuristic(issue.judged_by) ? "The keyword heuristic" : "JEV";
  if (!c || issue.judge_status !== "judged" || !issue.verdict) return "Not judged yet — the answers and the verdict land here in a moment.";
  const n = (v) => num(v, 2);
  let verdict, why;
  if (c.is_noise >= t.noise && c.severity < 3) { verdict = "ignore"; why = `noise ${n(c.is_noise)} is at or above ${t.noise} and severity ${num(c.severity)} is below 3`; }
  else if (c.severity >= t.pageSeverity && c.is_user_facing >= t.pageUserFacing && c.is_urgent >= t.pageUrgent) { verdict = "page"; why = `severity ${num(c.severity)} ≥ ${t.pageSeverity}, user-facing ${n(c.is_user_facing)} ≥ ${t.pageUserFacing} and urgent ${n(c.is_urgent)} ≥ ${t.pageUrgent}`; }
  else if (c.security_relevant >= 0.8 && c.severity >= 2) { verdict = "page"; why = `security relevance ${n(c.security_relevant)} ≥ 0.80 with severity ${num(c.severity)} ≥ 2`; }
  else if (c.data_risk >= 0.8 && c.severity >= 2) { verdict = "page"; why = `data risk ${n(c.data_risk)} ≥ 0.80 with severity ${num(c.severity)} ≥ 2`; }
  else if (c.revenue_impact >= 0.8 && c.is_urgent >= t.pageUrgent) { verdict = "page"; why = `revenue impact ${n(c.revenue_impact)} ≥ 0.80 and urgent ${n(c.is_urgent)} ≥ ${t.pageUrgent}`; }
  else if (c.severity >= t.notifySeverity || c.is_urgent >= 0.6) { verdict = "notify"; why = c.severity >= t.notifySeverity ? `severity ${num(c.severity)} ≥ ${t.notifySeverity}, but not enough to page` : `urgent ${n(c.is_urgent)} ≥ 0.60, but not enough to page`; }
  else if (c.is_actionable >= 0.5 || c.severity >= 1) { verdict = "ticket"; why = c.is_actionable >= 0.5 ? `a developer can fix it (actionable ${n(c.is_actionable)} ≥ 0.50) and nothing is urgent` : `severity ${num(c.severity)} ≥ 1 and nothing is urgent`; }
  else { verdict = "ignore"; why = "nothing crossed a threshold: low severity, not urgent, not actionable"; }
  if (verdict !== issue.verdict) return `${who} answered the questions below; the code turned them into ${issue.verdict.toUpperCase()} with the thresholds in force at the time (they have changed since — Re-judge to apply the current ones).`;
  return `${who} answered the questions below; the code turned them into ${verdict.toUpperCase()} because ${why}.`;
}

// ---------------------------------------------------------------- tabs
function JevTab({ d, meta, wm, onMerge }) {
  const { issue } = d;
  const c = issue.classification || null;
  const t = { ...DEFAULT_T, ...(meta?.project?.settings?.thresholds || {}) };
  const ghost = (meta?.ghosts || []).find((g) => g.id === c?.responder);
  const similar = d.similar;
  return (
    <div className="grow scroll">
      <div className="iw-sentence">{explainVerdict(issue, c, t)} <JudgedBy by={issue.judged_by} /></div>
      {similar ? (
        <div className="iw-sentence">
          JEV thinks this has the same root cause as <b>#{similar.id}</b> {headline(similar)} (p={num(issue.similar_p, 2)}).{" "}
          <button className="btn98 small" onClick={() => wm?.open?.("issue", { id: similar.id })}>Open</button>{" "}
          <button className="btn98 small" disabled={!!issue.merged_into} onClick={() => onMerge(similar)}>Merge into #{similar.id}</button>
        </div>
      ) : null}
      {(d.merged || []).length ? (
        <div className="iw-sentence">Merged into this issue: {d.merged.map((m) => <span key={m.id}> #{m.id} {headline(m)} ({fmtNum(m.count)} events);</span>)}</div>
      ) : null}
      <div className="grid2">
        <div className="group98"><span className="gl">Scores</span>
          <Meter label="severity" value={c?.severity} max={4} digits={1} hint={`0 noise … 4 critical${word(SEVERITY_WORDS, c?.severity) ? ` — ${word(SEVERITY_WORDS, c.severity)}` : ""}`} />
          <Meter label="fix complexity" value={c?.fix_complexity} max={4} digits={1} hot={2} hint={`0 trivial … 4 not fixable here${word(FIX_WORDS, c?.fix_complexity) ? ` — ${word(FIX_WORDS, c.fix_complexity)}` : ""}`} />
          <Meter label="urgent" value={c?.is_urgent} hint="needs a human right now rather than during working hours" />
          <Meter label="user-facing" value={c?.is_user_facing} hint="end users directly experience it" />
          <Meter label="revenue impact" value={c?.revenue_impact} hint="stops money changing hands or customers getting what they paid for" />
          <Meter label="data risk" value={c?.data_risk} hint="risks losing, corrupting or leaking data" />
          <Meter label="security" value={c?.security_relevant} hint="a sign of an attack, abuse or a security weakness" />
          <Meter label="actionable" value={c?.is_actionable} hot={2} hint="a defect in the application's own code that a developer could fix" />
          <Meter label="noise" value={c?.is_noise} hot={2} hint="nobody should spend time on it (extension, bot, cancelled request…)" />
        </div>
        <div className="group98"><span className="gl">Judgment</span>
          <dl className="iw-kv">
            <dt>category</dt><dd>{c?.category ? <>{label(c.category)}{conf(c.category_conf)}</> : "…"}</dd>
            <dt>likely cause</dt><dd>{c?.cause ? <>{label(c.cause)}{conf(c.cause_conf)}</> : "…"}</dd>
            <dt>severity</dt><dd>{c ? <>{num(c.severity)}/4 {word(SEVERITY_WORDS, c.severity)}{conf(c.severity_conf)}</> : "…"}</dd>
            <dt>fix size</dt><dd>{c ? <>{num(c.fix_complexity)}/4 {word(FIX_WORDS, c.fix_complexity)}</> : "…"}</dd>
            <dt>responder</dt><dd>{c?.responder ? <>{ghost ? <><i className="iw-swatch" style={{ background: ghost.color }} />{ghost.name} </> : null}<span className="muted">{c.responder}</span>{conf(c.responder_conf)}</> : "…"}</dd>
            <dt>judged by</dt><dd><JudgedBy by={issue.judged_by} />{!issue.judged_by ? "…" : null}</dd>
            <dt>latency</dt><dd>{typeof c?.latencyMs === "number" ? `${Math.round(c.latencyMs)} ms` : isHeuristic(issue.judged_by) ? "– (local heuristic, no JEV request)" : "–"}</dd>
            <dt>judged</dt><dd>{issue.judged_at ? `${ago(issue.judged_at)}, at ${fmtNum(issue.judged_count)} event(s)` : "not yet"}</dd>
            <dt>priority</dt><dd>{issue.priority == null ? "–" : `${Math.round(issue.priority)} / 100`}</dd>
          </dl>
          {ghost?.specialty ? <div className="muted" style={{ padding: "0 8px" }}>{ghost.name}: {ghost.specialty}</div> : null}
        </div>
      </div>
    </div>
  );
}

const inApp = (f) => !/node_modules|^node:|webpack|next\/dist|<anonymous>/.test(String(f?.file || ""));

function crumbOffset(step, ts) {
  const raw = step?.$timestamp;
  const t = typeof raw === "number" ? raw : Date.parse(raw);
  if (!Number.isFinite(t) || !ts) return "";
  const s = (t - ts) / 1000;
  return Math.abs(s) < 0.05 ? "0s" : `${s > 0 ? "+" : "−"}${Math.abs(s) < 60 ? `${Math.abs(s).toFixed(1)}s` : Math.abs(s) < 3600 ? `${Math.round(Math.abs(s) / 60)}m` : `${Math.round(Math.abs(s) / 3600)}h`}`;
}

function KindProps({ kind, p }) {
  const rows = kind === "network" ? [["method", p.$method], ["url", p.$url], ["status", p.$status === 0 ? "0 (network failure)" : p.$status], ["duration", p.$duration_ms != null ? `${p.$duration_ms} ms` : null], ["slow", p.$slow ? "yes" : null]]
    : kind === "log" ? [["level", p.$level], ["message", p.$message], ["logger", p.logger], ...Object.entries(p).filter(([k]) => !k.startsWith("$") && k !== "logger").slice(0, 12).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])]
    : [["element", p.$el_tag], ["text", p.$el_text], ["selector", p.$el_selector], ["href", p.$el_href], ["clicks", p.$click_count]];
  return (
    <dl className="iw-kv mono selectable">
      {rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => [<dt key={`${k}-k`}>{k}</dt>, <dd key={`${k}-v`}>{String(v)}</dd>])}
    </dl>
  );
}

function StackTab({ d, wm }) {
  const events = d.events || [];
  const [at, setAt] = useState(0);
  const [frameSel, setFrameSel] = useState(null);
  const ev = events[Math.min(at, events.length - 1)];
  if (!ev) return <div className="iw-empty">No stored occurrence of this issue (events past the retention window are pruned).</div>;
  const p = ev.props || {};
  const ex = p.$exception_list?.[0];
  const frames = ex?.stacktrace?.frames || [];
  const steps = Array.isArray(p.$exception_steps) ? p.$exception_steps : [];
  const kind = d.issue.kind;
  return (
    <div className="grow scroll">
      <div className="row pad" style={{ paddingBottom: 2 }}>
        <span className="muted">occurrence</span>
        <select className="in98" value={Math.min(at, events.length - 1)} onChange={(e) => { setAt(Number(e.target.value)); setFrameSel(null); }}>
          {events.map((e, i) => <option key={e.id} value={i}>{fmtDateTime(e.ts)} · {e.distinct_id || "anonymous"}</option>)}
        </select>
        {ev.session_id ? <button className="iw-link" onClick={() => wm?.open?.("session", { id: ev.session_id })}>open session</button> : null}
        {ev.distinct_id ? <button className="iw-link" onClick={() => wm?.open?.("person", { id: ev.distinct_id })}>open person</button> : null}
      </div>
      {kind === "error" || ex ? (
        <>
          <div className="pad selectable" style={{ paddingBottom: 2 }}>
            <b>{ex?.type || d.issue.type || "Error"}</b>: <span className="mono">{ex?.value || d.issue.title}</span>{" "}
            {ex?.mechanism ? <span className={`tag${ex.mechanism.handled === false ? " regressed" : ""}`}>{ex.mechanism.handled === false ? "unhandled" : "handled"}{ex.mechanism.type ? ` · ${ex.mechanism.type}` : ""}</span> : null}
          </div>
          <div className="iw-frames sunken-thin">
            {frames.length ? frames.map((f, i) => (
              <div key={i} className={`iw-frame${inApp(f) ? "" : " vendor"}${frameSel === i ? " on" : ""}`} onClick={() => setFrameSel(i)}>
                <span className="fn">at {f.function || "<anonymous>"}</span>
                <span className="loc">{f.file || "?"}{f.line != null ? `:${f.line}` : ""}{f.column != null ? `:${f.column}` : ""}</span>
              </div>
            )) : <div className="muted pad">no stack frames were captured for this occurrence</div>}
          </div>
        </>
      ) : <KindProps kind={kind} p={p} />}
      <div className="group98"><span className="gl">Breadcrumbs — what happened before</span>
        {steps.length ? (
          <div className="iw-crumbs">
            {steps.map((s, i) => (
              <div key={i} className="iw-crumb">
                <span className="when">{crumbOffset(s, ev.ts)}</span><span className="tag">{s.$category || "custom"}</span><span className="what">{String(s.$message ?? "")}</span>
              </div>
            ))}
            <div className="iw-crumb last"><span className="when">{fmtTime(ev.ts)}</span><span className="tag regressed">{label(kind)}</span><span className="what"><b>{ev.message}</b></span></div>
          </div>
        ) : <div className="muted">no breadcrumbs on this occurrence{kind === "error" ? "" : " (the SDK attaches them to exceptions only)"}</div>}
      </div>
      <div className="group98"><span className="gl">Context</span>
        <dl className="iw-kv selectable">
          {[["url", ev.url], ["page", ev.pathname], ["service", ev.service], ["environment", ev.environment], ["release", ev.release], ["client", [ev.browser, ev.os, ev.device].filter(Boolean).join(" / ")],
            ["sdk", p.$lib ? `${p.$lib} ${p.$lib_version || ""}` : null], ["session", ev.session_id], ["person", ev.distinct_id], ["event id", ev.uuid]]
            .filter(([, v]) => v).map(([k, v]) => [<dt key={`${k}-k`}>{k}</dt>, <dd key={`${k}-v`}>{v}</dd>])}
        </dl>
      </div>
    </div>
  );
}

function TrendTab({ d }) {
  const points = (d.series || []).map((p) => ({ t: p.t, v: p.n || 0 }));
  const b = d.breakdowns || {};
  return (
    <div className="grow scroll">
      <div className="panel sunken-thin"><h4>Events, last 24 h (hourly)</h4><LineChart series={[{ name: "events", points }]} height={150} area /></div>
      <div className="grid3">
        {[["Browser", b.browser], ["OS", b.os], ["Page", b.pathname], ["Release", b.release], ["Environment", b.environment]].map(([name, rows]) => (
          <div key={name} className="panel sunken-thin"><h4>{name}</h4><BarList rows={rows || []} empty="not recorded" /></div>
        ))}
      </div>
    </div>
  );
}

function UsersTab({ d, wm }) {
  const affected = d.affected || [], events = d.events || [];
  return (
    <div className="grow scroll">
      <div className="panel sunken-thin"><h4>Affected people — top {affected.length} of {fmtNum(d.users)}</h4>
        {affected.length ? (
          <table className="t98 iw-table"><thead><tr><th>Person</th><th>Id</th><th className="num">Events</th><th>Last hit</th></tr></thead>
            <tbody>{affected.map((a) => (
              <tr key={a.distinct_id} onDoubleClick={() => wm?.open?.("person", { id: a.distinct_id })}>
                <td><button className="iw-link" onClick={() => wm?.open?.("person", { id: a.distinct_id })}>{a.props?.name || a.props?.email || a.distinct_id}</button>{a.is_identified ? null : <span className="muted"> anonymous</span>}</td>
                <td className="mono selectable">{a.distinct_id}</td><td className="num">{fmtNum(a.n)}</td><td>{a.last_ts ? ago(a.last_ts) : "–"}</td>
              </tr>
            ))}</tbody></table>
        ) : <div className="muted pad">no identified or anonymous ids on these events</div>}
      </div>
      <div className="panel sunken-thin"><h4>Recent events ({events.length})</h4>
        {events.length ? (
          <table className="t98 iw-table"><thead><tr><th>When</th><th>Message</th><th>Person</th><th>Page</th><th>Session</th></tr></thead>
            <tbody>{events.map((e) => (
              <tr key={e.id}>
                <td>{fmtDateTime(e.ts)}</td><td className="iw-fill mono" title={e.message || ""}>{e.message}</td>
                <td>{e.distinct_id ? <button className="iw-link" onClick={() => wm?.open?.("person", { id: e.distinct_id })}>{e.distinct_id}</button> : "–"}</td>
                <td>{e.pathname || "–"}</td>
                <td>{e.session_id ? <button className="iw-link" onClick={() => wm?.open?.("session", { id: e.session_id })}>open</button> : "–"}</td>
              </tr>
            ))}</tbody></table>
        ) : <div className="muted pad">no stored events</div>}
      </div>
    </div>
  );
}

function GhostTab({ d, wm, lines }) {
  const fixes = d.fixes || [], runs = d.runs || [], notes = d.notifications || [];
  return (
    <div className="grow scroll">
      {lines.length ? <div className="iw-ghostlog sunken-thin">{lines.map((l, i) => <div key={i}><span className="ph">[{fmtTime(l.at)} {l.phase}]</span> {l.line}</div>)}</div> : null}
      <div className="panel sunken-thin"><h4>Fix reports ({fixes.length})</h4>
        {fixes.length ? fixes.map((f) => {
          const r = f.report || {};
          return (
            <div key={f.id} className="iw-fix" style={{ borderBottom: "1px solid #c0c0c0" }}>
              <div className="row" style={{ flexWrap: "wrap" }}>
                {f.ghost ? <b><i className="iw-swatch" style={{ background: f.ghost.color }} />{f.ghost.name}</b> : <b>ghost</b>}
                <span className="tag" title="which generative provider wrote this">{f.provider || "unknown provider"}</span>
                {f.provider === "template" ? <span className="muted">no generative model — a template plan from the classification</span> : null}
                {typeof r.confidence === "number" ? <span className="muted">confidence {r.confidence.toFixed(2)}</span> : null}
                <span className="muted">{f.created_at ? ago(f.created_at) : ""}</span>
              </div>
              <p><b>{f.summary}</b></p>
              {r.diagnosis ? <p>{r.diagnosis}</p> : null}
              {r.root_cause_file ? <p className="mono">root cause: {r.root_cause_file}</p> : null}
              {Array.isArray(r.steps) && r.steps.length ? <ol className="selectable">{r.steps.map((s, i) => <li key={i}>{String(s)}</li>)}</ol> : null}
              {r.patch ? <pre className="code sunken-thin">{String(r.patch)}</pre> : null}
              {r.provider_error ? <div className="err">provider error (fell back to {f.provider}): {r.provider_error}</div> : null}
            </div>
          );
        }) : <div className="muted pad">No fix report yet — “Ask the ghost for a fix” above writes one (it never edits code).</div>}
      </div>
      <div className="panel sunken-thin"><h4>Agent runs ({runs.length})</h4>
        {runs.length ? (
          <table className="t98 iw-table"><thead><tr><th>Run</th><th>Status</th><th className="num">Attempt</th><th>Trigger</th><th>Started</th><th>Summary</th><th /></tr></thead>
            <tbody>{runs.map((r) => (
              <tr key={r.id} onDoubleClick={() => wm?.open?.("run", { id: r.id })}>
                <td>#{r.id}</td><td><span className={`tag${r.status === "failed" ? " regressed" : ""}`}>{label(r.status)}</span></td><td className="num">{r.attempt ?? "–"}</td>
                <td>{r.trigger || "–"}</td><td>{r.created_at ? ago(r.created_at) : "–"}</td><td className="wrap">{r.summary || <span className="muted">…</span>}</td>
                <td><button className="btn98 small" onClick={() => wm?.open?.("run", { id: r.id })}>Open</button></td>
              </tr>
            ))}</tbody></table>
        ) : <div className="muted pad">No agent has been sent to this issue.</div>}
      </div>
      <div className="panel sunken-thin"><h4>Notifications sent ({notes.length})</h4>
        {notes.length ? (
          <table className="t98 iw-table"><thead><tr><th>When</th><th>Channel</th><th>Target</th><th>Status</th><th>Subject</th></tr></thead>
            <tbody>{notes.map((n) => (
              <tr key={n.id} title={n.error || ""}>
                <td>{n.created_at ? ago(n.created_at) : "–"}</td><td>{n.channel_type}</td><td>{n.target || "–"}</td>
                <td><span className={`tag${n.status === "failed" ? " regressed" : ""}`}>{label(n.status)}</span></td>
                <td className="wrap">{n.subject}{n.error ? <span className="muted"> — {n.error}</span> : null}</td>
              </tr>
            ))}</tbody></table>
        ) : <div className="muted pad">Nobody was notified about this issue.</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the window
export default function IssueDetail({ wm, params, nonce }) {
  const id = params?.id != null && params.id !== "" ? Number(params.id) : null;
  const { data, error, loading, reload } = useApi(id != null ? `issues/${id}` : null);
  const meta = useApi("meta");
  const [tab, setTab] = useState(() => (TABS.some(([k]) => k === params?.tab) ? params.tab : "jev"));
  const [busy, setBusy] = useState(null);     // "status" | "rejudge" | "fix" | "agent" | "merge"
  const [note, setNote] = useState(null);      // { text, bad?, runId? }
  const [lines, setLines] = useState([]);      // ghost progress for this issue
  const [mergeTarget, setMergeTarget] = useState(null);
  const issue = data?.issue || null;

  // honour params.tab on mount and whenever the window is re-opened with new params
  useEffect(() => { if (TABS.some(([k]) => k === params?.tab)) setTab(params.tab); }, [params?.tab, nonce]);

  const wmRef = useRef(wm); wmRef.current = wm;
  const titleText = issue ? `#${issue.id} ${headline(issue)}` : null;
  useEffect(() => { if (titleText) wmRef.current?.setTitle?.(`Issue ${titleText.slice(0, 90)}`); }, [titleText]);

  // Reload only for messages about this issue (useApi itself already reloads on `reset`).
  const timer = useRef(null);
  useStream((msg) => {
    const m = msg.data || {};
    const mine = msg.type === "event" ? m.event?.issue_id === id : msg.type === "verdict" ? m.issue?.id === id : msg.type === "issue" || msg.type === "agent" ? m.issue_id === id : false;
    if (!mine || id == null) return;
    if (msg.type === "agent" && m.line) setLines((ls) => [...ls.slice(-39), { at: Date.now(), phase: m.phase || "", line: String(m.line), runId: m.run_id }]);
    clearTimeout(timer.current);
    timer.current = setTimeout(reload, msg.type === "event" ? 1200 : 300);
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (id == null) return; const t = setInterval(reload, 30000); return () => clearInterval(t); }, [id, reload]);

  const run = async (kind, fn, okText) => {
    if (busy) return;
    setBusy(kind); setNote(null);
    try { const out = await fn(); setNote(typeof okText === "function" ? okText(out) : { text: okText }); reload(); }
    catch (err) { setNote({ text: `${kind} failed: ${err.message}`, bad: true }); }
    finally { setBusy(null); }
  };
  const setStatus = (status, text) => run("status", () => patchIssue(id, { status }), text);
  const rejudge = () => run("rejudge", () => api(`issues/${id}/rejudge`, { method: "POST" }), "queued for re-judging — the verdict lands in a moment");
  const askFix = () => run("fix", () => api(`issues/${id}/fix`, { method: "POST" }), () => { setTab("ghost"); return { text: "the ghost wrote a fix report — see the Ghost tab" }; });
  const sendAgent = () => run("agent", () => api(`issues/${id}/agent`, { method: "POST" }), (out) => {
    const r = out?.run;
    if (!r) return { text: "the agent did not start", bad: true };
    return r.status === "skipped" ? { text: `agent not started: ${r.summary || "skipped"}`, bad: true } : { text: `agent run #${r.id} ${label(r.status)} (attempt ${r.attempt ?? 1})`, runId: r.id };
  });
  const doMerge = () => run("merge", () => patchIssue(id, { merge_into: mergeTarget.id }), () => {
    const target = mergeTarget.id; setMergeTarget(null); wmRef.current?.open?.("issue", { id: target });
    return { text: `merged into #${target}` };
  }).finally(() => setMergeTarget(null));

  if (id == null) return <div className="iw-empty">No issue selected — open one from Issues or the Live Feed.</div>;
  if (!data) {
    return error
      ? <div className="iw-root"><div className="err">Cannot load issue #{id}: {error}.{/no such issue/.test(error) ? " It may have been deleted when the feed was cleared." : " Retrying…"}</div>
          <div className="pad"><button className="btn98 small" onClick={reload}>Retry</button> <button className="btn98 small" onClick={() => wm?.close?.()}>Close</button></div></div>
      : <div className="iw-empty">{loading ? "…" : "nothing to show"}</div>;
  }

  const last = lines[lines.length - 1];
  const ghostLive = busy === "fix" || (last && ACTIVE_PHASES.has(last.phase) && Date.now() - last.at < 600_000);
  return (
    <div className="iw-root" data-s98-issue={id}>
      <div className="iw-head">
        <h3 className="selectable">{issue.type ? `${issue.type}: ` : ""}{issue.title || "(no message)"}</h3>
        {issue.culprit ? <div className="mono muted selectable">{issue.culprit}</div> : null}
        <div className="chips">
          <span className={`tag${issue.status === "open" ? "" : " new"}`}>{label(issue.status)}</span>
          <VerdictTag issue={issue} /><JudgedBy by={issue.judged_by} />
          <span>priority <b>{issue.priority == null ? "–" : Math.round(issue.priority)}</b></span>
          <span className="muted">{label(issue.kind)}{issue.level ? ` · ${issue.level}` : ""}{issue.service ? ` · ${issue.service}` : ""}</span>
          <IssueTags issue={issue} />
          {issue.merged_into ? <span className="tag regressed">merged into <button className="iw-link" onClick={() => wm?.open?.("issue", { id: issue.merged_into })}>#{issue.merged_into}</button></span> : null}
        </div>
        <div className="chips muted">
          <span>first seen {issue.first_seen ? `${fmtDateTime(issue.first_seen)} (${ago(issue.first_seen)})` : "–"}</span>
          <span>last seen {issue.last_seen ? ago(issue.last_seen) : "–"}</span>
          <span><b style={{ color: "#000" }}>{fmtNum(issue.count)}</b> events · <b style={{ color: "#000" }}>{fmtNum(data.users)}</b> users · <b style={{ color: "#000" }}>{fmtNum(data.sessions)}</b> sessions</span>
        </div>
        <div className="actions">
          {issue.status !== "resolved" ? <button className="btn98 small" disabled={!!busy} onClick={() => setStatus("resolved", "resolved — if it fires again it regresses and is re-judged")}>Resolve</button> : null}
          {issue.status !== "ignored" ? <button className="btn98 small" disabled={!!busy} onClick={() => setStatus("ignored", "ignored — moved to the Recycle Bin")}>Ignore</button> : null}
          {issue.status !== "open" ? <button className="btn98 small" disabled={!!busy} onClick={() => setStatus("open", "reopened")}>Reopen</button> : null}
          <button className="btn98 small" disabled={!!busy} onClick={rejudge}>Re-judge</button>
          <span className="iw-sep" />
          <button className="btn98 small" disabled={!!busy} onClick={askFix} title="read-only: writes a diagnosis and a suggested patch; can take a few minutes">{busy === "fix" ? "The ghost is thinking…" : "Ask the ghost for a fix"}</button>
          <button className="btn98 small" disabled={!!busy} onClick={sendAgent} title="a coding agent fixes it on its own branch in a git worktree; nothing is applied until you say so">{busy === "agent" ? "Summoning…" : "Send agent to fix it"}</button>
          {note ? <span style={note.bad ? { color: "#a00000" } : undefined}>{note.text} {note.runId ? <button className="iw-link" onClick={() => wm?.open?.("run", { id: note.runId })}>open run #{note.runId}</button> : null}</span> : null}
        </div>
      </div>
      <div className={`iw-ghostline sunken-thin${ghostLive ? " live" : ""}`} title="ghost progress for this issue">
        {last ? `${ghostLive ? "▶" : "■"} [${last.phase}] ${last.line}` : busy === "fix" ? "▶ waking the ghost…" : "ghost: idle"}
      </div>

      <div className="tabs">{TABS.map(([k, name]) => <div key={k} className={`tab${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>{name}</div>)}</div>
      <div className="tab-body">
        {tab === "jev" ? <JevTab d={data} meta={meta.data} wm={wm} onMerge={setMergeTarget} />
          : tab === "stack" ? <StackTab d={data} wm={wm} />
          : tab === "trend" ? <TrendTab d={data} />
          : tab === "users" ? <UsersTab d={data} wm={wm} />
          : <GhostTab d={data} wm={wm} lines={lines} />}
      </div>

      <div className="statusbar">
        <div className="cell sunken-thin">issue #{issue.id}</div>
        <div className="cell grow sunken-thin" style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
          {error ? <span style={{ color: "#a00000" }}>API unreachable, showing last known state — {error}</span> : "live — updates when this issue fires, is judged, or the ghost moves"}
        </div>
        <div className="cell sunken-thin">{issue.assignee ? `assigned to ${issue.assignee}` : "unassigned"}</div>
      </div>

      {mergeTarget ? (
        <ConfirmDialog title="Merge issues" yes="Merge" no="Cancel" danger busy={busy === "merge"} onYes={doMerge} onNo={() => setMergeTarget(null)}>
          Merge <b>#{issue.id}</b> into <b>#{mergeTarget.id}</b> {headline(mergeTarget)}?<br /><br />
          Its {fmtNum(issue.count)} event(s) move to #{mergeTarget.id} and future occurrences are counted there. This cannot be undone from the UI.
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
