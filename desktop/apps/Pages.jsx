"use client";
import { useState, useEffect } from "react";

// The events that crossed the paging rule, with the receipts.
// Live: polls /api/feed so pages fired from the playground show up here.
export default function Pages({ fixedIds = new Set() }) {
  const [events, setEvents] = useState([]);

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

  const paged = events.filter(e => e.paged && e.status === "judged");
  return (
    <>
      <div className="toolbar">
        <span style={{ color: "#a00000", fontWeight: "bold" }}>
          {paged.length} page{paged.length === 1 ? "" : "s"} tonight
        </span>
        <span style={{ color: "#333" }}>rule: urgent ≥ 0.70 and user-facing ≥ 0.60 and novel ≥ 0.55</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "2px 3px 3px 3px" }}>
        {paged.length === 0 && (
          <div style={{ padding: 30, textAlign: "center", color: "#808080" }}>
            no pages yet — set off an error from the playground (:3000) and JEV will decide if it pages.
          </div>
        )}
        {paged.map(e => {
          const fixed = fixedIds.has(e.id);
          const j = e.judgments || {};
          return (
            <div key={e.id} className="page-card raised-thin">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "#606060" }}>{String(e.ts).slice(11, 19)} · {e.service} · {e.level}</span>
                {fixed
                  ? <span className="verdict-tag" style={{ color: "#008000", borderColor: "#008000", background: "#d8ffd8" }}>EXORCISED</span>
                  : <span className="verdict-tag paged">PAGED</span>}
              </div>
              <div className="msg" style={{ fontFamily: "'Courier New', monospace" }}>{e.message}</div>
              <div className="why">
                why: urgent <b>{(j.is_urgent ?? 0).toFixed(2)}</b> ≥ 0.70,{" "}
                user-facing <b>{(j.is_user_facing ?? 0).toFixed(2)}</b> ≥ 0.60,{" "}
                novel <b>{(j.is_novel ?? 0).toFixed(2)}</b> ≥ 0.55.
                severity {(j.severity ?? 0).toFixed(2)}.
              </div>
            </div>
          );
        })}
      </div>
      <div className="statusbar">
        <div className="cell grow sunken-thin">drag the ghost onto this window to unleash it</div>
      </div>
    </>
  );
}
