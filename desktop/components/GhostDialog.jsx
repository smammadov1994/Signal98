"use client";
import { GhostGlyph } from "./Ghost";

// "JEV has chosen a ghost — unleash it?" dialog.
export default function GhostDialog({ summon, onUnleash, onDismiss }) {
  const { route, events, phase } = summon;
  const g = route.ghost;
  return (
    <div className="dialog-veil" style={{ zIndex: 9600 }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="dialog raised" style={{ width: 400 }}>
        <div className="title-bar">
          <span className="ttitle">ghost summoned</span>
        </div>
        <div className="dbody">
          <GhostGlyph color={g.color} size={52} />
          <div style={{ flex: 1 }}>
            {phase === "ask" ? (
              <>
                <div style={{ fontWeight: "bold", marginBottom: 4 }}>
                  JEV has chosen {g.id} &ldquo;{g.name}&rdquo;
                </div>
                <div style={{ marginBottom: 6, color: "#333" }}>{route.reason}</div>
                <div style={{ marginBottom: 4 }}><b>Permissions:</b> {g.permissions.join(", ")}</div>
                <div style={{ marginBottom: 8 }}><b>Specialty:</b> {g.specialty}</div>
                <div>Unleash it on these <b>{events.length}</b> issue{events.length === 1 ? "" : "s"}?</div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: "bold", marginBottom: 6 }}>{g.name} is working&hellip;</div>
                <div className="cursor-blink" style={{ fontFamily: "'Courier New', monospace" }}>
                  consulting the model &#9612;
                </div>
              </>
            )}
          </div>
        </div>
        {phase === "ask" && (
          <div className="dbuttons">
            <button className="btn98" onClick={onUnleash}>Unleash</button>
            <button className="btn98" onClick={onDismiss}>Dismiss</button>
          </div>
        )}
      </div>
    </div>
  );
}
