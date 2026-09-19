"use client";
// Live Feed (app id `feed`) — the tail. Backfills from /api/events, then appends from the shared
// SSE stream. Issue-linked rows show "judging…" until the `verdict` message for their issue
// arrives; the row is patched in place and flashes — that delay is the product's signature.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, useStream, useStreamStatus, fmtTime, label } from "../lib/client";
import { VerdictTag, JudgedBy } from "../components/charts";
import { ConfirmDialog, num } from "./Issues";

const CAP = 500;
const BACKFILL = "events?limit=150";
const LAND_MS = 2000;

// event name → what a human calls it (colour is decoration; the word carries the meaning)
const KINDS = {
  $exception: ["exception", "#d03b3b"], $network_error: ["network error", "#b86a00"], $log: ["log", "#7a5c00"],
  $rageclick: ["rage click", "#8a2be2"], $dead_click: ["dead click", "#8a2be2"], $pageview: ["pageview", "#2a78d6"],
  $pageleave: ["page leave", "#2a78d6"], $autocapture: ["click", "#808080"], $web_vitals: ["web vital", "#008080"],
  $identify: ["identify", "#008300"], $feature_flag_called: ["flag", "#808080"],
};
const kindOf = (e) => {
  const k = KINDS[e.event];
  if (!k) return { text: e.event?.startsWith("$") ? e.event.slice(1) : "custom", color: "#000" };
  return { text: e.event === "$log" && e.level ? `log · ${e.level}` : k[0], color: k[1] };
};

const FILTERS = {
  all: ["All", () => true],
  errors: ["Errors", (e) => e.issue_id != null || e.event === "$exception" || e.event === "$network_error"],
  product: ["Product events", (e) => !String(e.event).startsWith("$") || e.event === "$identify"],
  nav: ["Pageviews + clicks", (e) => e.event === "$pageview" || e.event === "$pageleave" || e.event === "$autocapture"],
};

const judged = (issue) => !!issue && issue.judge_status === "judged" && !!issue.verdict;

// Merge rows by id, oldest → newest, newest CAP kept. Incoming issue info wins unless it would
// downgrade a verdict we already showed.
function merge(prev, incoming) {
  if (!incoming.length) return prev;
  const map = new Map(prev.map((r) => [r.id, r]));
  for (const r of incoming) {
    const old = map.get(r.id);
    map.set(r.id, old ? { ...old, ...r, _at: old._at, _landed: old._landed, issue: judged(old.issue) && !judged(r.issue) ? old.issue : r.issue } : r);
  }
  return [...map.values()].sort((a, b) => a.id - b.id).slice(-CAP);
}

// Apply a verdict to every row of that issue. Returns the same array when nothing changed.
function applyVerdict(rows, issue, now) {
  if (!rows.some((r) => r.issue_id === issue.id)) return rows;
  return rows.map((r) => {
    if (r.issue_id !== issue.id) return r;
    const landed = !judged(r.issue) || r.issue.verdict !== issue.verdict;
    return { ...r, issue: { ...r.issue, ...issue }, _landed: landed ? now : r._landed };
  });
}

export const FeedRow = memo(function FeedRow({ row, onIssue, onSession }) {
  const k = kindOf(row);
  const where = [row.service, row.pathname].filter(Boolean).join(" · ");
  const landed = row._landed && Date.now() - row._landed < LAND_MS;
  const i = row.issue;
  return (
    <div className={`feed-row${row.issue_id ? " link" : ""}${landed ? " landed" : ""}`} onClick={row.issue_id ? () => onIssue(row.issue_id) : undefined}
      title={row.issue_id ? `open issue #${row.issue_id}` : undefined}>
      <span className="t">{fmtTime(row.ts)}</span>
      <span><i className="feed-dot" style={{ background: k.color }} />{k.text}</span>
      <span className="msg" title={row.message || ""}>
        {row.issue_created ? <><span className="tag new">new</span> </> : null}
        {row.issue_regressed ? <><span className="tag regressed">regressed</span> </> : null}
        {row.message || row.event}
      </span>
      <span className="where" title={where}>{where || "–"}</span>
      <span>{row.session_id ? <button className="iw-link" title={`session ${row.session_id}`} onClick={(e) => { e.stopPropagation(); onSession(row.session_id); }}>session</button> : null}</span>
      <span className="verdict">
        {i ? <>
          <VerdictTag issue={i} />
          {judged(i) ? <>
            <span className="cat">{label(i.category) || "–"}</span>
            <span className="muted">sev {num(i.severity)}</span>
            <JudgedBy by={i.judged_by} />
          </> : null}
        </> : null}
      </span>
    </div>
  );
});

export default function LiveFeed({ wm }) {
  const [rows, setRows] = useState([]);
  const [state, setState] = useState({ loading: true, error: null });
  const [paused, setPaused] = useState(false);
  const [heldCount, setHeldCount] = useState(0);
  const [filter, setFilter] = useState("all");
  const [text, setText] = useState("");
  const [unseen, setUnseen] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [note, setNote] = useState(null);
  const [, tick] = useState(0);
  const status = useStreamStatus();

  const wmRef = useRef(wm); wmRef.current = wm;
  const pausedRef = useRef(false); pausedRef.current = paused;
  const queue = useRef([]);   // arrived, not yet rendered (bursts are flushed once per frame)
  const held = useRef([]);    // arrived while paused
  const flushTimer = useRef(null);
  const box = useRef(null);
  const stick = useRef(true);

  const flush = useCallback(() => {
    flushTimer.current = null;
    const batch = queue.current; queue.current = [];
    if (!batch.length) return;
    setRows((prev) => merge(prev, batch));
    if (!stick.current) setUnseen((n) => n + batch.length);
  }, []);
  const enqueue = useCallback((list) => {
    queue.current.push(...list);
    if (!flushTimer.current) flushTimer.current = setTimeout(flush, 60);
  }, [flush]);

  // Backfill; also used to re-sync after a reconnect or an issue status change.
  const sync = useCallback(async () => {
    try {
      const d = await api(BACKFILL);
      const list = (Array.isArray(d?.events) ? d.events : []).map((e) => ({ ...e, _at: e.ts })).reverse();
      if (pausedRef.current) setRows((prev) => merge(prev, list.filter((e) => prev.some((r) => r.id === e.id)))); // paused: refresh, do not append
      else setRows((prev) => merge(prev, list));
      setState({ loading: false, error: null });
      return true;
    } catch (err) {
      setState({ loading: false, error: err.message });
      return false;
    }
  }, []);

  useEffect(() => {
    let alive = true, t = null;
    const attempt = async () => { if (!(await sync()) && alive) t = setTimeout(attempt, 5000); };
    attempt();
    const clock = setInterval(() => tick((n) => n + 1), 5000); // keeps events/min honest while idle
    return () => { alive = false; clearTimeout(t); clearInterval(clock); clearTimeout(flushTimer.current); flushTimer.current = null; };
  }, [sync]);

  const wasLive = useRef(false);
  useEffect(() => {
    if (status === "live" && wasLive.current === "lost") sync();
    wasLive.current = status === "live" ? "live" : wasLive.current ? "lost" : false;
  }, [status, sync]);

  const resyncTimer = useRef(null);
  useStream((msg) => {
    if (msg.type === "event" && msg.data?.event?.id != null) {
      const row = { ...msg.data.event, issue: msg.data.issue || null, _at: Date.now() };
      if (pausedRef.current) { held.current.push(row); if (held.current.length > CAP) held.current.shift(); setHeldCount(held.current.length); }
      else enqueue([row]);
    } else if (msg.type === "verdict" && msg.data?.issue?.id != null) {
      const { id, status: st, verdict, category, severity, judge_status, judged_by } = msg.data.issue;
      const issue = { id, status: st, verdict, category, severity, judge_status, judged_by };
      const now = Date.now();
      queue.current = applyVerdict(queue.current, issue, now);
      held.current = applyVerdict(held.current, issue, now);
      setRows((prev) => applyVerdict(prev, issue, now));
    } else if (msg.type === "issue") {
      clearTimeout(resyncTimer.current);
      resyncTimer.current = setTimeout(sync, 600); // resolved / ignored / merged: refresh what the rows say
    } else if (msg.type === "reset") {
      queue.current = []; held.current = [];
      setRows([]); setHeldCount(0); setUnseen(0);
    }
  });
  useEffect(() => () => clearTimeout(resyncTimer.current), []);

  const togglePause = () => {
    if (paused) { const h = held.current; held.current = []; setHeldCount(0); enqueue(h); }
    setPaused(!paused);
  };

  const visible = useMemo(() => {
    const test = FILTERS[filter][1];
    const needle = text.trim().toLowerCase();
    return rows.filter((e) => test(e) && (!needle ||
      [e.message, e.event, e.service, e.pathname, e.distinct_id, e.issue?.category, e.issue?.verdict].some((v) => v && String(v).toLowerCase().includes(needle))));
  }, [rows, filter, text]);

  // Follow the tail unless the user scrolled up to read something.
  const toBottom = () => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; stick.current = true; setUnseen(0); };
  useLayoutEffect(() => { if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight; }, [visible]);
  useLayoutEffect(toBottom, [filter]);
  const onScroll = () => {
    const el = box.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
    if (stick.current && unseen) setUnseen(0);
  };

  const onIssue = useCallback((id) => wmRef.current?.open?.("issue", { id }), []);
  const onSession = useCallback((id) => wmRef.current?.open?.("session", { id }), []);

  const doClear = async () => {
    setClearing(true);
    try {
      await api("events", { method: "DELETE" });
      queue.current = []; held.current = [];
      setRows([]); setHeldCount(0); setUnseen(0); setNote(null);
    } catch (err) { setNote(`clear failed: ${err.message}`); }
    finally { setClearing(false); setConfirm(false); }
  };

  const cutoff = Date.now() - 60_000;
  const perMin = rows.reduce((n, r) => n + (r._at >= cutoff ? 1 : 0), 0);

  return (
    <div className="iw-root">
      <div className="toolbar iw-wrap">
        <button className={`tool-btn${paused ? " on" : ""}`} onClick={togglePause} title={paused ? "resume the tail" : "freeze the list; events are held, verdicts still land"}>{paused ? "▶ Run" : "❚❚ Pause"}</button>
        <span className="iw-sep" />
        {Object.entries(FILTERS).map(([k, [name]]) => (
          <button key={k} className={`tool-btn${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{name}</button>
        ))}
        <input className="in98 grow" style={{ minWidth: 90 }} placeholder="filter text…" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="tool-btn" onClick={() => setConfirm(true)} disabled={!rows.length && !state.error}>Clear</button>
      </div>

      <div className="feed sunken" ref={box} onScroll={onScroll}>
        <div className="feed-head"><span>Time</span><span>Kind</span><span>Message</span><span>Service · page</span><span /><span>Verdict</span></div>
        {visible.map((r) => <FeedRow key={r.id} row={r} onIssue={onIssue} onSession={onSession} />)}
        {!visible.length && (
          state.loading ? <div className="iw-empty">…</div>
          : state.error && !rows.length ? <div className="err">Cannot reach the API ({state.error}). Retrying every 5 s…</div>
          : rows.length ? <div className="iw-empty">Nothing in the feed matches this filter.</div>
          : <div className="iw-empty">The feed is empty. Fire the playground at :3000 (or any app wrapped with the signal98 SDK)<br />and watch events land here — errors show “judging…” until the verdict arrives.</div>
        )}
        {unseen > 0 && <button className="btn98 small feed-jump" onClick={toBottom}>▼ {unseen} new</button>}
      </div>

      <div className="statusbar">
        <div className="cell sunken-thin" title="server-sent events stream">{status === "live" ? "● live" : status === "connecting" ? "○ connecting…" : "○ reconnecting…"}</div>
        {paused ? <div className="cell sunken-thin">paused · {heldCount} held</div> : null}
        <div className="cell grow sunken-thin" style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
          {note ? <span style={{ color: "#a00000" }}>{note}</span>
            : state.error && rows.length ? <span style={{ color: "#a00000" }}>API unreachable — {state.error}</span>
            : "click an error to open its issue"}
        </div>
        <div className="cell sunken-thin">{visible.length === rows.length ? `${rows.length} events` : `${visible.length} of ${rows.length} events`}{rows.length >= CAP ? ` (last ${CAP})` : ""}</div>
        <div className="cell sunken-thin">{perMin >= CAP ? `${CAP}+` : perMin} events/min</div>
      </div>

      {confirm && (
        <ConfirmDialog title="Clear captured data" danger busy={clearing} yes="Clear" no="Cancel" onYes={doClear} onNo={() => setConfirm(false)}>
          This does more than empty this window: it permanently deletes <b>all captured events, issues, sessions, persons, fix reports and agent runs</b> for this project.
          Alert rules, channels, flags and settings are kept.<br /><br />Clear everything?
        </ConfirmDialog>
      )}
    </div>
  );
}
