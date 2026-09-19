// Interaction auto-capture: $autocapture (click / submit / change),
// $rageclick, $dead_click and "ui" breadcrumbs. Listeners sit on the document
// in the capture phase, so an app calling stopPropagation() cannot hide
// interactions from us, and they are passive observers only.

import { elementProps, interactiveTarget, isIgnored, createRageDetector } from "./dom.js";

const DEAD_CLICK_MS = 2500;
const tagOf = (el) => String(el.tagName || "").toLowerCase();

// Clicks that legitimately change nothing on the page: focusing a field,
// opening a new tab / mail client / download.
function deadClickExempt(el, e) {
  if (/^(input|textarea|select|option|label)$/.test(tagOf(el))) return true;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.button > 0) return true;
  if (tagOf(el) !== "a") return false;
  const get = (n) => el.getAttribute(n);
  return get("target") === "_blank" || get("download") != null || /^(mailto|tel|sms):/i.test(get("href") || "");
}

export function installAutocapture({ client, win, opts, guard, cleanups, activity }) {
  const doc = win.document;
  const env = client._env;
  const rage = createRageDetector();
  let pending = null; // at most one dead-click candidate is watched at a time

  function settle(report) {
    const p = pending;
    if (!p) return;
    pending = null;
    env.clearTimeout(p.timer);
    p.observer.disconnect();
    win.removeEventListener("scroll", p.onScroll, true);
    if (report && !p.alive && activity.n === p.mark) client.capture("$dead_click", p.props);
  }
  cleanups.push(() => settle(false));

  function watchDeadClick(props) {
    settle(false); // clicking again restarts the clock; rage clicks cover the frustration
    if (!win.MutationObserver) return;
    const p = { props, alive: false, mark: activity.n };
    p.onScroll = () => (p.alive = true);
    p.observer = new win.MutationObserver(() => {
      p.alive = true;
      p.observer.disconnect(); // one mutation is proof enough; stop paying for more
    });
    p.observer.observe(doc, { childList: true, subtree: true, attributes: true, characterData: true });
    win.addEventListener("scroll", p.onScroll, true);
    p.timer = env.setTimeout(() => guard(() => settle(true)), DEAD_CLICK_MS);
    pending = p;
  }

  const onClick = (e) =>
    guard(() => {
      let raw = e.target;
      if (raw && !raw.tagName) raw = raw.parentElement; // text node
      if (!raw || isIgnored(raw)) return;
      const el = interactiveTarget(raw);
      const props = elementProps(el || raw);
      if (opts.steps) {
        client.addStep(`click ${props.$el_selector}${props.$el_text ? ` "${props.$el_text}"` : ""}`, {
          $category: "ui",
          selector: props.$el_selector,
        });
      }
      // Clicks on plain text are noise as events, but they still count towards rage.
      if (opts.clicks && el) client.capture("$autocapture", { $event_type: "click", ...props });
      // detail === 0 is a keyboard "click" (Enter held on a button), not a mouse.
      if (opts.rageClicks && e.detail !== 0) {
        const count = rage(e.clientX || 0, e.clientY || 0, env.now());
        if (count) client.capture("$rageclick", { ...props, $click_count: count });
      }
      if (opts.deadClicks && el && !deadClickExempt(el, e)) watchDeadClick(props);
    });

  const onForm = (type) => (e) =>
    guard(() => {
      const el = e.target;
      if (!opts.clicks || !el || !el.tagName || isIgnored(el)) return;
      if (type === "change" && !/^(input|select|textarea)$/.test(tagOf(el))) return;
      const props = elementProps(el);
      if (opts.steps) client.addStep(`${type} ${props.$el_selector}`, { $category: "ui", selector: props.$el_selector });
      client.capture("$autocapture", { $event_type: type, ...props });
    });

  const listen = (type, fn) => {
    doc.addEventListener(type, fn, true);
    cleanups.push(() => doc.removeEventListener(type, fn, true));
  };
  listen("click", onClick);
  listen("submit", onForm("submit"));
  listen("change", onForm("change"));
}
