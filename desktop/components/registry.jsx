"use client";
// One registry, two shells. The Win98 desktop (app/page.jsx) and the modern dashboard
// (components/ModernShell.jsx) host the SAME window components with the same { wm, params, nonce }
// contract (docs/UI.md) — a theme is a shell plus CSS, never a second copy of a screen.
import { Stream, Bell, Trash, FileText, Exe, BugIcon, ChartIcon, GlobeIcon, FilmIcon, PeopleIcon, GearIcon, WrenchIcon, Folder } from "./icons";

import Conversations from "./Conversations";
import { GhostGlyph } from "./Ghost";
import JevResult from "./JevResult";
import Overview from "../apps/Overview";
import LiveFeed from "../apps/LiveFeed";
import Issues from "../apps/Issues";
import IssueDetail from "../apps/IssueDetail";
import Pages from "../apps/Pages";
import RecycleBin from "../apps/RecycleBin";
import Insights from "../apps/Insights";
import WebAnalytics from "../apps/WebAnalytics";
import Sessions from "../apps/Sessions";
import SessionDetail from "../apps/SessionDetail";
import Persons from "../apps/Persons";
import PersonDetail from "../apps/PersonDetail";
import Alerts from "../apps/Alerts";
import Settings from "../apps/Settings";
import GhostRuns from "../apps/GhostRuns";
import RunDetail from "../apps/RunDetail";
import Readme from "../apps/Readme";

// `multi` apps get one instance per params.id (a window in Win98, a drawer in the modern shell).
export const APPS = {
  conversations: { title: "Conversations", icon: "conversations", w: 1100, h: 720, C: Conversations },
  judgment: { title: "Classification result", icon: "issues", w: 760, h: 600, C: JevResult, multi: true },
  overview: { title: "Overview", icon: "overview", w: 900, h: 600, C: Overview },
  feed: { title: "Live Feed", icon: "feed", w: 860, h: 460, C: LiveFeed },
  issues: { title: "Issues", icon: "issues", w: 960, h: 520, C: Issues },
  issue: { title: "Issue", icon: "issues", w: 760, h: 540, C: IssueDetail, multi: true },
  pages: { title: "Pages — who needs waking up", short: "Pages", icon: "pages", w: 620, h: 560, C: Pages },
  recycle: { title: "Recycle Bin", icon: "recycle", w: 760, h: 400, C: RecycleBin },
  insights: { title: "Insights", icon: "insights", w: 860, h: 540, C: Insights },
  web: { title: "Web Analytics", icon: "web", w: 900, h: 600, C: WebAnalytics },
  sessions: { title: "Sessions", icon: "sessions", w: 940, h: 460, C: Sessions },
  session: { title: "Session", icon: "sessions", w: 640, h: 560, C: SessionDetail, multi: true },
  persons: { title: "People", icon: "persons", w: 700, h: 420, C: Persons },
  person: { title: "Person", icon: "persons", w: 680, h: 520, C: PersonDetail, multi: true },
  alerts: { title: "Alerts", icon: "alerts", w: 780, h: 480, C: Alerts },
  settings: { title: "Control Panel", short: "Settings", icon: "settings", w: 700, h: 540, C: Settings },
  runs: { title: "Ghost Agents", icon: "runs", w: 820, h: 420, C: GhostRuns },
  run: { title: "Agent run", icon: "runs", w: 780, h: 560, C: RunDetail, multi: true },
  readme: { title: "readme.txt — Notepad", short: "Readme", icon: "readme", w: 540, h: 460, C: Readme },
};

export const DESKTOP_ICONS = [
  ["overview", "Overview"], ["feed", "Live Feed"], ["issues", "Issues"], ["pages", "Pages"], ["insights", "Insights"], ["web", "Web Analytics"],
  ["sessions", "Sessions"], ["persons", "People"], ["alerts", "Alerts"], ["runs", "Ghost Agents"], ["settings", "Control Panel"],
  ["recycle", "Recycle Bin"], ["readme", "readme.txt"],
];

// Sidebar grouping for the modern shell.
export const NAV = [
  { group: "Monitor", items: ["overview", "feed", "issues", "pages"] },
  { group: "Analytics", items: ["insights", "web", "sessions", "persons"] },
  { group: "Operate", items: ["alerts", "runs", "settings"] },
  { group: "More", items: ["recycle", "readme"] },
];

export function glyph(key, size, { binEmpty = false } = {}) {
  switch (key) {
    case "conversations": return <GhostGlyph size={size} color="#8877d5" />;
    case "overview": return <Folder size={size} />;
    case "feed": return <Stream size={size} />;
    case "issues": return <BugIcon size={size} />;
    case "pages": case "alerts": return <Bell size={size} />;
    case "recycle": return <Trash size={size} empty={binEmpty} />;
    case "insights": return <ChartIcon size={size} />;
    case "web": return <GlobeIcon size={size} />;
    case "sessions": return <FilmIcon size={size} />;
    case "persons": return <PeopleIcon size={size} />;
    case "settings": return <GearIcon size={size} />;
    case "runs": return <WrenchIcon size={size} />;
    case "readme": return <FileText size={size} />;
    default: return <Exe size={size} />;
  }
}
