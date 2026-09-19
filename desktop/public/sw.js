// signal98 service worker — browser push for alerts. Nothing else: no fetch handler, no caching,
// so it can never serve a stale monitor.
//
// Push payload (desktop/lib/alerts.js → sendPush): JSON { title, body, url, tag }.
// Anything else (plain text, empty push) still produces a notification.
//
// Click contract with the page: the worker focuses an open monitor tab and posts { url } to it
// (app/page.jsx listens and opens the issue / session window, keeping the desktop intact).
// With no tab open it opens a new window at `url`; the page handles ?issue= / ?session= on load.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function readPayload(data) {
  if (!data) return {};
  try {
    const j = data.json();
    if (j && typeof j === "object" && !Array.isArray(j)) return j;
    return { body: String(j) };
  } catch {
    try { return { body: data.text() }; } catch { return {}; }
  }
}

self.addEventListener("push", (event) => {
  const msg = readPayload(event.data);
  const title = String(msg.title || "signal98").slice(0, 200);
  const tag = msg.tag ? String(msg.tag).slice(0, 120) : undefined;
  const options = {
    body: String(msg.body || "").slice(0, 600),
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { url: typeof msg.url === "string" && msg.url ? msg.url : "/" },
    requireInteraction: /^PAGE/.test(title), // a page stays on screen until someone deals with it
  };
  if (tag) {
    options.tag = tag;       // one notification per issue: a repeat replaces the old one…
    options.renotify = true; // …but still makes a sound
  }
  event.waitUntil(
    self.registration.showNotification(title, options).catch(() =>
      // some platforms reject options they do not know; the alert matters more than the chrome
      self.registration.showNotification(title, { body: options.body, data: options.data })
    )
  );
});

function targetOf(notification) {
  let url;
  try { url = new URL((notification.data && notification.data.url) || "/", self.location.origin); }
  catch { url = new URL("/", self.location.origin); }
  const issue = Number(url.searchParams.get("issue"));
  return {
    href: url.href,
    issue_id: Number.isInteger(issue) && issue > 0 ? issue : null,
    session_id: url.searchParams.get("session") || null,
  };
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = targetOf(event.notification);
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const mine = all.filter((c) => { try { return new URL(c.url).origin === self.location.origin; } catch { return false; } });
    const client = mine.find((c) => c.focused) || mine.find((c) => c.visibilityState === "visible") || mine[0];
    if (client) {
      try { await client.focus(); } catch { /* focus needs a user activation on some platforms */ }
      try {
        client.postMessage({ type: "s98:open", url: target.href, issue_id: target.issue_id, session_id: target.session_id });
        return;
      } catch { /* fall through and open a window */ }
    }
    await self.clients.openWindow(target.href);
  })());
});

// The browser rotated the subscription: enrol the new one so alerts keep arriving.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      const old = event.oldSubscription;
      const sub = event.newSubscription || (old && old.options ? await self.registration.pushManager.subscribe(old.options) : null);
      const post = (path, body) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (sub) await post("/api/push/subscribe", sub.toJSON());
      if (old && (!sub || old.endpoint !== sub.endpoint)) await post("/api/push/unsubscribe", { endpoint: old.endpoint });
    } catch { /* the Alerts window re-syncs the subscription the next time it opens */ }
  })());
});
