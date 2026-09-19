"use client";
// Browser-side helpers shared by every window: fetch wrapper, polling hook,
// the single shared SSE connection, and formatters.
import { useEffect, useRef, useState, useCallback } from "react";

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api/${path}`, {
    method, cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

// useApi("issues?status=open", { every: 5000, on: ["verdict", "issue"] })
//   → { data, error, loading, reload }
// `on` lists stream message types that should trigger a (debounced) reload, so windows
// stay live without hammering the API.
export function useApi(path, { every = 0, on = [] } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    try {
      const data = await api(path);
      if (mine === seq.current) setState({ data, error: null, loading: false });
    } catch (err) {
      if (mine === seq.current) setState((s) => ({ ...s, error: err.message, loading: false }));
    }
  }, [path]);
  useEffect(() => {
    setState({ data: null, error: null, loading: !!path });
    reload();
    if (!every) return;
    const t = setInterval(reload, every);
    return () => clearInterval(t);
  }, [reload, every]);
  const timer = useRef(null);
  useStream((msg) => {
    if (!on.includes(msg.type) && msg.type !== "reset") return;
    // throttle, not debounce: under a steady stream a debounce would never fire
    if (timer.current) return;
    timer.current = setTimeout(() => { timer.current = null; reload(); }, 400);
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  return { ...state, reload };
}

// ---- one EventSource for the whole desktop, fanned out to subscribers ----
const hub = { es: null, subs: new Set(), status: "connecting", statusSubs: new Set() };

function ensureStream() {
  if (hub.es || typeof window === "undefined") return;
  const es = new EventSource("/api/stream");
  hub.es = es;
  const setStatus = (s) => { hub.status = s; hub.statusSubs.forEach((fn) => fn(s)); };
  es.onopen = () => setStatus("live");
  es.onerror = () => setStatus("reconnecting"); // EventSource retries by itself
  for (const type of ["event", "verdict", "issue", "session", "notification", "agent", "settings", "chat", "reset"]) {
    es.addEventListener(type, (e) => {
      let data = null;
      try { data = JSON.parse(e.data); } catch { return; }
      hub.subs.forEach((fn) => { try { fn({ type, data }); } catch { /* one window must not break another */ } });
    });
  }
}

export function useStream(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    ensureStream();
    const fn = (m) => ref.current?.(m);
    hub.subs.add(fn);
    return () => hub.subs.delete(fn);
  }, []);
}

export function useStreamStatus() {
  const [s, setS] = useState(hub.status);
  useEffect(() => {
    ensureStream();
    hub.statusSubs.add(setS);
    setS(hub.status);
    return () => hub.statusSubs.delete(setS);
  }, []);
  return s;
}

// ---- formatters ----
export const fmtTime = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour12: false });
export const fmtDateTime = (ts) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function fmtNum(n) {
  if (n == null) return "–";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2);
}
export const fmtPct = (v, d = 0) => (v == null ? "–" : `${(v * 100).toFixed(d)}%`);
export function fmtDuration(ms) {
  if (ms == null) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
export const fmtUsd = (v) => (v == null ? "–" : v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(2)}`);
export const label = (s) => String(s ?? "").replace(/_/g, " ");

// Verdicts are STATUS colours: always rendered with their word, never colour alone.
export const VERDICTS = {
  page: { label: "PAGE", color: "#d03b3b", hint: "wake someone up" },
  notify: { label: "NOTIFY", color: "#b86a00", hint: "tell the team, no page" },
  ticket: { label: "TICKET", color: "#2a78d6", hint: "fix during working hours" },
  ignore: { label: "IGNORE", color: "#808080", hint: "noise" },
};
// Categorical series colours in FIXED order (validated on the white chart surface with
// the dataviz validator; three are under 3:1 contrast, so charts always show labels).
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
