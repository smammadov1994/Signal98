"use client";
import { useRef, useEffect } from "react";

export default function Window({
  id, title, icon, x, y, w, h, z, focused, minimized, maximized, hot,
  onFocus, onClose, onMinimize, onMaximize, children,
}) {
  const ref = useRef(null);
  const drag = useRef(null);

  const onMouseDown = (e) => {
    onFocus(id);
    if (maximized || e.target.closest(".tbtn")) return;
    const r = ref.current.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    const move = (ev) => {
      const el = ref.current;
      el.style.left = Math.max(0, ev.clientX - drag.current.dx) + "px";
      el.style.top = Math.max(0, ev.clientY - drag.current.dy) + "px";
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  useEffect(() => {
    if (!maximized && ref.current) {
      ref.current.style.left = x + "px";
      ref.current.style.top = y + "px";
    }
  }, [maximized]);

  if (minimized) return null;

  return (
    <div
      ref={ref}
      data-window-id={id}
      className={`window raised${maximized ? " maxed" : ""}${hot ? " hot" : ""}`}
      style={{ left: x, top: y, width: w, height: h, zIndex: z }}
      onMouseDown={() => onFocus(id)}
    >
      <div className={`title-bar${focused ? "" : " inactive"}`} onMouseDown={onMouseDown} onDoubleClick={() => onMaximize(id)}>
        <span className="ticon">{icon}</span>
        <span className="ttitle">{title}</span>
        <div className="title-btns">
          <button className="tbtn" onClick={(e) => { e.stopPropagation(); onMinimize(id); }} aria-label="minimize">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="7" width="8" height="2" fill="#000"/></svg>
          </button>
          <button className="tbtn" onClick={(e) => { e.stopPropagation(); onMaximize(id); }} aria-label="maximize">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="none" stroke="#000" strokeWidth="2"/><rect x="1" y="1" width="8" height="2" fill="#000"/></svg>
          </button>
          <button className="tbtn" onClick={(e) => { e.stopPropagation(); onClose(id); }} aria-label="close">
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="#000" strokeWidth="2"/></svg>
          </button>
        </div>
      </div>
      <div className="window-body">{children}</div>
    </div>
  );
}
