"use client";
import { useState, useEffect } from "react";
import { WinLogo } from "./icons";

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  let h = now.getHours(), m = now.getMinutes().toString().padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return <span>{h}:{m} {ap}</span>;
}

export default function Taskbar({ windows, activeId, onTaskClick, onStartItem, menuOpen, setMenuOpen, apps }) {
  return (
    <>
      {menuOpen && (
        <div className="start-menu raised">
          <div className="side">signal98</div>
          <div className="items">
            {apps.map(a => (
              <div key={a.id} className="start-item" onClick={() => { onStartItem(a.id); setMenuOpen(false); }}>
                {a.glyph(28)}<span>{a.menuLabel || a.label}</span>
              </div>
            ))}
            <div className="start-sep" />
            <div className="start-item" onClick={() => { onStartItem("__shutdown"); setMenuOpen(false); }}>
              <span style={{ width: 28, textAlign: "center", fontSize: 16 }}>⏻</span><span>Shut Down...</span>
            </div>
          </div>
        </div>
      )}
      <div className="taskbar">
        <button className={`start-btn${menuOpen ? " open" : ""}`} onClick={() => setMenuOpen(v => !v)}>
          <WinLogo size={20} /><span>Start</span>
        </button>
        <div className="task-btns">
          {windows.map(w => (
            <button
              key={w.id}
              className={`task-btn${w.id === activeId && !w.minimized ? " active" : ""}`}
              onClick={() => onTaskClick(w.id)}
            >
              <span className="ticon">{w.icon}</span><span>{w.title}</span>
            </button>
          ))}
        </div>
        <div className="tray"><Clock /></div>
      </div>
    </>
  );
}
