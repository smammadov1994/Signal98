"use client";
import { use, useEffect } from "react";
import Link from "next/link";
import { capture } from "signal98";
import { byId, money } from "../../lib/catalog";
import { useCart } from "../../lib/cart";

export default function Product({ params }) {
  const { id } = use(params);
  const product = byId(id);
  const cart = useCart();
  useEffect(() => { if (product) capture("product_viewed", { product: product.id }); }, [product]);
  if (!product) return <p>No such product. <Link href="/">Back</Link></p>;
  return (
    <div className="card wide">
      <h1>{product.name}</h1>
      <p className="blurb">{product.blurb}</p>
      <table className="specs">
        <tbody>
          <tr><td>Weight</td><td>{product.specs.weight}</td></tr>
          <tr><td>Material</td><td>{product.specs.material}</td></tr>
        </tbody>
      </table>
      <div className="rowb">
        <b>{money(product.price)}</b>
        <button className="btn" onClick={() => { cart.add(product.id); capture("product_added_to_cart", { product: product.id, price: product.price }); }}>Add to cart</button>
      </div>
    </div>
  );
}
