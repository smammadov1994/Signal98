"use client";
import { useState, useEffect } from "react";

export default function RecycleBin({ onEmptyChange }) {
  const [events, setEvents] = useState([]);
  const [emptied, setEmptied] = useState(false);
  const [confirm, setConfirm] = useState(false);

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

  const suppressed = events.filter(e => e.status === "judged" && !e.paged);

  const doEmpty = () => { setEmptied(true); setConfirm(false); onEmptyChange && onEmptyChange(0); };
  const doRestore = () => { setEmptied(false); onEmptyChange && onEmptyChange(suppressed.length); };

  const why = (e) => {
    const j = e.judgments || {};
    return j.is_user_facing < 0.6 ? "not user-facing" : j.is_urgent < 0.7 ? "not urgent" : "not novel";
  };

  return (
    <>
      <div className="toolbar">
        {!emptied
          ? <button className="tool-btn" onClick={() => setConfirm(true)}>Empty Recycle Bin</button>
          : <button className="tool-btn" onClick={doRestore}>Restore all items</button>}
        <span style={{ color: "#333" }}>deleted alerts go here. they bothered no one.</span>
      </div>
      <div className="trace-table-wrap sunken">
        <table className="traces">
          <thead><tr><th>Time</th><th>Service</th><th>Event</th><th className="num">Urgent</th><th>Why suppressed</th></tr></thead>
          <tbody>
            {!emptied && suppressed.map(e => (
              <tr key={e.id}>
                <td>{String(e.ts).slice(11, 19)}</td><td>{e.service}</td>
                <td style={{ fontFamily: "'Courier New', monospace" }}>{e.message}</td>
                <td className="num">{(e.judgments?.is_urgent ?? 0).toFixed(2)}</td>
                <td style={{ color: "#606060" }}>{why(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(emptied || suppressed.length === 0) && <div style={{ padding: 30, textAlign: "center", color: "#808080" }}>The Recycle Bin is empty. Ahh, silence.</div>}
      </div>
      <div className="statusbar">
        <div className="cell grow sunken-thin">{emptied ? 0 : suppressed.length} object(s)</div>
      </div>
      {confirm && (
        <div className="dialog-veil">
          <div className="dialog raised">
            <div className="title-bar"><span className="ttitle">Confirm Delete</span></div>
            <div className="dbody">
              <span style={{ fontSize: 28 }}>⚠️</span>
              <span>Are you sure you want to permanently delete these {suppressed.length} suppressed alerts?<br /><br />JEV already decided they don&apos;t matter. Trust JEV.</span>
            </div>
            <div className="dbuttons">
              <button className="btn98" onClick={doEmpty}>Yes</button>
              <button className="btn98" onClick={() => setConfirm(false)}>No</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
