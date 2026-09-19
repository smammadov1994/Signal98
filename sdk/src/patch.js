// Monkey-patching with manners. `make(original)` returns the replacement;
// the returned cleanup restores the original *exactly* (including "it was
// inherited, not an own property") — unless someone else has wrapped our
// wrapper since, in which case unhooking would cut their patch out of the
// chain. Then we leave ours in place and rely on the caller's `active` guard
// to make it a pure pass-through.

export function patch(obj, name, make, cleanups) {
  const orig = obj && obj[name];
  if (typeof orig !== "function") return;
  const own = Object.prototype.hasOwnProperty.call(obj, name);
  const patched = make(orig);
  obj[name] = patched;
  cleanups.push(() => {
    if (obj[name] !== patched) return;
    if (own) obj[name] = orig;
    else delete obj[name];
  });
}
