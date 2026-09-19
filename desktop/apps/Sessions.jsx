"use client";
// Sessions — every visit, with JEV's read of it (intent, outcome, frustration).
// JEV reads a session once it has gone quiet (~2 min idle), so fresh rows say "waiting".
// The small helpers exported here are shared by SessionDetail / Persons / PersonDetail.
import { useState } from "react";
import { useApi, fmtDateTime, fmtDuration, fmtNum, ago, label } from "../lib/client";
import { JudgedBy } from "../components/charts";

// ---- shared helpers ---------------------------------------------------------
export const INTENT_KEYS = ["browsing", "evaluating", "purchasing", "onboarding", "using_product", "managing_account", "troubleshooting", "automated"];
export const OUTCOME_KEYS = ["succeeded", "blocked_by_error", "abandoned", "unclear"];
// Outcomes are STATUS colours: always rendered with their word.
const OUTCOME_COLOR = { succeeded: "#006300", blocked_by_error: "#d03b3b", abandoned: "#b86a00", unclear: "#808080" };
const FRUSTRATION_WORDS = ["smooth", "mild", "frustrated", "severe"];

export const shortId = (id) => {
  const s = String(id ?? "");
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s || "–";
};

// name / email when the person is identified, else a short distinct_id
export function personLabel(props, distinctId) {
  const p = props && typeof props === "object" ? props : {};
  const name = typeof p.name === "string" && p.name ? p.name : null;
  const email = typeof p.email === "string" && p.email ? p.email : null;
  if (name || email) return { main: name || email, sub: name && email ? email : null, known: true };
  return { main: distinctId ? shortId(distinctId) : "(no id)", sub: null, known: false };
}

export function PersonCell({ props, distinctId }) {
  const who = personLabel(props, distinctId);
  return (
    <span title={distinctId || ""}>
      {who.known ? who.main : <span className="mono">{who.main}</span>}
      {who.sub ? <span className="muted"> {who.sub}</span> : null}
    </span>
  );
}

export function OutcomeTag({ outcome, hint }) {
  if (!outcome) return <span className="muted">–</span>;
  const c = OUTCOME_COLOR[outcome] || "#808080";
  return <span className="vtag" style={{ color: c, borderColor: c }} title={hint || ""}>{label(outcome).toUpperCase()}</span>;
}

export const frustrationWord = (v) => (v == null ? null : FRUSTRATION_WORDS[Math.max(0, Math.min(3, Math.round(v)))]);

// Compact 0–3 meter for table cells: bar + number + the word (never colour alone).
export function FrustMeter({ value }) {
  if (value == null || !Number.isFinite(Number(value))) return <span className="muted">–</span>;
  const v = Math.max(0, Math.min(3, Number(value)));
  const color = v >= 2.1 ? "#d03b3b" : v >= 1.26 ? "#b86a00" : "#2a78d6";
  return (
    <span className="fmeter" title={`frustration ${v.toFixed(1)} of 3 — ${frustrationWord(v)}`}>
      <span className="mt sunken-thin"><i style={{ width: `${(v / 3) * 100}%`, background: color }} /></span>
      <span className="fv">{v.toFixed(1)}</span>
      <span className="muted">{frustrationWord(v)}</span>
    </span>
  );
}

// Why a session has no read yet. JEV only reads sessions with 3+ events, after they go quiet.
export function sessionReadState(s) {
  if (!s) return "waiting";
  if (s.judge_status === "judged" && (s.intent || s.outcome || s.classification)) return "judged";
  return (s.event_count || 0) < 3 ? "short" : "waiting";
}

export function Unjudged({ session }) {
  const st = sessionReadState(session);
  if (st === "short") return <span className="muted" title="JEV reads sessions that have at least 3 events">too short to read</span>;
  return <span className="vtag judging" title="JEV reads a session once it has been idle for about 2 minutes">waiting for session to go quiet…</span>;
}

export const deviceLabel = (s) => [s?.device, s?.browser, s?.os].filter(Boolean).join(" · ") || "–";

// ---- the window -------------------------------------------------------------
export default function Sessions({ wm }) {
  const [intent, setIntent] = useState("");
  const [outcome, setOutcome] = useState("");
  const [frustrated, setFrustrated] = useState(false);
  const [sort, setSort] = useState("recent");
  const [sel, setSel] = useState(null);

  const qs = new URLSearchParams();
  if (intent) qs.set("intent", intent);
  if (outcome) qs.set("outcome", outcome);
  if (frustrated) qs.set("frustrated", "1");
  if (sort === "frustration") qs.set("sort", "frustration");
  const { data, error, loading } = useApi(`sessions${qs.toString() ? `?${qs}` : ""}`, { every: 10_000, on: ["session", "event"] });
  const meta = useApi("meta");
  const tax = meta.data?.taxonomy || {};
  const intents = tax.intents ? Object.keys(tax.intents) : INTENT_KEYS;
  const outcomes = tax.outcomes ? Object.keys(tax.outcomes) : OUTCOME_KEYS;

  const rows = Array.isArray(data?.sessions) ? data.sessions : [];
  const filtered = !!(intent || outcome || frustrated);
  const judged = rows.filter((s) => sessionReadState(s) === "judged").length;
  const hot = rows.filter((s) => (s.frustration ?? 0) >= 1.5).length;
  const open = (s) => { setSel(s.id); wm?.open?.("session", { id: s.id }); };

  return (
    <>
      <div className="toolbar an-wrap">
        <span>Intent</span>
        <select className="in98" value={intent} onChange={(e) => setIntent(e.target.value)}>
          <option value="">any</option>
          {intents.map((k) => <option key={k} value={k}>{label(k)}</option>)}
        </select>
        <span>Outcome</span>
        <select className="in98" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">any</option>
          {outcomes.map((k) => <option key={k} value={k}>{label(k)}</option>)}
        </select>
        <label className="check98" title="frustration 1.5 or higher">
          <input type="checkbox" checked={frustrated} onChange={(e) => setFrustrated(e.target.checked)} /> frustrated only
        </label>
        <span className="an-sep" />
        <span>Sort</span>
        <button className={`tool-btn${sort === "recent" ? " on" : ""}`} onClick={() => setSort("recent")}>Recent</button>
        <button className={`tool-btn${sort === "frustration" ? " on" : ""}`} onClick={() => setSort("frustration")}>Most frustrated</button>
      </div>
      <div className="pane sunken an-pane">
        {error && !data ? <div className="err">could not load sessions: {error}</div> : !data ? <div className="muted pad">…</div> : (
          <table className="t98">
            <thead>
              <tr>
                <th>Started</th><th>Person</th><th className="num">Duration</th><th className="num">Pages</th><th className="num">Events</th>
                <th className="num">Errors</th><th className="num">Rage</th><th>Entry → exit</th><th>Device</th>
                <th>Intent</th><th>Outcome</th><th>Frustration</th><th>Judged by</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={13} className="wrap muted" style={{ textAlign: "center", padding: 24 }}>
                  {filtered ? "no sessions match these filters" : "no sessions yet — open the demo shop at :3000 and click around; a session shows up with its first event"}
                </td></tr>
              )}
              {rows.map((s) => {
                const read = sessionReadState(s) === "judged";
                return (
                  <tr key={s.id} className={sel === s.id ? "sel" : ""} onClick={() => open(s)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") open(s); }} style={{ cursor: "pointer" }}>
                    <td title={ago(s.started_at)}>{fmtDateTime(s.started_at)}</td>
                    <td><PersonCell props={s.person_props} distinctId={s.distinct_id} /></td>
                    <td className="num">{fmtDuration(Math.max(0, (s.last_at || 0) - (s.started_at || 0)))}</td>
                    <td className="num">{fmtNum(s.pageviews ?? 0)}</td>
                    <td className="num">{fmtNum(s.event_count ?? 0)}</td>
                    <td className="num">{s.errors > 0 ? <b className="an-bad">{fmtNum(s.errors)}</b> : <span className="muted">0</span>}</td>
                    <td className="num">{s.rage_clicks > 0 ? <b className="an-warn">{fmtNum(s.rage_clicks)}</b> : <span className="muted">0</span>}</td>
                    <td className="mono" title={`${s.entry_path || "?"} → ${s.exit_path || "?"}`}>{s.entry_path || "?"} → {s.exit_path || "?"}</td>
                    <td title={deviceLabel(s)}>{[s.device, s.browser].filter(Boolean).join(" · ") || "–"}</td>
                    {read ? (
                      <>
                        <td title={tax.intents?.[s.intent] || ""}>{s.intent ? label(s.intent) : "–"}</td>
                        <td><OutcomeTag outcome={s.outcome} hint={tax.outcomes?.[s.outcome]} /></td>
                        <td><FrustMeter value={s.frustration} /></td>
                        <td><JudgedBy by={s.judged_by} /></td>
                      </>
                    ) : (
                      <td colSpan={4}><Unjudged session={s} /></td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="statusbar">
        <div className="cell grow sunken-thin">
          {error && data ? `refresh failed: ${error}` : loading && data ? "refreshing…" : `${rows.length} session(s)${rows.length >= 150 ? " — showing the latest 150" : ""} — click a row for the timeline`}
        </div>
        <div className="cell sunken-thin">{judged} read</div>
        <div className="cell sunken-thin">{hot} frustrated</div>
      </div>
    </>
  );
}
