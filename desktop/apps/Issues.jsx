"use client";
// Issues (app id `issues`) — the error-tracking list.
// Also the home of the tiny kit the sibling issue windows share (LiveFeed, IssueDetail, Pages,
// RecycleBin import from here): ConfirmDialog, patchIssue, headline, num, IssueTags, useSelection.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, useApi, ago, fmtNum, label, VERDICTS } from "../lib/client";
import { Spark, VerdictTag, JudgedBy } from "../components/charts";

// ---------------------------------------------------------------- shared kit
export const patchIssue = (id, body) => api(`issues/${id}`, { method: "PATCH", body });
export const headline = (i) => (i ? `${i.type ? `${i.type}: ` : ""}${i.title || "(no message)"}` : "");
export const num = (v, d = 1) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "–");

// A modal Win98 dialog scoped to the window it lives in: the parent must be `.iw-root`.
export function ConfirmDialog({ title, children, yes = "Yes", no = "No", danger = false, busy = false, onYes, onNo }) {
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);
  return (
    <div className="iw-veil" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onNo?.(); } }}>
      <div className="dialog raised" role="alertdialog" aria-label={title}>
        <div className="title-bar"><span className="ttitle">{title}</span></div>
        <div className="dbody">
          <svg width="32" height="32" viewBox="0 0 32 32" style={{ flex: "0 0 auto" }} aria-hidden="true">
            <path d="M16 3 L30 28 L2 28 Z" fill="#ffe100" stroke="#000" strokeWidth="1.5" />
            <rect x="14.5" y="11" width="3" height="10" fill="#000" /><rect x="14.5" y="23" width="3" height="3" fill="#000" />
          </svg>
          <div style={{ lineHeight: 1.5 }}>{children}</div>
        </div>
        <div className="dbuttons">
          <button className="btn98" ref={danger ? null : first} disabled={busy} onClick={onYes}>{busy ? "Working…" : yes}</button>
          <button className="btn98" ref={danger ? first : null} disabled={busy} onClick={onNo}>{no}</button>
        </div>
      </div>
    </div>
  );
}

export function IssueTags({ issue }) {
  if (!issue) return null;
  const fresh = issue.first_seen && Date.now() - issue.first_seen < 3_600_000;
  return (
    <span className="iw-tags">
      {fresh ? <span className="tag new">new</span> : null}
      {issue.regressed ? <span className="tag regressed">regressed</span> : null}
      {issue.has_fix ? <span className="tag">fix ready</span> : null}
      {issue.run ? <span className="tag" title={`agent run #${issue.run.id}, attempt ${issue.run.attempt ?? 1}`}>agent: {label(issue.run.status)}</span> : null}
      {issue.assignee ? <span className="tag">@{issue.assignee}</span> : null}
    </span>
  );
}

// Keyboard + mouse selection over a list of rows with `.id`. Keeps the cursor near where it
// was when the selected row leaves the list (e.g. it was just resolved).
export function useSelection(rows, onOpen) {
  const [selId, setSelId] = useState(null);
  const lastIndex = useRef(0);
  const wrap = useRef(null);
  const index = rows.findIndex((r) => r.id === selId);
  useEffect(() => {
    if (index >= 0) { lastIndex.current = index; return; }
    if (selId != null) setSelId(rows.length ? rows[Math.min(lastIndex.current, rows.length - 1)].id : null);
  }, [index, selId, rows]);
  useEffect(() => { wrap.current?.querySelector("tr.sel")?.scrollIntoView({ block: "nearest" }); }, [selId]);
  const onKeyDown = (e) => {
    if (!rows.length) return;
    const move = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key];
    let next = null;
    if (move) next = index < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, index + move));
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (e.key === "Enter" && index >= 0) { e.preventDefault(); onOpen?.(rows[index]); return; }
    if (next == null) return;
    e.preventDefault();
    setSelId(rows[next].id);
  };
  return { selId, setSelId, selected: index >= 0 ? rows[index] : null, wrapProps: { ref: wrap, tabIndex: 0, onKeyDown } };
}

// ---------------------------------------------------------------- the window
const STATUSES = ["open", "resolved", "ignored", "all"];
const KINDS = ["error", "network", "log", "ux"];
const SORTS = [["priority", "Priority"], ["last_seen", "Last seen"], ["count", "Events"], ["severity", "Severity"]];
const FALLBACK_CATEGORIES = ["payments", "auth", "rendering", "data", "network", "third_party", "database", "performance", "infrastructure", "security", "ux_friction", "noise"];

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function Row({ issue, sel, onSelect, onOpen }) {
  return (
    <tr className={sel ? "sel" : ""} onMouseDown={() => onSelect(issue.id)} onDoubleClick={() => onOpen(issue)}>
      <td><VerdictTag issue={issue} /></td>
      <td><JudgedBy by={issue.judged_by} /></td>
      <td className="num">{issue.priority == null ? "–" : Math.round(issue.priority)}</td>
      <td className="iw-fill" title={`#${issue.id} ${headline(issue)}${issue.culprit ? `\n${issue.culprit}` : ""}`}>
        {issue.type ? <b>{issue.type}: </b> : null}{issue.title || "(no message)"}
        {issue.culprit ? <span className="muted"> — {issue.culprit}</span> : null}
      </td>
      <td>{issue.category ? label(issue.category) : <span className="muted">…</span>}</td>
      <td className="num">{num(issue.severity)}</td>
      <td className="num">{fmtNum(issue.count)}</td>
      <td className="num">{fmtNum(issue.users)}</td>
      <td><Spark values={issue.spark || []} color={sel ? "#ffffff" : undefined} /></td>
      <td>{issue.last_seen ? ago(issue.last_seen) : "–"}</td>
      <td><IssueTags issue={issue} /></td>
    </tr>
  );
}

export default function Issues({ wm }) {
  const [f, setF] = useState({ status: "open", verdict: "", kind: "", category: "", sort: "priority" });
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const path = useMemo(() => {
    const qs = new URLSearchParams({ status: f.status, sort: f.sort });
    for (const k of ["verdict", "kind", "category"]) if (f[k]) qs.set(k, f[k]);
    if (q) qs.set("q", q);
    return `issues?${qs}`;
  }, [f, q]);
  const { data, error, loading, reload } = useApi(path, { on: ["verdict", "issue", "event"], every: 15000 });
  const meta = useApi("meta");
  const rows = useMemo(() => (Array.isArray(data?.issues) ? data.issues : []), [data]);
  const categories = Object.keys(meta.data?.taxonomy?.categories || {});

  const open = (issue) => issue && wm?.open?.("issue", { id: issue.id });
  const { selId, setSelId, selected, wrapProps } = useSelection(rows, open);

  const act = async (verb, body) => {
    if (!selected || busy) return;
    setBusy(true); setNote(null);
    try { await patchIssue(selected.id, body); setNote(`#${selected.id} ${verb}`); reload(); }
    catch (err) { setNote(`could not update #${selected.id}: ${err.message}`); }
    finally { setBusy(false); }
  };

  const counts = useMemo(() => {
    const c = { page: 0, notify: 0, ticket: 0, ignore: 0, judging: 0 };
    for (const i of rows) c[i.judge_status === "judged" && c[i.verdict] !== undefined ? i.verdict : "judging"]++;
    return c;
  }, [rows]);
  const filtered = f.verdict || f.kind || f.category || q || f.status !== "open";
  const sortHead = (key, text, cls = "") => (
    <th className={`iw-sort ${cls}`} onClick={() => setF((s) => ({ ...s, sort: key }))}>{text}{f.sort === key ? " ▼" : ""}</th>
  );

  return (
    <div className="iw-root" data-s98-issue={selId ?? undefined}>
      <div className="toolbar iw-wrap">
        {STATUSES.map((s) => (
          <button key={s} className={`tool-btn${f.status === s ? " on" : ""}`} onClick={() => setF((x) => ({ ...x, status: s }))}>{label(s)[0].toUpperCase() + s.slice(1)}</button>
        ))}
        <span className="iw-sep" />
        <button className="tool-btn" disabled={!selected} onClick={() => open(selected)}>Open</button>
        <button className="tool-btn" disabled={!selected || busy || selected.status === "resolved"} onClick={() => act("resolved", { status: "resolved" })}>Resolve</button>
        <button className="tool-btn" disabled={!selected || busy || selected.status === "ignored"} onClick={() => act("ignored", { status: "ignored" })}>Ignore</button>
        <button className="tool-btn" disabled={!selected || busy || selected.status === "open"} onClick={() => act("reopened", { status: "open" })}>Reopen</button>
      </div>
      <div className="toolbar iw-wrap">
        <select className="in98" value={f.verdict} onChange={set("verdict")} aria-label="verdict">
          <option value="">any verdict</option>
          {Object.keys(VERDICTS).map((v) => <option key={v} value={v}>{VERDICTS[v].label.toLowerCase()} — {VERDICTS[v].hint}</option>)}
        </select>
        <select className="in98" value={f.kind} onChange={set("kind")} aria-label="kind">
          <option value="">any kind</option>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select className="in98" value={f.category} onChange={set("category")} aria-label="category">
          <option value="">any category</option>
          {(categories.length ? categories : FALLBACK_CATEGORIES).map((c) => <option key={c} value={c}>{label(c)}</option>)}
        </select>
        <span className="muted">sort</span>
        <select className="in98" value={f.sort} onChange={set("sort")} aria-label="sort">
          {SORTS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
        </select>
        <input className="in98 grow" style={{ minWidth: 90 }} placeholder="search title, type, culprit…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="pane sunken iw-table" style={{ margin: "0 3px 3px" }} {...wrapProps}>
        <table className="t98">
          <thead><tr>
            <th>Verdict</th><th>Judged by</th>{sortHead("priority", "Pri", "num")}<th>Issue</th><th>Category</th>
            {sortHead("severity", "Sev", "num")}{sortHead("count", "Events", "num")}<th className="num">Users</th><th>24 h</th>{sortHead("last_seen", "Last seen")}<th>Tags</th>
          </tr></thead>
          <tbody>
            {rows.map((i) => <Row key={i.id} issue={i} sel={i.id === selId} onSelect={setSelId} onOpen={open} />)}
          </tbody>
        </table>
        {!rows.length && (
          error ? <div className="err">Cannot load issues: {error}. Retrying…</div>
          : loading ? <div className="iw-empty">…</div>
          : <div className="iw-empty">{filtered
              ? "Nothing matches these filters."
              : <>No open issues. Fire the playground at :3000 (or any app wrapped with the signal98 SDK) —<br />exceptions, failed requests, error logs and rage clicks group into issues here.</>}</div>
        )}
      </div>

      <div className="statusbar">
        <div className="cell sunken-thin">{rows.length}{rows.length >= 200 ? "+" : ""} issue(s)</div>
        {Object.keys(VERDICTS).map((v) => (
          <div key={v} className="cell sunken-thin"><i className="iw-swatch" style={{ background: VERDICTS[v].color }} />{VERDICTS[v].label} {counts[v]}</div>
        ))}
        {counts.judging ? <div className="cell sunken-thin">judging… {counts.judging}</div> : null}
        <div className="cell grow sunken-thin" style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
          {error && rows.length ? <span style={{ color: "#a00000" }}>API unreachable, showing last known list — {error}</span>
            : note || "Enter opens · drag the ghost onto this window to unleash it"}
        </div>
      </div>
    </div>
  );
}
