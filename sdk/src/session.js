// Identity (who) and sessions (which visit). See PROTOCOL.md "Sessions".
//
//   s98_did   localStorage    current distinct_id (anonymous uuid or identified id)
//   s98_anon  localStorage    the device's anonymous id, kept so $identify can link the two
//   s98_sid   local + session { id, start, last } — localStorage so tabs share one session,
//                              sessionStorage as the fallback when localStorage is blocked
//   s98_wid   sessionStorage  per-tab window id

import { uuid } from "./util.js";

export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_MAX_MS = 24 * 3_600_000;
const WRITE_EVERY_MS = 5000;

export function createIdentity(store, tabStore, now = Date.now) {
  let distinctId = store.get("s98_did") || uuid();
  let anonId = store.get("s98_anon") || distinctId;
  store.set("s98_did", distinctId);
  store.set("s98_anon", anonId);

  let windowId = tabStore.get("s98_wid");
  if (!windowId) tabStore.set("s98_wid", (windowId = uuid()));

  let cur = null; // { id, start, last }
  let lastWrite = 0;

  const valid = (s) => s && typeof s.id === "string" && s.start > 0 && s.last > 0;

  function write(t) {
    lastWrite = t;
    store.setJSON("s98_sid", cur);
    tabStore.setJSON("s98_sid", cur);
  }

  // Returns the live session id, rotating it when the visit has gone stale.
  // Every call counts as activity, because it is only called when an event
  // is being captured.
  function getSessionId() {
    const t = now();
    const stored = store.getJSON("s98_sid") || tabStore.getJSON("s98_sid");
    // Another tab may have rotated (or touched) the shared session — adopt the newest view.
    if (valid(stored) && (!cur || stored.start >= cur.start)) {
      cur = cur && stored.id === cur.id ? { ...stored, last: Math.max(stored.last, cur.last) } : stored;
    }
    if (!cur || t - cur.last > SESSION_IDLE_MS || t - cur.start > SESSION_MAX_MS) {
      cur = { id: uuid(), start: t, last: t };
      write(t);
    } else {
      cur.last = t;
      // Activity only needs coarse persistence; a storage write per event is wasteful.
      if (t - lastWrite > WRITE_EVERY_MS) write(t);
    }
    return cur.id;
  }

  return {
    getDistinctId: () => distinctId,
    getAnonId: () => anonId,
    getWindowId: () => windowId,
    getSessionId,
    isIdentified: () => distinctId !== anonId,
    setDistinctId(id) {
      distinctId = id;
      store.set("s98_did", id);
    },
    // Logout: fresh anonymous person and a fresh session, so the next user of
    // this browser is not stitched onto the previous one.
    reset() {
      distinctId = anonId = uuid();
      store.set("s98_did", distinctId);
      store.set("s98_anon", anonId);
      cur = null;
      store.remove("s98_sid");
      tabStore.remove("s98_sid");
    },
  };
}
