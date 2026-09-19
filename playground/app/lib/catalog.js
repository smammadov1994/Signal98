// The demo shop's catalogue. Note the last product: it came from a supplier feed
// without a `specs` block — the product page does not expect that (see product/[id]/page.jsx).
export const PRODUCTS = [
  { id: "lantern", name: "Spirit Lantern", price: 4200, blurb: "Glows when something is wrong in production.", specs: { weight: "1.2 kg", material: "brass" } },
  { id: "sheet", name: "Classic Bedsheet", price: 1900, blurb: "Two eye holes. Timeless.", specs: { weight: "0.4 kg", material: "cotton" } },
  { id: "chains", name: "Rattling Chains", price: 6500, blurb: "For when the pager is not loud enough.", specs: { weight: "3.8 kg", material: "iron" } },
  { id: "ouija", name: "Ouija Keyboard", price: 12900, blurb: "Types the stack trace for you.", specs: { weight: "0.9 kg", material: "oak" } },
  { id: "fog", name: "Fog in a Can", price: 900, blurb: "Supplier import. Details pending." },
];

export const byId = (id) => PRODUCTS.find((p) => p.id === id);
export const money = (cents) => `$${(cents / 100).toFixed(2)}`;
