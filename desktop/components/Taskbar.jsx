"use client";
import { useState, useEffect } from "react";
import { WinLogo } from "./icons";
import { useStreamStatus, fmtUsd } from "../lib/client";

function Clock() {
  const [now, setNow] = useState(null); // null on the server render: avoids a hydration mismatch
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!now) return <span>--:--</span>;
  let h = now.getHours();
  const m = now.getMinutes().toString().padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return <span>{h}:{m} {ap}</span>;
}

export default function Taskbar({ windows, activeId, startOpen, onStart, onTaskClick, overview, onTray }) {
  const stream = useStreamStatus();
  const jev = overview?.jev;
  const pages = overview?.unread_pages || 0;
  return (
    <div className="taskbar">
      <button className={`start-btn${startOpen ? " open" : ""}`} onClick={(e) => { e.stopPropagation(); onStart(); }}>
        <WinLogo size={20} /><span>Start</span>
      </button>
      <div className="task-btns">
        {windows.map((w) => (
          <button key={w.id} className={`task-btn${w.id === activeId && !w.minimized ? " active" : ""}`} onClick={() => onTaskClick(w.id)} title={w.title}>
            <span className="ticon">{w.icon}</span><span className="tlabel">{w.title}</span>
          </button>
        ))}
      </div>
      <div className="tray">
        {pages > 0 && (
          <button className="tray-item tray-page" onClick={() => onTray("pages")} title={`${pages} open issue${pages === 1 ? "" : "s"} JEV says to page for`}>
            <i className="dot blink" style={{ background: "#d03b3b" }} />{pages} PAGE{pages === 1 ? "" : "S"}
          </button>
        )}
        <button className="tray-item" onClick={() => onTray("jev")}
          title={jev ? (jev.enabled ? `JEV ${jev.model} · circuit ${jev.circuit} · 30 d cost ${fmtUsd(jev.cost_30d_usd)}` : "No TYPESAFE_API_KEY: a local heuristic is judging. Click for setup.") : ""}>
          <i className="dot" style={{ background: !jev ? "#808080" : jev.enabled ? (jev.circuit === "open" ? "#b86a00" : "#0ca30c") : "#808080" }} />
          {!jev ? "…" : jev.enabled ? (jev.circuit === "open" ? "JEV degraded" : "JEV") : "heuristic"}
        </button>
        <button className="tray-item tray-theme" onClick={() => onTray("theme")} title="Switch to the modern dashboard (same data, same screens)">
          <i className="theme-chip" aria-hidden="true" />Modern
        </button>
        <span className="tray-item" title={`live stream: ${stream}`}>
          <i className="dot" style={{ background: stream === "live" ? "#0ca30c" : "#b86a00" }} />{stream === "live" ? "live" : stream}
        </span>
        <Clock />
      </div>
    </div>
  );
}
