"use client";
// One session: JEV's read of it on top, then "session replay lite" — a timeline of every
// event, nested under the pageview it happened on so the visit can be scanned in seconds.
import { useEffect, useMemo, useState } from "react";
import { useApi, fmtDateTime, fmtDuration, fmtNum, fmtTime, ago, label } from "../lib/client";
import { Meter, JudgedBy } from "../components/charts";
import { OutcomeTag, PersonCell, personLabel, sessionReadState, frustrationWord, deviceLabel, shortId } from "./Sessions";

const BAD = "#d03b3b", WARN = "#b86a00", GOOD = "#006300";
const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const RATING = { good: { c: GOOD, w: "good" }, "needs-improvement": { c: WARN, w: "needs improvement" }, poor: { c: BAD, w: "poor" } };
const fmtVital = (m, v) => (typeof v !== "number" ? "–" : m === "CLS" ? v.toFixed(2) : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);

// 12px pixel-ish glyph per event kind (no emoji, no icon font)
function Glyph({ kind }) {
  const s = { width: 12, height: 12, viewBox: "0 0 12 12", shapeRendering: "crispEdges", style: { display: "block" } };
  switch (kind) {
    case "page": return <svg {...s}><path d="M2 1h5l3 3v7H2z" fill="#fff" stroke="#000" /><path d="M7 1v3h3" fill="none" stroke="#000" /><path d="M4 6h4M4 8h4" stroke="#2a78d6" /></svg>;
    case "click": return <svg {...s}><path d="M3 1v9l2-2 2 3 1-1-2-3h3z" fill="#fff" stroke="#000" strokeWidth=".9" shapeRendering="geometricPrecision" /></svg>;
    case "rage": return <svg {...s}><rect x="1" y="1" width="10" height="10" fill={BAD} /><path d="M4 3v4M4 8.5v1M8 3v4M8 8.5v1" stroke="#fff" strokeWidth="1.6" /></svg>;
    case "dead": return <svg {...s}><rect x="1" y="1" width="10" height="10" fill="#fff" stroke={WARN} /><path d="M4 4l4 4M8 4l-4 4" stroke={WARN} strokeWidth="1.4" shapeRendering="geometricPrecision" /></svg>;
    case "error": return <svg {...s} shapeRendering="geometricPrecision"><circle cx="6" cy="6" r="5.5" fill={BAD} /><path d="M4 4l4 4M8 4l-4 4" stroke="#fff" strokeWidth="1.6" /></svg>;
    case "net": return <svg {...s} shapeRendering="geometricPrecision"><path d="M6 1l5.5 10h-11z" fill="#ffd84a" stroke="#000" strokeWidth=".8" /><path d="M6 4.5v3.2M6 8.8v1" stroke="#000" strokeWidth="1.3" /></svg>;
    case "custom": return <svg {...s} shapeRendering="geometricPrecision"><path d="M6 .8l5.2 5.2L6 11.2.8 6z" fill="#2a78d6" stroke="#0d366b" strokeWidth=".8" /></svg>;
    case "person": return <svg {...s}><rect x="4" y="1" width="4" height="4" fill="#000080" /><path d="M2 11V8l2-2h4l2 2v3z" fill="#000080" /></svg>;
    case "vitals": return <svg {...s}><path d="M1 11h10" stroke="#000" /><rect x="2" y="7" width="2" height="4" fill="#2a78d6" /><rect x="5" y="4" width="2" height="7" fill="#2a78d6" /><rect x="8" y="2" width="2" height="9" fill="#2a78d6" /></svg>;
    case "leave": return <svg {...s}><path d="M1 6h7M6 3l3 3-3 3" fill="none" stroke="#6b6b6b" strokeWidth="1.4" shapeRendering="geometricPrecision" /><path d="M11 1v10" stroke="#6b6b6b" /></svg>;
    case "flag": return <svg {...s}><path d="M2 1v10" stroke="#000" /><path d="M3 2h7l-2 2 2 2H3z" fill="#1baf7a" stroke="#000" strokeWidth=".6" /></svg>;
    default: return <svg {...s}><rect x="1" y="2" width="10" height="8" fill="#fff" stroke="#6b6b6b" /><path d="M3 5h6M3 7h4" stroke="#6b6b6b" /></svg>;
  }
}

const KEY_KINDS = new Set(["page", "custom", "error", "net", "rage", "dead", "person"]);
function kindOf(e) {
  switch (e.event) {
    case "$pageview": return "page";
    case "$pageleave": return "leave";
    case "$autocapture": return "click";
    case "$rageclick": return "rage";
    case "$dead_click": return "dead";
    case "$exception": return "error";
    case "$network_error": return "net";
    case "$web_vitals": return "vitals";
    case "$identify": return "person";
    case "$feature_flag_called": return "flag";
    case "$log": return e.level === "error" || e.level === "fatal" ? "error" : "log";
    default: return String(e.event || "").startsWith("$") ? "log" : "custom";
  }
}

// key custom props: skip $-internals and utm noise, keep it to a handful
function keyProps(props) {
  const out = [];
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith("$") || k.startsWith("utm_") || v == null || out.length >= 5) continue;
    out.push([k, clip(typeof v === "object" ? JSON.stringify(v) : v, 40)]);
  }
  return out;
}

// events → [{ head: pageview|null, path, items: [row] }], with runs of identical clicks and
// bursts of web vitals folded into one row each.
function buildTimeline(events, keyOnly) {
  const groups = [];
  let cur = null;
  for (const e of events) {
    const kind = kindOf(e);
    if (kind === "page") { cur = { head: e, path: e.pathname || e.message || "/", items: [] }; groups.push(cur); continue; }
    if (keyOnly && !KEY_KINDS.has(kind)) continue;
    if (!cur) { cur = { head: null, path: e.pathname || null, items: [] }; groups.push(cur); }
    const last = cur.items[cur.items.length - 1];
    const p = e.props || {};
    if (kind === "click" && last?.kind === "click" && last.sig === `${p.$event_type}|${p.$el_selector || p.$el_text}`) { last.times++; last.lastTs = e.ts; continue; }
    if (kind === "vitals" && last?.kind === "vitals" && e.ts - last.lastTs < 5000) { last.vitals.push(p); last.lastTs = e.ts; continue; }
    cur.items.push({ kind, e, ts: e.ts, lastTs: e.ts, times: 1, sig: kind === "click" ? `${p.$event_type}|${p.$el_selector || p.$el_text}` : null, vitals: kind === "vitals" ? [p] : null });
  }
  return groups;
}

function Row({ item, t0, wm }) {
  const { e, kind } = item;
  const p = e.props || {};
  const el = p.$el_text || p.$el_selector || p.$el_tag || "element";
  const issueLink = e.issue_id ? (
    <span className="an-lnk" role="link" tabIndex={0} onClick={() => wm?.open?.("issue", { id: e.issue_id })}
      onKeyDown={(ev) => { if (ev.key === "Enter") wm?.open?.("issue", { id: e.issue_id }); }}>issue #{e.issue_id}</span>
  ) : null;
  let body;
  if (kind === "click") {
    body = <>{p.$event_type || "click"} <span className="muted">{p.$el_tag || ""}</span> “{clip(el, 80)}”{item.times > 1 ? <b> ×{item.times}</b> : null}{p.$el_href ? <span className="muted"> → {clip(p.$el_href, 60)}</span> : null}</>;
  } else if (kind === "rage") {
    body = <><b style={{ color: BAD }}>RAGE CLICK</b> on “{clip(el, 80)}”{p.$click_count ? <b> ×{p.$click_count}</b> : null} {issueLink}</>;
  } else if (kind === "dead") {
    body = <><b style={{ color: WARN }}>DEAD CLICK</b> on “{clip(el, 80)}” <span className="muted">— nothing happened</span> {issueLink}</>;
  } else if (kind === "error") {
    const ex = p.$exception_list?.[0];
    const top = ex?.stacktrace?.frames?.[0];
    const unhandled = ex?.mechanism?.handled === false;
    body = (
      <>
        <b style={{ color: BAD }}>{e.event === "$log" ? "LOGGED ERROR" : "ERROR"}</b> <span className="selectable" style={{ color: "#a00000" }}>{clip(e.message || "Error", 300)}</span>
        {ex ? <span className="tag" style={{ marginLeft: 6 }}>{unhandled ? "unhandled" : "handled"}</span> : null} {issueLink}
        {top ? <div className="muted mono">at {top.function || "<anonymous>"} ({clip(top.file, 60)}:{top.line ?? "?"})</div> : null}
      </>
    );
  } else if (kind === "net") {
    body = <><b style={{ color: p.$slow ? WARN : BAD }}>{p.$slow ? "SLOW REQUEST" : "REQUEST FAILED"}</b> <span className="mono selectable">{clip(e.message || `${p.$method || "GET"} ${p.$url || ""}`, 200)}</span>{typeof p.$duration_ms === "number" ? <span className="muted"> · {fmtNum(Math.round(p.$duration_ms))} ms</span> : null} {issueLink}</>;
  } else if (kind === "vitals") {
    body = (
      <span className="muted">web vitals:{" "}
        {item.vitals.map((v, i) => {
          const r = RATING[v.$rating];
          return <span key={i} style={{ marginRight: 8 }}><span style={{ color: "#000" }}>{v.$metric || "?"} {fmtVital(v.$metric, v.$value)}</span>{r ? <b style={{ color: r.c }}> {r.w}</b> : null}</span>;
        })}
      </span>
    );
  } else if (kind === "leave") {
    const d = p.$prev_pageview_duration, sc = p.$scroll_depth;
    body = <span className="muted">left the page{typeof d === "number" ? ` after ${fmtDuration(d * 1000)}` : ""}{typeof sc === "number" ? ` · scrolled ${Math.round(sc * 100)}%` : ""}</span>;
  } else if (kind === "person") {
    const set = { ...(p.$set_once || {}), ...(p.$set || {}) };
    body = <><b>identified</b> as <span className="selectable">{set.email || set.name || e.distinct_id || "?"}</span>{keyProps(set).filter(([k]) => k !== "email").map(([k, v]) => <span key={k} className="tag" style={{ marginLeft: 4 }}>{k}={v}</span>)}</>;
  } else if (kind === "flag") {
    body = <span className="muted">feature flag <span style={{ color: "#000" }}>{String(p.$feature_flag ?? "?")}</span> → {String(p.$feature_flag_response ?? "?")}</span>;
  } else if (kind === "custom") {
    body = <><b>{e.event}</b>{keyProps(p).map(([k, v]) => <span key={k} className="tag" style={{ marginLeft: 4 }}>{k}={v}</span>)}</>;
  } else {
    body = <span className="muted">{e.event === "$log" ? `log ${e.level || "info"}: ` : `${e.event} `}{e.event === "$log" ? clip(e.message, 200) : ""}</span>;
  }
  return (
    <div className={`tl-row${kind === "rage" ? " rage" : kind === "error" || kind === "net" ? " bad" : ""}`}>
      <span className="tl-t" title={fmtTime(e.ts)}>{mmss(e.ts - t0)}</span>
      <span className="tl-i"><Glyph kind={kind} /></span>
      <div className="tl-b">{body}</div>
    </div>
  );
}

export default function SessionDetail({ wm, params }) {
  const id = params?.id;
  const { data, error, loading } = useApi(id != null ? `sessions/${encodeURIComponent(id)}` : null, { every: 10_000, on: ["session"] });
  const meta = useApi("meta");
  const tax = meta.data?.taxonomy || {};
  const idleMin = meta.data?.project?.settings?.sessionIdleMinutes ?? 2;
  const [keyOnly, setKeyOnly] = useState(false);

  const s = data?.session || null;
  const events = Array.isArray(data?.events) ? data.events : [];
  const person = data?.person || null;
  const who = personLabel(person?.props, s?.distinct_id);
  const title = s ? `Session — ${who.main} · ${fmtDateTime(s.started_at)}` : null;
  useEffect(() => { if (title) wm?.setTitle?.(title); }, [title]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => buildTimeline(events, keyOnly), [events, keyOnly]);
  const t0 = s?.started_at ?? events[0]?.ts ?? 0;

  if (id == null) return <div className="err">no session id given</div>;
  if (error && !data) return <div className="err">could not load session {String(id)}: {error}</div>;
  if (!data) return <div className="muted pad">…</div>;

  const c = s.classification || {};
  const state = sessionReadState(s);
  const stale = state === "judged" && (s.event_count || 0) > (s.judged_count || 0);
  const openPerson = () => s.distinct_id && wm?.open?.("person", { id: s.distinct_id });
  let prevTs = t0;

  return (
    <>
      <div className="grid2">
        <div className="group98">
          <span className="gl">JEV&apos;s read of this session</span>
          {state === "judged" ? (
            <>
              <div className="row" style={{ flexWrap: "wrap", marginBottom: 4 }}>
                <span className="muted">intent</span><b title={tax.intents?.[s.intent] || ""}>{s.intent ? label(s.intent) : "–"}</b>
                {c.intent_conf != null ? <span className="muted">({Math.round(c.intent_conf * 100)}% sure)</span> : null}
                <span className="muted" style={{ marginLeft: 8 }}>outcome</span><OutcomeTag outcome={s.outcome} hint={tax.outcomes?.[s.outcome]} />
                {c.outcome_conf != null ? <span className="muted">({Math.round(c.outcome_conf * 100)}% sure)</span> : null}
              </div>
              <Meter label={`frustration${s.frustration != null ? ` · ${frustrationWord(s.frustration)}` : ""}`} value={s.frustration} max={3} digits={1} hint="0 smooth · 1 mild · 2 frustrated · 3 severe" />
              <Meter label="churn risk" value={c.churn_risk} hint="probability this visitor gives up on the product because of this session" />
              <Meter label="hit blocking bug" value={c.hit_blocking_bug} hint="probability a product malfunction stopped the visitor from finishing" />
              <div className="row" style={{ marginTop: 4, flexWrap: "wrap" }}>
                <JudgedBy by={s.judged_by} />
                {s.judged_at ? <span className="muted">read {ago(s.judged_at)}</span> : null}
                {stale ? <span className="muted">· {fmtNum(s.event_count - s.judged_count)} newer event(s) — re-read once it goes quiet</span> : null}
              </div>
            </>
          ) : state === "short" ? (
            <div className="muted">too short to read — JEV reads sessions that have at least 3 events.</div>
          ) : (
            <div><span className="vtag judging">waiting for session to go quiet…</span><div className="muted" style={{ marginTop: 4 }}>JEV reads a whole session in one request once it has been idle for about {fmtNum(idleMin)} min.</div></div>
          )}
        </div>
        <div className="group98">
          <span className="gl">Visitor</span>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <span className="an-lnk" role="link" tabIndex={0} onClick={openPerson} onKeyDown={(e) => { if (e.key === "Enter") openPerson(); }}>
              <PersonCell props={person?.props} distinctId={s.distinct_id} />
            </span>
            <span className="tag">{person?.is_identified ? "identified" : "anonymous"}</span>
          </div>
          <table className="an-kv">
            <tbody>
              <tr><td>started</td><td>{fmtDateTime(s.started_at)} <span className="muted">({ago(s.started_at)})</span></td></tr>
              <tr><td>duration</td><td>{fmtDuration(Math.max(0, (s.last_at || 0) - (s.started_at || 0)))} · {fmtNum(s.pageviews ?? 0)} page(s) · {fmtNum(s.event_count ?? 0)} event(s)</td></tr>
              <tr><td>path</td><td className="mono">{s.entry_path || "?"} → {s.exit_path || "?"}</td></tr>
              <tr><td>came from</td><td>{s.referrer_domain || "direct"}{s.utm_source ? <span className="muted"> · utm_source {s.utm_source}</span> : null}</td></tr>
              <tr><td>device</td><td>{deviceLabel(s)}</td></tr>
              <tr><td>session id</td><td className="mono selectable" title={s.id}>{shortId(s.id)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="toolbar">
        <button className={`tool-btn${!keyOnly ? " on" : ""}`} onClick={() => setKeyOnly(false)}>Everything</button>
        <button className={`tool-btn${keyOnly ? " on" : ""}`} onClick={() => setKeyOnly(true)} title="pages, product events, errors, rage and dead clicks, identify">Key moments</button>
        <span className="muted">times are mm:ss from the start of the session</span>
      </div>
      <div className="pane sunken an-pane">
        {events.length === 0 ? <div className="muted pad">this session has no stored events (they may have been pruned by retention)</div> : (
          <div className="tl">
            {groups.map((g, gi) => {
              const headTs = g.head?.ts ?? g.items[0]?.ts ?? prevTs;
              const gap = headTs - prevTs;
              prevTs = g.items.length ? g.items[g.items.length - 1].lastTs : headTs;
              let inner = headTs;
              return (
                <div key={g.head?.id ?? `g${gi}`} className="tl-group">
                  {gap >= 60_000 ? <div className="tl-gap">— {fmtDuration(gap)} idle —</div> : null}
                  <div className="tl-row tl-head">
                    <span className="tl-t" title={fmtTime(headTs)}>{mmss(headTs - t0)}</span>
                    <span className="tl-i"><Glyph kind="page" /></span>
                    <div className="tl-b">
                      {g.head ? <>viewed <b className="mono selectable">{g.path}</b>{g.head.props?.$title ? <span className="muted"> — {clip(g.head.props.$title, 60)}</span> : null}</> : <span className="muted">before the first pageview{g.path ? <> (on <span className="mono">{g.path}</span>)</> : null}</span>}
                      {g.head && gi === 0 && s.referrer_domain ? <span className="muted"> · from {s.referrer_domain}</span> : null}
                    </div>
                  </div>
                  <div className="tl-kids">
                    {g.items.map((it) => {
                      const igap = it.ts - inner;
                      inner = it.lastTs;
                      return (
                        <div key={it.e.id}>
                          {igap >= 60_000 ? <div className="tl-gap">— {fmtDuration(igap)} idle —</div> : null}
                          <Row item={it} t0={t0} wm={wm} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="statusbar">
        <div className="cell grow sunken-thin">
          {error ? `refresh failed: ${error}` : loading ? "refreshing…" : `${fmtNum(events.length)} event(s)${events.length >= 1000 ? " (first 1,000 shown)" : ""} on ${groups.filter((g) => g.head).length} page view(s)`}
        </div>
        <div className="cell sunken-thin">{fmtNum(s.errors ?? 0)} error(s)</div>
        <div className="cell sunken-thin">{fmtNum(s.rage_clicks ?? 0)} rage click(s)</div>
      </div>
    </>
  );
}
