"use client";
// This is the whole integration: init() once, wrap the tree in the error boundary.
// Everything else the monitor shows — pageviews, clicks, rage clicks, failed requests,
// web vitals, sessions — is captured automatically.
import { useEffect, useState } from "react";
import Link from "next/link";
import { init, getClient } from "signal98";
import { createErrorBoundary } from "signal98/react";
import { useCart } from "./lib/cart";

const HOST = process.env.NEXT_PUBLIC_SIGNAL98_HOST || "http://localhost:3001";
const KEY = process.env.NEXT_PUBLIC_SIGNAL98_KEY || "s98_pk_local_dev";

let Boundary = null;
function boundary() {
  if (Boundary) return Boundary;
  init({ host: HOST, apiKey: KEY, service: "ghost-mart", environment: "playground", release: "shop@0.2.0", autoCapture: { console: true } });
  Boundary = createErrorBoundary(getClient());
  return Boundary;
}

function Crashed() {
  return (
    <div className="crash">
      <h2>This page crashed.</h2>
      <p>The error was captured by signal98 — look at the monitor on <a href={HOST} target="_blank" rel="noreferrer">:3001</a>.</p>
      <p><a href="/">Back to the shop</a></p>
    </div>
  );
}

export default function Shell({ children }) {
  const [ready, setReady] = useState(false);
  const cart = useCart();
  useEffect(() => { boundary(); setReady(true); }, []);
  const B = ready ? boundary() : null;
  return (
    <>
      <header className="nav">
        <Link href="/" className="brand">ghost mart</Link>
        <nav>
          <Link href="/">Shop</Link>
          <Link href="/cart">Cart ({cart.items.length})</Link>
          <Link href="/account">Account</Link>
          <Link href="/chaos" className="chaos-link">Chaos panel</Link>
        </nav>
      </header>
      <main className="wrap">{B ? <B fallback={<Crashed />}>{children}</B> : children}</main>
      <footer className="foot">demo app wrapped with the signal98 SDK · monitor at <a href={HOST} target="_blank" rel="noreferrer">{HOST}</a></footer>
    </>
  );
}
