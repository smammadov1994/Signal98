"use client";
// One ghost agent run: what it said, the diff it produced on its branch, its log, and the
// button that applies the diff to the real working tree. params.id = run id.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, useApi, useStream, fmtDateTime, fmtDuration, fmtUsd, ago } from "../lib/client";
import { Confirm, CopyButton } from "./Alerts";
import { RunStatus, RUN_STATUS, TRIGGERS, runDuration, useNow } from "./GhostRuns";

// Unified diff → classified lines. "--- "/"+++ " are file headers only before the first hunk of
// a file; inside a hunk a removed SQL comment also starts with "---".
function parseDiff(diff) {
  const lines = String(diff || "").replace(/\n$/, "").split("\n");
  const out = [], files = [];
  let inHunk = false, file = null;
  for (const text of lines) {
    let kind = "ctx";
    if (text.startsWith("diff --git ")) {
      inHunk = false;
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(text);
      file = { path: m ? m[2] : text.slice(11), add: 0, del: 0 };
      files.push(file);
      kind = "fh";
    } else if (text.startsWith("@@")) { inHunk = true; kind = "hunk"; }
    else if (!inHunk) kind = /^(--- |\+\+\+ )/.test(text) ? "fh" : "meta"; // index, new file mode, rename from…
    else if (text.startsWith("+")) { kind = "add"; if (file) file.add++; }
    else if (text.startsWith("-")) { kind = "del"; if (file) file.del++; }
    else if (text.startsWith("\\")) kind = "meta"; // "\ No newline at end of file"
    out.push({ kind, text });
  }
  return { lines: out, files, add: files.reduce((s, f) => s + f.add, 0), del: files.reduce((s, f) => s + f.del, 0) };
}

function Diff({ parsed }) {
  return (
    <pre className="code diff selectable">
      {parsed.lines.map((l, i) => (l.kind === "ctx" ? <span key={i}>{l.text + "\n"}</span> : <span key={i} className={l.kind}>{l.text || " "}</span>))}
    </pre>
  );
}

export default function RunDetail({ wm, params, nonce }) {
  const id = Number(params?.id) || null;
  const res = useApi(id ? `agent/runs/${id}` : null);
  const meta = useApi("meta", { on: ["settings"] });
  const run = res.data?.run && res.data.run.id === id ? res.data.run : null;
  const issue = useApi(run?.issue_id ? `issues/${run.issue_id}` : null, { on: ["issue"] });
  const issueRow = issue.data?.issue || null;

  const [extra, setExtra] = useState([]);       // progress lines streamed since the last load
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState(null);
  const timer = useRef(null);
  const logRef = useRef(null);
  const stick = useRef(true);

  const active = run?.status === "running" || run?.status === "queued";
  const now = useNow(run?.status === "running");

  useEffect(() => { setExtra([]); setApplyError(null); setConfirming(false); }, [id]);
  useEffect(() => { if (nonce) res.reload(); /* re-opened from elsewhere: make sure it is fresh */ }, [nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // while it runs: append lines as they stream in, reconcile with the server now and then
  useStream((m) => {
    if (m.type !== "agent" || !id || m.data?.run_id !== id) return;
    if (m.data.phase === "running" && m.data.line) setExtra((x) => [...x.slice(-200), String(m.data.line)]);
    if (m.data.phase !== "running") { clearTimeout(timer.current); timer.current = setTimeout(res.reload, 150); }
  });
  useEffect(() => {
    if (!active) return;
    const t = setInterval(res.reload, 8000);
    return () => clearInterval(t);
  }, [active, res.reload]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // server tail + whatever streamed in after it (dropping lines the tail already contains)
  const log = useMemo(() => {
    const tail = String(run?.log_tail || "").replace(/\n+$/, "");
    const tailLines = tail ? tail.split("\n") : [];
    const lastSeen = tailLines.length ? extra.lastIndexOf(tailLines[tailLines.length - 1]) : -1;
    return [...tailLines, ...extra.slice(lastSeen + 1)].join("\n");
  }, [run?.log_tail, extra]);

  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  const parsed = useMemo(() => (run?.diff ? parseDiff(run.diff) : null), [run?.diff]);
  const issueTitle = issueRow ? `${issueRow.type ? issueRow.type + ": " : ""}${issueRow.title || ""}` : null;

  useEffect(() => {
    if (!id) return;
    wm?.setTitle?.(`Run #${id}${run ? ` · ${RUN_STATUS[run.status]?.label || run.status}` : ""}${issueTitle ? ` — ${issueTitle}` : ""}`);
  }, [wm, id, run?.status, issueTitle]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async () => {
    setBusy(true); setApplyError(null);
    try {
      await api(`agent/runs/${id}/apply`, { method: "POST" });
      setConfirming(false);
    } catch (err) {
      setApplyError(err.message);
      setConfirming(false); // the error stays on the window, next to the button, where it can be read and copied
    }
    setBusy(false);
    res.reload(); issue.reload();
  };

  if (!id) return <div className="s98-app"><div className="muted pad">No run selected. Open one from the Ghost runs window.</div><div className="statusbar"><div className="cell grow sunken-thin">–</div></div></div>;

  const repo = meta.data?.project?.settings?.ghost?.repoPath || "";
  const canApply = run?.status === "succeeded" && !!run.diff;
  const d = run ? runDuration(run, now) : null;

  return (
    <div className="s98-app">
      <div className="toolbar">
        <button type="button" className="tool-btn" disabled={!canApply || busy} style={canApply ? { fontWeight: "bold" } : undefined}
          title={canApply ? "Apply this diff to the configured repository" : run?.status === "applied" ? "Already applied" : "Only a succeeded run with a diff can be applied"}
          onClick={() => { setApplyError(null); setConfirming(true); }}>
          {busy ? "Applying…" : "Apply fix to working tree…"}
        </button>
        <button type="button" className="tool-btn" disabled={!run?.issue_id} onClick={() => wm?.open?.("issue", { id: run.issue_id })}>Open issue</button>
        <button type="button" className="tool-btn" onClick={() => wm?.open?.("runs")}>All runs</button>
        <span className="grow" />
        <button type="button" className="tool-btn" onClick={res.reload}>Refresh</button>
      </div>

      {res.loading && !run ? <div className="grow muted pad">Loading run #{id}…</div>
        : res.error && !run ? <div className="grow"><div className="err">Could not load run #{id}: {res.error}</div><div className="muted pad">Runs are deleted when the Live Feed is cleared. <button type="button" className="link98" onClick={() => wm?.open?.("runs")}>See all runs</button></div></div>
        : !run ? <div className="grow muted pad">…</div>
        : (
          <div className="grow scroll">
            {res.error ? <div className="err">Showing the last good copy — reload failed: {res.error}</div> : null}
            <dl className="kv98" style={{ padding: "6px 8px" }}>
              <dt>Status</dt>
              <dd><RunStatus status={run.status} /> <span className="muted">{RUN_STATUS[run.status]?.hint || ""}</span></dd>
              <dt>Issue</dt>
              <dd><button type="button" className="link98" onClick={() => wm?.open?.("issue", { id: run.issue_id })}>#{run.issue_id} {issueTitle ?? (issue.error ? "(issue no longer exists)" : "…")}</button>
                {issueRow?.status ? <span className="muted"> · {issueRow.status}{issueRow.regressed ? ", regressed" : ""}</span> : null}</dd>
              <dt>Branch</dt>
              <dd>{run.branch ? <><span className="mono selectable">{run.branch}</span> <CopyButton text={run.branch} /> <span className="muted">contains the starting snapshot and fix; the worktree is removed after the run</span></> : <span className="muted">none — the run never got as far as creating one</span>}</dd>
              <dt>Attempt / trigger</dt>
              <dd>attempt {run.attempt ?? "–"} · {TRIGGERS[run.trigger] || run.trigger || "–"}{run.trigger === "regression" ? " (the issue came back after a fix)" : run.trigger === "auto" ? " (Auto mode)" : ""}</dd>
              <dt>Time / cost</dt>
              <dd>{run.started_at ? `started ${fmtDateTime(run.started_at)} (${ago(run.started_at)})` : `created ${fmtDateTime(run.created_at)}`} · {d == null ? "no run time" : fmtDuration(d)} · {run.cost_usd == null ? "cost –" : fmtUsd(run.cost_usd)}</dd>
            </dl>

            {applyError ? (
              <div className="warn98 danger" style={{ margin: "0 6px 6px" }}>
                <div className="grow"><b>The fix was not applied.</b> git said:
                  <pre className="code selectable" style={{ background: "transparent", padding: "4px 0 0" }}>{applyError}</pre>
                  <span className="muted">Nothing was marked resolved. Usual causes: the files changed since the run, or uncommitted edits conflict. The fix remains available in the saved diff and branch.</span>
                </div>
              </div>
            ) : null}
            {run.status === "applied" ? <div className="note98" style={{ margin: "0 6px 6px" }}>Applied to the working tree and the issue was resolved. If the bug fires again the issue regresses, is re-judged, and the ghost tries again knowing what did not hold.</div> : null}

            <div className="sect98">{run.status === "skipped" ? "Why it was skipped" : run.status === "failed" ? "What went wrong" : "Agent's summary"}</div>
            <div className="pad selectable" style={{ background: "#fff", whiteSpace: "pre-wrap", lineHeight: 1.5, overflowWrap: "anywhere" }}>
              {run.summary || <span className="muted">{active ? "The agent has not reported yet — it writes its summary when it finishes." : "No summary was recorded."}</span>}
            </div>

            <div className="sect98">Diff {parsed ? <span className="muted">{parsed.files.length} file{parsed.files.length === 1 ? "" : "s"} · +{parsed.add} −{parsed.del}</span> : null}
              <span className="grow" />{run.diff ? <CopyButton text={run.diff}>Copy patch</CopyButton> : null}</div>
            {parsed ? (
              <>
                <div className="pad selectable" style={{ background: "#fff", paddingBottom: 0 }}>
                  {parsed.files.map((f, i) => <div key={i} className="mono">{f.path} <span style={{ color: "#006300" }}>+{f.add}</span> <span style={{ color: "#a00000" }}>−{f.del}</span></div>)}
                </div>
                <Diff parsed={parsed} />
              </>
            ) : (
              <div className="pad muted" style={{ background: "#fff" }}>
                {active ? "No diff yet — it is taken when the agent finishes." : run.status === "skipped" ? "The run never started, so there is no diff." : "This run produced no code change."}
              </div>
            )}

            <div className="sect98">Log <span className="muted">last lines{run.status === "running" ? ", live" : ""}</span></div>
            <pre className="runlog" ref={logRef}
              onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
              {log || (run.status === "queued" ? "queued — waiting for the ghost to be free" : "(no log)")}{run.status === "running" ? <span className="cursor-blink"> _</span> : null}
            </pre>
          </div>
        )}

      <div className="statusbar">
        <div className="cell grow sunken-thin">{run ? (canApply ? "Review the diff, then apply it to your current files" : RUN_STATUS[run.status]?.hint || run.status) : "…"}</div>
        <div className="cell sunken-thin">{parsed ? `+${parsed.add} −${parsed.del}` : "no diff"}</div>
        <div className="cell sunken-thin">run #{id}</div>
      </div>

      {confirming ? (
        <Confirm title="Apply fix to working tree" okLabel="Apply fix" busy={busy} onOk={apply} onCancel={() => setConfirming(false)}>
          <p>This applies only the fix from run #{id} in <span className="mono selectable">{repo || "the repository configured in Settings → Ghost"}</span> — your real working tree, on whatever branch is checked out — and marks issue #{run?.issue_id} <b>resolved</b>.</p>
          <p>A running dev server will hot-reload the change. Your staging is preserved. Conflicting edits cause the apply to stop. If the bug comes back, the issue regresses and the ghost tries again, knowing this fix did not hold.</p>
        </Confirm>
      ) : null}
    </div>
  );
}
