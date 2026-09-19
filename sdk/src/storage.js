// Storage that can never throw. Safari private mode, blocked site data,
// quota errors and SSR all degrade to an in-memory Map, so callers never
// need their own try/catch.

export function safeStorage(getBacking) {
  const mem = new Map();
  let backing = null;
  try {
    // Merely *touching* window.localStorage throws when site data is blocked,
    // which is why the backing store arrives as a getter.
    backing = getBacking ? getBacking() : null;
    if (backing) {
      backing.setItem("s98_t", "1");
      backing.removeItem("s98_t");
    }
  } catch {
    backing = null;
  }

  const api = {
    persistent: !!backing,
    get(key) {
      try {
        const v = backing && backing.getItem(key);
        if (v != null) return v;
      } catch {
        /* fall through to memory */
      }
      return mem.has(key) ? mem.get(key) : null;
    },
    // `diskOnly` skips the memory fallback: used for the event queue, which
    // already lives in memory, so a second copy would only waste space.
    set(key, value, diskOnly) {
      try {
        if (backing) {
          backing.setItem(key, value);
          mem.delete(key);
          return true;
        }
      } catch {
        /* quota exceeded */
      }
      if (!diskOnly) mem.set(key, value);
      return false;
    },
    remove(key) {
      mem.delete(key);
      try {
        if (backing) backing.removeItem(key);
      } catch {
        /* ignore */
      }
    },
    getJSON(key) {
      try {
        const v = api.get(key);
        return v == null ? null : JSON.parse(v);
      } catch {
        return null; // corrupted entry
      }
    },
    setJSON(key, value) {
      try {
        return api.set(key, JSON.stringify(value));
      } catch {
        return false;
      }
    },
  };
  return api;
}
