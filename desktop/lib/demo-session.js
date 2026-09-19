"use client";
import { useEffect, useState } from "react";
const KEY = "s98_demo_since";
function read() { try { const n = Number(localStorage.getItem(KEY)); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; } }
export function useDemoSession() {
  const [since, setSince] = useState(null);
  useEffect(() => {
    const sync = () => setSince(read());
    const custom = (e) => setSince(e.detail);
    sync(); window.addEventListener("storage", sync); window.addEventListener("s98-demo", custom);
    return () => { window.removeEventListener("storage", sync); window.removeEventListener("s98-demo", custom); };
  }, []);
  const change = (n) => {
    try { n ? localStorage.setItem(KEY, String(n)) : localStorage.removeItem(KEY); } catch { /* current tab still works */ }
    setSince(n); window.dispatchEvent(new CustomEvent("s98-demo", { detail: n }));
  };
  return { since, start: () => change(Date.now()), history: () => change(null) };
}
