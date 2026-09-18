"use client";
import { useRef, useState, useEffect } from "react";

// 8-bit ghost sprite, drawn as chunky pixels. Recolors per ghost variant.
// The pupils follow your cursor. When excited (hovering a valid drop
// target) the pupils grow and the ghost glows.
const MAP = [
  "....XXXX....",
  "..XXXXXXXX..",
  ".XXXXXXXXXX.",
  "XXXXXXXXXXXX",
  "XXWWXXXXWWXX",
  "XXWPXXXXWPXX",
  "XXXXXXXXXXXX",
  "XXXXXXXXXXXX",
  "XXXXXXXXXXXX",
  "XXXXXXXXXXXX",
  "XXXXXXXXXXXX",
  "XX.XXXXXX.XX",
];

export function GhostGlyph({ color = "#e8e8ff", size = 36, look = { x: 0, y: 0 }, excited = false }) {
  const rects = [];
  MAP.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === "." || ch === "P") return; // pupils drawn separately
      const fill = ch === "X" ? color : "#ffffff";
      rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={fill} />);
    })
  );
  const pw = excited ? 1.7 : 1.02;
  const po = excited ? -0.35 : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" shapeRendering="crispEdges" style={{ display: "block" }}>
      {rects}
      <g transform={`translate(${look.x},${look.y})`}>
        <rect x={3 + po} y={5 + po} width={pw} height={pw} fill="#101060" />
        <rect x={9 + po} y={5 + po} width={pw} height={pw} fill="#101060" />
      </g>
    </svg>
  );
}

export default function Ghost({ x, y, color, dragging, working, hot, onPointerDown }) {
  const ref = useRef(null);
  const [look, setLook] = useState({ x: 0, y: 0 });

  // eyes follow the cursor
  useEffect(() => {
    const q = (v) => Math.round(Math.max(-1.2, Math.min(1.2, v)) * 5) / 5;
    const onMove = (e) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / 60;
      const dy = (e.clientY - (r.top + r.height / 2)) / 60;
      const n = { x: q(dx), y: q(dy) };
      setLook((prev) => (prev.x === n.x && prev.y === n.y ? prev : n));
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  return (
    <>
      <style>{`
        @keyframes ghost-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes ghost-busy { 0%,100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-10px) scale(1.12); } }
        @keyframes ghost-hot { 0%,100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-4px) scale(1.15); } }
      `}</style>
      <div
        ref={ref}
        onPointerDown={onPointerDown}
        title="drag me onto a window"
        style={{
          position: "absolute", left: x, top: y, cursor: "grab", zIndex: dragging ? 9500 : 50,
          pointerEvents: dragging ? "none" : "auto",
          filter: hot
            ? "drop-shadow(2px 2px 0 rgba(0,0,0,.45)) drop-shadow(0 0 12px #ffffff)"
            : "drop-shadow(2px 2px 0 rgba(0,0,0,.45))",
          animation: working ? "ghost-busy .5s steps(2) infinite" : hot ? "ghost-hot .6s ease-in-out infinite" : "ghost-float 2.4s ease-in-out infinite",
          touchAction: "none",
        }}
      >
        <GhostGlyph color={color} size={40} look={look} excited={hot} />
        <div style={{ textAlign: "center", color: "#fff", fontSize: 10, textShadow: "1px 1px 0 #000", marginTop: 2 }}>
          ghost
        </div>
      </div>
    </>
  );
}
