"use client";
// Persons — everyone the SDK has seen. Anonymous visitors become identified people when the
// host app calls identify(); their earlier history is folded into the identified record.
import { useEffect, useState } from "react";
import { useApi, fmtDateTime, fmtNum, ago } from "../lib/client";
import { personLabel } from "./Sessions";

const clip = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export function propsSummary(props, skip = ["name", "email"], max = 4) {
  const out = [];
  for (const [k, v] of Object.entries(props && typeof props === "object" ? props : {})) {
    if (skip.includes(k) || v == null || v === "") continue;
    out.push(`${k}=${clip(typeof v === "object" ? JSON.stringify(v) : v, 28)}`);
  }
  return { shown: out.slice(0, max), more: Math.max(0, out.length - max) };
}

export default function Persons({ wm }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [identified, setIdentified] = useState(false);
  const [sel, setSel] = useState(null);
  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 250); return () => clearTimeout(t); }, [text]);

  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (identified) qs.set("identified", "1");
  const { data, error, loading } = useApi(`persons${qs.toString() ? `?${qs}` : ""}`, { every: 15_000 });
  const rows = Array.isArray(data?.persons) ? data.persons : [];
  const known = rows.filter((p) => p.is_identified).length;
  const open = (p) => { setSel(p.distinct_id); wm?.open?.("person", { id: p.distinct_id }); };

  return (
    <>
      <div className="toolbar an-wrap">
        <span>Search</span>
        <input className="in98" style={{ width: 220 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="id, email, name or any property" spellCheck={false} />
        {text ? <button className="btn98 small" onClick={() => setText("")}>Clear</button> : null}
        <label className="check98"><input type="checkbox" checked={identified} onChange={(e) => setIdentified(e.target.checked)} /> identified only</label>
      </div>
      <div className="pane sunken an-pane">
        {error && !data ? <div className="err">could not load persons: {error}</div> : !data ? <div className="muted pad">…</div> : (
          <table className="t98">
            <thead><tr><th>Person</th><th>Distinct id</th><th>Properties</th><th>First seen</th><th>Last seen</th><th className="num">Events</th></tr></thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={6} className="wrap muted" style={{ textAlign: "center", padding: 24 }}>
                  {q || identified ? "nobody matches — try a shorter search, or untick “identified only”" : "no persons yet — open the demo shop at :3000 and click around; sign in there to see an identified person"}
                </td></tr>
              )}
              {rows.map((p) => {
                const who = personLabel(p.props, p.distinct_id);
                const sum = propsSummary(p.props);
                return (
                  <tr key={p.id ?? p.distinct_id} className={sel === p.distinct_id ? "sel" : ""} onClick={() => open(p)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") open(p); }} style={{ cursor: "pointer" }}>
                    <td>
                      {who.known ? <><b>{who.main}</b>{who.sub ? <span className="muted"> {who.sub}</span> : null}</> : <span className="muted">anonymous visitor</span>}
                      {p.is_identified ? <span className="tag" style={{ marginLeft: 6 }}>identified</span> : null}
                    </td>
                    <td className="mono selectable" title={p.distinct_id}>{clip(p.distinct_id, 40)}</td>
                    <td title={sum.shown.join("  ")}>
                      {sum.shown.length ? sum.shown.map((s) => <span key={s} className="tag" style={{ marginRight: 4 }}>{s}</span>) : <span className="muted">–</span>}
                      {sum.more ? <span className="muted">+{sum.more} more</span> : null}
                    </td>
                    <td>{p.first_seen ? fmtDateTime(p.first_seen) : "–"}</td>
                    <td title={p.last_seen ? fmtDateTime(p.last_seen) : ""}>{p.last_seen ? ago(p.last_seen) : "–"}</td>
                    <td className="num">{fmtNum(p.event_count ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="statusbar">
        <div className="cell grow sunken-thin">
          {error && data ? `refresh failed: ${error}` : loading && data ? "searching…" : `${rows.length} person(s)${rows.length >= 200 ? " — showing the 200 most recent, search to narrow" : ""}`}
        </div>
        <div className="cell sunken-thin">{known} identified</div>
        <div className="cell sunken-thin">{rows.length - known} anonymous</div>
      </div>
    </>
  );
}
