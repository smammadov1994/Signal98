"use client";

// 8-bit ghost sprite, drawn as chunky pixels. Recolors per ghost variant.
// Behaviour (eyes, bubbles, drag-and-drop) lives in GhostAssistant.jsx.
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
