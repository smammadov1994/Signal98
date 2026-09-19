import { test } from "node:test";
import assert from "node:assert/strict";
import { el } from "./helpers.js";
import { cssSelector, elementText, elementProps, isIgnored, isMasked, interactiveTarget, createRageDetector } from "../src/dom.js";

function page() {
  const body = el("body");
  const main = el("main", { class: "layout css-1x2y3z9" });
  const form = el("form", { id: "checkout" });
  const list = el("ul", { class: "cart-items" });
  const items = [el("li", { class: "item" }, "Tea"), el("li", { class: "item" }, "Coffee"), el("li", { class: "item" }, "Milk")];
  body.append(main.append(form, list.append(...items)));
  return { body, main, form, list, items };
}

test("selector: stops at a stable id", () => {
  const { form } = page();
  const btn = el("button", { class: "btn btn-primary" }, "Pay");
  form.append(el("div", { class: "row" }).append(btn));
  assert.equal(cssSelector(btn), "#checkout > div.row > button.btn.btn-primary");
  assert.equal(cssSelector(form), "#checkout");
});

test("selector: nth-of-type among same-tag siblings, max 4 levels, never past body", () => {
  const { items, body } = page();
  assert.equal(cssSelector(items[1]), "main.layout > ul.cart-items > li.item:nth-of-type(2)");
  let deep = el("span", {}, "x");
  let cur = deep;
  for (let i = 0; i < 10; i++) cur = el("div").append(cur);
  assert.equal(cssSelector(deep).split(" > ").length, 4);
  assert.equal(cssSelector(body), "body");
});

test("selector: prefers test hooks and name, skips generated ids and classes", () => {
  const { form, main } = page();
  const email = el("input", { name: "email", type: "email", class: "sc-bdVaJa Input_root__3xK2a" });
  form.append(email);
  assert.equal(cssSelector(email), '#checkout > input[name="email"]');
  const hooked = el("button", { "data-testid": "pay-now", id: ":r7:" });
  main.append(el("section").append(hooked));
  assert.equal(cssSelector(hooked), 'button[data-testid="pay-now"]', "a test hook anchors the selector");
  const generated = el("div", { id: "ember12345", class: "md:w-1/2 card__title jsx-99 mt-4" });
  main.append(generated);
  assert.equal(cssSelector(generated), "main.layout > div.card__title.mt-4");
  assert.equal(cssSelector(el("a", { id: "9lives" })), "a", "ids that are not valid CSS identifiers are not used");
});

test("text: trimmed, collapsed, capped at 80 chars", () => {
  assert.equal(elementText(el("button", {}, "  Pay \n   now  ")), "Pay now");
  assert.equal(elementText(el("p", {}, "x".repeat(500))).length, 80);
  assert.equal(elementText(el("button", { "aria-label": "Close dialog" })), "Close dialog");
  assert.equal(elementText(el("img", { alt: "Logo" })), "Logo");
});

test("privacy: input values and typed text are never read", () => {
  const input = el("input", { type: "text", value: "hunter2", name: "password" });
  input.value = "hunter2";
  const textarea = el("textarea", {}, "my private diary");
  const select = el("select", {}).append(el("option", {}, "Visa ending 4242"));
  const editable = el("div", { contenteditable: "" }, "draft message");
  const form = el("form", {}, "everything in the form");
  for (const e of [input, textarea, select, editable, form]) assert.equal(elementText(e), "", e.tagName);
  const props = elementProps(input);
  assert.equal(JSON.stringify(props).includes("hunter2"), false);
  assert.deepEqual(props.$el_attrs, { name: "password", type: "text" });
});

test("privacy: data-s98-mask / .s98-mask on the element, an ancestor or a descendant", () => {
  const card = el("div", { "data-s98-mask": "" }).append(el("span", {}, "4242 4242 4242 4242"));
  assert.equal(elementText(card.children[0]), "***", "ancestor masked");
  assert.equal(elementText(card), "***");
  assert.equal(isMasked(card.children[0]), true);
  const byClass = el("p", { class: "note s98-mask" }, "secret");
  assert.equal(elementText(byClass), "***");
  assert.equal(cssSelector(byClass), "p.note", "the mask class is not part of the selector");
  const wrapper = el("button", {}, "Pay with ").append(el("span", { class: "s98-mask" }, "jane@example.com"));
  assert.equal(elementText(wrapper), "***", "a masked descendant masks the container's text");
  assert.equal(elementText(el("p", {}, "not-masked")), "not-masked");
  assert.equal(elementText(el("td", {}, "Card 4111 1111 1111 1111")), "***", "long digit runs are masked without being asked");
  assert.equal(elementText(el("td", {}, "Order 1234")), "Order 1234");
});

test("privacy: data-s98-ignore on the element or any ancestor", () => {
  const zone = el("div", { "data-s98-ignore": "" }).append(el("button", {}, "x"));
  assert.equal(isIgnored(zone.children[0]), true);
  assert.equal(isIgnored(zone), true);
  assert.equal(isIgnored(el("button")), false);
});

test("elementProps: catalogue fields, data-s98-* attrs, href without query", () => {
  const a = el("a", { href: "/pricing?coupon=SECRET#plans", id: "cta", role: "button", "data-s98-plan": "pro", "data-s98-mask": "", "data-other": "no" });
  const icon = el("svg", {});
  a.append(icon);
  const target = interactiveTarget(icon);
  assert.equal(target, a, "a click on the icon is attributed to the link");
  assert.deepEqual(elementProps(target), {
    $el_tag: "a",
    $el_text: "***",
    $el_selector: "#cta",
    $el_href: "/pricing",
    $el_attrs: { id: "cta", role: "button", "data-s98-plan": "pro" },
  });
  assert.equal(interactiveTarget(el("p", {}, "plain text")), null);
  assert.ok(interactiveTarget(el("div", { role: "tab" })));
  assert.ok(interactiveTarget(el("div", { onclick: "go()" })));
});

test("rage detector: 3 clicks within 1 s and 30 px", () => {
  let rage = createRageDetector();
  assert.deepEqual([rage(100, 100, 0), rage(105, 98, 300), rage(110, 102, 600)], [0, 0, 3]);
  assert.equal(rage(110, 102, 700), 0, "starts over after firing");
  rage = createRageDetector();
  assert.deepEqual([rage(0, 0, 0), rage(0, 0, 900), rage(0, 0, 2000), rage(0, 0, 2100)], [0, 0, 0, 0], "too slow");
  assert.equal(rage(0, 0, 2200), 3);
  rage = createRageDetector();
  assert.deepEqual([rage(0, 0, 0), rage(10, 10, 100), rage(200, 10, 200), rage(205, 10, 300)], [0, 0, 0, 0], "too far apart");
});

// A real DOM exposes childNodes; the fake one above deliberately does not. Both must work.
test("elementText: sibling elements are separated by a space, own text is never lost", async () => {
  const { elementText } = await import("../src/dom.js");
  const text = (v) => ({ nodeType: 3, nodeValue: v });
  const el = (tagName, nodes) => {
    const kids = nodes.filter((n) => n.nodeType === 1);
    return { nodeType: 1, tagName, children: kids, childNodes: nodes, getAttribute: () => null, parentElement: null,
      get textContent() { return nodes.map((n) => (n.nodeType === 3 ? n.nodeValue : n.textContent)).join(""); } };
  };
  // <button><span>Double charge detected</span><span>handled, but money is involved</span></button>
  const card = el("BUTTON", [el("SPAN", [text("Double charge detected")]), el("SPAN", [text("handled, but money is involved")])]);
  assert.equal(card.textContent, "Double charge detectedhandled, but money is involved"); // the glue we are fixing
  assert.equal(elementText(card), "Double charge detected handled, but money is involved");
  // own text mixed with a child element keeps both, in order
  assert.equal(elementText(el("BUTTON", [text("Save "), el("B", [text("changes")])])), "Save changes");
});
