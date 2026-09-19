"use client";
import { useState } from "react";
import Link from "next/link";
import { capture, wrap, addStep } from "signal98";
import { money } from "../lib/catalog";
import { useCart } from "../lib/cart";

// wrap(): anything this throws is reported, then rethrown so the UI can react.
const chargeCard = wrap(async (total) => {
  addStep("charging card", { total });
  const res = await fetch("/api/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ total }) });
  if (!res.ok) throw new Error(`payment failed: POST /api/pay returned ${res.status} for ${money(total)}`);
  return res.json();
}, { name: "chargeCard" });

export default function Checkout() {
  const cart = useCart();
  const [state, setState] = useState("idle");

  const pay = async () => {
    setState("paying");
    try {
      const receipt = await chargeCard(cart.subtotal);
      capture("order_completed", { total: cart.subtotal, items: cart.lines.length, order: receipt.order });
      cart.clear();
      setState("done");
    } catch {
      setState("failed");
    }
  };

  if (state === "done") return <div className="card wide"><h1>Order placed</h1><p className="blurb">Your ghost supplies are on the way. <Link href="/">Keep shopping</Link></p></div>;
  return (
    <div className="card wide">
      <h1>Checkout</h1>
      <p className="blurb">{cart.lines.length} item(s) · total <b>{money(cart.subtotal)}</b></p>
      <p className="hint">Demo scenario: orders over $100 trigger an intentional payment error. No real payment is taken.</p>
      <button className="btn block" id="pay-now" disabled={state === "paying" || cart.lines.length === 0} onClick={pay}>
        {state === "paying" ? "Charging…" : "Pay now"}
      </button>
      {state === "failed" && <div className="demo-error" role="status"><strong>Demo error triggered</strong><p>This shop has an intentional checkout bug. No real payment was taken.</p><a href="http://localhost:3001/" className="btn block">See what Signal 98 detected →</a></div>}
    </div>
  );
}
