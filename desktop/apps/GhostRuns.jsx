"use client";
// Ghost runs: every coding-agent run the ghost started (or refused to start, with the reason).
// Live on `agent` stream messages { issue_id, run_id, phase, line }.
import { useEffect, useRef, useState } from "react";
import { useApi, useStream, useStreamStatus, fmtDateTime, fmtDuration, fmtUsd, ago } from "../lib/client";

export const RUN_STATUS = {
  queued: { label: "QUEUED", color: "#6b6b6b", hint: "waiting — the ghost runs one agent at a time" },
  running: { label: "RUNNING", color: "#2a78d6", hint: "an agent is working in its own worktree" },
  succeeded: { label: "SUCCEEDED", color: "#006300", hint: "a diff is ready on its branch — review it, then apply" },
  applied: { label: "APPLIED", color: "#000080", hint: "the diff was applied to the working tree and the issue resolved" },
  failed: { label: "FAILED", color: "#a00000", hint: "the agent errored or changed nothing" },
  skipped: { label: "SKIPPED", color: "#808080", hint: "the run never started — the summary says why" },
};
const ACTIVE = new Set(["queued", "running"]);

export function RunStatus({ status }) {
  const s = RUN_STATUS[status] || { label: String(status ?? "–").toUpperCase(), color: "#6b6b6b" };
  return <span className="vtag" style={{ color: s.color, borderColor: s.color }} title={s.hint}>{s.label}</span>;
}

export const TRIGGERS = { manual: "manual", auto: "auto", regression: "regression" };

// running → ticks; finished → fixed; never started → null
export function runDuration(run, now) {
  if (!run?.started_at) return null;
  if (run.status === "running") return Math.max(0, now - run.started_at);
  return run.finished_at ? Math.max(0, run.finished_at - run.started_at) : null;
}

export function useNow(active, every = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [active, every]);
  return now;
}

const firstLine = (s) => String(s || "").split("\n").find((l) => l.trim())?.trim() || "";
const lastLine = (s) => String(s || "").split("\n").filter((l) => l.trim()).pop() || "";

const FILTERS = [["all", "All"], ["active", "Active"], ["ready", "Ready to apply"], ["applied", "Applied"], ["failed", "Failed"], ["skipped", "Skipped"]];
const matches = (r, f) => f === "all" || (f === "active" ? ACTIVE.has(r.status) : f === "ready" ? r.status === "succeeded" : r.status === f);

export default function GhostRuns({ wm }) {
  const runs = useApi("agent/runs", { every: 20000 });
  const stream = useStreamStatus();
  const [filter, setFilter] = useState("all");
  const [sel, setSel] = useState(null);
  const [lines, setLines] = useState({}); // run_id → latest progress line from the stream
  const timer = useRef(null);
  const known = useRef(new Map());
  const list = runs.data?.runs || [];
  known.current = new Map(list.map((r) => [r.id, r.status]));

  // Progress lines update the strip in place; only a change of phase is worth a reload.
  useStream((m) => {
    if (m.type !== "agent" || !m.data?.run_id) return; // fix proposals ("thinking") carry no run_id
    const { run_id, phase, line } = m.data;
    if (line) setLines((l) => ({ ...l, [run_id]: String(line) }));
    const have = known.current.get(run_id);
    if (phase !== "running" || have !== "running") {
      clearTimeout(timer.current);
      timer.current = setTimeout(runs.reload, 200);
    }
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const running = list.find((r) => r.status === "running") || null;
  const queued = list.filter((r) => r.status === "queued").length;
  const now = useNow(!!running);
  const shown = list.filter((r) => matches(r, filter));
  const cost = list.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  const openRun = (r) => { setSel(r.id); wm?.open?.("run", { id: r.id }); };

  return (
    <div className="s98-app">
      <div className="toolbar">
        {FILTERS.map(([k, name]) => {
          const n = k === "all" ? list.length : list.filter((r) => matches(r, k)).length;
          return <button key={k} type="button" className={`tool-btn${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{name}{runs.data && k !== "all" && n ? ` (${n})` : ""}</button>;
        })}
        <span className="grow" />
        <button type="button" className="tool-btn" onClick={() => wm?.open?.("settings", { tab: "ghost" })}>Ghost settings…</button>
        <button type="button" className="tool-btn" onClick={runs.reload}>Refresh</button>
      </div>

      <div className="nowstrip sunken-thin" aria-live="polite">
        {running ? (
          <>
            <b>now working</b>
            <span>run #{running.id} · issue #{running.issue_id} · {fmtDuration(runDuration(running, now))}</span>
            <span className="ln" title={lines[running.id] || undefined}>&gt; {lines[running.id] || lastLine(running.log_tail) || "starting…"}<span className="cursor-blink">_</span></span>
          </>
        ) : (
          <span className="ln">{runs.data ? `The ghost is idle.${queued ? ` ${queued} queued.` : ""}` : "…"}</span>
        )}
      </div>

      {runs.error && runs.data ? <div className="err">Showing the last good copy — reload failed: {runs.error}</div> : null}
      <div className="pane sunken" style={{ margin: "0 4px 4px" }}>
        {runs.loading && !runs.data ? <div className="muted pad">Loading runs…</div>
          : runs.error && !runs.data ? <div className="err">Could not load agent runs: {runs.error}. Is the backend on :3001 running?</div>
          : list.length === 0 ? (
            <div className="muted pad" style={{ lineHeight: 1.6 }}>
              No agent runs yet. Open an issue and send the ghost's agent at it, or switch on Auto mode in{" "}
              <button type="button" className="link98" onClick={() => wm?.open?.("settings", { tab: "ghost" })}>Settings → Ghost</button>.
              The agent needs the Claude Code CLI and the monitored app's repository path; without them a run is recorded here as SKIPPED with the reason.
            </div>
          ) : shown.length === 0 ? <div className="muted pad">No runs match this filter ({list.length} in total).</div>
          : (
            <table className="t98">
              <thead><tr><th>Status</th><th>Issue</th><th>Trigger</th><th className="num">Attempt</th><th>Started</th><th className="num">Duration</th><th className="num">Cost</th><th>Summary</th></tr></thead>
              <tbody>
                {shown.map((r) => {
                  const d = runDuration(r, now);
                  const started = r.started_at || r.created_at;
                  const summary = r.status === "running" ? lines[r.id] || lastLine(r.log_tail) : firstLine(r.summary);
                  return (
                    <tr key={r.id} className={sel === r.id ? "sel" : ""} onClick={() => openRun(r)} style={{ cursor: "pointer" }}>
                      <td><RunStatus status={r.status} />{r.status === "succeeded" && r.has_diff ? <span className="muted"> diff</span> : null}</td>
                      <td>
                        <button type="button" className="link98" title="Open the issue" onClick={(e) => { e.stopPropagation(); wm?.open?.("issue", { id: r.issue_id }); }}>
                          #{r.issue_id} {r.issue_title ? `${r.issue_type ? r.issue_type + ": " : ""}${r.issue_title}` : "(issue deleted)"}
                        </button>
                      </td>
                      <td>{TRIGGERS[r.trigger] || r.trigger || "–"}</td>
                      <td className="num">{r.attempt ?? "–"}</td>
                      <td title={started ? fmtDateTime(started) : undefined}>{started ? ago(started) : "–"}</td>
                      <td className="num">{d == null ? "–" : fmtDuration(d)}</td>
                      <td className="num">{fmtUsd(r.cost_usd)}</td>
                      <td title={summary || undefined}>{summary || <span className="muted">–</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </div>

      <div className="statusbar">
        <div className="cell grow sunken-thin">{runs.data ? `${list.length} run${list.length === 1 ? "" : "s"} (latest 50) — click a row for the diff and log` : "…"}</div>
        <div className="cell sunken-thin">{list.filter((r) => r.status === "succeeded").length} ready to apply</div>
        <div className="cell sunken-thin">spent {cost ? fmtUsd(cost) : "$0"}</div>
        <div className="cell sunken-thin">stream {stream}</div>
      </div>
    </div>
  );
}
