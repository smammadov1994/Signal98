// $pageview / $pageleave, single-page-app aware. The History API has no
// "url changed" event, so pushState/replaceState are wrapped; back/forward
// and hash routers arrive via popstate/hashchange.

import { patch } from "./patch.js";

export function installPageviews({ client, win, opts, guard, cleanups, activity, onPageHide }) {
  const loc = win.location;
  const doc = win.document;
  const now = client._env.now;
  let url, path, route, startedAt, maxDepth, left;
  let lastDepthCheck = 0;

  function measureDepth() {
    const de = doc.documentElement || {};
    const body = doc.body || {};
    const full = Math.max(de.scrollHeight || 0, body.scrollHeight || 0);
    const seen = (win.scrollY || win.pageYOffset || 0) + (win.innerHeight || 0);
    if (full > 0) maxDepth = Math.max(maxDepth, Math.min(1, seen / full));
  }

  function view() {
    url = loc.href;
    path = loc.pathname;
    route = loc.pathname + (loc.hash || "");
    startedAt = now();
    maxDepth = 0;
    left = false;
    if (opts.pageviews) client.capture("$pageview");
  }

  function leave() {
    if (left) return; // pagehide can follow a leave we already reported
    left = true;
    measureDepth();
    if (!opts.pageviews) return;
    client.capture("$pageleave", {
      // The URL has usually changed already by the time we hear about it.
      $current_url: url,
      $pathname: path,
      $prev_pageview_duration: Math.round((now() - startedAt) / 10) / 100,
      $scroll_depth: Math.round(maxDepth * 100) / 100,
    });
  }

  const onUrlChange = () =>
    guard(() => {
      if (loc.href === url) return; // replaceState with the same URL, hash-less popstate, ...
      const from = route;
      activity.n++; // a navigation counts as "the click did something"
      leave();
      view();
      if (opts.steps) client.addStep(`navigate ${from} -> ${route}`, { $category: "navigation", from, to: route });
    });

  for (const name of ["pushState", "replaceState"]) {
    patch(
      win.history,
      name,
      (orig) =>
        function () {
          const out = orig.apply(this, arguments);
          onUrlChange();
          return out;
        },
      cleanups
    );
  }

  const listen = (target, type, fn, o) => {
    target.addEventListener(type, fn, o);
    cleanups.push(() => target.removeEventListener(type, fn, o));
  };
  listen(win, "popstate", onUrlChange);
  listen(win, "hashchange", onUrlChange);
  // Reading scrollHeight forces layout, so sample it instead of doing it per scroll event.
  listen(
    win,
    "scroll",
    () =>
      guard(() => {
        const t = now();
        if (t - lastDepthCheck < 250) return;
        lastDepthCheck = t;
        measureDepth();
      }),
    { passive: true, capture: true }
  );
  // Restored from the back/forward cache: the same document gets a second life.
  listen(win, "pageshow", (e) => guard(() => e && e.persisted && view()));

  onPageHide.push(leave);
  view();
}
