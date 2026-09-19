"use client";
// Settings: install snippets, JEV status, the verdict rule, the ghost's leash, feature flags, projects.
// Opened with params.tab = "install" | "jev" | "rule" | "ghost" | "flags" | "projects".
import { useEffect, useMemo, useRef, useState } from "react";
import { api, useApi, useStream, useStreamStatus, fmtDateTime, fmtNum, fmtUsd, ago, VERDICTS } from "../lib/client";
import { StatTile } from "../components/charts";
import { openSetup } from "../components/SetupWizard";
import { Confirm, CopyButton, WarnIcon } from "./Alerts";

const TABS = [["install", "Install"], ["jev", "JEV"], ["rule", "Verdict rule"], ["ghost", "Ghost"], ["flags", "Feature flags"], ["projects", "Projects"]];
const SECTIONS = [
  ["general", "Overview", "Your setup at a glance"],
  ["install", "Connect your app", "Installation & event capture"],
  ["jev", "JEV classification", "Connection & usage"],
  ["ghost", "Fix assistant", "Repository & automation"],
  ["rule", "Priority rules", "Advanced thresholds"],
  ["flags", "Feature flags", "Control feature rollout"],
  ["projects", "Projects", "Manage your workspaces"],
];
const ALIAS = { verdict: "rule", thresholds: "rule", "feature-flags": "flags", project: "projects" };
const tabOf = (t) => { const k = ALIAS[t] || t; return SECTIONS.some(([id]) => id === k) ? k : null; };

const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const VTag = ({ v }) => <span className="vtag" style={{ color: VERDICTS[v].color, borderColor: VERDICTS[v].color }}>{VERDICTS[v].label}</span>;

// A form draft over server settings: follows the server until the user types, then holds
// until Save (reconciled with a reload) or Revert.
function useDraft(source, pick) {
  const base = useMemo(() => (source ? pick(source) : null), [source, pick]);
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (base && !dirty) setDraft(base); }, [base, dirty]);
  return {
    draft, dirty, base,
    set: (patch) => { setDraft((d) => ({ ...(d || {}), ...patch })); setDirty(true); },
    revert: () => { setDraft(base); setDirty(false); },
    saved: () => setDirty(false),
  };
}

const pickRule = (s) => ({
  pageSeverity: String(s.thresholds?.pageSeverity ?? ""), pageUserFacing: String(s.thresholds?.pageUserFacing ?? ""),
  pageUrgent: String(s.thresholds?.pageUrgent ?? ""), notifySeverity: String(s.thresholds?.notifySeverity ?? ""),
  noise: String(s.thresholds?.noise ?? ""), sessionIdleMinutes: String(s.sessionIdleMinutes ?? ""), retentionDays: String(s.retentionDays ?? ""),
});
const pickGhost = (s) => ({
  repoPath: s.ghost?.repoPath || "", autoMode: !!s.ghost?.autoMode, autoApply: !!s.ghost?.autoApply,
  maxAttemptsPerIssue: String(s.ghost?.maxAttemptsPerIssue ?? ""), maxRunsPerDay: String(s.ghost?.maxRunsPerDay ?? ""),
  minActionable: String(s.ghost?.minActionable ?? ""), maxFixComplexity: String(s.ghost?.maxFixComplexity ?? ""),
});

export default function Settings({ wm, params, nonce, modern = false }) {
  const [tab, setTab] = useState(tabOf(params?.tab) || (modern ? "general" : "install"));
  useEffect(() => { const t = tabOf(params?.tab); if (t) setTab(t); }, [params?.tab, nonce]);

  const meta = useApi("meta", { on: ["settings"] });
  const overview = useApi(["general", "install", "jev"].includes(tab) ? "overview" : null, { every: 5000, on: ["verdict"] });
  const stream = useStreamStatus();
  const settings = meta.data?.project?.settings || null;
  const rule = useDraft(settings, pickRule);
  const ghost = useDraft(settings, pickGhost);
  const jev = overview.data?.jev || meta.data?.jev || null;

  const body = () => {
    if (meta.loading && !meta.data) return <div className="muted pad">Loading settings…</div>;
    if (meta.error && !meta.data) return <div className="err">Could not load settings: {meta.error}. Is the backend on :3001 running?</div>;
    switch (tab) {
      case "general": return <SettingsOverview meta={meta} jev={jev} overview={overview} navigate={setTab} />;
      case "install": return <InstallTab meta={meta} overview={overview} wm={wm} />;
      case "jev": return <JevTab jev={jev} overview={overview} />;
      case "rule": return <RuleTab form={rule} meta={meta} jevOn={!!jev?.enabled} />;
      case "ghost": return <GhostTab form={ghost} meta={meta} jevOn={!!jev?.enabled} wm={wm} />;
      case "flags": return <FlagsTab />;
      default: return <ProjectsTab meta={meta} />;
    }
  };

  if (modern) {
    const section = SECTIONS.find(([id]) => id === tab) || SECTIONS[0];
    return <div className="settings-page"><div className="dash-intro"><div><p className="eyebrow">MAKE SIGNAL 98 YOURS</p><h1>Settings</h1><p>Connect your app, choose how issues are classified, and control the fix assistant.</p></div><button className="dash-button primary" onClick={openSetup}>Setup walkthrough →</button></div><div className="settings-layout"><nav className="settings-nav" aria-label="Settings sections">{SECTIONS.map(([id, title, hint]) => <button key={id} onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined} className={tab === id ? "on" : ""}><strong>{title}{(id === "ghost" && ghost.dirty) || (id === "rule" && rule.dirty) ? " · unsaved" : ""}</strong><span>{hint}</span></button>)}</nav><section className="settings-content"><header><h2>{section[1]}</h2><p>{section[2]}</p></header>{meta.error && meta.data && <p className="dash-warning">Couldn’t refresh settings. Showing the last saved values.</p>}<div className="settings-body">{body()}</div></section></div><p className="settings-foot">{rule.dirty || ghost.dirty ? "You have unsaved changes. Use Save in the section you edited." : "Changes take effect only when you save them."}</p></div>;
  }

  return (
    <div className="s98-app">
      <div className="tabs" role="tablist">
        {TABS.map(([k, name]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>
            {name}{(k === "rule" && rule.dirty) || (k === "ghost" && ghost.dirty) ? " *" : ""}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {meta.error && meta.data ? <div className="err">Showing the last good copy — reload failed: {meta.error}</div> : null}
        {body()}
      </div>
      <div className="statusbar">
        <div className="cell grow sunken-thin">{rule.dirty || ghost.dirty ? "Unsaved changes (*) — press Save on that tab" : meta.data ? `Project “${meta.data.project?.name ?? "?"}” (#${meta.data.project?.id ?? "?"})` : "…"}</div>
        <div className="cell sunken-thin">{jev ? (jev.enabled ? `JEV · ${jev.model}` : "heuristic mode") : "…"}</div>
        <div className="cell sunken-thin">ghost: {meta.data?.ghost_provider || "…"}</div>
        <div className="cell sunken-thin">stream {stream}</div>
      </div>
    </div>
  );
}

function SettingsOverview({ meta, jev, overview, navigate }) {
  const connected = !!overview.data?.events_24h;
  return <div className="setup-overview"><p className="settings-lede">Three parts work together. Here’s what is connected right now.</p><div className="setup-item"><span className="setup-number">1</span><div><h3>Capture activity from your app</h3><span className={`connection-label ${connected ? "ok" : ""}`}>{connected ? "Events received in the last 24 hours" : "Waiting for events"}</span><p>The demo shop is already instrumented. Use this section when you’re ready to connect your own app.</p><button className="dash-link" onClick={() => navigate("install")}>View installation →</button></div></div><div className="setup-item"><span className="setup-number">2</span><div><h3>Classify issues with JEV</h3><span className={`connection-label ${jev?.lastOkAt && jev?.circuit !== "open" ? "ok" : ""}`}>{!jev?.enabled ? "Not connected · using keyword rules" : jev.circuit === "open" ? "Connection failing · using fallback" : jev.lastOkAt ? "Connected · successful response received" : "Key configured · awaiting first response"}</span><p>JEV decides how urgent an issue is. It is separate from the coding assistant that suggests fixes.</p><button className="dash-link" onClick={() => navigate("jev")}>{jev?.enabled ? "View JEV connection" : "Set up JEV"} →</button></div></div><div className="setup-item"><span className="setup-number">3</span><div><h3>Choose how Ghost helps</h3><span className="connection-label ok">{meta.data?.ghost_provider === "claude-code" ? "Claude Code available" : meta.data?.ghost_provider === "openai-compatible" ? "Model provider available" : "Template suggestions only"}</span><p>{meta.data?.project?.settings?.ghost?.autoMode ? "Automatic agent runs are enabled." : "Agent runs are started manually."} {meta.data?.project?.settings?.ghost?.autoApply ? "Automatic application is enabled for automatic runs." : "Fixes require review before application."}</p><button className="dash-link" onClick={() => navigate("ghost")}>Configure fix assistant →</button></div></div><div className="settings-tip"><strong>Just exploring?</strong><p>Go to the dashboard and choose Start a fresh demo, then open the demo controls. You can test capture without a JEV key.</p></div></div>;
}

// ================================================================ install
function snippets(host, key) {
  return {
    script: {
      name: "Script tag", where: "Paste into <head> of every page. Exposes window.signal98 and starts capturing at once.",
      code: `<script src="${host}/s98.js" data-key="${key}" data-host="${host}" defer></script>`,
    },
    npm: {
      name: "npm", where: `Install from this monitor: npm install "${host}/downloads/signal98-0.2.0.tgz" — then initialize once, as early as possible.`,
      code: `import { init } from "signal98";\n\ninit({\n  host: "${host}",\n  apiKey: "${key}",\n  environment: "production", // optional\n  release: "1.4.2",          // optional: lets you see which deploy broke it\n});`,
    },
    react: {
      name: "React", where: "An error boundary that reports render crashes (uncaught errors are captured without it).",
      code: `import { init } from "signal98";\nimport { createErrorBoundary } from "signal98/react";\n\ninit({ host: "${host}", apiKey: "${key}" });\nconst SignalBoundary = createErrorBoundary({ fallback: <p>Something broke.</p> });\n\nexport default function Root() {\n  return (\n    <SignalBoundary>\n      <App />\n    </SignalBoundary>\n  );\n}`,
    },
    node: {
      name: "Node / Express", where: "uncaughtException and unhandledRejection are captured by init(); the middleware adds request context and 5xx errors.",
      code: `import express from "express";\nimport { init, requestHandler, errorHandler, captureException } from "signal98";\n\ninit({ host: "${host}", apiKey: "${key}", service: "api" });\n\nconst app = express();\napp.use(requestHandler());   // first: one breadcrumb per request\n// ... your routes ...\napp.use(errorHandler());     // after the routes, before your own error handler\n\n// anywhere: report a caught error yourself\ntry { await chargeCard(); } catch (err) { captureException(err, { where: "checkout" }); throw err; }`,
    },
  };
}

function InstallTab({ meta, overview, wm }) {
  const project = meta.data?.project;
  const key = project?.api_key || "";
  const [host, setHost] = useState("");
  useEffect(() => { setHost(window.location.origin); }, []);
  const [which, setWhich] = useState("script");
  const [rotating, setRotating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [live, setLive] = useState(null); // the first event seen on the stream since this tab opened
  const last = useApi("events?limit=1");
  useStream((m) => {
    if (m.type !== "event" || !m.data) return;
    const row = m.data.event && typeof m.data.event === "object" ? m.data.event : m.data; // { project_id, event: row, issue }
    setLive({ event: typeof row.event === "string" ? row.event : "event", ts: Number(row.ts) || Date.now() });
  });

  const snip = snippets(host || "http://localhost:3001", key)[which];
  const lastEvent = live || last.data?.events?.[0] || null;
  const n24 = overview.data?.events_24h;
  const arrived = !!lastEvent || n24 > 0;

  const rotate = async () => {
    setBusy(true); setError(null);
    try {
      await api("projects/rotate-key", { method: "POST" });
      await meta.reload();
      setRotating(false);
    } catch (err) { setError(err.message); }
    setBusy(false);
  };

  return (
    <div className="grow scroll">
      <div className="group98">
        <span className="gl">Project API key</span>
        <div className="row">
          <input className="in98 mono grow" readOnly value={key} aria-label="project API key" onFocus={(e) => e.target.select()} />
          <CopyButton text={key} />
          <button type="button" className="btn98 small" onClick={() => { setError(null); setRotating(true); }}>Rotate key…</button>
        </div>
        <div className="muted" style={{ paddingTop: 4 }}>A public capture key: it can send events and read evaluated feature flags, but cannot access admin data. It travels in the page source, like any analytics key.</div>
      </div>

      <div className="group98">
        <span className="gl">Add signal98 to your app</span>
        <div className="row" style={{ flexWrap: "wrap" }}>
          {Object.entries(snippets("", "")).map(([k, s]) => <button key={k} type="button" className={`tool-btn${which === k ? " on" : ""}`} onClick={() => setWhich(k)}>{s.name}</button>)}
          <span className="grow" />
          <CopyButton text={snip.code}>Copy snippet</CopyButton>
        </div>
        <div className="muted" style={{ padding: "6px 0 4px" }}>{snip.where}</div>
        <pre className="code sunken selectable">{snip.code}</pre>
        <div className="muted" style={{ paddingTop: 4 }}>Host is this monitor's address ({host || "…"}). If your app reaches it under another name, change it in the snippet.</div>
      </div>

      <div className="group98">
        <span className="gl">Verify installation</span>
        {overview.error && !overview.data && !lastEvent ? <div className="err">Could not check: {overview.error}</div>
          : !overview.data && !lastEvent ? <div className="muted">Checking…</div>
          : arrived ? (
            <div className="row" style={{ alignItems: "flex-start" }}>
              <span className="vtag resolved">RECEIVING</span>
              <div className="grow">
                <b>Events are arriving.</b> {n24 != null ? `${fmtNum(n24)} in the last 24 h.` : ""}
                {lastEvent ? <div className="muted">Last: <span className="mono">{lastEvent.event}</span> · {fmtDateTime(lastEvent.ts)} ({ago(lastEvent.ts)})</div> : null}
              </div>
              <button type="button" className="btn98 small" onClick={() => wm?.open?.("feed")}>Open live feed</button>
            </div>
          ) : (
            <div className="row" style={{ alignItems: "flex-start" }}>
              <span className="vtag judging">WAITING<span className="cursor-blink">…</span></span>
              <div className="grow">
                <b>No event has arrived yet.</b> This box updates by itself the moment the first one lands.
                <div className="muted">Load a page of your app with the snippet in place, or open the playground at :3000 and press a button. A 401 in the app's network tab means the key is wrong.</div>
              </div>
            </div>
          )}
      </div>

      {rotating ? (
        <Confirm title="Rotate API key" okLabel="Rotate key" busy={busy} error={error} onOk={rotate} onCancel={() => setRotating(false)}>
          <p>Generate a new key for <b>{project?.name || "this project"}</b>?</p>
          <p>The old key stops working immediately: every app still using it gets 401 and <b>stops reporting</b> until you deploy the new key — including the playground.</p>
        </Confirm>
      ) : null}
    </div>
  );
}

// ================================================================ JEV
function JevTab({ jev, overview }) {
  if (!jev) return <p>{overview.error ? "Couldn’t load the connection status. Please try again." : "Checking JEV connection…"}</p>;
  const healthy = jev.enabled && jev.lastOkAt && jev.circuit !== "open";
  return <div className="jev-settings"><div className={`jev-connection ${healthy ? "connected" : ""}`}><span className="connection-label">{healthy ? "Connected" : !jev.enabled ? "Not connected" : jev.circuit === "open" ? "Connection failing" : "Not verified yet"}</span><h3>{!jev.enabled ? "JEV isn’t being used yet." : healthy ? "JEV has responded successfully." : "JEV is configured, but not currently verified."}</h3><p>{!jev.enabled ? "The integration is built, but this server has no TypeSafe API key. All current judgments are made by local keyword rules and labelled heuristic." : jev.circuit === "open" ? "Requests are failing. New judgments fall back to keyword rules until JEV recovers." : !jev.lastOkAt ? "A key is present. A successful classification request is still needed to confirm that it works." : "Each issue shows the classifier that actually judged it. Failed requests may still use the keyword fallback."}</p></div>{!healthy && <section className="jev-setup"><h3>Connect JEV in three steps</h3><ol><li><strong>Use a TypeSafe API key.</strong><p>The key belongs on the monitor’s server, not in the browser or the shop’s public SDK key.</p></li><li><strong>Add it to the server configuration.</strong><p>Set this in <code>desktop/.env.local</code>:</p><pre>TYPESAFE_API_KEY=your_key_here</pre><p>This screen never displays or stores your private key.</p></li><li><strong>Restart the monitor.</strong><p>Previously heuristic judgments are retried in the background. A successful response will appear here.</p></li></ol></section>}<div className="jev-facts"><div><span>Last successful response</span><strong>{jev.lastOkAt ? fmtDateTime(jev.lastOkAt) : "None since server start"}</strong></div><div><span>Model</span><strong>{jev.model || "Not selected"}</strong></div></div>{jev.lastError && <div className="dash-warning"><strong>Latest connection error</strong><p>{jev.lastError}</p></div>}<button className="dash-button quiet" onClick={overview.reload}>Refresh connection status</button><details className="settings-details"><summary>Usage and technical details</summary><div className="jev-facts"><div><span>Requests today</span><strong>{fmtNum(jev.today?.requests || 0)}</strong></div><div><span>Keyword judgments today</span><strong>{fmtNum(jev.today?.heuristic || 0)}</strong></div><div><span>JEV cost, last 30 days</span><strong>{fmtUsd(jev.cost_30d_usd)}</strong></div><div><span>Queued requests</span><strong>{jev.queued || 0}</strong></div></div><p>JEV judges grouped issues rather than every repeated error. Repeat occurrences can reuse an existing judgment.</p></details></div>;
}

// ================================================================ save bar shared by the two settings forms
function SaveBar({ form, busy, error, savedAt }) {
  return (
    <div className="row" style={{ padding: "6px 4px 2px" }}>
      <button type="submit" className="btn98" disabled={busy || !form.dirty}>{busy ? "Saving…" : "Save"}</button>
      <button type="button" className="btn98" disabled={busy || !form.dirty} onClick={form.revert}>Revert</button>
      {error ? <span className="err" style={{ padding: 0 }}>{error}</span> : savedAt && !form.dirty ? <span className="muted">Saved.</span> : null}
    </div>
  );
}

function NumIn({ d, k, set, min, max, step }) {
  return <input className="in98" type="number" min={min} max={max} step={step} value={d[k] ?? ""} onChange={(e) => set(k, e.target.value)} aria-label={k} />;
}

function inRange(d, key, lo, hi, name, integer = false) {
  const v = num(d[key]);
  if (v == null || v < lo || v > hi || (integer && !Number.isInteger(v))) return `${name} must be ${integer ? "a whole number" : "a number"} between ${lo} and ${hi}.`;
  return null;
}

// ================================================================ verdict rule
function RuleTab({ form, meta, jevOn }) {
  const d = form.draft;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  if (!d) return <div className="muted pad">Loading…</div>;
  const setK = (k, v) => { setError(null); form.set({ [k]: v }); };
  const show = (k) => (num(d[k]) == null ? "?" : num(d[k]));

  const save = async () => {
    const bad = inRange(d, "pageSeverity", 0, 4, "Page severity") || inRange(d, "pageUserFacing", 0, 1, "Page user-facing") || inRange(d, "pageUrgent", 0, 1, "Page urgent") ||
      inRange(d, "notifySeverity", 0, 4, "Notify severity") || inRange(d, "noise", 0, 1, "Noise") ||
      inRange(d, "sessionIdleMinutes", 0.25, 120, "Session idle minutes") || inRange(d, "retentionDays", 1, 3650, "Retention days", true);
    if (bad) return setError(bad);
    setBusy(true); setError(null);
    try {
      await api("settings", { method: "PATCH", body: {
        thresholds: { pageSeverity: num(d.pageSeverity), pageUserFacing: num(d.pageUserFacing), pageUrgent: num(d.pageUrgent), notifySeverity: num(d.notifySeverity), noise: num(d.noise) },
        sessionIdleMinutes: num(d.sessionIdleMinutes), retentionDays: num(d.retentionDays),
      } });
      await meta.reload();
      form.saved(); setSavedAt(Date.now());
    } catch (err) { setError(err.message); }
    setBusy(false);
  };

  return (
    <form className="grow scroll" noValidate onSubmit={(e) => { e.preventDefault(); if (!busy) save(); }}>
      <div className="note98">
        {jevOn ? "JEV" : "The classifier (the heuristic right now — JEV is off)"} scores each issue: severity 0–4 and probabilities 0–1. This rule, not a volume threshold, turns those scores into a verdict.
      </div>
      <div className="group98">
        <span className="gl">Thresholds</span>
        <div className="rule98">
          <label>Noise</label><NumIn d={d} set={setK} k="noise" min="0" max="1" step="0.05" />
          <span>Checked first: noise probability ≥ this means <VTag v="ignore" /> — unless severity is 3 or more.</span>
          <label>Page: severity</label><NumIn d={d} set={setK} k="pageSeverity" min="0" max="4" step="0.1" />
          <span><VTag v="page" /> needs severity (0–4) at or above this…</span>
          <label>Page: user-facing</label><NumIn d={d} set={setK} k="pageUserFacing" min="0" max="1" step="0.05" />
          <span>…and the probability that users see it at or above this…</span>
          <label>Page: urgent</label><NumIn d={d} set={setK} k="pageUrgent" min="0" max="1" step="0.05" />
          <span>…and the probability that it cannot wait at or above this. All three together.</span>
          <label>Notify: severity</label><NumIn d={d} set={setK} k="notifySeverity" min="0" max="4" step="0.1" />
          <span><VTag v="notify" /> when severity reaches this without meeting the page rule.</span>
        </div>
        {num(d.notifySeverity) != null && num(d.pageSeverity) != null && num(d.notifySeverity) > num(d.pageSeverity)
          ? <div className="muted" style={{ paddingTop: 6 }}>Note: notify severity is above page severity, so almost nothing will ever be “notify”.</div> : null}
        <div className="english98 sunken-thin selectable">
          <b>The rule in plain English, in order:</b>
          <ol>
            <li>Noise ≥ {show("noise")} and severity below 3 → <b>IGNORE</b>.</li>
            <li>Severity ≥ {show("pageSeverity")} <i>and</i> user-facing ≥ {show("pageUserFacing")} <i>and</i> urgent ≥ {show("pageUrgent")} → <b>PAGE</b>. Also PAGE, whatever the numbers above: security relevance or data risk ≥ 0.8 with severity ≥ 2, or revenue impact ≥ 0.8 with urgent ≥ {show("pageUrgent")}.</li>
            <li>Severity ≥ {show("notifySeverity")}, or urgent ≥ 0.6 → <b>NOTIFY</b>.</li>
            <li>Actionable ≥ 0.5, or severity ≥ 1 → <b>TICKET</b>.</li>
            <li>Anything else → <b>IGNORE</b>.</li>
          </ol>
        </div>
        <div className="muted" style={{ paddingTop: 6 }}>New thresholds apply to issues judged from now on. An existing issue keeps its verdict until it is re-judged (it grows, regresses, or you press Re-judge).</div>
      </div>
      <div className="group98">
        <span className="gl">Sessions and retention</span>
        <div className="rule98">
          <label>Session idle (min)</label><NumIn d={d} set={setK} k="sessionIdleMinutes" min="0.25" max="120" step="0.25" />
          <span>A session is read and classified once it has been quiet for this long (0.25–120).</span>
          <label>Retention (days)</label><NumIn d={d} set={setK} k="retentionDays" min="1" max="3650" step="1" />
          <span>Events older than this are pruned (1–3650).</span>
        </div>
      </div>
      <SaveBar form={form} busy={busy} error={error} savedAt={savedAt} />
    </form>
  );
}

// ================================================================ ghost
const PROVIDERS = {
  "claude-code": "The Claude Code CLI was found on this machine. The ghost reads your repository to diagnose issues and can dispatch coding agents that fix bugs on a branch.",
  "openai-compatible": "An OpenAI-compatible chat model (LLM_API_KEY or DEEPSEEK_API_KEY) writes diagnoses and patch suggestions from the stack trace. It cannot read or edit your code, so agent runs are skipped — install the Claude Code CLI for those.",
  template: "No generative model is configured. The ghost fills in a template plan from the classification: no reading of your code, no agent runs. Install the Claude Code CLI (or set SIGNAL98_CLAUDE_BIN), or put LLM_API_KEY in desktop/.env.local, then restart.",
};

function GhostTab({ form, meta, jevOn, wm }) {
  const d = form.draft;
  const provider = meta.data?.ghost_provider;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [confirming, setConfirming] = useState(false);
  if (!d) return <div className="muted pad">Loading…</div>;
  const set = (patch) => { setError(null); form.set(patch); };

  const validate = () => inRange(d, "maxAttemptsPerIssue", 1, 20, "Max attempts per issue", true) || inRange(d, "maxRunsPerDay", 0, 500, "Max runs per day", true) ||
    inRange(d, "minActionable", 0, 1, "Min actionable") || inRange(d, "maxFixComplexity", 0, 4, "Max fix complexity");

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api("settings", { method: "PATCH", body: { ghost: {
        repoPath: d.repoPath.trim(), autoMode: d.autoMode, autoApply: d.autoApply,
        maxAttemptsPerIssue: num(d.maxAttemptsPerIssue), maxRunsPerDay: num(d.maxRunsPerDay), minActionable: num(d.minActionable), maxFixComplexity: num(d.maxFixComplexity),
      } } });
      await meta.reload();
      form.saved(); setSavedAt(Date.now()); setConfirming(false);
    } catch (err) { setError(err.message); }
    setBusy(false);
  };
  const submit = () => {
    const bad = validate();
    if (bad) return setError(bad);
    // switching auto-apply on is the one setting that lets software edit your checkout unattended
    if (d.autoMode && d.autoApply && !(form.base?.autoMode && form.base?.autoApply)) return setConfirming(true);
    save();
  };
  const setK = (k, v) => set({ [k]: v });

  return (
    <>
      <form className="grow scroll" noValidate onSubmit={(e) => { e.preventDefault(); if (!busy) submit(); }}>
        <div className="group98">
          <span className="gl">Provider</span>
          <div><b className="mono">{provider || "…"}</b></div>
          <div className="muted" style={{ paddingTop: 3, lineHeight: 1.5 }}>{PROVIDERS[provider] || "Detected when the server starts."}</div>
        </div>

        <div className="group98">
          <span className="gl">Repository of the monitored app</span>
          <input className="in98 mono" style={{ width: "100%" }} type="text" spellCheck={false} autoComplete="off" value={d.repoPath}
            placeholder="/Users/you/code/your-app" aria-label="repository path" onChange={(e) => set({ repoPath: e.target.value })} />
          <div className="muted" style={{ paddingTop: 4, lineHeight: 1.5 }}>
            An absolute path on the machine running this server, inside a git checkout (a subdirectory is fine).
            {d.repoPath.trim() ? " It is checked when a run starts: a bad path produces a skipped run that says why." : " Empty: the ghost diagnoses from stack traces only, and every agent run is skipped."}
          </div>
        </div>

        <div className="group98">
          <span className="gl">Auto mode</span>
          <label className="check98"><input type="checkbox" checked={d.autoMode} onChange={(e) => set({ autoMode: e.target.checked })} /> <b>Auto mode</b> — dispatch a fix agent right after a verdict, without asking</label>
          <div className="warn98">
            <WarnIcon size={22} />
            <div>
              What keeps an unattended agent safe:
              <ul>
                <li>It works in its own <b>git worktree</b> on a new branch <span className="mono">signal98/fix-&lt;issue&gt;-&lt;attempt&gt;</span>. It includes your current uncommitted files, excluding ignored files. Your checkout, staging and current branch are preserved.</li>
                <li><b>No shell.</b> It gets Read, Grep, Glob, Edit and Write only, confined to that worktree.</li>
                <li><b>Budgets:</b> one run at a time, the attempt and daily limits below, a 10 minute timeout and a USD cap per run (SIGNAL98_AGENT_BUDGET_USD, default $2).</li>
                <li>The result is a diff you review in the run window. Nothing reaches your working tree until you press Apply — unless auto-apply is on.</li>
              </ul>
            </div>
          </div>
          <label className="check98" style={{ marginTop: 4 }}><input type="checkbox" checked={d.autoApply} disabled={!d.autoMode} onChange={(e) => set({ autoApply: e.target.checked })} /> <b>Auto-apply</b> successful automatic fixes {d.autoMode ? "" : <span className="muted">(only matters in Auto mode)</span>}</label>
          <div className="warn98 danger">
            <WarnIcon size={22} />
            <div><b>This edits your working tree with no human review.</b> When an automatic run succeeds, its diff is applied to the repository above without changing your staging and the issue is marked resolved; a dev server will hot-reload the change. Uncommitted work in the same files can conflict. Runs you start by hand are never auto-applied. Leave this off unless the repository is a sandbox.</div>
          </div>
        </div>

        <div className="group98">
          <span className="gl">Limits and JEV gates</span>
          <div className="rule98">
            <label>Max attempts / issue</label><NumIn d={d} set={setK} k="maxAttemptsPerIssue" min="1" max="20" step="1" />
            <span>After this many runs on one issue the ghost stops and leaves it to a human.</span>
            <label>Max runs / day</label><NumIn d={d} set={setK} k="maxRunsPerDay" min="0" max="500" step="1" />
            <span>Across all issues, per rolling 24 hours. 0 stops every run, manual ones too.</span>
            <label>Min actionable</label><NumIn d={d} set={setK} k="minActionable" min="0" max="1" step="0.05" />
            <span>Auto mode only acts when the “this is a code defect someone can fix” probability is at least this.</span>
            <label>Max fix complexity</label><NumIn d={d} set={setK} k="maxFixComplexity" min="0" max="4" step="0.1" />
            <span>…and the fix-complexity score (0 trivial – 4 architectural) is at most this.</span>
          </div>
          <div className="muted" style={{ paddingTop: 6, lineHeight: 1.5 }}>
            Also always required in Auto mode: the issue is open, its verdict is page, notify or ticket, and its noise probability is under 0.5. If a fixed issue fires again it regresses, is re-judged, and the next attempt is told what was tried before.
            {jevOn ? "" : " JEV is off, so these gates currently run on the heuristic's numbers, not JEV's."}
          </div>
        </div>
        <div className="row" style={{ padding: "0 4px" }}>
          <span className="grow"><SaveBar form={form} busy={busy} error={confirming ? null : error} savedAt={savedAt} /></span>
          <button type="button" className="btn98 small" onClick={() => wm?.open?.("runs")}>Ghost runs…</button>
        </div>
      </form>
      {confirming ? (
        <Confirm title="Turn on auto-apply" okLabel="Turn it on" busy={busy} error={error} onOk={save} onCancel={() => setConfirming(false)}>
          <p>From now on the ghost may <b>edit the working tree</b> of <span className="mono selectable">{d.repoPath.trim() || "(no repository set)"}</span> by itself, whenever an automatic run succeeds.</p>
          <p>Nobody reviews those diffs first. Turn it on?</p>
        </Confirm>
      ) : null}
    </>
  );
}

// ================================================================ feature flags
const normKey = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 60);

function FlagsTab() {
  const flags = useApi("feature-flags");
  const list = flags.data?.flags || [];
  const [f, setF] = useState({ key: "", name: "", rollout: "100" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [pending, setPending] = useState({});   // id → optimistic enabled
  const [rollouts, setRollouts] = useState({}); // id → text being edited
  const keyRef = useRef(null);
  const key = normKey(f.key);
  const example = list.find((x) => x.id === sel)?.key || list[0]?.key || key || "new-checkout";

  const create = async () => {
    const rollout = num(f.rollout);
    if (!key) return setError("Type a key, for example new-checkout.");
    if (list.some((x) => x.key === key)) return setError(`A flag with the key “${key}” already exists.`);
    if (rollout == null || rollout < 0 || rollout > 100) return setError("Rollout is a percentage, 0–100.");
    setBusy(true); setError(null);
    try {
      await api("feature-flags", { method: "POST", body: { key, name: f.name.trim() || key, rollout: Math.round(rollout), enabled: true } });
      setF({ key: "", name: "", rollout: "100" });
      keyRef.current?.focus();
    } catch (err) { setError(err.message); }
    setBusy(false);
    flags.reload();
  };

  const patch = async (flag, body) => {
    setError(null);
    if (body.enabled !== undefined) setPending((p) => ({ ...p, [flag.id]: body.enabled }));
    try { await api(`feature-flags/${flag.id}`, { method: "PATCH", body }); }
    catch (err) { setError(`Could not update “${flag.key}”: ${err.message}`); }
    await flags.reload();
    setPending((p) => { const n = { ...p }; delete n[flag.id]; return n; });
    setRollouts((r) => { const n = { ...r }; delete n[flag.id]; return n; });
  };
  const commitRollout = (flag) => {
    const text = rollouts[flag.id];
    if (text === undefined) return;
    const v = num(text);
    if (v == null || v < 0 || v > 100) { setError("Rollout is a percentage, 0–100."); return setRollouts((r) => { const n = { ...r }; delete n[flag.id]; return n; }); }
    if (Math.round(v) === flag.rollout) return setRollouts((r) => { const n = { ...r }; delete n[flag.id]; return n; });
    patch(flag, { rollout: Math.round(v) });
  };

  const remove = async () => {
    setBusy(true); setError(null);
    try { await api(`feature-flags/${deleting.id}`, { method: "DELETE" }); setDeleting(null); }
    catch (err) { setError(err.message); }
    setBusy(false);
    flags.reload();
  };

  return (
    <>
      <form className="row" style={{ paddingBottom: 6, flexWrap: "wrap" }} noValidate onSubmit={(e) => { e.preventDefault(); if (!busy) create(); }}>
        <input ref={keyRef} className="in98 mono" style={{ width: 150 }} type="text" placeholder="flag-key" aria-label="flag key" spellCheck={false} value={f.key} onChange={(e) => { setError(null); setF({ ...f, key: e.target.value }); }} />
        <input className="in98 grow" style={{ minWidth: 100 }} type="text" placeholder="What it switches (optional)" aria-label="flag name" maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input className="in98" style={{ width: 56 }} type="number" min="0" max="100" step="1" aria-label="rollout percent" value={f.rollout} onChange={(e) => setF({ ...f, rollout: e.target.value })} /><span>%</span>
        <button type="submit" className="btn98 small" disabled={busy}>Create flag</button>
      </form>
      {f.key && key !== f.key.trim() ? <div className="muted" style={{ paddingBottom: 4 }}>Will be stored as <span className="mono">{key || "(empty)"}</span> — keys are lower-case letters, digits, “-” and “_”.</div> : null}
      {error && !deleting ? <div className="err">{error}</div> : null}
      <div className="pane sunken">
        {flags.loading && !flags.data ? <div className="muted pad">Loading flags…</div>
          : flags.error && !flags.data ? <div className="err">Could not load flags: {flags.error}</div>
          : list.length === 0 ? <div className="muted pad">No feature flags yet. Create one above, then gate code on it with the line below. A flag at 100% is on for everyone; lower the rollout to ship to a stable slice of users.</div>
          : (
            <table className="t98">
              <thead><tr><th>On</th><th>Key</th><th>Name</th><th className="num">Rollout %</th><th>Serves</th><th>Created</th><th /></tr></thead>
              <tbody>
                {list.map((flag) => (
                  <tr key={flag.id} className={sel === flag.id ? "sel" : ""} onClick={() => setSel(flag.id)}>
                    <td><input type="checkbox" checked={pending[flag.id] ?? !!flag.enabled} aria-label={`enable ${flag.key}`} onClick={(e) => e.stopPropagation()} onChange={(e) => patch(flag, { enabled: e.target.checked })} /></td>
                    <td className="mono selectable">{flag.key}</td>
                    <td title={flag.name || undefined}>{flag.name && flag.name !== flag.key ? flag.name : <span className="muted">–</span>}</td>
                    <td className="num">
                      <input className="in98" style={{ width: 56, textAlign: "right" }} type="number" min="0" max="100" step="1" aria-label={`rollout of ${flag.key}`}
                        value={rollouts[flag.id] ?? String(flag.rollout ?? 0)} onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRollouts((r) => ({ ...r, [flag.id]: e.target.value }))}
                        onBlur={() => commitRollout(flag)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setRollouts((r) => { const n = { ...r }; delete n[flag.id]; return n; }); }} />
                    </td>
                    <td>{Array.isArray(flag.variants) && flag.variants.length ? flag.variants.join(" / ") : "true / false"}</td>
                    <td>{flag.created_at ? fmtDateTime(flag.created_at) : "–"}</td>
                    <td className="acts"><button type="button" className="btn98 small" onClick={(e) => { e.stopPropagation(); setError(null); setDeleting(flag); }}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      <div className="note98">
        In your app: <span className="mono selectable">{`if (signal98.isFeatureEnabled("${example}")) { /* new path */ }`}</span> <CopyButton text={`signal98.isFeatureEnabled("${example}")`} />
        <div className="muted">A user's bucket is a stable hash of flag key + distinct_id, so nobody flips between on and off. A switched-off flag is false for everyone.</div>
      </div>
      {deleting ? (
        <Confirm title="Delete feature flag" okLabel="Delete" busy={busy} error={error} onOk={remove} onCancel={() => setDeleting(null)}>
          <p>Delete the flag <b className="mono">{deleting.key}</b>?</p>
          <p className="muted">Code that still asks for it gets <span className="mono">false</span> from then on.</p>
        </Confirm>
      ) : null}
    </>
  );
}

// ================================================================ projects
function ProjectsTab({ meta }) {
  const projects = meta.data?.projects || [];
  const currentId = meta.data?.project?.id;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);

  const create = async () => {
    if (!name.trim()) return setError("Give the project a name.");
    setBusy(true); setError(null);
    try {
      const r = await api("projects", { method: "POST", body: { name: name.trim().slice(0, 80) } });
      setCreated(r?.project || null);
      setName("");
    } catch (err) { setError(err.message); }
    setBusy(false);
    meta.reload();
  };

  return (
    <>
      <form className="row" style={{ paddingBottom: 6 }} noValidate onSubmit={(e) => { e.preventDefault(); if (!busy) create(); }}>
        <input className="in98 grow" type="text" maxLength={80} placeholder="New project name, e.g. shop-web production" aria-label="new project name" value={name} onChange={(e) => { setError(null); setName(e.target.value); }} />
        <button type="submit" className="btn98 small" disabled={busy}>{busy ? "Creating…" : "Create project"}</button>
      </form>
      {error ? <div className="err">{error}</div> : null}
      {created ? (
        <div className="warn98" style={{ alignItems: "center" }}>
          <div className="grow">Project <b>{created.name}</b> (#{created.id}) created. Its API key: <span className="mono selectable">{created.api_key}</span></div>
          <CopyButton text={created.api_key} />
        </div>
      ) : null}
      <div className="pane sunken">
        {projects.length === 0 ? <div className="muted pad">No projects — the server normally seeds one called “default” on first start.</div> : (
          <table className="t98">
            <thead><tr><th className="num">Id</th><th>Name</th><th>API key</th><th>Created</th><th /></tr></thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td className="num">{p.id}</td>
                  <td>{p.name}{p.id === currentId ? <span className="muted"> — shown on this desktop</span> : null}</td>
                  <td className="mono selectable">{p.api_key}</td>
                  <td>{p.created_at ? fmtDateTime(p.created_at) : "–"}</td>
                  <td className="acts"><CopyButton text={p.api_key}>Copy key</CopyButton></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="note98">
        Each project has its own key, events, issues, rules and settings. This desktop shows the first project; switching is not built yet.
        Every API call accepts <span className="mono selectable">?project=&lt;id&gt;</span>, e.g. <span className="mono selectable">/api/overview?project=2</span>.
      </div>
    </>
  );
}
