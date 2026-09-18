"use client";
import { GhostGlyph } from "../components/Ghost";

// The ghost's fix report, opened as a window after the haunting.
export default function GhostReport({ result }) {
  const v = result.variant;
  return (
    <>
      <div className="toolbar">
        <GhostGlyph color={v.color} size={20} />
        <b>{v.id} &ldquo;{v.name}&rdquo; report</b>
        {result.offline && (
          <span style={{ color: "#7a5c00" }}>
            &nbsp;&mdash; dreaming (no DEEPSEEK_API_KEY), template plan
          </span>
        )}
      </div>
      <div className="notepad sunken">
        {result.report ? (
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", userSelect: "text" }}>
            {result.report}
          </pre>
        ) : (
          result.fixes.map((f, i) => (
            <div key={i} className="page-card sunken-thin" style={{ margin: "0 0 8px 0" }}>
              <div className="msg" style={{ fontFamily: "'Courier New', monospace" }}>{f.event}</div>
              <div className="why"><b>Diagnosis:</b> {f.diagnosis}</div>
              <div className="why">
                <b>Fix:</b>
                <ul style={{ margin: "4px 0 4px 18px" }}>
                  {f.steps.map((s, j) => <li key={j}>{s}</li>)}
                </ul>
              </div>
              {f.patch && (
                <pre style={{ background: "#f0f0f0", padding: 6, border: "1px solid #d0d0d0", userSelect: "text" }}>
                  {f.patch}
                </pre>
              )}
            </div>
          ))
        )}
        <div style={{ color: "#008000", fontWeight: "bold", marginTop: 8 }}>
          {result.fixedCount} issue{result.fixedCount === 1 ? "" : "s"} exorcised.
        </div>
      </div>
    </>
  );
}
