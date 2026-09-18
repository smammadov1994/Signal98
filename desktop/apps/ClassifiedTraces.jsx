"use client";
import { useState, useEffect, useMemo } from "react";

const COLS = [
  { k: "ts", label: "Time" },
  { k: "service", label: "Service" },
  { k: "level", label: "Level" },
  { k: "message", label: "Event" },
  { k: "is_urgent", label: "Urgent", num: true, j: true },
  { k: "is_user_facing", label: "User-facing", num: true, j: true },
  { k: "is_novel", label: "Novel", num: true, j: true },
  { k: "severity", label: "Severity", num: true, j: true },
  { k: "verdict", label: "Verdict" },
];

const valCls = (v) => (v == null ? "" : v >= 0.7 ? "val-hi" : v >= 0.4 ? "val-med" : "val-lo");
const sevCls = (v) => (v == null ? "" : v >= 2 ? "val-hi" : v >= 1 ? "val-med" : "val-lo");
const num = (v, d = 2) => (v == null ? "…" : v.toFixed(d));

export default function ClassifiedTraces({ fixedIds = new Set() }) {
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState({ k: "ts", dir: 1 });

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/feed", { cache: "no-store" });
        const d = await r.json();
        if (alive) setEvents(d.events || []);
      } catch {
        /* backend not up yet */
      }
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const rows = useMemo(() => {
    let r = events.map(e => ({
      ...e,
      is_urgent: e.judgments?.is_urgent,
      is_user_facing: e.judgments?.is_user_facing,
      is_novel: e.judgments?.is_novel,
      severity: e.judgments?.severity,
      fixed: fixedIds.has(e.id),
      verdict: e.status !== "judged" ? "judging…" : fixedIds.has(e.id) ? "EXORCISED" : e.paged ? "PAGED" : "suppressed",
      time: String(e.ts).slice(11, 19),
    }));
    if (filter === "paged") r = r.filter(e => e.paged && e.status === "judged");
    if (filter === "suppressed") r = r.filter(e => !e.paged && e.status === "judged");
    const { k, dir } = sort;
    r.sort((a, b) => {
      const av = a[k], bv = b[k];
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return r;
  }, [events, filter, sort, fixedIds]);

  const nPaged = events.filter(e => e.paged).length;

  const clickSort = (k) =>
    setSort(s => (s.k === k ? { k, dir: -s.dir } : { k, dir: 1 }));

  const verdictTag = (e) => {
    if (e.verdict === "judging…")
      return <span className="verdict-tag" style={{ color: "#8a6d1a", borderColor: "#e8d9a8", background: "#fdf6e3" }}>judging…</span>;
    if (e.fixed)
      return <span className="verdict-tag" style={{ color: "#008000", borderColor: "#008000", background: "#d8ffd8" }}>EXORCISED</span>;
    return <span className={`verdict-tag ${e.paged ? "paged" : "supp"}`}>{e.verdict}</span>;
  };

  return (
    <>
      <div className="menubar"><span>File</span><span>Edit</span><span>View</span><span>Help</span></div>
      <div className="toolbar">
        <button className={`tool-btn${filter === "all" ? " on" : ""}`} onClick={() => setFilter("all")}>All</button>
        <button className={`tool-btn${filter === "paged" ? " on" : ""}`} onClick={() => setFilter("paged")}>Paged</button>
        <button className={`tool-btn${filter === "suppressed" ? " on" : ""}`} onClick={() => setFilter("suppressed")}>Suppressed</button>
      </div>
      <div className="addrbar"><span>Address</span><div className="addr sunken-thin">C:\signal\classified_traces</div></div>
      <div className="trace-table-wrap sunken">
        <table className="traces">
          <thead><tr>
            {COLS.map(c => (
              <th key={c.k} className={c.num ? "num" : ""} onClick={() => clickSort(c.k)}>
                {c.label}{sort.k === c.k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr></thead>
          <tbody>
            {rows.map(e => (
              <tr key={e.id} className={e.paged && !e.fixed ? "paged" : ""}>
                <td>{e.time}</td><td>{e.service}</td><td>{e.level}</td>
                <td style={{ fontFamily: "'Courier New', monospace" }}>{e.message}</td>
                <td className={`num ${valCls(e.is_urgent)}`}>{num(e.is_urgent)}</td>
                <td className={`num ${valCls(e.is_user_facing)}`}>{num(e.is_user_facing)}</td>
                <td className={`num ${valCls(e.is_novel)}`}>{num(e.is_novel)}</td>
                <td className={`num ${sevCls(e.severity)}`}>{num(e.severity, 1)}</td>
                <td>{verdictTag(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="statusbar">
        <div className="cell grow sunken-thin">{rows.length} object(s) — drag the ghost onto this window to unleash it</div>
        <div className="cell sunken-thin">{nPaged} paged</div>
        <div className="cell sunken-thin">{events.filter(e => e.status === "judged").length - nPaged} suppressed</div>
      </div>
    </>
  );
}
