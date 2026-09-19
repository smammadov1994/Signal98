"use client";
// The modern dashboard shell: sidebar + one main view + a slide-over drawer for detail screens.
// It hosts exactly the same app components as the Win98 window manager (see registry.jsx):
//   singleton apps  → the main view (visited views stay mounted, so a live feed keeps its rows)
//   multi apps      → a drawer stack on the right (issue → session → person, with Back)
// The `wm` contract from docs/UI.md is unchanged: open / close / setTitle.
import { useCallback, useEffect, useRef, useState } from "react";
import { APPS, NAV, glyph } from "./registry";
import Dashboard from "./MonitoringDashboard";
import { IssueBrief, SimpleIssues } from "./Dashboard";
import { GhostGlyph } from "./Ghost";
import { useDemoSession } from "../lib/demo-session";
import { useApi, useStreamStatus } from "../lib/client";


export default function ModernShell({ overview, meta, onToggleTheme }) {
  const [active, setActive] = useState("conversations");
  const [views, setViews] = useState({ conversations: { params: {}, nonce: 0 } }); // visited singleton views
  const [drawers, setDrawers] = useState([]); // [{ id, app, params, nonce, title }]
  const hotTarget = null;
  const [advanced, setAdvanced] = useState(false);
  const [navOpen, setNavOpen] = useState(false); // narrow screens
  const mainRef = useRef(null);
  const dialogRef = useRef(null);
  const stream = useStreamStatus();
  const demoSession = useDemoSession();
  const scopedOverview = useApi(demoSession.since ? `overview?since=${demoSession.since}` : null, { every: 10000, on: ["event", "issue", "verdict"] });

  const open = useCallback((app, params = {}) => {
    const def = APPS[app];
    if (!def) return;
    if (def.multi) {
      if (params.id === undefined || params.id === null) return;
      const id = `${app}:${params.id}`;
      setDrawers((ds) => {
        const existing = ds.find((d) => d.id === id);
        const rest = ds.filter((d) => d.id !== id);
        return [...rest, existing ? { ...existing, params: { ...existing.params, ...params }, nonce: existing.nonce + 1 } : { id, app, params, nonce: 0, title: def.title }];
      });
      return;
    }
    setDrawers([]); // navigating the main view closes detail panels, like any dashboard
    setNavOpen(false);
    setActive(app);
    setViews((v) => ({ ...v, [app]: v[app] ? { params: { ...v[app].params, ...params }, nonce: v[app].nonce + 1 } : { params, nonce: 0 } }));
  }, []);

  // Deep links show a problem; ordinary visits start at the conversation inbox.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("issue")) { open("conversations", { id: Number(p.get("issue")) }); }
    else if (p.get("session")) { open("sessions"); open("session", { id: p.get("session") }); }
    const onMsg = (e) => {
      try {
        const u = new URL(e.data?.url, window.location.origin);
        if (u.searchParams.get("issue")) open("conversations", { id: Number(u.searchParams.get("issue")) });
        if (u.searchParams.get("session")) open("session", { id: u.searchParams.get("session") });
      } catch { /* not ours */ }
    };
    navigator.serviceWorker?.addEventListener("message", onMsg);
    return () => navigator.serviceWorker?.removeEventListener("message", onMsg);
  }, [open]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") setDrawers((ds) => ds.slice(0, -1)); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // one stable `wm` per hosted instance, so app effects depending on it do not re-run every render
  const wmCache = useRef(new Map());
  const wmFor = (id, isDrawer) => {
    let wm = wmCache.current.get(id);
    if (!wm) {
      wm = {
        open,
        close: () => { if (isDrawer) setDrawers((ds) => ds.filter((d) => d.id !== id)); },
        setTitle: (title) => { if (isDrawer) setDrawers((ds) => ds.map((d) => (d.id === id && d.title !== title ? { ...d, title: String(title).slice(0, 120) } : d))); },
      };
      wmCache.current.set(id, wm);
    }
    return wm;
  };

  const o = demoSession.since ? scopedOverview.data : overview.data;
  const pages = o?.unread_pages || 0;
  const openIssues = o ? Object.values(o.open_issues || {}).reduce((s, n) => s + n, 0) : 0;
  const badge = (app) => (app === "pages" ? pages : app === "issues" ? openIssues : 0);
  const top = drawers[drawers.length - 1];
  useEffect(() => {
    if (!top) return;
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.querySelector("button")?.focus();
    const trap = (e) => {
      if (e.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll('button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]')].filter(el => el.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    dialog?.addEventListener("keydown", trap);
    return () => { dialog?.removeEventListener("keydown", trap); previous?.focus?.(); };
  }, [top?.id]);

  return (
    <div className={`m-shell${navOpen ? " nav-open" : ""}`}>
      <aside className="m-side" inert={!!top}>
        <div className="m-brand"><GhostGlyph size={26} color="#7c6cf5" /><span>signal98</span></div>
        <nav>
          {[{ group: "Workspace", items: ["conversations", "overview", "issues", "runs"] }, ...(advanced ? NAV.map(g => ({ ...g, items: g.items.filter(a => !["overview", "issues", "runs", "settings"].includes(a)) })).filter(g => g.items.length) : []), { group: "", items: ["settings"] }].map((g) => (
            <div key={g.group} className="m-group">
              <div className="m-group-title">{g.group}</div>
              {g.items.map((app) => (
                <button key={app} className={`m-nav${active === app ? " on" : ""}${hotTarget === app ? " hot" : ""}`} onClick={() => open(app)} data-icon-id={app}>
                  <span className="m-nav-icon">{glyph(app, 18)}</span>
                  <span className="m-nav-label">{{overview:"Dashboard", runs:"Fix activity", settings:"Settings"}[app] || APPS[app].short || APPS[app].title}</span>
                  {badge(app) > 0 && <span className={`m-badge${app === "pages" ? " danger" : ""}`}>{badge(app)}</span>}
                </button>
              ))}
            </div>
          ))}
          <button className="m-nav advanced-toggle" onClick={() => setAdvanced(v => !v)} aria-expanded={advanced}>{advanced ? "− Fewer tools" : "+ More tools"}</button>
        </nav>
        <button className="m-theme" role="switch" aria-checked="false" onClick={onToggleTheme} title="Switch the whole monitor back to the Windows 98 desktop">
          <span className="m-switch" aria-hidden="true" />Windows 98 style
        </button>
      </aside>

      <div className="m-main" ref={mainRef}>
        <header className="m-top" inert={!!top}>
          <button className="m-burger" onClick={() => setNavOpen((v) => !v)} aria-label="menu">☰</button>
          <span className="m-location">{{overview:"Dashboard",runs:"Fix activity",settings:"Settings"}[active] || APPS[active].short || APPS[active].title}</span>
          <div className="m-top-right">
            <span className={`m-pill${stream === "live" ? " ok" : " warn"}`} title={`live stream: ${stream}`}><i className="dot" />{stream === "live" ? "Receiving live updates" : stream === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
          </div>
        </header>

        <div className="m-views" inert={!!top}>
          {Object.entries(views).map(([app, v]) => {
            const App = app === "overview" ? Dashboard : app === "issues" ? SimpleIssues : APPS[app].C;
            return (
              <section key={app} className={`m-view${hotTarget === app ? " hot" : ""}`} hidden={app !== active} data-window-id={app} data-window-app={app}>
                <App wm={wmFor(app, false)} params={v.params} nonce={v.nonce} overview={overview} meta={meta} modern />
              </section>
            );
          })}
        </div>

        {top && <div className="m-scrim" onClick={() => setDrawers([])} />}
        {/* every drawer stays mounted so Back returns to the same scroll position and tab */}
        {drawers.map((d) => {
          const App = d.app === "issue" ? IssueBrief : APPS[d.app].C;
          return (
            <aside ref={d === top ? dialogRef : null} role="dialog" aria-modal="true" aria-label={d.app === "issue" ? "Problem details" : d.title} key={d.id} className={`m-drawer${hotTarget === d.id ? " hot" : ""}`} hidden={d !== top} data-window-id={d.id} data-window-app={d.app}>
              <header className="m-drawer-head">
                {drawers.length > 1 && <button className="m-icon-btn" onClick={() => setDrawers((ds) => ds.slice(0, -1))} title="Back">←</button>}
                <span className="m-drawer-icon">{glyph(APPS[d.app].icon, 18)}</span>
                <h2 title={d.title}>{d.title}</h2>
                <button className="m-icon-btn" onClick={() => setDrawers((ds) => ds.filter((x) => x.id !== d.id))} title="Close (Esc)">✕</button>
              </header>
              <div className="m-drawer-body"><App wm={wmFor(d.id, true)} params={d.params} nonce={d.nonce} /></div>
            </aside>
          );
        })}


      </div>
    </div>
  );
}
