"use client";
import { useState, useRef, useEffect } from "react";
import DesktopIcon from "../components/DesktopIcon";
import Window from "../components/Window";
import Taskbar from "../components/Taskbar";
import { Folder, FileText, Trash, Stream, Bell, Exe } from "../components/icons";
import Ghost, { GhostGlyph } from "../components/Ghost";
import GhostDialog from "../components/GhostDialog";
import ClassifiedTraces from "../apps/ClassifiedTraces";
import LiveStream from "../apps/LiveStream";
import Pages from "../apps/Pages";
import RecycleBin from "../apps/RecycleBin";
import Readme from "../apps/Readme";
import GhostReport from "../apps/GhostReport";
import { routeGhost } from "../lib/jevRouter";

const GHOST_IDLE = "#e8e8ff";

// ghost rests in the bottom-right corner of the desktop
const ghostHome = (desktopEl) => {
  if (!desktopEl) return { x: 24, y: 330 };
  const r = desktopEl.getBoundingClientRect();
  return { x: Math.max(8, r.width - 96), y: Math.max(8, r.height - 116) };
};

let zTop = 10;
let cascade = 0;

const ICONS = [
  { id: "traces", label: "JEV Verdicts", glyph: "traces" },
  { id: "stream", label: "Raw Feed", glyph: "stream" },
  { id: "pages", label: "Pages", glyph: "pages" },
  { id: "recycle", label: "Recycle Bin", glyph: "recycle" },
  { id: "readme", label: "readme.txt", glyph: "readme" },
];

export default function Desktop() {
  const [windows, setWindows] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [selectedIcon, setSelectedIcon] = useState(null);
  const [startOpen, setStartOpen] = useState(false);
  const [showShutdownConfirm, setShowShutdownConfirm] = useState(false);
  const [shutDown, setShutDown] = useState(false);
  const [feedEvents, setFeedEvents] = useState([]);
  const [binEmptied, setBinEmptied] = useState(false);
  const [ghostPos, setGhostPos] = useState(null);
  const [ghostDrag, setGhostDrag] = useState(false);
  const [hotTarget, setHotTarget] = useState(null);
  const [ghostColor, setGhostColor] = useState(GHOST_IDLE);
  const [summon, setSummon] = useState(null);
  const [fixedIds, setFixedIds] = useState(() => new Set());
  const [ghostReportData, setGhostReportData] = useState(null);
  const desktopRef = useRef(null);
  const dragRef = useRef(false);

  // park the ghost bottom-right on mount and when the window resizes
  useEffect(() => {
    setGhostPos(ghostHome(desktopRef.current));
    const onResize = () => {
      if (!dragRef.current) setGhostPos(ghostHome(desktopRef.current));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // live event feed: the bundled history plus anything the playground
  // (or any signal98 SDK) fires into /api/ingest. ghost routing, badges,
  // and counts all read from this.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/feed", { cache: "no-store" });
        const d = await r.json();
        if (alive) setFeedEvents(d.events || []);
      } catch {
        /* backend not up yet */
      }
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const glyphs = {
    traces: <Folder color="#f5c542" />,
    stream: <Stream />,
    pages: <Bell />,
    recycle: <Trash empty={binEmptied} />,
    readme: <FileText />,
    ghost: <GhostGlyph color={GHOST_IDLE} size={16} />,
  };

  const contentFor = (id) => {
    switch (id) {
      case "traces": return <ClassifiedTraces fixedIds={fixedIds} />;
      case "stream": return <LiveStream />;
      case "pages": return <Pages fixedIds={fixedIds} />;
      case "recycle": return <RecycleBin onEmptyChange={(n) => setBinEmptied(n === 0)} />;
      case "readme": return <Readme />;
      case "ghost-report": return ghostReportData ? <GhostReport result={ghostReportData} /> : null;
      default: return null;
    }
  };

  const metaFor = (id) => {
    switch (id) {
      case "traces": return { title: "JEV Verdicts", icon: "traces", w: 640, h: 420 };
      case "stream": return { title: "Raw Feed — JEV ingest", icon: "stream", w: 560, h: 380 };
      case "pages": return { title: "Pages — tonight", icon: "pages", w: 560, h: 400 };
      case "recycle": return { title: "Recycle Bin", icon: "recycle", w: 600, h: 380 };
      case "readme": return { title: "readme.txt — Notepad", icon: "readme", w: 520, h: 420 };
      case "ghost-report": return { title: "ghost report", icon: "ghost", w: 560, h: 440 };
      default: return { title: id, icon: "readme", w: 480, h: 360 };
    }
  };

  const openWindow = (id) => {
    const meta = metaFor(id);
    setWindows((ws) => {
      const ex = ws.find((w) => w.id === id);
      if (ex) {
        setActiveId(id);
        return ws.map((w) => (w.id === id ? { ...w, minimized: false, z: ++zTop } : w));
      }
      cascade = (cascade + 1) % 6;
      setActiveId(id);
      return [...ws, {
        id, title: meta.title, iconKey: meta.icon,
        x: 120 + cascade * 28, y: 40 + cascade * 24,
        w: meta.w, h: meta.h, z: ++zTop, minimized: false, maximized: false,
      }];
    });
  };

  const openApp = (id) => openWindow(id);
  const closeWindow = (id) => {
    setWindows((ws) => ws.filter((w) => w.id !== id));
    if (id === "ghost-report") setGhostReportData(null);
    setActiveId((a) => {
      if (a !== id) return a;
      const rest = windows.filter((w) => w.id !== id && !w.minimized);
      return rest.length ? rest[rest.length - 1].id : null;
    });
  };
  const focusWindow = (id) => {
    setActiveId(id);
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, z: ++zTop } : w)));
  };
  const minimizeWindow = (id) => setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, minimized: true } : w)));
  const maximizeWindow = (id) => setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, maximized: !w.maximized } : w)));
  const toggleMinimize = (id) => {
    const w = windows.find((x) => x.id === id);
    if (!w) return;
    if (w.minimized) { focusWindow(id); setWindows((ws) => ws.map((x) => (x.id === id ? { ...x, minimized: false } : x))); }
    else if (activeId === id) minimizeWindow(id);
    else focusWindow(id);
  };

  // ---------- ghost: drag, drop, summon, unleash ----------
  const summonGhost = (target) => {
    const judged = feedEvents.filter((e) => e.status === "judged" && e.judgments);
    const evts =
      target === "pages" ? judged.filter((e) => e.paged)
      : target === "recycle" ? judged.filter((e) => !e.paged)
      : judged;
    if (!evts.length) return;
    const route = routeGhost(evts);
    setGhostColor(route.ghost.color);
    setSummon({ target, events: evts, route, phase: "ask" });
  };

  const unleash = async () => {
    const s = summon;
    if (!s) return;
    setSummon({ ...s, phase: "working" });
    try {
      const res = await fetch("/api/ghost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantId: s.route.ghost.id, events: s.events }),
      });
      const data = await res.json();
      setFixedIds((prev) => new Set([...prev, ...s.events.map((e) => e.id)]));
      setSummon(null);
      setGhostColor(GHOST_IDLE);
      setGhostReportData(data);
      openWindow("ghost-report");
    } catch (err) {
      setSummon(null);
      setGhostColor(GHOST_IDLE);
    }
  };

  const onGhostDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = true;
    setGhostDrag(true);
  };
  const onDesktopMove = (e) => {
    if (!ghostDrag || !desktopRef.current) return;
    const r = desktopRef.current.getBoundingClientRect();
    setGhostPos({ x: e.clientX - r.left - 20, y: e.clientY - r.top - 20 });
    // highlight the drop target under the ghost
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const winEl = el && el.closest ? el.closest("[data-window-id]") : null;
    const iconEl = el && el.closest ? el.closest("[data-icon-id]") : null;
    const t = (winEl && winEl.dataset.windowId) || (iconEl && iconEl.dataset.iconId);
    const valid = t === "pages" || t === "traces" || t === "recycle";
    setHotTarget(valid ? t : null);
  };
  const onDesktopUp = (e) => {
    if (!ghostDrag) return;
    setGhostDrag(false);
    dragRef.current = false;
    setHotTarget(null);
    setGhostPos(ghostHome(desktopRef.current));
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const winEl = el && el.closest ? el.closest("[data-window-id]") : null;
    const iconEl = el && el.closest ? el.closest("[data-icon-id]") : null;
    const target = (winEl && winEl.dataset.windowId) || (iconEl && iconEl.dataset.iconId);
    if (target === "pages" || target === "traces" || target === "recycle") {
      if (iconEl && !windows.some((w) => w.id === target)) openApp(target);
      summonGhost(target);
    }
  };

  const doShutdown = () => {
    setShowShutdownConfirm(false);
    setStartOpen(false);
    setShutDown(true);
  };

  return (
    <>
      <div
        ref={desktopRef}
        className="desktop"
        onClick={() => setSelectedIcon(null)}
        onPointerMove={onDesktopMove}
        onPointerUp={onDesktopUp}
      >
        <div className="icons">
          {ICONS.map((ic) => (
            <DesktopIcon
              key={ic.id}
              id={ic.id}
              label={ic.label}
              glyph={glyphs[ic.glyph]}
              selected={selectedIcon === ic.id}
              hot={hotTarget === ic.id}
              badge={ic.id === "pages" ? feedEvents.filter((e) => e.paged).length : 0}
              onClick={(e) => { e.stopPropagation(); setSelectedIcon(ic.id); }}
              onDoubleClick={() => openApp(ic.id)}
            />
          ))}
        </div>

        {windows.map((w) => (
          <Window
            key={w.id}
            id={w.id}
            title={w.title}
            icon={glyphs[w.iconKey]}
            x={w.x} y={w.y} w={w.w} h={w.h} z={w.z}
            focused={activeId === w.id}
            minimized={w.minimized}
            maximized={w.maximized}
            hot={hotTarget === w.id}
            onFocus={focusWindow}
            onClose={closeWindow}
            onMinimize={minimizeWindow}
            onMaximize={maximizeWindow}
          >
            {contentFor(w.id)}
          </Window>
        ))}

        {ghostPos && (
          <Ghost
            x={ghostPos.x}
            y={ghostPos.y}
            color={ghostColor}
            dragging={ghostDrag}
            hot={!!hotTarget}
            working={!!(summon && summon.phase === "working")}
            onPointerDown={onGhostDown}
          />
        )}

        {summon && (
          <GhostDialog
            summon={summon}
            onUnleash={unleash}
            onDismiss={() => { setSummon(null); setGhostColor(GHOST_IDLE); }}
          />
        )}

        {startOpen && (
          <div className="start-menu raised" onClick={(e) => e.stopPropagation()}>
            <div className="side">signal98</div>
            <div className="items">
              {ICONS.map((ic) => (
                <div key={ic.id} className="start-item" onClick={() => { openApp(ic.id); setStartOpen(false); }}>
                  <span className="glyph">{glyphs[ic.glyph]}</span>
                  {ic.label}
                </div>
              ))}
              <div className="start-sep" />
              <div className="start-item" onClick={() => { setStartOpen(false); setShowShutdownConfirm(true); }}>
                <span className="glyph"><Exe /></span>
                Shut Down...
              </div>
            </div>
          </div>
        )}

        {showShutdownConfirm && (
          <div className="dialog-veil">
            <div className="dialog raised">
              <div className="title-bar"><span className="ttitle">Shut Down Windows</span></div>
              <div className="dbody">
                <span style={{ fontSize: 28 }}>⚠️</span>
                <span>Are you sure you want to shut down?<br /><br />The ghosts will miss you.</span>
              </div>
              <div className="dbuttons">
                <button className="btn98" onClick={doShutdown}>Yes</button>
                <button className="btn98" onClick={() => setShowShutdownConfirm(false)}>No</button>
              </div>
            </div>
          </div>
        )}
      </div>

      <Taskbar
        windows={windows.map((w) => ({ ...w, icon: glyphs[w.iconKey] }))}
        activeId={activeId}
        startOpen={startOpen}
        onStart={() => setStartOpen((s) => !s)}
        onTaskClick={toggleMinimize}
      />

      {shutDown && (
        <div className="safe-screen" onClick={() => setShutDown(false)}>
          It&apos;s now safe to turn off<br />your computer.
        </div>
      )}
    </>
  );
}
