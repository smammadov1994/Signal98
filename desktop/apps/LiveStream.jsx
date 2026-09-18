"use client";
import { useState, useEffect, useRef } from "react";

// Raw Feed: the live event stream. Seeded with the bundled history, then
// live events arrive here as the playground (or any signal98 SDK) fires them
// into /api/ingest. Each event lands as "judging…" and its JEV verdict
// fills in a moment later.
export default function LiveStream() {
  const [events, setEvents] = useState([]);
  const [running, setRunning] = useState(true);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!running) return;
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
    const t = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [running]);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [events]);

  const clear = async () => {
    try {
      await fetch("/api/feed", { method: "DELETE" });
    } catch {}
    setEvents([]);
  };

  const lines = events.slice(-200);
  const fmt = (e) => {
    const tag = e.status !== "judged" ? "judging…" : e.paged ? "PAGED" : "suppressed";
    const j = e.judgments
      ? `jev: urgent=${e.judgments.is_urgent.toFixed(2)} facing=${e.judgments.is_user_facing.toFixed(2)} novel=${e.judgments.is_novel.toFixed(2)} sev=${e.judgments.severity.toFixed(1)} → ${tag}`
      : tag;
    return { tag, j };
  };

  return (
    <>
      <div className="toolbar">
        <button className="tool-btn" onClick={() => setRunning(r => !r)}>{running ? "❚❚ Pause" : "▶ Run"}</button>
        <button className="tool-btn" onClick={clear}>Clear</button>
        <span style={{ color: "#333" }}>live from /api/ingest — fire the playground →</span>
      </div>
      <div className="stream-log sunken" ref={boxRef}>
        {lines.map((e) => {
          const { tag, j } = fmt(e);
          return (
            <div key={e.id} className={`ln${e.paged ? " paged-ln" : ""}`}>
              <span className="t">[{String(e.ts).slice(11, 19)}]</span> {e.message}
              <br />
              <span className="judge">  └─ {j}</span>
            </div>
          );
        })}
        <span className="cursor-blink">▊</span>
      </div>
      <div className="statusbar">
        <div className="cell grow sunken-thin">{running ? "● receiving" : "○ paused"}</div>
        <div className="cell sunken-thin">{events.length} events</div>
      </div>
    </>
  );
}
