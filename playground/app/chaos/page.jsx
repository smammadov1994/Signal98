"use client";
// One-click failures of every flavour, so you can watch how differently JEV treats them.
// Each trigger reports through the real SDK — nothing here talks to the monitor directly.
// Editing this file moves line numbers; issues must keep grouping regardless (see
// sdk/src/util.js → fingerprintOf), which is what lets a regressed bug be recognised.
import { useState } from "react";
import { capture, captureException, log, isFeatureEnabled } from "signal98";

const TRIGGERS = [
  { group: "Should wake someone up", items: [
    { title: "Uncaught crash on the profile page", desc: "TypeError reading 'name' of undefined — unhandled", run: () => setTimeout(() => { const user = undefined; return user.name; }, 30) },
    { title: "Login endpoint is down", desc: "POST /v1/login 500: password verifier crashed — unhandled rejection", run: () => { Promise.reject(new Error("POST /v1/login 500: password verifier crashed, users cannot sign in")); } },
    { title: "Double charge detected", desc: "handled, but money and data are involved", run: () => captureException(new Error("duplicate charge: card charged twice for order GM-1042, refund required"), { order: "GM-1042" }) },
  ] },
  { group: "Worth a ticket, not a page", items: [
    { title: "Bad config JSON (caught)", desc: "JSON.parse blew up while loading settings", run: () => { try { JSON.parse("{oops"); } catch (err) { captureException(err, { where: "settings-load" }); } } },
    { title: "Nightly report job failed", desc: "background job, no user noticed", run: () => captureException(new Error("nightly report job failed: /tmp is full"), { job: "nightly-report" }) },
    { title: "Slow recommendations API", desc: "takes ~5 s → reported as a slow request", run: () => fetch("/api/recommendations").catch(() => {}) },
    { title: "Error log line", desc: "log.error from application code", run: () => log.error("inventory sync failed for sku 8831: upstream returned 502", { logger: "inventory" }) },
  ] },
  { group: "Noise", items: [
    // (The classic "ResizeObserver loop" noise never even leaves the browser: the SDK drops it
    // at the source. This one does reach the monitor, so you can watch it get IGNOREd.)
    { title: "Browser extension error", desc: "thrown inside an extension's content script — not our code at all", run: () => captureException(Object.assign(new Error("Extension context invalidated: cannot access chrome.runtime from injected ad blocker script"), { stack: "Error: Extension context invalidated\n    at inject (chrome-extension://abcdef/content.js:1:1)" })) },
    { title: "console.error deprecation", desc: "console capture is on in this app", run: () => console.error("Warning: deprecated API v1 called by legacy client") },
    { title: "Request cancelled by the user", desc: "AbortError", run: () => { const c = new AbortController(); fetch("/api/recommendations", { signal: c.signal }).catch((e) => captureException(e)); c.abort(); } },
  ] },
  { group: "Product events", items: [
    { title: "user_signed_up", desc: "a conversion — JEV files it under activation", run: () => capture("user_signed_up", { plan: "pro", source: "chaos-panel" }) },
    { title: "subscription_cancelled", desc: "a churn signal", run: () => capture("subscription_cancelled", { plan: "team", reason: "too many ghosts" }) },
    { title: "invite_sent", desc: "referral", run: () => capture("invite_sent", { channel: "email" }) },
    { title: "Check a feature flag", desc: "new-checkout (create it in Control Panel → Feature flags)", run: (say) => say(`new-checkout → ${String(isFeatureEnabled("new-checkout"))}`) },
  ] },
];

export default function Chaos() {
  const [note, setNote] = useState("");
  const [burst, setBurst] = useState(false);
  const flood = () => {
    setBurst(true);
    let n = 0;
    const t = setInterval(() => {
      captureException(new Error(`search index unavailable: shard ${1 + (n % 3)} timed out`), { shard: 1 + (n % 3) });
      if (++n >= 40) { clearInterval(t); setBurst(false); }
    }, 60);
  };
  return (
    <>
      <h1>Chaos panel</h1>
      <p className="sub">Each button sets off a real failure through the SDK. The shop itself also has three genuine bugs: open <b>Fog in a Can</b>, apply coupon <b>GHOST10</b>, and check out with more than $100 in the cart. Rage-click the coupon button when it does nothing.</p>
      {note && <p className="hint">{note}</p>}
      {TRIGGERS.map((g) => (
        <section key={g.group}>
          <h2>{g.group}</h2>
          <div className="grid">
            {g.items.map((b) => (
              <button key={b.title} className="card trigger" onClick={() => { setNote(`fired: ${b.title} — watch the monitor`); b.run(setNote); }}>
                <span className="pname">{b.title}</span>
                <span className="blurb">{b.desc}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
      <section>
        <h2>Volume</h2>
        <button className="btn ghost" disabled={burst} onClick={flood}>{burst ? "flooding…" : "Throw the same error 40 times"}</button>
        <p className="hint">The SDK&apos;s burst protection keeps at most 10 per fingerprint per 10 s; the monitor groups them into one issue and JEV is asked once.</p>
      </section>
    </>
  );
}
