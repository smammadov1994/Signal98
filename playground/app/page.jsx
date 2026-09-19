"use client";
import Link from "next/link";
import { capture } from "signal98";
import { PRODUCTS, money } from "./lib/catalog";
import { useCart } from "./lib/cart";

export default function Shop() {
  const cart = useCart();
  return (
    <>
      <h1>Everything a production ghost needs</h1>
      <p className="sub">A small shop with real bugs in it. Browse, add to cart, check out — and watch the monitor.</p>
      <div className="grid">
        {PRODUCTS.map((p) => (
          <div key={p.id} className="card">
            <Link href={`/product/${p.id}`} className="pname">{p.name}</Link>
            <p className="blurb">{p.blurb}</p>
            <div className="rowb">
              <b>{money(p.price)}</b>
              <button className="btn" onClick={() => { cart.add(p.id); capture("product_added_to_cart", { product: p.id, price: p.price }); }}>Add to cart</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
