"use client";
// The window manager. Contract with the windows it hosts: docs/UI.md.
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import DesktopIcon from "../components/DesktopIcon";
import Window from "../components/Window";
import Taskbar from "../components/Taskbar";
import GhostAssistant from "../components/GhostAssistant";
import { GhostGlyph } from "../components/Ghost";
import { Exe } from "../components/icons";
import { useApi, api } from "../lib/client";
import { useTheme } from "../lib/theme";
import { APPS, DESKTOP_ICONS, glyph as baseGlyph } from "../components/registry";
import SetupWizard from "../components/SetupWizard";
import ModernShell from "../components/ModernShell";

let zTop = 10;
let cascade = 0;

function Login() {
  const [token, setToken] = useState("");
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api("login", { method: "POST", body: { token } });
      window.location.reload(); // the shared event stream must reconnect with the cookie
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <div className="desktop" style={{ inset: 0 }}>
      <div className="dialog-veil" style={{ background: "none" }}>
        <form className="dialog raised" onSubmit={submit} style={{ width: 360 }}>
          <div className="title-bar"><span className="ttitle">Welcome to signal98</span></div>
          <div className="dbody">
            <GhostGlyph size={40} />
            <div style={{ flex: 1 }}>
              <div style={{ marginBottom: 8 }}>Type the admin token to log on to the monitor.</div>
              <input className="in98" type="password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} style={{ width: "100%" }} aria-label="admin token" />
              {error && <div className="err" style={{ padding: "6px 0 0" }}>{error}</div>}
            </div>
          </div>
          <div className="dbuttons"><button className="btn98" type="submit">OK</button></div>
        </form>
      </div>
    </div>
  );
}

// Picks the shell. Both shells get the same data and host the same apps (components/registry.jsx).
export default function Monitor() {
  const { theme, toggle } = useTheme();
  const overview = useApi("overview", { every: 10_000, on: ["verdict", "issue"] });
  const meta = useApi("meta", { on: ["settings"] });

  const [setupOpen,setSetupOpen] = useState(false);
  useEffect(()=>{if(meta.data?.setup?.required)setSetupOpen(true);},[meta.data?.setup?.required]);
  useEffect(()=>{const open=()=>setSetupOpen(true);window.addEventListener("s98-open-setup",open);return()=>window.removeEventListener("s98-open-setup",open);},[]);

  // SIGNAL98_ADMIN_TOKEN is set on the server and this browser has no session yet
  if (overview.error === "admin token required" || meta.error === "admin token required") return <Login />;
  if (!theme) return null; // the choice lives in localStorage: wait one tick rather than flash the wrong shell
  return <><div inert={setupOpen} style={{display:"contents"}}>{theme === "modern"
    ? <ModernShell overview={overview} meta={meta} onToggleTheme={toggle} />
    : <Win98Desktop overview={overview} meta={meta} onToggleTheme={toggle} />}</div>{setupOpen&&<SetupWizard onClose={()=>{setSetupOpen(false);meta.reload();}}/>}</>;
}

function Win98Desktop({ overview, meta, onToggleTheme }) {
  const [windows, setWindows] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [selectedIcon, setSelectedIcon] = useState(null);
  const [startOpen, setStartOpen] = useState(false);
  const [confirmShutdown, setConfirmShutdown] = useState(false);
  const [shutDown, setShutDown] = useState(false);
  const [binCount, setBinCount] = useState(null);
  const [hotTarget, setHotTarget] = useState(null);
  const desktopRef = useRef(null);

  const ghostSettings = meta.data?.project?.settings?.ghost;

  const binEmpty = (binCount ?? overview.data?.open_issues?.ignore ?? 0) === 0;
  const glyph = (key, size) => baseGlyph(key, size, { binEmpty });

  const open = useCallback((app, params = {}) => {
    const def = APPS[app];
    if (!def) return;
    const id = def.multi ? `${app}:${params.id}` : app;
    if (def.multi && (params.id === undefined || params.id === null)) return;
    setStartOpen(false);
    setActiveId(id);
    setWindows((ws) => {
      if (ws.some((w) => w.id === id)) {
        // re-opening passes fresh params (e.g. "open Settings on the Ghost tab")
        return ws.map((w) => (w.id === id ? { ...w, params: { ...w.params, ...params }, nonce: w.nonce + 1, minimized: false, z: ++zTop } : w));
      }
      cascade = (cascade + 1) % 7;
      const vw = window.innerWidth, vh = window.innerHeight - 30;
      const w = Math.min(def.w, vw - 250), h = Math.min(def.h, vh - 40);
      return [...ws, {
        id, app, params, nonce: 0, title: def.title, iconKey: def.icon,
        x: Math.max(8, Math.min(vw - w - 8, 236 + cascade * 26)), y: Math.max(4, Math.min(vh - h - 4, 16 + cascade * 22)),
        w, h, z: ++zTop, minimized: false, maximized: false,
      }];
    });
  }, []);

  const close = useCallback((id) => {
    setWindows((ws) => {
      const rest = ws.filter((w) => w.id !== id);
      setActiveId((a) => (a !== id ? a : rest.filter((w) => !w.minimized).sort((p, q) => q.z - p.z)[0]?.id ?? null));
      return rest;
    });
  }, []);
  const focus = useCallback((id) => {
    setActiveId(id);
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, z: ++zTop } : w)));
  }, []);
  const minimize = (id) => { setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, minimized: true } : w))); setActiveId((a) => (a === id ? null : a)); };
  const maximize = (id) => setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, maximized: !w.maximized } : w)));
  const taskClick = (id) => {
    const w = windows.find((x) => x.id === id);
    if (!w) return;
    if (w.minimized) { setWindows((ws) => ws.map((x) => (x.id === id ? { ...x, minimized: false, z: ++zTop } : x))); setActiveId(id); }
    else if (activeId === id) minimize(id);
    else focus(id);
  };

  // first paint: the two windows that show the product is alive, plus deep links from alerts
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("issue")) { open("issues"); open("issue", { id: Number(p.get("issue")) }); }
    else if (p.get("session")) { open("sessions"); open("session", { id: p.get("session") }); }
    else { open("overview"); open("issues"); open("feed"); }
    // a clicked push notification asks an already-open desktop to navigate
    const onMsg = (e) => {
      try {
        const u = new URL(e.data?.url, window.location.origin);
        if (u.searchParams.get("issue")) open("issue", { id: Number(u.searchParams.get("issue")) });
        if (u.searchParams.get("session")) open("session", { id: u.searchParams.get("session") });
      } catch { /* not ours */ }
    };
    navigator.serviceWorker?.addEventListener("message", onMsg);
    return () => navigator.serviceWorker?.removeEventListener("message", onMsg);
  }, [open]);

  // one stable `wm` per window so app effects depending on it do not re-run every render
  const wmCache = useRef(new Map());
  const wmFor = (id) => {
    let wm = wmCache.current.get(id);
    if (!wm) {
      wm = {
        open,
        close: () => close(id),
        setTitle: (title) => setWindows((ws) => ws.map((w) => (w.id === id && w.title !== title ? { ...w, title: String(title).slice(0, 80) } : w))),
      };
      wmCache.current.set(id, wm);
    }
    return wm;
  };
  const desktopWm = useMemo(() => ({ open, close: () => {}, setTitle: () => {} }), [open]);

  const pagesBadge = overview.data?.unread_pages || 0;


  return (
    <>
      <div ref={desktopRef} className="desktop" onClick={() => { setSelectedIcon(null); setStartOpen(false); }}>
        <div className="icons">
          {DESKTOP_ICONS.map(([id, text]) => (
            <DesktopIcon
              key={id} id={id} label={text} glyph={glyph(id, 40)}
              selected={selectedIcon === id} hot={hotTarget === id}
              badge={id === "pages" ? pagesBadge : 0}
              onClick={(e) => { e.stopPropagation(); setSelectedIcon(id); }}
              onDoubleClick={() => open(id)}
            />
          ))}
        </div>

        {windows.map((w) => {
          const App = APPS[w.app].C;
          return (
            <Window
              key={w.id} id={w.id} app={w.app} title={w.title} icon={glyph(w.iconKey, 16)}
              x={w.x} y={w.y} w={w.w} h={w.h} z={w.z}
              focused={activeId === w.id} minimized={w.minimized} maximized={w.maximized} hot={hotTarget === w.id}
              onFocus={focus} onClose={close} onMinimize={minimize} onMaximize={maximize}
            >
              <App wm={wmFor(w.id)} params={w.params} nonce={w.nonce} {...(w.app === "recycle" ? { onEmptyChange: setBinCount } : {})} />
            </Window>
          );
        })}

        <GhostAssistant
          wm={desktopWm} desktopRef={desktopRef} ghosts={meta.data?.ghosts || []}
          autoMode={!!ghostSettings?.autoMode} repoConfigured={!!ghostSettings?.repoPath}
          onSettingsChanged={meta.reload} setHotTarget={setHotTarget}
        />

        {startOpen && (
          <div className="start-menu raised" onClick={(e) => e.stopPropagation()}>
            <div className="side">signal98</div>
            <div className="items">
              {DESKTOP_ICONS.map(([id, text]) => (
                <div key={id} className="start-item" onClick={() => open(id)}>
                  <span className="glyph">{glyph(id, 22)}</span>{text}
                </div>
              ))}
              <div className="start-sep" />
              <div className="start-item" onClick={() => { setStartOpen(false); onToggleTheme(); }}>
                <span className="glyph"><Exe size={22} /></span>Switch to modern dashboard
              </div>
              <div className="start-item" onClick={() => { setStartOpen(false); setConfirmShutdown(true); }}>
                <span className="glyph"><Exe size={22} /></span>Shut Down...
              </div>
            </div>
          </div>
        )}

        {confirmShutdown && (
          <div className="dialog-veil">
            <div className="dialog raised">
              <div className="title-bar"><span className="ttitle">Shut Down Windows</span></div>
              <div className="dbody">
                <GhostGlyph size={36} />
                <span>Are you sure you want to shut down?<br /><br />Monitoring keeps running on the server. The ghost will miss you.</span>
              </div>
              <div className="dbuttons">
                <button className="btn98" onClick={() => { setConfirmShutdown(false); setShutDown(true); }}>Yes</button>
                <button className="btn98" onClick={() => setConfirmShutdown(false)}>No</button>
              </div>
            </div>
          </div>
        )}
      </div>

      <Taskbar
        windows={windows.map((w) => ({ ...w, icon: glyph(w.iconKey, 16) }))}
        activeId={activeId} startOpen={startOpen} onStart={() => setStartOpen((s) => !s)} onTaskClick={taskClick}
        overview={overview.data}
        onTray={(what) => (what === "pages" ? open("pages") : what === "theme" ? onToggleTheme() : open("settings", { tab: "jev" }))}
      />

      {shutDown && (
        <div className="safe-screen" onClick={() => setShutDown(false)}>
          It&apos;s now safe to turn off<br />your computer.
        </div>
      )}
    </>
  );
}
