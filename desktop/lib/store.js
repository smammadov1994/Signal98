// The desktop's event store: starts EMPTY. Live events from the playground
// (or any signal98 SDK) are appended as they arrive via /api/ingest.
// Nothing shows in Raw Feed / JEV Verdicts / Pages / Recycle Bin until
// you set off an error.
//
// Next.js bundles lib/ files separately into each API route, so plain
// module-level state would NOT be shared between /api/ingest and /api/feed
// (each route would get its own copy of the store). The state lives on
// globalThis instead — one Node process, one store.
const MAX = 300;

function createStore() {
  return { seq: 0, events: [] };
}

function store() {
  if (!globalThis.__signal98_store) globalThis.__signal98_store = createStore();
  return globalThis.__signal98_store;
}

export function pushEvent(evt) {
  const s = store();
  const entry = { id: ++s.seq, ...evt };
  s.events.push(entry);
  if (s.events.length > MAX) s.events.splice(0, s.events.length - MAX);
  return entry;
}

export function updateEvent(id, patch) {
  const e = store().events.find((e) => e.id === id);
  if (e) Object.assign(e, patch);
}

export function listEvents() {
  return store().events;
}

// Truly empty the feed (used by the Raw Feed "Clear" button).
export function clearEvents() {
  const s = store();
  s.events.length = 0;
  s.seq = 0;
}
