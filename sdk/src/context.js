// Properties attached to every browser event (PROTOCOL.md). Split into a
// static half computed once and a per-event half, because the URL, title and
// viewport change during the life of a single-page app.

import { safe } from "./util.js";

const UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

export function staticContext(win, tabStore) {
  const nav = win.navigator || {};
  const scr = win.screen || {};
  const ctx = {
    $screen_width: scr.width,
    $screen_height: scr.height,
    $user_agent: nav.userAgent,
    $locale: nav.language,
    $timezone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
  };
  // UTM tags live on the landing URL only, so remember them for the rest of
  // the tab's life — the campaign should still be credited three pages later.
  let utm = tabStore.getJSON("s98_utm");
  if (!utm) {
    utm = {};
    safe(() => {
      const q = new URLSearchParams(win.location.search);
      for (const k of UTM) if (q.get(k)) utm[k] = q.get(k);
    });
    tabStore.setJSON("s98_utm", utm);
  }
  return Object.assign(ctx, utm);
}

export function pageContext(win) {
  const loc = win.location || {};
  const doc = win.document || {};
  const ref = doc.referrer || "";
  return {
    $current_url: loc.href,
    $pathname: loc.pathname,
    $host: loc.host,
    // "$direct" mirrors PostHog, so existing dashboards/filters carry over.
    $referrer: ref || "$direct",
    $referring_domain: (ref && safe(() => new URL(ref).host)) || "$direct",
    $title: doc.title,
    $viewport_width: win.innerWidth,
    $viewport_height: win.innerHeight,
  };
}

// navigator.doNotTrack is "1" almost everywhere; old IE/Safari used other spellings.
export function dntEnabled(win) {
  const nav = (win && win.navigator) || {};
  return [nav.doNotTrack, nav.msDoNotTrack, win && win.doNotTrack].some((v) => v === "1" || v === "yes");
}
