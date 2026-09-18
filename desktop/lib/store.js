// The desktop's event store: seeded with the bundled history, then live
// events from the playground (or any signal98 SDK) are appended as they arrive.
//
// Next.js bundles lib/ files separately into each API route, so plain
// module-level state would NOT be shared between /api/ingest and /api/feed
// (each route would get its own copy of the store). The state lives on
// globalThis instead — one Node process, one store.
import seedEvents from "../data/events.json";

const MAX = 300;

function normalizeSeed(e) {
  return { ...e, mechanism: "seed", status: "judged", judgedBy: "jev" };
}

function createStore() {
  return {
    seq: seedEvents.reduce((m, e) => Math.max(m, e.id), -1),
    events: seedEvents.map(normalizeSeed),
  };
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

// Clear back to the bundled history (used by the Raw Feed "Clear" button).
export function resetEvents() {
  const s = store();
  s.events.length = 0;
  seedEvents.map(normalizeSeed).forEach((e) => s.events.push(e));
  s.seq = seedEvents.reduce((m, e) => Math.max(m, e.id), -1);
}
