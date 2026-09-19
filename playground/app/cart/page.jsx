"use client";
import { useState } from "react";
import Link from "next/link";
import { capture, addStep } from "signal98";
import { money } from "../lib/catalog";
import { useCart } from "../lib/cart";
import { COUPONS } from "../lib/coupons";

// Returns the discount in cents for a coupon code.
function discountFor(code, subtotal) {
  const coupon = COUPONS[code.trim().toUpperCase()];
  if (!coupon) return 0;
  if (coupon.off) return coupon.off;
  const discount = Math.round(subtotal * coupon.percent / 100);
  if (Number.isNaN(discount)) throw new Error(`Invalid discount computed for coupon ${code}`);
  return discount;
}

export default function Cart() {
  const cart = useCart();
  const [code, setCode] = useState("");
  const [discount, setDiscount] = useState(0);

  const apply = () => {
    addStep("coupon submitted", { code });
    setDiscount(discountFor(code, cart.subtotal));
    capture("coupon_applied", { code });
  };

  return (
    <div className="card wide">
      <h1>Your cart</h1>
      {cart.lines.length === 0 && <p className="blurb">Empty. <Link href="/">Go haunt the shop.</Link></p>}
      {cart.lines.map((p, i) => (
        <div key={i} className="line">
          <span>{p.name}</span>
          <span>{money(p.price)} <button className="link" onClick={() => cart.remove(i)}>remove</button></span>
        </div>
      ))}
      {cart.lines.length > 0 && (
        <>
          <div className="coupon">
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Coupon (try GHOST10)" aria-label="coupon code" />
            <button className="btn ghost" id="apply-coupon" onClick={apply}>Apply coupon</button>
            {/* wired up "later": clicking this does nothing at all */}
            <button className="btn ghost" id="compare">Compare prices</button>
          </div>
          <div className="line total"><span>Total</span><b>{money(Math.max(0, cart.subtotal - discount))}</b></div>
          <Link href="/checkout" className="btn block" onClick={() => capture("checkout_started", { total: cart.subtotal - discount, items: cart.lines.length })}>Check out</Link>
        </>
      )}
    </div>
  );
}
