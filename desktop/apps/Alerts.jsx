"use client";
// Alerts: rules decide WHEN, channels decide WHERE, and the Outbox shows exactly what went out —
// or would have: dry runs are first-class, so nobody has to guess. Also owns browser-push
// enrolment (public/sw.js).
//
// This file also exports the small in-window dialog kit (Dialog, Confirm, CopyButton, WarnIcon)
// that Settings / RunDetail reuse: window.confirm/alert are never used.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, useApi, useStreamStatus, fmtDateTime, ago, label, VERDICTS } from "../lib/client";

// ================================================================ shared dialog kit
export function WarnIcon({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ flex: "0 0 auto" }}>
      <path d="M16 3 30 28H2z" fill="#ffd800" stroke="#000" strokeWidth="1.5" strokeLinejoin="round" />
      <rect x="14.5" y="11" width="3" height="9" fill="#000" />
      <rect x="14.5" y="22" width="3" height="3" fill="#000" />
    </svg>
  );
}

const FOCUSABLE = "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])";

// A modal that lives inside its window (the app root must be `.s98-app`). It is a <form>, so
// Enter submits; Escape closes; Tab stays inside.
export function Dialog({ title, onClose, onSubmit, children, buttons, width = 390, busy = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const el = root.querySelector("[data-autofocus]") ||
      root.querySelector(".modal98-body input:not([type=checkbox]):not([disabled]), .modal98-body select:not([disabled])") ||
      root.querySelector("button[type=submit]");
    try { el?.focus(); if (el?.tagName === "INPUT" && el.type === "text") el.select(); } catch { /* focus is a nicety */ }
  }, []);
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!busy) onClose?.();
    } else if (e.key === "Tab" && ref.current) {
      const els = [...ref.current.querySelectorAll(FOCUSABLE)];
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  return (
    <div className="modal98-veil" onKeyDown={onKeyDown}>
      <form ref={ref} className="modal98 raised" style={{ width }} noValidate
        onSubmit={(e) => { e.preventDefault(); if (!busy) onSubmit?.(); }}>
        <div className="modal98-title">
          <span>{title}</span>
          <button type="button" className="tbtn" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg width="8" height="7" viewBox="0 0 8 7"><path d="M0 0h2l2 2 2-2h2L5 3.5 8 7H6L4 5 2 7H0l3-3.5z" fill="#000" /></svg>
          </button>
        </div>
        <div className="modal98-body">{children}</div>
        <div className="modal98-btns">{buttons}</div>
      </form>
    </div>
  );
}

export function Confirm({ title = "Confirm", children, okLabel = "OK", busy = false, error = null, onOk, onCancel }) {
  return (
    <Dialog title={title} onClose={onCancel} onSubmit={onOk} busy={busy} width={370}
      buttons={<>
        <button type="submit" className="btn98" data-autofocus disabled={busy}>{busy ? "Working…" : okLabel}</button>
        <button type="button" className="btn98" onClick={onCancel} disabled={busy}>Cancel</button>
      </>}>
      <div className="confirm98">
        <WarnIcon />
        <div className="grow">
          {children}
          {error ? <div className="err selectable" style={{ padding: "8px 0 0", whiteSpace: "pre-wrap" }}>{error}</div> : null}
        </div>
      </div>
    </Dialog>
  );
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* no permission / insecure context */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;user-select:text";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

export function CopyButton({ text, children = "Copy", disabled = false, className = "btn98 small" }) {
  const [state, setState] = useState(null); // null | "ok" | "fail"
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const click = async () => {
    const ok = await copyText(String(text ?? ""));
    setState(ok ? "ok" : "fail");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), 1600);
  };
  return (
    <button type="button" className={className} disabled={disabled || !text} onClick={click}
      title={state === "fail" ? "The browser refused clipboard access — select the text and copy it by hand" : undefined}>
      {state === "ok" ? "Copied" : state === "fail" ? "Select + Ctrl+C" : children}
    </button>
  );
}

// ================================================================ vocabulary
const KINDS = {
  issue_verdict: { name: "Issue verdict", help: "Fires when an issue is first judged with one of these verdicts, and again if it escalates (notify → page). Never for repeats. Cooldown is per issue." },
  issue_regression: { name: "Regression", help: "Fires when an issue that was marked resolved comes back. Cooldown is per issue." },
  issue_spike: { name: "Volume spike", help: "Fires when one issue's volume in the window is many times its recent baseline. Checked periodically, not on every event." },
  session_frustration: { name: "Frustrated session", help: "Fires when a finished session's frustration score (0–3) reaches the minimum. Cooldown is per person, so one struggling user does not alert repeatedly." },
  metric_threshold: { name: "Event count", help: "Counts one event name over a window and fires when the count crosses the value. Checked periodically. Cooldown is per rule." },
};
const CHANNEL_TYPES = { email: "Email", webhook: "Webhook", slack: "Slack", push: "Browser push" };
const NOTE_STATUS = {
  sent: { label: "SENT", color: "#006300", hint: "delivered to the channel" },
  failed: { label: "FAILED", color: "#a00000", hint: "the channel refused it or could not be reached" },
  dry_run: { label: "DRY RUN", color: "#6b5a00", hint: "nothing left this machine — the channel is not fully configured" },
  skipped: { label: "NOT SENT", color: "#6b6b6b", hint: "" },
};

export function StatusTag({ map, status }) {
  const s = map[status] || { label: String(status ?? "–").toUpperCase(), color: "#6b6b6b" };
  return <span className="vtag" style={{ color: s.color, borderColor: s.color }} title={s.hint || undefined}>{s.label}</span>;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function fmtCooldown(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return "none";
  if (n < 60) return `${Math.round(n)} s`;
  if (n < 3600) return `${+(n / 60).toFixed(1)} min`;
  if (n < 86400) return `${+(n / 3600).toFixed(1)} h`;
  return `${+(n / 86400).toFixed(1)} d`;
}

export function describeRule(kind, config) {
  const c = config || {};
  switch (kind) {
    case "issue_verdict": {
      const vs = (c.verdicts || []).map((v) => VERDICTS[v]?.label || String(v).toUpperCase());
      const cats = c.categories?.length ? ` in ${c.categories.map(label).join(", ")}` : "";
      return vs.length ? `verdict is ${vs.join(" or ")}${cats}` : "no verdict selected — never fires";
    }
    case "issue_regression": return "a resolved issue comes back";
    case "issue_spike": return `an issue reaches ${c.factor ?? 10}× its usual volume within ${c.windowMinutes ?? 5} min (at least ${c.minCount ?? 20} events)`;
    case "session_frustration": return `session frustration ≥ ${c.min ?? 2.2} of 3`;
    case "metric_threshold": return c.event ? `"${c.event}" happens ${c.op === "below" ? "fewer" : "more"} than ${c.value ?? "?"}× in ${c.windowMinutes ?? 5} min` : "no event chosen — never fires";
    default: return label(kind);
  }
}

function maskUrl(url) {
  const s = String(url || "");
  try { const u = new URL(s); return `${u.host}/…${s.slice(-6)}`; } catch { return s ? "…" + s.slice(-6) : ""; }
}

function channelTarget(ch, pushSubscribers) {
  const c = ch.config || {};
  if (ch.type === "email") return c.to || null;
  if (ch.type === "webhook") return c.url || null;
  if (ch.type === "slack") return c.url ? maskUrl(c.url) : null;
  if (ch.type === "push") return `${plural(pushSubscribers ?? 0, "browser")} subscribed`;
  return null;
}

// taxonomy.categories is { key: description } today; tolerate an array too
function categoryList(tax) {
  const c = tax?.categories;
  if (Array.isArray(c)) return c.map((k) => (typeof k === "string" ? { key: k, hint: "" } : { key: k.key || k.id || k.name, hint: k.description || "" })).filter((x) => x.key);
  if (c && typeof c === "object") return Object.entries(c).map(([key, hint]) => ({ key, hint: String(hint || "") }));
  return [];
}

function States({ res, what, children }) {
  if (res.loading && !res.data) return <div className="muted pad">Loading {what}…</div>;
  if (res.error && !res.data) return <div className="err">Could not load {what}: {res.error}. Is the backend on :3001 running?</div>;
  return children;
}

// ================================================================ window
const TABS = [["rules", "Rules"], ["channels", "Channels"], ["outbox", "Outbox"]];
const isTab = (t) => TABS.some(([k]) => k === t);

export default function Alerts({ wm, params, nonce }) {
  const [tab, setTab] = useState(isTab(params?.tab) ? params.tab : "rules");
  useEffect(() => { if (isTab(params?.tab)) setTab(params.tab); }, [params?.tab, nonce]);

  const rules = useApi("alerts/rules", { on: ["notification"] });
  const channels = useApi("alerts/channels", { on: ["notification"] });
  const outbox = useApi("alerts/notifications", { on: ["notification"] });
  const meta = useApi("meta", { on: ["settings"] });
  const stream = useStreamStatus();

  const ruleList = rules.data?.rules || [];
  const channelList = channels.data?.channels || [];
  const notes = outbox.data?.notifications || [];
  const transport = meta.data ? meta.data.mail_transport : undefined;

  let status = "";
  if (tab === "rules") status = rules.data ? `${plural(ruleList.length, "rule")}, ${ruleList.filter((r) => r.enabled).length} enabled` : "";
  else if (tab === "channels") status = channels.data ? `${plural(channelList.length, "channel")} · ${plural(channels.data.push_subscribers ?? 0, "browser")} subscribed to push` : "";
  else status = outbox.data ? `${plural(notes.length, "message")} (latest 100) · ${notes.filter((n) => n.status === "sent").length} sent · ${notes.filter((n) => n.status === "failed").length} failed · ${notes.filter((n) => n.status === "dry_run").length} dry run` : "";

  return (
    <div className="s98-app">
      <div className="tabs" role="tablist">
        {TABS.map(([k, name]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>
            {name}{k === "outbox" && notes.length ? ` (${notes.length})` : ""}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {tab === "rules" && <RulesTab rules={rules} channels={channels} categories={categoryList(meta.data?.taxonomy)} goChannels={() => setTab("channels")} />}
        {tab === "channels" && <ChannelsTab channels={channels} rules={rules} transport={transport} />}
        {tab === "outbox" && <OutboxTab outbox={outbox} rules={ruleList} wm={wm} />}
      </div>
      <div className="statusbar">
        <div className="cell grow sunken-thin">{status || "…"}</div>
        <div className="cell sunken-thin" title="how email leaves this machine">mail: {transport === undefined ? "…" : transport || "dry run"}</div>
        <div className="cell sunken-thin">stream {stream}</div>
      </div>
    </div>
  );
}

// ================================================================ rules
function RulesTab({ rules, channels, categories, goChannels }) {
  const [sel, setSel] = useState(null);
  const [editing, setEditing] = useState(null);   // null | { rule: row | null }
  const [deleting, setDeleting] = useState(null); // null | row
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState({});     // id → optimistic enabled

  const list = rules.data?.rules || [];
  const channelList = channels.data?.channels || [];
  const byId = useMemo(() => new Map(channelList.map((c) => [c.id, c])), [channelList]);
  const current = list.find((r) => r.id === sel) || null;

  const toggle = async (rule, enabled) => {
    setError(null);
    setPending((p) => ({ ...p, [rule.id]: enabled }));
    try { await api(`alerts/rules/${rule.id}`, { method: "PATCH", body: { enabled } }); }
    catch (err) { setError(`Could not ${enabled ? "enable" : "disable"} “${rule.name}”: ${err.message}`); }
    await rules.reload();
    setPending((p) => { const n = { ...p }; delete n[rule.id]; return n; });
  };

  const remove = async () => {
    setBusy(true); setError(null);
    try {
      await api(`alerts/rules/${deleting.id}`, { method: "DELETE" });
      setDeleting(null); setSel(null);
    } catch (err) { setError(err.message); }
    setBusy(false);
    rules.reload();
  };

  return (
    <>
      <div className="row" style={{ paddingBottom: 6 }}>
        <button type="button" className="btn98 small" onClick={() => setEditing({ rule: null })}>New rule…</button>
        <button type="button" className="btn98 small" disabled={!current} onClick={() => setEditing({ rule: current })}>Edit…</button>
        <button type="button" className="btn98 small" disabled={!current} onClick={() => { setError(null); setDeleting(current); }}>Delete</button>
        <span className="grow" />
        <span className="muted">A rule decides when; its channels decide where.</span>
      </div>
      {error && !deleting ? <div className="err">{error}</div> : null}
      {rules.error && rules.data ? <div className="err">Showing the last good copy — reload failed: {rules.error}</div> : null}
      <div className="pane sunken">
        <States res={rules} what="rules">
          {list.length === 0 ? (
            <div className="muted pad">No alert rules, so nothing is ever sent. Click <b>New rule…</b> — “verdict is PAGE → browser push” is the one to start with.</div>
          ) : (
            <table className="t98">
              <thead><tr><th>On</th><th>Name</th><th>Kind</th><th>Fires when</th><th>Channels</th><th>Cooldown</th><th>Last fired</th></tr></thead>
              <tbody>
                {list.map((r) => {
                  const on = pending[r.id] ?? !!r.enabled;
                  const ids = Array.isArray(r.channel_ids) ? r.channel_ids : [];
                  return (
                    <tr key={r.id} className={sel === r.id ? "sel" : ""} onClick={() => setSel(r.id)} onDoubleClick={() => setEditing({ rule: r })}>
                      <td><input type="checkbox" checked={on} aria-label={`enable ${r.name}`} onClick={(e) => e.stopPropagation()} onChange={(e) => toggle(r, e.target.checked)} /></td>
                      <td title={r.name}>{r.name}</td>
                      <td>{KINDS[r.kind]?.name || label(r.kind)}</td>
                      <td className="wrap">{describeRule(r.kind, r.config)}</td>
                      <td className="wrap">
                        {ids.length === 0 ? <span className="muted">none — fires silently</span> : ids.map((id, i) => {
                          const ch = byId.get(id);
                          return <span key={id}>{i ? ", " : ""}{ch ? ch.name : <em>#{id} (deleted)</em>}{ch && !ch.enabled ? <span className="muted"> (off)</span> : null}</span>;
                        })}
                      </td>
                      <td>{fmtCooldown(r.cooldown_s)}</td>
                      <td title={r.last_fired_at ? fmtDateTime(r.last_fired_at) : undefined}>{r.last_fired_at ? ago(r.last_fired_at) : <span className="muted">never</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </States>
      </div>
      {editing ? (
        <RuleDialog rule={editing.rule} channels={channelList} categories={categories} goChannels={goChannels}
          onClose={() => setEditing(null)}
          onSaved={async (id) => { await rules.reload(); setSel(id ?? sel); setEditing(null); }} />
      ) : null}
      {deleting ? (
        <Confirm title="Delete rule" okLabel="Delete" busy={busy} error={error} onOk={remove} onCancel={() => setDeleting(null)}>
          <p>Delete the rule <b>{deleting.name}</b>?</p>
          <p className="muted">It stops firing at once. Messages it already sent stay in the Outbox.</p>
        </Confirm>
      ) : null}
    </>
  );
}

function ruleToForm(rule) {
  const c = rule?.config || {};
  return {
    name: rule?.name || "",
    kind: KINDS[rule?.kind] ? rule.kind : rule?.kind || "issue_verdict",
    enabled: rule ? !!rule.enabled : true,
    cooldownMin: String(rule ? +(Number(rule.cooldown_s || 0) / 60).toFixed(2) : 15),
    channel_ids: Array.isArray(rule?.channel_ids) ? rule.channel_ids : [],
    verdicts: Array.isArray(c.verdicts) ? c.verdicts : ["page"],
    categories: Array.isArray(c.categories) ? c.categories : [],
    factor: String(c.factor ?? 10), windowMinutes: String(c.windowMinutes ?? 5), minCount: String(c.minCount ?? 20),
    min: String(c.min ?? 2.2),
    event: c.event || "", op: c.op === "below" ? "below" : "above", value: String(c.value ?? 100),
  };
}

// → { config } or { error }
function formToConfig(f) {
  const win = num(f.windowMinutes);
  const badWin = win == null || win < 1 || win > 1440;
  switch (f.kind) {
    case "issue_verdict":
      if (!f.verdicts.length) return { error: "Tick at least one verdict." };
      return { config: { verdicts: f.verdicts, ...(f.categories.length ? { categories: f.categories } : {}) } };
    case "issue_regression": return { config: {} };
    case "issue_spike": {
      const factor = num(f.factor), minCount = num(f.minCount);
      if (factor == null || factor <= 1) return { error: "The factor must be a number above 1 (10 means ten times the usual volume)." };
      if (badWin) return { error: "The window must be between 1 and 1440 minutes." };
      if (minCount == null || minCount < 1) return { error: "The minimum event count must be 1 or more." };
      return { config: { factor, windowMinutes: win, minCount: Math.round(minCount) } };
    }
    case "session_frustration": {
      const min = num(f.min);
      if (min == null || min < 0 || min > 3) return { error: "Frustration is scored 0–3; pick a minimum in that range." };
      return { config: { min } };
    }
    case "metric_threshold": {
      const value = num(f.value);
      if (!f.event.trim()) return { error: "Type the event name to count (for example $pageview or signup)." };
      if (value == null || value < 0) return { error: "The value must be a number, 0 or more." };
      if (badWin) return { error: "The window must be between 1 and 1440 minutes." };
      return { config: { event: f.event.trim(), op: f.op, value, windowMinutes: win } };
    }
    default: return { error: `Unknown rule kind “${f.kind}”.` };
  }
}

function RuleDialog({ rule, channels, categories, goChannels, onClose, onSaved }) {
  const isNew = !rule;
  const [f, setF] = useState(() => ruleToForm(rule));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const events = useApi(f.kind === "metric_threshold" ? "insights/events" : null);
  const set = (patch) => { setError(null); setF((s) => ({ ...s, ...patch })); };
  const flip = (key, value, on) => set({ [key]: on ? [...new Set([...f[key], value])] : f[key].filter((x) => x !== value) });

  const draft = formToConfig(f);
  const autoName = draft.config ? describeRule(f.kind, draft.config).replace(/^./, (ch) => ch.toUpperCase()) : KINDS[f.kind]?.name || "Rule";

  const save = async () => {
    if (draft.error) return setError(draft.error);
    const cooldown = num(f.cooldownMin);
    if (cooldown == null || cooldown < 0 || cooldown > 10080) return setError("Cooldown must be between 0 and 10080 minutes (7 days).");
    const channel_ids = f.channel_ids.filter((id) => channels.some((c) => c.id === id));
    if (!channel_ids.length) return setError(channels.length ? "Pick at least one channel — a rule without one fires silently." : "There are no channels yet. Create one in the Channels tab first.");
    const body = { name: (f.name.trim() || autoName).slice(0, 120), enabled: f.enabled, config: draft.config, channel_ids, cooldown_s: Math.round(cooldown * 60) };
    setBusy(true);
    try {
      let id = rule?.id;
      if (isNew) {
        id = (await api("alerts/rules", { method: "POST", body: { ...body, kind: f.kind } })).id;
        // POST treats cooldown 0 as "unset" and stores 900; PATCH accepts 0.
        if (body.cooldown_s === 0) await api(`alerts/rules/${id}`, { method: "PATCH", body: { cooldown_s: 0 } });
      } else {
        await api(`alerts/rules/${id}`, { method: "PATCH", body });
      }
      await onSaved(id);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const names = (events.data?.events || []).map((e) => e.name).filter(Boolean);

  return (
    <Dialog title={isNew ? "New alert rule" : `Edit rule — ${rule.name}`} onClose={onClose} onSubmit={save} busy={busy} width={430}
      buttons={<>
        <button type="submit" className="btn98" disabled={busy}>{busy ? "Saving…" : "OK"}</button>
        <button type="button" className="btn98" onClick={onClose} disabled={busy}>Cancel</button>
      </>}>
      <div className="field"><label htmlFor="rl-name">Name</label>
        <input id="rl-name" className="in98" type="text" maxLength={120} value={f.name} placeholder={autoName} onChange={(e) => set({ name: e.target.value })} /></div>
      <div className="field"><label htmlFor="rl-kind">Kind</label>
        <select id="rl-kind" className="in98" value={f.kind} disabled={!isNew} title={isNew ? undefined : "The kind of an existing rule cannot change — create a new rule instead"} onChange={(e) => set({ kind: e.target.value })}>
          {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}
          {!KINDS[f.kind] ? <option value={f.kind}>{label(f.kind)}</option> : null}
        </select></div>
      <p className="hint98">{KINDS[f.kind]?.help || "This kind of rule is not known to this window; its condition cannot be edited here."}</p>

      {f.kind === "issue_verdict" && <>
        <div className="field"><label>Verdicts</label>
          <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
            {Object.entries(VERDICTS).map(([k, v]) => (
              <label key={k} className="check98" title={v.hint}>
                <input type="checkbox" checked={f.verdicts.includes(k)} onChange={(e) => flip("verdicts", k, e.target.checked)} />
                <span className="vtag" style={{ color: v.color, borderColor: v.color }}>{v.label}</span>
              </label>
            ))}
          </div></div>
        <div className="field" style={{ alignItems: "flex-start" }}><label>Categories</label>
          {categories.length ? (
            <div className="checklist98 sunken-thin">
              {categories.map((c) => (
                <label key={c.key} className="check98" title={c.hint}>
                  <input type="checkbox" checked={f.categories.includes(c.key)} onChange={(e) => flip("categories", c.key, e.target.checked)} /> {label(c.key)}
                </label>
              ))}
            </div>
          ) : <span className="muted">category list unavailable — the rule applies to every category</span>}
        </div>
        <p className="hint98">{f.categories.length ? `Only issues in: ${f.categories.map(label).join(", ")}.` : "No category ticked = every category."}</p>
      </>}

      {f.kind === "issue_spike" && <>
        <div className="field"><label htmlFor="rl-factor">Factor ×</label><input id="rl-factor" className="in98" type="number" min="1.1" step="any" value={f.factor} onChange={(e) => set({ factor: e.target.value })} /></div>
        <div className="field"><label htmlFor="rl-win">Window (min)</label><input id="rl-win" className="in98" type="number" min="1" max="1440" step="1" value={f.windowMinutes} onChange={(e) => set({ windowMinutes: e.target.value })} /></div>
        <div className="field"><label htmlFor="rl-minc">At least (events)</label><input id="rl-minc" className="in98" type="number" min="1" step="1" value={f.minCount} onChange={(e) => set({ minCount: e.target.value })} /></div>
      </>}

      {f.kind === "session_frustration" && (
        <div className="field"><label htmlFor="rl-min">Minimum (0–3)</label><input id="rl-min" className="in98" type="number" min="0" max="3" step="0.1" value={f.min} onChange={(e) => set({ min: e.target.value })} /></div>
      )}

      {f.kind === "metric_threshold" && <>
        <div className="field"><label htmlFor="rl-event">Event name</label>
          <input id="rl-event" className="in98 mono" type="text" list="rl-events" value={f.event} placeholder="$pageview" onChange={(e) => set({ event: e.target.value })} />
          <datalist id="rl-events">{names.map((n) => <option key={n} value={n} />)}</datalist></div>
        <div className="field"><label htmlFor="rl-op">Fires when count is</label>
          <select id="rl-op" className="in98" value={f.op} onChange={(e) => set({ op: e.target.value })}><option value="above">above</option><option value="below">below</option></select>
          <input className="in98" type="number" min="0" step="any" aria-label="value" value={f.value} onChange={(e) => set({ value: e.target.value })} /></div>
        <div className="field"><label htmlFor="rl-mwin">Window (min)</label><input id="rl-mwin" className="in98" type="number" min="1" max="1440" step="1" value={f.windowMinutes} onChange={(e) => set({ windowMinutes: e.target.value })} /></div>
      </>}

      <div className="field" style={{ alignItems: "flex-start" }}><label>Send to</label>
        {channels.length ? (
          <div className="checklist98 sunken-thin">
            {channels.map((c) => (
              <label key={c.id} className="check98">
                <input type="checkbox" checked={f.channel_ids.includes(c.id)} onChange={(e) => flip("channel_ids", c.id, e.target.checked)} />
                {c.name} <span className="muted">({CHANNEL_TYPES[c.type] || c.type}{c.enabled ? "" : ", off"})</span>
              </label>
            ))}
          </div>
        ) : <span className="muted">no channels yet — <button type="button" className="link98" onClick={() => { onClose(); goChannels(); }}>create one</button></span>}
      </div>
      <div className="field"><label htmlFor="rl-cd">Cooldown (min)</label>
        <input id="rl-cd" className="in98" type="number" min="0" max="10080" step="any" value={f.cooldownMin} onChange={(e) => set({ cooldownMin: e.target.value })} style={{ maxWidth: 80 }} />
        <span className="muted">quiet time before the same subject can fire again</span></div>
      <label className="check98"><input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled</label>
      {error ? <div className="err" style={{ padding: "8px 0 0" }}>{error}</div> : null}
    </Dialog>
  );
}

// ================================================================ channels
function ChannelsTab({ channels, rules, transport }) {
  const [sel, setSel] = useState(null);
  const [editing, setEditing] = useState(null);   // null | { channel: row | null }
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState({});
  const [tests, setTests] = useState({});         // id → { busy } | { status, error, at }

  const list = channels.data?.channels || [];
  const ruleList = rules.data?.rules || [];
  const subscribers = channels.data?.push_subscribers ?? 0;
  const current = list.find((c) => c.id === sel) || null;
  const pushChannel = list.find((c) => c.type === "push") || null;
  const usedBy = (id) => ruleList.filter((r) => Array.isArray(r.channel_ids) && r.channel_ids.includes(id));

  const toggle = async (ch, enabled) => {
    setError(null);
    setPending((p) => ({ ...p, [ch.id]: enabled }));
    try { await api(`alerts/channels/${ch.id}`, { method: "PATCH", body: { enabled } }); }
    catch (err) { setError(`Could not ${enabled ? "enable" : "disable"} “${ch.name}”: ${err.message}`); }
    await channels.reload();
    setPending((p) => { const n = { ...p }; delete n[ch.id]; return n; });
  };

  const sendTest = useCallback(async (ch) => {
    if (!ch.enabled) return setTests((t) => ({ ...t, [ch.id]: { status: "skipped", error: "this channel is switched off, so nothing was sent — tick “On” and try again", at: Date.now() } }));
    setTests((t) => ({ ...t, [ch.id]: { busy: true } }));
    try {
      const r = await api(`alerts/channels/${ch.id}/test`, { method: "POST" });
      const n = r?.notifications?.[0];
      setTests((t) => ({ ...t, [ch.id]: n ? { status: n.status, error: n.error, at: Date.now() } : { status: "skipped", error: "the server sent nothing (is the channel switched off?)", at: Date.now() } }));
    } catch (err) {
      setTests((t) => ({ ...t, [ch.id]: { status: "failed", error: err.message, at: Date.now() } }));
    }
    channels.reload();
  }, [channels]);

  const remove = async () => {
    setBusy(true); setError(null);
    try {
      const id = deleting.id;
      await api(`alerts/channels/${id}`, { method: "DELETE" });
      // the API leaves the id behind in rules.channel_ids; tidy it so rules do not point at a ghost
      for (const r of usedBy(id)) await api(`alerts/rules/${r.id}`, { method: "PATCH", body: { channel_ids: r.channel_ids.filter((x) => x !== id) } }).catch(() => {});
      setDeleting(null); setSel(null);
    } catch (err) { setError(err.message); }
    setBusy(false);
    channels.reload(); rules.reload();
  };

  const createPush = async () => {
    setError(null);
    try { await api("alerts/channels", { method: "POST", body: { type: "push", name: "Browser push", config: {} } }); }
    catch (err) { setError(err.message); }
    channels.reload();
  };

  return (
    <>
      <div className="row" style={{ paddingBottom: 6 }}>
        <button type="button" className="btn98 small" onClick={() => setEditing({ channel: null })}>New channel…</button>
        <button type="button" className="btn98 small" disabled={!current} onClick={() => setEditing({ channel: current })}>Edit…</button>
        <button type="button" className="btn98 small" disabled={!current} onClick={() => { setError(null); setDeleting(current); }}>Delete</button>
      </div>
      {error && !deleting ? <div className="err">{error}</div> : null}
      {channels.error && channels.data ? <div className="err">Showing the last good copy — reload failed: {channels.error}</div> : null}
      <div className="grow scroll col">
        <div className="sunken" style={{ background: "#fff", overflow: "auto", minHeight: 96 }}>
          <States res={channels} what="channels">
            {list.length === 0 ? (
              <div className="muted pad">No channels, so alerts have nowhere to go. Click <b>New channel…</b> to add an email address, a webhook or a Slack incoming webhook.</div>
            ) : (
              <table className="t98">
                <thead><tr><th>On</th><th>Type</th><th>Name</th><th>Target</th><th>Used by</th><th>Test</th></tr></thead>
                <tbody>
                  {list.map((ch) => {
                    const on = pending[ch.id] ?? !!ch.enabled;
                    const target = channelTarget(ch, subscribers);
                    const t = tests[ch.id];
                    const n = usedBy(ch.id).length;
                    return (
                      <tr key={ch.id} className={sel === ch.id ? "sel" : ""} onClick={() => setSel(ch.id)} onDoubleClick={() => setEditing({ channel: ch })}>
                        <td><input type="checkbox" checked={on} aria-label={`enable ${ch.name}`} onClick={(e) => e.stopPropagation()} onChange={(e) => toggle(ch, e.target.checked)} /></td>
                        <td>{CHANNEL_TYPES[ch.type] || ch.type}</td>
                        <td title={ch.name}>{ch.name}</td>
                        <td className="selectable" title={ch.type === "slack" ? "Slack webhook URLs are secrets, so only the tail is shown" : target || undefined}>{target || <span className="muted">(unset — dry runs)</span>}</td>
                        <td>{n ? plural(n, "rule") : <span className="muted">no rule</span>}</td>
                        <td className="wrap">
                          <button type="button" className="btn98 small" disabled={t?.busy} onClick={(e) => { e.stopPropagation(); sendTest(ch); }}>{t?.busy ? "Sending…" : "Send test"}</button>
                          {t && !t.busy ? <> <StatusTag map={NOTE_STATUS} status={t.status} /> <span className="selectable" style={{ color: "#000" }}>{t.error || (t.status === "sent" ? "delivered" : "")}</span></> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </States>
        </div>

        <div className="note98">
          {transport === undefined ? "…" : transport === null
            ? <>No mail transport is configured: <b>emails are dry runs until SMTP_URL or RESEND_API_KEY is set in desktop/.env.local</b>; you can still read them in the Outbox.</>
            : transport === "resend" ? "Email leaves through Resend (RESEND_API_KEY is set)."
            : transport === "smtp" ? "Email leaves through your SMTP server (SMTP_URL is set)."
            : `Email transport: ${transport}.`}
          {" "}Every test lands in the Outbox with its status, including dry runs.
        </div>

        <PushBox pushChannel={pushChannel} subscribers={subscribers} channelsLoaded={!!channels.data}
          onChange={channels.reload} onCreateChannel={createPush} onTest={sendTest} test={pushChannel ? tests[pushChannel.id] : null} />
      </div>

      {editing ? (
        <ChannelDialog channel={editing.channel} hasPush={!!pushChannel} onClose={() => setEditing(null)}
          onSaved={async (id) => { await channels.reload(); setSel(id ?? sel); setEditing(null); }} />
      ) : null}
      {deleting ? (
        <Confirm title="Delete channel" okLabel="Delete" busy={busy} error={error} onOk={remove} onCancel={() => setDeleting(null)}>
          <p>Delete the channel <b>{deleting.name}</b>?</p>
          <p className="muted">{usedBy(deleting.id).length
            ? `${plural(usedBy(deleting.id).length, "rule")} send${usedBy(deleting.id).length === 1 ? "s" : ""} to it (${usedBy(deleting.id).map((r) => r.name).join("; ")}). They keep their other channels and lose this one.`
            : "No rule uses it."}</p>
        </Confirm>
      ) : null}
    </>
  );
}

function ChannelDialog({ channel, hasPush, onClose, onSaved }) {
  const isNew = !channel;
  const [f, setF] = useState(() => ({
    type: channel?.type || "email", name: channel?.name || "",
    target: channel?.type === "email" ? channel?.config?.to || "" : channel?.config?.url || "",
    enabled: channel ? !!channel.enabled : true,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => { setError(null); setF((s) => ({ ...s, ...patch })); };
  const target = f.target.trim();

  const save = async () => {
    if (f.type === "email" && target && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) return setError("That does not look like an email address.");
    if ((f.type === "webhook" || f.type === "slack") && target && !/^https?:\/\//i.test(target)) return setError("The URL must start with http:// or https://");
    const config = f.type === "email" ? { ...(channel?.config || {}), to: target } : f.type === "push" ? channel?.config || {} : { ...(channel?.config || {}), url: target };
    const name = (f.name.trim() || CHANNEL_TYPES[f.type] || f.type).slice(0, 80);
    setBusy(true);
    try {
      let id = channel?.id;
      if (isNew) {
        id = (await api("alerts/channels", { method: "POST", body: { type: f.type, name, config } })).id;
        if (!f.enabled) await api(`alerts/channels/${id}`, { method: "PATCH", body: { enabled: false } }); // POST always creates enabled
      } else {
        await api(`alerts/channels/${id}`, { method: "PATCH", body: { name, config, enabled: f.enabled } });
      }
      await onSaved(id);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const help = {
    email: "One recipient address. Leave it empty and the emails are recorded as dry runs.",
    webhook: "signal98 POSTs JSON { source, subject, body, url, tag } to this URL (8 s timeout).",
    slack: "A Slack incoming-webhook URL (https://hooks.slack.com/services/…). It is a secret: the list only shows its tail.",
    push: "System notifications in every browser that clicked “Enable push on this browser”. Nothing to configure here.",
  }[f.type];

  return (
    <Dialog title={isNew ? "New channel" : `Edit channel — ${channel.name}`} onClose={onClose} onSubmit={save} busy={busy}
      buttons={<>
        <button type="submit" className="btn98" disabled={busy}>{busy ? "Saving…" : "OK"}</button>
        <button type="button" className="btn98" onClick={onClose} disabled={busy}>Cancel</button>
      </>}>
      <div className="field"><label htmlFor="ch-type">Type</label>
        <select id="ch-type" className="in98" value={f.type} disabled={!isNew} title={isNew ? undefined : "The type of an existing channel cannot change"} onChange={(e) => set({ type: e.target.value, target: "" })}>
          <option value="email">Email</option><option value="webhook">Webhook</option><option value="slack">Slack</option>
          {!hasPush || f.type === "push" ? <option value="push">Browser push</option> : null}
        </select></div>
      <div className="field"><label htmlFor="ch-name">Name</label>
        <input id="ch-name" className="in98" type="text" maxLength={80} value={f.name} placeholder={CHANNEL_TYPES[f.type]} onChange={(e) => set({ name: e.target.value })} /></div>
      {f.type !== "push" ? (
        <div className="field"><label htmlFor="ch-target">{f.type === "email" ? "Send to" : "URL"}</label>
          <input id="ch-target" className="in98 mono" type="text" spellCheck={false} autoComplete="off" value={f.target}
            placeholder={f.type === "email" ? "oncall@example.com" : f.type === "slack" ? "https://hooks.slack.com/services/…" : "https://example.com/hooks/signal98"}
            onChange={(e) => set({ target: e.target.value })} /></div>
      ) : null}
      <p className="hint98">{help}</p>
      <label className="check98"><input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled</label>
      {error ? <div className="err" style={{ padding: "8px 0 0" }}>{error}</div> : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------- browser push
function b64urlToBytes(s) {
  const b64 = (s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// false only when the browser's subscription was made for a different VAPID key (e.g. the DB was reset)
function sameKey(sub, bytes) {
  const have = sub?.options?.applicationServerKey;
  if (!have) return true;
  const a = new Uint8Array(have);
  return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
}

function askPermission() {
  return new Promise((resolve, reject) => {
    try {
      const p = Notification.requestPermission(resolve); // old Safari: callback; everyone else: promise
      if (p && p.then) p.then(resolve, reject);
    } catch (err) { reject(err); }
  });
}

function pushSupport() {
  if (typeof window === "undefined") return "checking";
  if (!window.isSecureContext) return "Web push needs a secure context: open the monitor over https, or on localhost.";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    return "This browser has no Push API here. On iPhone/iPad, add the monitor to the Home Screen first; private windows often disable it too.";
  return null;
}

function usePush(onChange) {
  const [s, setS] = useState({ phase: "checking", reason: null, busy: false, error: null });
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    let alive = true;
    (async () => {
      const why = pushSupport();
      if (why) return alive && setS((x) => ({ ...x, phase: "unsupported", reason: why }));
      if (Notification.permission === "denied") return alive && setS((x) => ({ ...x, phase: "denied" }));
      try {
        const reg = await navigator.serviceWorker.getRegistration("/");
        const sub = reg ? await reg.pushManager.getSubscription() : null;
        if (!sub || Notification.permission !== "granted") return alive && setS((x) => ({ ...x, phase: "idle" }));
        const { key } = await api("push/key");
        if (key && !sameKey(sub, b64urlToBytes(key))) return alive && setS((x) => ({ ...x, phase: "idle", reason: "This browser holds a subscription made for an older server key. Click Enable to renew it." }));
        // keep the server in step (idempotent upsert) — its database may have been reset since
        await api("push/subscribe", { method: "POST", body: sub.toJSON() });
        if (alive) { setS((x) => ({ ...x, phase: "subscribed" })); changed.current?.(); }
      } catch (err) {
        if (alive) setS((x) => ({ ...x, phase: "idle", error: err.message }));
      }
    })();
    return () => { alive = false; };
  }, []);

  const enable = async () => {
    setS((x) => ({ ...x, busy: true, error: null, reason: null }));
    try {
      const perm = await askPermission(); // first, while the click still counts as a user gesture
      if (perm === "denied") return setS((x) => ({ ...x, busy: false, phase: "denied" }));
      if (perm !== "granted") return setS((x) => ({ ...x, busy: false, phase: "idle", error: "The permission prompt was dismissed. Click Enable again and choose Allow." }));
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      const reg = await navigator.serviceWorker.ready;
      const { key } = await api("push/key");
      if (!key) throw new Error("the server has no VAPID key — the web-push package is missing (cd desktop && npm install), then restart");
      const bytes = b64urlToBytes(key);
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameKey(sub, bytes)) { await sub.unsubscribe().catch(() => {}); sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      await api("push/subscribe", { method: "POST", body: sub.toJSON() });
      setS((x) => ({ ...x, busy: false, phase: "subscribed" }));
    } catch (err) {
      setS((x) => ({ ...x, busy: false, error: `Could not enable push: ${err?.message || err}` }));
    }
    changed.current?.();
  };

  const disable = async () => {
    setS((x) => ({ ...x, busy: true, error: null }));
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe().catch(() => {});
        await api("push/unsubscribe", { method: "POST", body: { endpoint } });
      }
      setS((x) => ({ ...x, busy: false, phase: "idle" }));
    } catch (err) {
      setS((x) => ({ ...x, busy: false, error: `Could not disable push: ${err?.message || err}` }));
    }
    changed.current?.();
  };

  return { ...s, enable, disable };
}

function PushBox({ pushChannel, subscribers, channelsLoaded, onChange, onCreateChannel, onTest, test }) {
  const push = usePush(onChange);
  const here = {
    checking: "checking…",
    unsupported: "unsupported",
    denied: "permission denied",
    subscribed: "subscribed on this browser",
    idle: "not subscribed",
  }[push.phase];
  return (
    <div className="group98">
      <span className="gl">Browser push</span>
      <dl className="kv98">
        <dt>This browser</dt>
        <dd><b>{here}</b>
          {push.phase === "unsupported" ? <div className="muted">{push.reason}</div> : null}
          {push.phase === "denied" ? <div className="muted">Notifications are blocked for this site. Allow them in the browser's site settings (the icon left of the address), then reopen this window.</div> : null}
          {push.phase === "subscribed" ? <div className="muted">Alerts arrive as system notifications even when this tab is closed, as long as the browser is running. PAGE alerts stay on screen until dismissed.</div> : null}
          {push.phase === "idle" && push.reason ? <div className="muted">{push.reason}</div> : null}
        </dd>
        <dt>All browsers</dt>
        <dd>{channelsLoaded ? `${plural(subscribers, "browser")} subscribed` : "…"}</dd>
      </dl>
      <div className="row" style={{ padding: "6px 4px 0", flexWrap: "wrap" }}>
        {push.phase === "subscribed"
          ? <button type="button" className="btn98 small" disabled={push.busy} onClick={push.disable}>{push.busy ? "Working…" : "Disable on this browser"}</button>
          : <button type="button" className="btn98 small" disabled={push.busy || push.phase === "unsupported" || push.phase === "checking" || push.phase === "denied"} onClick={push.enable}>{push.busy ? "Working…" : "Enable push on this browser"}</button>}
        {pushChannel
          ? <button type="button" className="btn98 small" disabled={test?.busy} onClick={() => onTest(pushChannel)}>{test?.busy ? "Sending…" : "Send test push"}</button>
          : channelsLoaded ? <button type="button" className="btn98 small" onClick={onCreateChannel}>Create push channel</button> : null}
        {test && !test.busy ? <span><StatusTag map={NOTE_STATUS} status={test.status} /> <span className="selectable">{test.error || (test.status === "sent" ? "delivered" : "")}</span></span> : null}
      </div>
      {channelsLoaded && !pushChannel ? <div className="muted" style={{ padding: "6px 4px 0" }}>There is no push channel, so no rule can send to browsers yet.</div> : null}
      {pushChannel && !pushChannel.enabled ? <div className="muted" style={{ padding: "6px 4px 0" }}>The push channel is switched off in the list above, so subscribed browsers receive nothing.</div> : null}
      {push.error ? <div className="err selectable" style={{ padding: "6px 4px 0" }}>{push.error}</div> : null}
    </div>
  );
}

// ================================================================ outbox
function OutboxTab({ outbox, rules, wm }) {
  const [sel, setSel] = useState(null);
  const [filter, setFilter] = useState("all");
  const list = outbox.data?.notifications || [];
  const shown = filter === "all" ? list : list.filter((n) => n.status === filter);
  const current = list.find((n) => n.id === sel) || null;
  const ruleName = (n) => (n.rule_id == null ? "test message" : rules.find((r) => r.id === n.rule_id)?.name || `rule #${n.rule_id} (deleted)`);

  return (
    <>
      <div className="row" style={{ paddingBottom: 6 }}>
        {[["all", "All"], ["sent", "Sent"], ["failed", "Failed"], ["dry_run", "Dry run"]].map(([k, name]) => (
          <button key={k} type="button" className={`tool-btn${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{name}</button>
        ))}
        <span className="grow" />
        <button type="button" className="btn98 small" onClick={outbox.reload}>Refresh</button>
      </div>
      {outbox.error && outbox.data ? <div className="err">Showing the last good copy — reload failed: {outbox.error}</div> : null}
      <div className="pane sunken" style={{ flex: 3 }}>
        <States res={outbox} what="the outbox">
          {list.length === 0 ? (
            <div className="muted pad">Nothing has been dispatched yet. Fire an error from the playground at :3000 (a PAGE verdict triggers the seeded rule), or press <b>Send test</b> in the Channels tab.</div>
          ) : shown.length === 0 ? (
            <div className="muted pad">No {label(filter)} messages among the latest {list.length}.</div>
          ) : (
            <table className="t98">
              <thead><tr><th>Time</th><th>Channel</th><th>Status</th><th>Subject</th><th>Target</th></tr></thead>
              <tbody>
                {shown.map((n) => (
                  <tr key={n.id} className={sel === n.id ? "sel" : ""} onClick={() => setSel(n.id)}>
                    <td title={ago(n.created_at)}>{fmtDateTime(n.created_at)}</td>
                    <td>{CHANNEL_TYPES[n.channel_type] || n.channel_type}</td>
                    <td><StatusTag map={NOTE_STATUS} status={n.status} /></td>
                    <td title={n.subject || undefined}>{n.subject || <span className="muted">(no subject)</span>}</td>
                    <td>{n.target || <span className="muted">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </States>
      </div>
      <div className="pane sunken" style={{ flex: 2, marginTop: 4 }}>
        {!current ? (
          <div className="muted pad">{list.length ? "Select a message to read exactly what was (or would have been) sent." : ""}</div>
        ) : (
          <div className="pad">
            <div className="row" style={{ alignItems: "flex-start" }}>
              <div className="grow selectable"><b>{current.subject || "(no subject)"}</b></div>
              {current.issue_id ? <button type="button" className="btn98 small" onClick={() => wm?.open?.("issue", { id: current.issue_id })}>Open issue #{current.issue_id}</button> : null}
            </div>
            <div className="muted" style={{ margin: "3px 0 6px" }}>
              <StatusTag map={NOTE_STATUS} status={current.status} /> {fmtDateTime(current.created_at)} · {CHANNEL_TYPES[current.channel_type] || current.channel_type} → {current.target || "–"} · {ruleName(current)}
            </div>
            {current.status === "dry_run" ? <div className="note98" style={{ padding: "0 0 4px" }}>Dry run: nothing left this machine. Below is exactly what would have been sent.</div> : null}
            {current.error ? <div className="err selectable" style={{ padding: "0 0 6px" }}>{current.status === "failed" ? "Error: " : "Why: "}{current.error}</div> : null}
            <pre className="code selectable" style={{ padding: 0 }}>{current.body || "(empty body)"}</pre>
          </div>
        )}
      </div>
    </>
  );
}
