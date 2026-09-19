"use client";
// The ghost in the corner: signal98's Clippy. It listens to the live stream and speaks up
// when JEV says something matters — "It looks like checkout is broken. Want the fix?" —
// then either writes up a fix, or (auto mode / on request) sends a coding agent after it.
//
// Interactions: click = menu · drag onto an issue (or the Issues / Pages window) = fix that.
import { useEffect, useRef, useState, useCallback } from "react";
import { GhostGlyph } from "./Ghost";
import { api, useStream, VERDICTS, label } from "../lib/client";

const IDLE = "#e8e8ff";
const AREA = {
  payments: "checkout or payments", auth: "login", rendering: "a page", data: "some data handling", network: "an API call",
  third_party: "a third-party integration", database: "the database", performance: "performance", infrastructure: "the infrastructure",
  security: "security", ux_friction: "a control users are fighting with", noise: "something noisy",
};
const DROP_APPS = new Set(["issue", "issues", "pages", "feed"]);

export default function GhostAssistant({ wm, desktopRef, ghosts = [], autoMode, repoConfigured, onSettingsChanged, setHotTarget }) {
  const [pos, setPos] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [hot, setHot] = useState(false);
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [bubble, setBubble] = useState(null);   // { key, title, text, actions[], issueId, color }
  const [status, setStatus] = useState(null);   // { issueId, line, color } while something is working
  const [menu, setMenu] = useState(false);
  const queue = useRef([]);
  const el = useRef(null);
  const drag = useRef(null);

  const home = useCallback(() => {
    const r = desktopRef.current?.getBoundingClientRect();
    return r ? { x: Math.max(8, r.width - 92), y: Math.max(8, r.height - 96) } : { x: 24, y: 330 };
  }, [desktopRef]);

  useEffect(() => {
    setPos(home());
    const onResize = () => { if (!drag.current) setPos(home()); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [home]);

  // eyes follow the cursor
  useEffect(() => {
    const qz = (v) => Math.round(Math.max(-1.2, Math.min(1.2, v)) * 5) / 5;
    const onMove = (e) => {
      const r = el.current?.getBoundingClientRect();
      if (!r) return;
      const n = { x: qz((e.clientX - (r.left + r.width / 2)) / 60), y: qz((e.clientY - (r.top + r.height / 2)) / 60) };
      setLook((p) => (p.x === n.x && p.y === n.y ? p : n));
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  const ghostColor = (id) => ghosts.find((g) => g.id === id)?.color || IDLE;
  const ghostName = (id) => ghosts.find((g) => g.id === id)?.name || "ghost";

  // An actionable bubble is never silently replaced: newer ones wait their turn.
  const say = useCallback((b) => {
    setBubble((cur) => {
      if (!cur || cur.key === b.key || !cur.actions?.length) return b;
      queue.current = [...queue.current.filter((x) => x.key !== b.key), b].slice(-5);
      return cur;
    });
  }, []);
  const dismiss = useCallback(() => setBubble(() => queue.current.shift() || null), []);

  const askFix = useCallback(async (issue) => {
    setBubble(null);
    setStatus({ issueId: issue.id, line: "reading the issue…", color: ghostColor(issue.classification?.responder) });
    try {
      await api(`issues/${issue.id}/fix`, { method: "POST" }); // the fix_ready stream message opens the bubble
    } catch (err) {
      setStatus(null);
      say({ key: `err-${issue.id}`, title: "That didn't work", text: err.message, actions: [{ label: "OK" }] });
    }
  }, [say, ghosts]);

  const sendAgent = useCallback(async (issue) => {
    setBubble(null);
    try {
      const { run } = await api(`issues/${issue.id}/agent`, { method: "POST" });
      if (run.status === "skipped") {
        say({
          key: `skip-${run.id}`, title: "I can't send an agent yet", text: run.summary, issueId: issue.id,
          actions: [{ label: "Ghost settings", run: () => wm.open("settings", { tab: "ghost" }) }, { label: "OK" }],
        });
      }
    } catch (err) {
      say({ key: `err-${issue.id}`, title: "That didn't work", text: err.message, actions: [{ label: "OK" }] });
    }
  }, [say, wm]);

  useStream(({ type, data }) => {
    if (type === "verdict") {
      const i = data.issue;
      const escalated = !data.is_new && data.previous_verdict !== i.verdict && i.verdict === "page";
      if (i.status !== "open" || !["page", "notify"].includes(i.verdict) || !(data.is_new || escalated || i.regressed)) return;
      const v = VERDICTS[i.verdict];
      const c = i.classification || {};
      const canFix = c.is_actionable >= 0.5;
      say({
        key: `issue-${i.id}`, issueId: i.id, color: ghostColor(c.responder),
        title: i.regressed ? `It's back: ${AREA[i.category] || "something"} broke again` : `It looks like ${AREA[i.category] || "something"} is broken.`,
        text: `${i.type ? i.type + ": " : ""}${i.title}`,
        meta: `${v.label} · severity ${Number(i.severity ?? 0).toFixed(1)}/4 · ${label(i.category)} · ${label(i.cause)} · judged by ${i.judged_by}`,
        actions: autoMode && canFix
          ? [{ label: "Open", run: () => wm.open("issue", { id: i.id }) }, { label: "OK" }]
          : [
              { label: "Find the fix", primary: true, run: () => askFix(i) },
              { label: "Send an agent", run: () => sendAgent(i) },
              { label: "Open", run: () => wm.open("issue", { id: i.id }) },
              { label: "Not now" },
            ],
        footnote: autoMode && canFix ? "Auto mode is on — I'm already on it." : !canFix ? "JEV doubts this is a bug in your code, so I'd look before patching." : null,
      });
    }
    if (type === "agent") {
      const { phase, line, issue_id: issueId, run_id: runId, fix_id: fixId } = data;
      if (phase === "thinking" || phase === "running" || phase === "queued") {
        setStatus((s) => ({ issueId, line, color: s?.issueId === issueId ? s.color : IDLE }));
      } else if (phase === "fix_ready") {
        setStatus(null);
        say({
          key: `fix-${fixId}`, issueId, title: `Here's the fix for #${issueId}`, text: line,
          actions: [{ label: "Show me", primary: true, run: () => wm.open("issue", { id: issueId, tab: "ghost" }) }, { label: "Send an agent to do it", run: () => sendAgent({ id: issueId }) }, { label: "Later" }],
        });
      } else if (phase === "succeeded") {
        setStatus(null);
        say({
          key: `run-${runId}`, issueId, title: `I fixed #${issueId} on a branch`, text: String(line || "").slice(0, 260),
          actions: [
            { label: "Review the diff", primary: true, run: () => wm.open("run", { id: runId }) },
            { label: "Apply it", run: async () => { try { await api(`agent/runs/${runId}/apply`, { method: "POST" }); } catch (err) { say({ key: `err-run-${runId}`, title: "Couldn't apply the fix", text: err.message, actions: [{ label: "Open run", run: () => wm.open("run", { id: runId }) }, { label: "OK" }] }); } } },
            { label: "Later" },
          ],
        });
      } else if (phase === "applied") {
        setStatus(null);
        say({ key: `applied-${runId}`, issueId, title: "Fix applied", text: line, actions: [{ label: "Nice" }] });
      } else if (phase === "failed") {
        setStatus(null);
        say({ key: `run-${runId}`, issueId, title: `I couldn't fix #${issueId}`, text: String(line || "").slice(0, 260), actions: [{ label: "Open run", run: () => wm.open("run", { id: runId }) }, { label: "OK" }] });
      } else if (phase === "skipped") {
        setStatus(null);
      }
    }
  });

  // ---- pointer: click = menu, drag = drop onto an issue ----
  const targetAt = (x, y) => {
    const under = document.elementFromPoint(x, y);
    const w = under?.closest?.("[data-window-id]");
    const ic = under?.closest?.("[data-icon-id]");
    const app = w?.dataset.windowApp || ic?.dataset.iconId;
    if (!DROP_APPS.has(app)) return null;
    const issueId = Number(w?.querySelector("[data-s98-issue]")?.dataset.s98Issue) || null; // selected row / open issue
    return { app, issueId, windowId: w?.dataset.windowId || null, hotId: w?.dataset.windowId || ic?.dataset.iconId };
  };

  const onPointerDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { sx: e.clientX, sy: e.clientY, moved: false };
    const move = (ev) => {
      const d = drag.current;
      if (!d) return;
      if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 5) return;
      d.moved = true;
      setDragging(true);
      setMenu(false);
      const r = desktopRef.current.getBoundingClientRect();
      setPos({ x: ev.clientX - r.left - 20, y: ev.clientY - r.top - 20 });
      const t = targetAt(ev.clientX, ev.clientY);
      setHot(!!t);
      setHotTarget(t?.hotId || null);
    };
    const up = async (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const d = drag.current;
      drag.current = null;
      setDragging(false);
      setHot(false);
      setHotTarget(null);
      if (!d?.moved) return setMenu((m) => !m);
      // elementFromPoint must not hit the ghost itself: it has pointer-events none while dragging
      const t = targetAt(ev.clientX, ev.clientY);
      setPos(home());
      if (!t) return;
      try {
        let issue = null;
        if (t.issueId) issue = (await api(`issues/${t.issueId}`)).issue;
        else if (t.app === "issue" && t.windowId) issue = (await api(`issues/${t.windowId.split(":")[1]}`)).issue;
        else issue = (await api(`issues?status=open&sort=priority${t.app === "pages" ? "&verdict=page" : ""}`)).issues[0];
        if (!issue) return say({ key: "nothing", title: "Nothing to haunt", text: "There are no open issues there. Break something in the playground first.", actions: [{ label: "OK" }] });
        say({
          key: `drop-${issue.id}`, issueId: issue.id, color: ghostColor(issue.classification?.responder),
          title: `${ghostName(issue.classification?.responder)} takes #${issue.id}`,
          text: `${issue.type ? issue.type + ": " : ""}${issue.title}`,
          meta: issue.classification ? `JEV picked this responder${issue.classification.responder_conf != null ? ` (confidence ${issue.classification.responder_conf.toFixed(2)})` : ""}` : null,
          actions: [{ label: "Find the fix", primary: true, run: () => askFix(issue) }, { label: "Send an agent", run: () => sendAgent(issue) }, { label: "Cancel" }],
        });
      } catch (err) {
        say({ key: "drop-err", title: "That didn't work", text: err.message, actions: [{ label: "OK" }] });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const toggleAuto = async () => {
    setMenu(false);
    if (!autoMode && !repoConfigured) {
      return say({
        key: "need-repo", title: "Tell me where the code lives first",
        text: "Auto mode sends coding agents into your app's repository (on their own branch, in a worktree). Set the repository path and I can start.",
        actions: [{ label: "Ghost settings", primary: true, run: () => wm.open("settings", { tab: "ghost" }) }, { label: "Cancel" }],
      });
    }
    await api("settings", { method: "PATCH", body: { ghost: { autoMode: !autoMode } } }).catch(() => {});
    onSettingsChanged?.();
    say({
      key: "auto", title: !autoMode ? "Auto mode is ON" : "Auto mode is off",
      text: !autoMode
        ? "When JEV is confident an issue is a bounded defect in your code, I send an agent to fix it on a branch. If the bug comes back, I go again."
        : "I'll ask before doing anything.",
      actions: [{ label: "OK" }],
    });
  };

  if (!pos) return null;
  const working = !!status;
  const color = bubble?.color || status?.color || IDLE;
  // bubbles open up-and-left of the ghost, and flip when it is dragged near an edge
  const flipX = pos.x < 330, flipY = pos.y < 220;

  return (
    <>
      <div
        ref={el}
        className={`ghost${working ? " busy" : hot ? " excited" : ""}${autoMode ? " auto" : ""}`}
        onPointerDown={onPointerDown}
        title="click me · or drag me onto an issue"
        style={{ left: pos.x, top: pos.y, zIndex: dragging ? 9500 : 9000, pointerEvents: dragging ? "none" : "auto" }}
      >
        <GhostGlyph color={color} size={44} look={look} excited={hot || working} />
        <div className="ghost-label">{autoMode ? "ghost · auto" : "ghost"}</div>
      </div>

      {!dragging && (bubble || status) && (
        <div className="ghost-bubble" style={{ [flipX ? "left" : "right"]: flipX ? pos.x + 56 : `calc(100% - ${pos.x + 8}px)`, [flipY ? "top" : "bottom"]: flipY ? pos.y + 10 : `calc(100% - ${pos.y + 30}px)`, zIndex: 9001 }} onPointerDown={(e) => e.stopPropagation()}>
          {bubble ? (
            <>
              <div className="gb-title">{bubble.title}</div>
              {bubble.text && <div className="gb-text selectable">{bubble.text}</div>}
              {bubble.meta && <div className="gb-meta">{bubble.meta}</div>}
              {bubble.footnote && <div className="gb-meta"><i>{bubble.footnote}</i></div>}
              {status && <div className="gb-status">▸ {status.line}</div>}
              <div className="gb-actions">
                {(bubble.actions || []).map((a) => (
                  <button key={a.label} className="btn98 small" style={a.primary ? { fontWeight: "bold" } : undefined} onClick={() => { dismiss(); a.run?.(); }}>{a.label}</button>
                ))}
              </div>
              {queue.current.length > 0 && <div className="gb-meta">+{queue.current.length} more waiting</div>}
            </>
          ) : (
            <div className="gb-status">▸ {status.line}<span className="cursor-blink"> ▌</span></div>
          )}
        </div>
      )}

      {menu && !dragging && (
        <div className="ghost-menu raised" style={{ [flipX ? "left" : "right"]: flipX ? pos.x + 56 : `calc(100% - ${pos.x + 8}px)`, [flipY ? "top" : "bottom"]: flipY ? pos.y : `calc(100% - ${pos.y + 60}px)`, zIndex: 9002 }} onPointerDown={(e) => e.stopPropagation()}>
          <div className="start-item" onClick={toggleAuto}><span className="gm-check">{autoMode ? "✓" : ""}</span>Auto mode (fix bugs by myself)</div>
          <div className="start-sep" />
          <div className="start-item" onClick={() => { setMenu(false); wm.open("pages"); }}><span className="gm-check" />What needs attention?</div>
          <div className="start-item" onClick={() => { setMenu(false); wm.open("runs"); }}><span className="gm-check" />My agent runs</div>
          <div className="start-item" onClick={() => { setMenu(false); wm.open("settings", { tab: "ghost" }); }}><span className="gm-check" />Ghost settings…</div>
          {bubble && <div className="start-item" onClick={() => { setMenu(false); queue.current = []; setBubble(null); }}><span className="gm-check" />Be quiet</div>}
        </div>
      )}
    </>
  );
}
