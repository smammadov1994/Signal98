"use client";
import { useEffect, useState, useCallback } from "react";
import { byId } from "./catalog";

const KEY = "ghostmart_cart";
const read = () => {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
};

export function useCart() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    setItems(read());
    const sync = () => setItems(read());
    window.addEventListener("storage", sync);
    window.addEventListener("ghostmart:cart", sync);
    return () => { window.removeEventListener("storage", sync); window.removeEventListener("ghostmart:cart", sync); };
  }, []);
  const write = useCallback((next) => {
    localStorage.setItem(KEY, JSON.stringify(next));
    setItems(next);
    window.dispatchEvent(new Event("ghostmart:cart"));
  }, []);
  const add = useCallback((id) => write([...read(), id]), [write]);
  const remove = useCallback((index) => write(read().filter((_, i) => i !== index)), [write]);
  const clear = useCallback(() => write([]), [write]);
  const lines = items.map(byId).filter(Boolean);
  const subtotal = lines.reduce((s, p) => s + p.price, 0);
  return { items, lines, subtotal, add, remove, clear };
}
