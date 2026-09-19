// Describing a DOM element for $autocapture without leaking what the user
// typed. Deliberately uses only the narrow element surface (tagName, id,
// getAttribute, parentElement, children, textContent) so it can be unit
// tested against plain fake objects.

import { stripQuery } from "./util.js";

const FORM_FIELDS = /^(input|textarea|select|option)$/;
const INTERACTIVE = /^(a|button|input|select|textarea|label|summary|details)$/;
const INTERACTIVE_ROLES = /^(button|link|tab|menuitem|checkbox|radio|switch|option)$/;
// Ids and classes minted by tooling change on every build or render, which
// would make the selector useless for grouping: css-modules / styled /
// emotion hashes, React useId (":r1:"), long digit runs.
// Anything needing CSS escaping (Tailwind's "md:w-1/2") is skipped too.
const UNSTABLE = /^(css|sc|jsx|jss|svelte)-|^\d|\d{4,}|[_-](?=[a-z\d]*\d)(?=[a-z\d]*[a-z])[a-z\d]{5,}$|[^\w-]/i;
// Long digit runs in visible text are usually card / phone / account numbers.
const SENSITIVE_TEXT = /\d[\d\s-]{10,}\d/;

const tag = (el) => String(el.tagName || "").toLowerCase();
const attr = (el, name) => (el.getAttribute ? el.getAttribute(name) : null);

function climb(el, test, max = 50) {
  for (let cur = el, i = 0; cur && i < max; cur = cur.parentElement, i++) {
    if (tag(cur) && test(cur)) return cur;
  }
  return null;
}

export const isIgnored = (el) => !!climb(el, (e) => attr(e, "data-s98-ignore") != null);

export const isMasked = (el) =>
  !!climb(el, (e) => attr(e, "data-s98-mask") != null || /(^|\s)s98-mask(\s|$)/.test(attr(e, "class") || ""));

const isInteractive = (el) =>
  INTERACTIVE.test(tag(el)) ||
  INTERACTIVE_ROLES.test(attr(el, "role") || "") ||
  attr(el, "onclick") != null ||
  attr(el, "tabindex") === "0";

// A click usually lands on a <span> or <svg> inside the thing the user meant.
// Report the nearest interactive ancestor instead (within a few levels).
export const interactiveTarget = (el) => climb(el, isInteractive, 6);

const MASK_SELECTOR = "[data-s98-mask],.s98-mask";

// textContent glues sibling elements together ("Pay now" + "$42" → "Pay now$42").
// Join child texts with a space instead; depth- and size-bounded so a click on a big
// container never walks the whole page.
function spacedText(el, depth = 0) {
  const kids = el.children;
  // No element children, too deep, or a DOM without childNodes (this file promises to work on
  // a minimal surface): textContent is exact and is what we always used. Joining `children`
  // alone would silently drop the element's OWN text — "<button>Save</button>" became "".
  if (!kids || !kids.length || depth > 3 || !el.childNodes) return el.textContent || "";
  const parts = [];
  for (const n of Array.from(el.childNodes).slice(0, 40)) {
    if (n.nodeType === 3) parts.push(n.nodeValue || "");
    else if (n.nodeType === 1) parts.push(spacedText(n, depth + 1));
  }
  return parts.join(" ");
}

export function elementText(el) {
  // Masked itself, inside something masked, or *containing* something masked
  // (a button wrapping a masked card number): all read as ***.
  if (isMasked(el) || (el.querySelector && el.querySelector(MASK_SELECTOR))) return "***";
  const t = tag(el);
  // Never read form fields: textContent of a <textarea> is what the user
  // typed, and a <form>'s text is the whole form. Labels come from aria/title.
  let text = "";
  if (!FORM_FIELDS.test(t) && t !== "form" && attr(el, "contenteditable") == null) text = spacedText(el);
  text = (text || attr(el, "aria-label") || attr(el, "title") || attr(el, "alt") || "").replace(/\s+/g, " ").trim();
  if (SENSITIVE_TEXT.test(text)) return "***";
  return text.slice(0, 80);
}

const esc = (s) => String(s).replace(/["\\]/g, "\\$&");

function selectorPart(el) {
  const t = tag(el);
  for (const a of ["data-s98-id", "data-testid", "data-test", "name"]) {
    const v = attr(el, a);
    if (v) return { part: `${t}[${a}="${esc(v)}"]`, anchored: a !== "name" };
  }
  const classes = (attr(el, "class") || "")
    .split(/\s+/)
    .filter((c) => c && c !== "s98-mask" && !UNSTABLE.test(c))
    .slice(0, 2);
  let part = t + classes.map((c) => `.${c}`).join("");
  // Disambiguate among same-tag siblings; nth-of-type survives class churn.
  const parent = el.parentElement;
  if (parent && parent.children) {
    const same = Array.prototype.filter.call(parent.children, (c) => tag(c) === t);
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
  }
  return { part, anchored: false };
}

// Short and robust beats unique-at-all-costs: stop at the first stable id or
// test hook, otherwise describe at most 4 levels.
export function cssSelector(el) {
  const parts = [];
  for (let cur = el, depth = 0; cur && tag(cur) && depth < 4; cur = cur.parentElement, depth++) {
    const t = tag(cur);
    if (t === "html" || (t === "body" && parts.length)) break;
    // getAttribute, not `.id`: on a <form>, an <input name="id"> shadows the property.
    const id = attr(cur, "id");
    if (id && !UNSTABLE.test(id)) {
      parts.unshift(`#${id}`);
      break;
    }
    const { part, anchored } = selectorPart(cur);
    parts.unshift(part);
    if (anchored) break;
  }
  return parts.join(" > ");
}

export function elementProps(el) {
  const attrs = {};
  for (const name of ["id", "name", "type", "role"]) {
    const v = attr(el, name);
    if (v) attrs[name] = String(v).slice(0, 100);
  }
  // data-s98-* is the explicit "please record this" channel for app authors.
  const all = el.attributes || [];
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    if (a && /^data-s98-(?!mask$|ignore$)/.test(a.name)) attrs[a.name] = String(a.value).slice(0, 100);
  }
  const link = climb(el, (e) => tag(e) === "a", 6);
  const href = link && attr(link, "href");
  return {
    $el_tag: tag(el),
    $el_text: elementText(el),
    $el_selector: cssSelector(el),
    $el_href: href ? stripQuery(href) : undefined,
    $el_attrs: attrs,
  };
}

// Rage click: `threshold` clicks, each within `ms` and `px` of the previous
// one. Returns the click count when the threshold is hit (then starts over),
// otherwise 0.
export function createRageDetector(threshold = 3, ms = 1000, px = 30) {
  let clicks = [];
  return (x, y, t) => {
    const last = clicks[clicks.length - 1];
    if (last && (t - last.t > ms || Math.abs(x - last.x) > px || Math.abs(y - last.y) > px)) clicks = [];
    clicks.push({ x, y, t });
    if (clicks.length < threshold) return 0;
    clicks = [];
    return threshold;
  };
}
