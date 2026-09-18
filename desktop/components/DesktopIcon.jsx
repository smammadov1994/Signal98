"use client";

export default function DesktopIcon({ id, label, glyph, selected, hot, badge, onClick, onDoubleClick }) {
  return (
    <div
      className={`icon${selected ? " selected" : ""}${hot ? " hot" : ""}`}
      data-icon-id={id}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {badge > 0 && <span className="badge">{badge}</span>}
      <span className="glyph">{glyph}</span>
      <span className="label">{label}</span>
    </div>
  );
}
