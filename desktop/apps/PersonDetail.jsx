"use client";
// One person: who they are (properties), every session with JEV's read, the issues they
// personally hit, and their most recent events.
import { useEffect } from "react";
import { useApi, fmtDateTime, fmtDuration, fmtNum, fmtTime, ago, label } from "../lib/client";
import { StatTile, VerdictTag, JudgedBy } from "../components/charts";
import { OutcomeTag, FrustMeter, Unjudged, personLabel, sessionReadState, deviceLabel } from "./Sessions";

const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const showVal = (v) => (v == null ? "–" : typeof v === "object" ? JSON.stringify(v) : String(v));
const EVENT_NAMES = { $pageview: "pageview", $pageleave: "page leave", $autocapture: "click", $rageclick: "rage click", $dead_click: "dead click", $exception: "exception", $network_error: "network error", $web_vitals: "web vitals", $identify: "identify", $log: "log", $feature_flag_called: "feature flag" };

export default function PersonDetail({ wm, params }) {
  const id = params?.id;
  const { data, error, loading } = useApi(id != null ? `persons/${encodeURIComponent(id)}` : null, { every: 15_000, on: ["session"] });
  const person = data?.person || null;
  const who = personLabel(person?.props, person?.distinct_id ?? id);
  const title = person ? `Person — ${who.main}` : null;
  useEffect(() => { if (title) wm?.setTitle?.(title); }, [title]); // eslint-disable-line react-hooks/exhaustive-deps

  if (id == null) return <div className="err">no person id given</div>;
  if (error && !data) return <div className="err">could not load person {String(id)}: {error}</div>;
  if (!data || !person) return <div className="muted pad">…</div>;

  const props = Object.entries(person.props && typeof person.props === "object" ? person.props : {});
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const issues = Array.isArray(data.issues) ? data.issues : [];
  const events = Array.isArray(data.events) ? data.events : [];
  // The issues list carries the verdict but not who judged it; the events list does.
  const judgedBy = new Map();
  for (const e of events) if (e.issue?.id != null && e.issue.judged_by) judgedBy.set(e.issue.id, e.issue);
  const openIssue = (iid) => wm?.open?.("issue", { id: iid });
  const openSession = (sid) => wm?.open?.("session", { id: sid });

  return (
    <>
      <div className="grow scroll">
        <div className="row" style={{ padding: "6px 8px 0", flexWrap: "wrap" }}>
          <b style={{ fontSize: 13 }}>{who.known ? who.main : "Anonymous visitor"}</b>
          {who.sub ? <span className="muted selectable">{who.sub}</span> : null}
          <span className="tag">{person.is_identified ? "identified" : "anonymous"}</span>
          <span className="muted">id</span><span className="mono selectable">{person.distinct_id}</span>
        </div>
        <div className="stats">
          <StatTile label="events" value={fmtNum(person.event_count ?? 0)} />
          <StatTile label="sessions" value={fmtNum(sessions.length)} sub={sessions.length >= 20 ? "latest 20" : undefined} />
          <StatTile label="issues hit" value={fmtNum(issues.length)} />
          <StatTile label="first seen" value={person.first_seen ? ago(person.first_seen) : "–"} sub={person.first_seen ? fmtDateTime(person.first_seen) : undefined} />
          <StatTile label="last seen" value={person.last_seen ? ago(person.last_seen) : "–"} sub={person.last_seen ? fmtDateTime(person.last_seen) : undefined} />
        </div>

        <div className="panel sunken-thin">
          <h4>Properties</h4>
          {props.length === 0 ? (
            <div className="muted pad">no properties — the host app sets them with <span className="mono">signal98.identify(id, {"{ email, name, plan }"})</span></div>
          ) : (
            <table className="t98 selectable">
              <tbody>{props.map(([k, v]) => <tr key={k}><td style={{ width: 160 }} className="muted">{k}</td><td className="wrap">{clip(showVal(v), 400)}</td></tr>)}</tbody>
            </table>
          )}
        </div>

        <div className="panel sunken-thin">
          <h4>Sessions, as read by JEV</h4>
          {sessions.length === 0 ? <div className="muted pad">no sessions recorded for this person (server-side events carry no session)</div> : (
            <div className="scroll">
              <table className="t98">
                <thead><tr><th>Started</th><th className="num">Duration</th><th className="num">Pages</th><th className="num">Errors</th><th>Entry → exit</th><th>Device</th><th>Intent</th><th>Outcome</th><th>Frustration</th><th>Judged by</th></tr></thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id} onClick={() => openSession(s.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") openSession(s.id); }} style={{ cursor: "pointer" }}>
                      <td title={ago(s.started_at)}>{fmtDateTime(s.started_at)}</td>
                      <td className="num">{fmtDuration(Math.max(0, (s.last_at || 0) - (s.started_at || 0)))}</td>
                      <td className="num">{fmtNum(s.pageviews ?? 0)}</td>
                      <td className="num">{s.errors > 0 ? <b className="an-bad">{fmtNum(s.errors)}</b> : <span className="muted">0</span>}</td>
                      <td className="mono">{s.entry_path || "?"} → {s.exit_path || "?"}</td>
                      <td>{deviceLabel(s)}</td>
                      {sessionReadState(s) === "judged" ? (
                        <>
                          <td>{s.intent ? label(s.intent) : "–"}</td>
                          <td><OutcomeTag outcome={s.outcome} /></td>
                          <td><FrustMeter value={s.frustration} /></td>
                          <td><JudgedBy by={s.judged_by} /></td>
                        </>
                      ) : <td colSpan={4}><Unjudged session={s} /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel sunken-thin">
          <h4>Issues this person hit</h4>
          {issues.length === 0 ? <div className="muted pad">none — this person has not run into an error, failed request, rage click or dead click</div> : (
            <table className="t98">
              <thead><tr><th>Verdict</th><th>Issue</th><th className="num">Times hit</th><th>Status</th><th>Judged by</th></tr></thead>
              <tbody>
                {issues.map((i) => {
                  const j = judgedBy.get(i.id);
                  return (
                    <tr key={i.id} onClick={() => openIssue(i.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") openIssue(i.id); }} style={{ cursor: "pointer" }}>
                      <td><VerdictTag issue={{ ...i, judge_status: j?.judge_status }} /></td>
                      <td title={i.title || ""}><b>{i.type || "Error"}</b> <span className="muted">#{i.id}</span> {clip(i.title, 120)}</td>
                      <td className="num">{fmtNum(i.n ?? 0)}</td>
                      <td>{i.status || "–"}</td>
                      <td>{j?.judged_by ? <JudgedBy by={j.judged_by} /> : <span className="muted" title="open the issue to see who judged it">see issue</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel sunken-thin">
          <h4>Recent events</h4>
          {events.length === 0 ? <div className="muted pad">no events stored for this person</div> : (
            <table className="t98">
              <thead><tr><th>When</th><th>Event</th><th>Detail</th><th>Page</th><th>Session</th></tr></thead>
              <tbody>
                {events.map((e) => {
                  const bad = e.issue_id != null;
                  const custom = !String(e.event || "").startsWith("$");
                  return (
                    <tr key={e.id}>
                      <td title={fmtDateTime(e.ts)}>{Date.now() - e.ts < 86_400_000 ? fmtTime(e.ts) : fmtDateTime(e.ts)}</td>
                      <td>{custom ? <b>{e.event}</b> : EVENT_NAMES[e.event] || e.event}</td>
                      <td className="selectable" title={e.message || ""}>
                        {bad ? <span className="an-lnk" role="link" tabIndex={0} onClick={() => openIssue(e.issue_id)} onKeyDown={(ev) => { if (ev.key === "Enter") openIssue(e.issue_id); }}>{clip(e.message, 110)}</span>
                          : e.message && e.message !== e.event ? clip(e.message, 110) : <span className="muted">–</span>}
                      </td>
                      <td className="mono">{e.pathname || <span className="muted">–</span>}</td>
                      <td>{e.session_id ? <span className="an-lnk" role="link" tabIndex={0} onClick={() => openSession(e.session_id)} onKeyDown={(ev) => { if (ev.key === "Enter") openSession(e.session_id); }}>open</span> : <span className="muted">–</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div className="statusbar">
        <div className="cell grow sunken-thin">{error ? `refresh failed: ${error}` : loading ? "refreshing…" : `${fmtNum(events.length)} most recent event(s) shown`}</div>
        <div className="cell sunken-thin">{fmtNum(sessions.length)} session(s)</div>
        <div className="cell sunken-thin">{fmtNum(issues.length)} issue(s)</div>
      </div>
    </>
  );
}
