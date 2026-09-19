// Feature flags: GET {host}/api/flags?key=..&distinct_id=.. -> { flags: {...} }.
// Cached in localStorage so flags are available synchronously on the next
// page load, before the network answers. Every failure here is silent: a
// flag service being down must degrade to "flag off", never to an error.

const CACHE_KEY = "s98_flags";

export function createFlags({ url, apiKey, env, store, tabStore, identity, capture, log }) {
  let flags = {};
  let loaded = false;
  const listeners = [];
  let called = { sid: null, keys: [] }; // $feature_flag_called dedupe, per session

  // Only trust a cache that belongs to the current person.
  const cached = store.getJSON(CACHE_KEY);
  if (cached && cached.id === identity.getDistinctId() && cached.flags) {
    flags = cached.flags;
    loaded = true;
  }

  function notify() {
    for (const cb of listeners.slice()) {
      try {
        cb(flags);
      } catch (err) {
        log("onFeatureFlags callback threw", err);
      }
    }
  }

  async function reload() {
    if (!url || !env.fetch) return flags;
    try {
      const id = identity.getDistinctId();
      const res = await env.fetch(
        `${url}?key=${encodeURIComponent(apiKey || "")}&distinct_id=${encodeURIComponent(id)}`,
        { method: "GET" }
      );
      if (!res.ok) return flags;
      const data = await res.json();
      // The person may have changed (identify/reset) while we were waiting.
      if (data && data.flags && typeof data.flags === "object" && id === identity.getDistinctId()) {
        flags = data.flags;
        loaded = true;
        store.setJSON(CACHE_KEY, { id, flags });
        notify();
      }
    } catch (err) {
      log("flags unavailable", err);
    }
    return flags;
  }

  function getFeatureFlag(key) {
    const value = flags[key];
    try {
      const sid = identity.getSessionId();
      if (called.sid !== sid) called = tabStore.getJSON("s98_ffc") || called;
      if (called.sid !== sid) called = { sid, keys: [] };
      if (loaded && !called.keys.includes(key)) {
        called.keys.push(key);
        tabStore.setJSON("s98_ffc", called);
        capture("$feature_flag_called", { $feature_flag: key, $feature_flag_response: value === undefined ? false : value });
      }
    } catch (err) {
      log("flag bookkeeping failed", err);
    }
    return value;
  }

  return {
    reload,
    getFeatureFlag,
    isFeatureEnabled: (key) => {
      const v = getFeatureFlag(key);
      return v !== undefined && v !== false && v !== null;
    },
    onFeatureFlags(cb) {
      if (typeof cb !== "function") return () => {};
      listeners.push(cb);
      if (loaded) {
        try {
          cb(flags);
        } catch (err) {
          log("onFeatureFlags callback threw", err);
        }
      }
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    clear() {
      flags = {};
      loaded = false;
      store.remove(CACHE_KEY);
    },
  };
}
