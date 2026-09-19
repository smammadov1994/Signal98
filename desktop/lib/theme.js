"use client";
// Win98 ⇄ modern. The choice lives in localStorage and on <html data-theme>; app/layout.jsx
// sets the attribute before first paint so there is no flash of the other theme.
import { useCallback, useEffect, useState } from "react";

export const THEMES = ["win98", "modern"];
import { THEME_KEY as KEY } from "./theme-config";

const read = () => {
  try { const v = localStorage.getItem(KEY); return THEMES.includes(v) ? v : "modern"; } catch { return "modern"; }
};

export function useTheme() {
  // null until mounted: the server cannot know the choice, and guessing would mismatch hydration
  const [theme, setThemeState] = useState(null);
  useEffect(() => {
    setThemeState(read());
    const onStorage = (e) => { if (e.key === KEY) setThemeState(read()); }; // keep other tabs in step
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  useEffect(() => { if (theme) document.documentElement.dataset.theme = theme; }, [theme]);
  const setTheme = useCallback((t) => {
    if (!THEMES.includes(t)) return;
    try { localStorage.setItem(KEY, t); } catch { /* private mode: the choice lasts for this page */ }
    setThemeState(t);
  }, []);
  const toggle = useCallback(() => setTheme(theme === "modern" ? "win98" : "modern"), [setTheme, theme]);
  return { theme, setTheme, toggle };
}
