"use client";
import { useRef, useEffect } from "react";

// Position and size are driven imperatively while dragging (no re-render per mouse move);
// React only knows the initial geometry.
export default function Window({
  id, app, title, icon, x, y, w, h, z, focused, minimized, maximized, hot,
  onFocus, onClose, onMinimize, onMaximize, children,
}) {
  const ref = useRef(null);

  const track = (onMove) => {
    const up = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", up);
  };

  const startDrag = (e) => {
    onFocus(id);
    if (maximized || e.target.closest(".tbtn")) return;
    const r = ref.current.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    track((ev) => {
      const el = ref.current;
      if (!el) return;
      // keep the title bar reachable: never let it leave the desktop
      el.style.left = Math.min(window.innerWidth - 60, Math.max(-r.width + 80, ev.clientX - dx)) + "px";
      el.style.top = Math.min(window.innerHeight - 70, Math.max(0, ev.clientY - dy)) + "px";
    });
  };

  const startResize = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onFocus(id);
    const r = ref.current.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    document.body.style.cursor = "nwse-resize";
    track((ev) => {
      const el = ref.current;
      if (!el) return;
      el.style.width = Math.max(320, r.width + ev.clientX - sx) + "px";
      el.style.height = Math.max(180, r.height + ev.clientY - sy) + "px";
    });
  };

  useEffect(() => {
    if (!maximized && ref.current) {
      ref.current.style.left = ref.current.dataset.left || x + "px";
      ref.current.style.top = ref.current.dataset.top || y + "px";
    }
  }, [maximized]);

  // remember where the user left it, so un-maximizing restores their position
  const remember = () => {
    const el = ref.current;
    if (!el || maximized) return;
    el.dataset.left = el.style.left;
    el.dataset.top = el.style.top;
  };

  return (
    <div
      ref={ref}
      data-window-id={id}
      data-window-app={app}
      className={`window raised${maximized ? " maxed" : ""}${hot ? " hot" : ""}`}
      style={{ left: x, top: y, width: w, height: h, zIndex: z, display: minimized ? "none" : undefined }}
      onMouseDown={() => onFocus(id)}
      onMouseUp={remember}
    >
      <div className={`title-bar${focused ? "" : " inactive"}`} onMouseDown={startDrag} onDoubleClick={() => onMaximize(id)}>
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
      {!maximized && <div className="resize-grip" onMouseDown={startResize} aria-hidden="true" />}
    </div>
  );
}
