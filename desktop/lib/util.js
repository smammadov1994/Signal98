// Small pure helpers shared by ingest, classification and queries.
import crypto from "node:crypto";

export const clip = (v, n) => {
  const s = v == null ? "" : String(v);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");

// Turn a concrete message into its template so "user 7712 not found" and
// "user 9 not found" group together: ids, numbers, quoted values and hex go away.
export function templateOf(message) {
  return String(message || "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/https?:\/\/[^\s"')]+/g, "<url>")
    .replace(/"[^"]{0,120}"|'[^']{0,120}'/g, "<str>")
    .replace(/\$?\d+(?:[.,]\d+)*/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// /orders/8812/items/3 → /orders/:id/items/:id  (keeps network issues groupable)
export function templatePath(url) {
  let p = String(url || "");
  try { p = new URL(p, "http://x").pathname; } catch { /* keep as is */ }
  return p
    .split("/")
    .map((seg) =>
      /^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) ? ":id"
        // build content-hashes change on every deploy: main-3f9a2c1b9d.js, 4a57442373b707a3.hot-update.json
        : seg.replace(/^[0-9a-f]{8,}(?=\.)/i, ":hash").replace(/([._-])[0-9a-f]{8,}(?=[._-]|$)/gi, "$1:hash"))
    .join("/")
    .slice(0, 200);
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return ""; }
}

// Deliberately tiny user-agent sniffing: enough for the Browsers / OS / Devices panels.
export function parseUA(ua) {
  ua = String(ua || "");
  if (!ua) return { browser: null, os: null, device: null };
  let browser = "Other";
  if (/bot|crawl|spider|slurp|headless/i.test(ua)) browser = "Bot";
  else if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";
  else if (/node|undici/i.test(ua)) browser = "Node";
  let os = "Other";
  if (/Windows/.test(ua)) os = "Windows";
  else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Linux/.test(ua)) os = "Linux";
  const device = /iPad|Tablet/.test(ua) ? "Tablet" : /Mobi|iPhone|Android/.test(ua) ? "Mobile" : browser === "Node" ? "Server" : "Desktop";
  return { browser, os, device };
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(init.headers || {}) },
  });
}

export class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

// Token bucket, keyed by caller. Memory is bounded by sweeping idle buckets.
export function makeRateLimiter({ capacity, refillPerSec }) {
  const buckets = new Map();
  return function take(key, cost = 1) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size > 10_000) for (const [k, v] of buckets) if (now - v.at > 60_000) buckets.delete(k);
      b = { tokens: capacity, at: now };
      buckets.set(key, b);
    }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
    b.at = now;
    if (b.tokens < cost) return { ok: false, retryAfter: Math.ceil((cost - b.tokens) / refillPerSec) };
    b.tokens -= cost;
    return { ok: true };
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fmtMoney(usd) {
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(2)}`;
}
