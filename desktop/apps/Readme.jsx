"use client";

export default function Readme({ wm }) {
  const link = (app, text, params) => (
    <a href="#" onClick={(e) => { e.preventDefault(); wm?.open(app, params); }} style={{ color: "#000080" }}>{text}</a>
  );
  return (
    <>
      <div className="menubar"><span>File</span><span>Edit</span><span>Search</span><span>Help</span></div>
      <div className="notepad sunken selectable" style={{ flex: 1, overflow: "auto" }}>
        <h3>signal98 — what is this?</h3>
        <p>
          A monitoring system in the shape of PostHog or Datadog — error tracking, product and web
          analytics, sessions, people, feature flags, alerts — where the thing deciding what matters is{" "}
          <b>JEV</b>, TypeSafe&apos;s System One model, not a hand-tuned threshold.
        </p>
        <p>
          Traditional alerting counts. It pages you because something happened 50 times, whether or not
          anyone cares. signal98 asks JEV typed questions about <i>meaning</i> — which area broke, how
          severe, is a user feeling it, is it your code, is money involved, is it noise — and gets back
          calibrated probabilities. Paging is then a small rule over those answers.
        </p>
        <h3>why it is cheap</h3>
        <p>
          JEV judges <b>issues</b>, not events. The first occurrence of a bug is classified with one
          request (a dozen questions answered in parallel against one small state); the next ten
          thousand occurrences inherit that verdict for free. An issue is only re-read when its story
          changes: it regresses, or its volume grows by an order of magnitude. Sessions are read once
          they go quiet; custom event names once, ever. See {link("settings", "Control Panel → JEV", { tab: "jev" })} for
          live token usage and cost.
        </p>
        <h3>the desktop</h3>
        <p>
          {link("feed", "Live Feed")} — every event as it lands; verdicts fill in a moment later.<br />
          {link("issues", "Issues")} — grouped errors, failed requests, error logs and UX friction, ranked by JEV priority.<br />
          {link("pages", "Pages")} — what is worth waking someone up for, with the receipts.<br />
          {link("insights", "Insights")} — trends, funnels, retention, and a lifecycle view JEV builds from your event names.<br />
          {link("web", "Web Analytics")} — visitors, pages, referrers, devices, web vitals.<br />
          {link("sessions", "Sessions")} — timelines, with JEV&apos;s read of intent, outcome and frustration.<br />
          {link("persons", "People")} — who they are and what they hit.<br />
          {link("alerts", "Alerts")} — rules, email / push / Slack / webhook channels, and the outbox.<br />
          {link("runs", "Ghost Agents")} — coding agents the ghost dispatched, with their diffs.<br />
          {link("recycle", "Recycle Bin")} — what JEV called noise. Bothering no one.
        </p>
        <h3>the ghost</h3>
        <p>
          The ghost in the corner is Clippy for production. When JEV pages, it speaks up and offers the
          fix. Click it for the menu; drag it onto an issue to haunt that one. In <b>auto mode</b> it
          dispatches a coding agent — on its own git branch, in a worktree, without a shell — whenever
          JEV is confident an issue is a bounded defect in your code. If the bug comes back after a
          fix, the issue regresses, JEV reads it again, and the ghost goes again with its earlier
          attempt in hand.
        </p>
        <h3>honesty</h3>
        <p>
          Without <code>TYPESAFE_API_KEY</code> in <code>desktop/.env.local</code> a keyword heuristic
          judges instead. Everything it touches is labelled <code>heuristic</code>; nothing pretends to
          be JEV. Add a key, restart, and existing verdicts are upgraded in the background.
        </p>
      </div>
    </>
  );
}
