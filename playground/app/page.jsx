"use client";
import { useEffect, useState, useCallback } from "react";
import { init, capture, captureException, wrap, addStep } from "signal98";

// This app is the trigger panel. It fires errors through the signal98 SDK
// into the Win98 desktop's ingest (http://localhost:3001/api/ingest) —
// open the desktop's Raw Feed window to watch them get judged live.
const INGEST = "http://localhost:3001/api/ingest";
const FEED = "http://localhost:3001/api/feed";

// one wrapped function per demo, defined once
const chargeCard = wrap(
  (total) => {
    addStep("checkout attempted", { total });
    throw new Error(`payment failed: card declined for $${total}`);
  },
  { name: "chargeCard" }
);

const loginAttempt = wrap(
  () => {
    throw new Error("POST /v1/login 500: password verifier crashed");
  },
  { name: "loginAttempt" }
);

const BUTTONS = [
  {
    id: "uncaught",
    title: "Uncaught render crash",
    desc: "TypeError on user profile page",
    expect: "page",
    run: () => {
      setTimeout(() => {
        throw new Error(
          "TypeError: Cannot read properties of undefined (reading 'name') — user profile page"
        );
      }, 50);
    },
  },
  {
    id: "rejection",
    title: "Unhandled rejection",
    desc: "webhook delivery timed out",
    expect: "suppressed",
    run: () => {
      setTimeout(() => {
        Promise.reject(new Error("webhook delivery timed out after 3 retries"));
      }, 50);
    },
  },
  {
    id: "payment",
    title: "Failed payment (wrapped)",
    desc: "card declined for $4200",
    expect: "page",
    run: () => {
      try {
        chargeCard(4200);
      } catch {
        /* reported by wrap(), handled here */
      }
    },
  },
  {
    id: "login",
    title: "Login 500 (wrapped)",
    desc: "password verifier crashed",
    expect: "page",
    run: () => {
      try {
        loginAttempt();
      } catch {
        /* reported by wrap(), handled here */
      }
    },
  },
  {
    id: "background",
    title: "Background job failed",
    desc: "nightly report: /tmp full",
    expect: "suppressed",
    run: () => {
      captureException(new Error("nightly report job failed: /tmp full"), {
        job: "nightly-report",
      });
    },
  },
  {
    id: "console",
    title: "console.error",
    desc: "deprecated API v1 called",
    expect: "suppressed",
    run: () => {
      console.error("deprecated API v1 called by legacy client");
    },
  },
  {
    id: "manual",
    title: "Caught error (manual)",
    desc: "JSON.parse blew up on config",
    expect: "suppressed",
    run: () => {
      try {
        JSON.parse("{oops");
      } catch (err) {
        captureException(err, { where: "config-load" });
      }
    },
  },
  {
    id: "custom",
    title: "Custom event",
    desc: "user_signed_up (not an error)",
    expect: "suppressed",
    run: () => {
      capture("user_signed_up", { plan: "pro" });
    },
  },
];

export default function Page() {
  const [feed, setFeed] = useState([]);
  const [mode, setMode] = useState("heuristic");
  const [rule, setRule] = useState("");
  const [down, setDown] = useState(false);

  useEffect(() => {
    init({
      endpoint: INGEST,
      environment: "playground",
      autoCapture: { errors: true, rejections: true, console: true, steps: true },
    });
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(FEED, { cache: "no-store" });
        const data = await res.json();
        if (!alive) return;
        // only what this panel fired — the desktop's Raw Feed shows everything
        setFeed((data.events || []).filter((e) => e.service === "playground"));
        setMode(data.mode);
        setRule(data.rule);
        setDown(false);
      } catch {
        if (alive) setDown(true);
      }
    };
    poll();
    const t = setInterval(poll, 800);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const clear = useCallback(async () => {
    try {
      await fetch(FEED, { method: "DELETE" });
    } catch {
      /* desktop not up */
    }
    setFeed([]);
  }, []);

  const paged = feed.filter((e) => e.paged).length;
  const suppressed = feed.filter((e) => e.status === "judged" && !e.paged).length;

  const fmtTime = (iso) => {
    try {
      return new Date(iso).toLocaleTimeString("en-US", { hour12: false });
    } catch {
      return "";
    }
  };

  return (
    <div className="wrap">
      <header className="top">
        <h1>signal98 — error playground</h1>
        <span className={`mode ${mode}`}>{mode === "jev" ? "● judged by JEV" : "● heuristic judging"}</span>
      </header>
      <p className="sub">
        Press a button to set off an error. The signal98 SDK catches it and fires it into the{" "}
        <b>Win98 desktop&apos;s ingest</b> — open its <b>Raw Feed</b> window (http://localhost:3001){" "}
        to watch each event get judged live. {rule && <>Paging rule: <code>{rule}</code></>}
      </p>
      {down && (
        <p className="down">
          ⚠ can&apos;t reach the Win98 desktop — start it with <code>cd ~/signal98 && npm run dev</code>
        </p>
      )}

      <div className="grid">
        <div className="card">
          <h2>Set off errors</h2>
          {BUTTONS.map((b) => (
            <button key={b.id} className="btn" onClick={b.run}>
              <span className="t">
                {b.title}
                <span className={`expect ${b.expect === "page" ? "page" : "sup"}`}>
                  {b.expect === "page" ? "WILL PAGE" : "SUPPRESSED"}
                </span>
              </span>
              <span className="d">{b.desc}</span>
            </button>
          ))}
        </div>

        <div className="card">
          <div className="feed-head">
            <h2>What you fired</h2>
            <button className="clear" onClick={clear}>Clear</button>
          </div>
          <div className="feed">
            {feed.length === 0 && !down && (
              <div className="empty">Nothing yet. Press a button — watch the verdict land.</div>
            )}
            {feed.map((e) => (
              <div key={e.id} className="ev">
                <div className="line">{e.message}</div>
                <div className="meta">
                  <span className="time">{fmtTime(e.ts)}</span>
                  <span className="mech">{e.mechanism}</span>
                  {e.status === "judging" && <span className="judging">judging…</span>}
                  {e.status === "judged" && e.judgments && (
                    <>
                      <span className="chips">
                        <span className="chip">urgent <b>{e.judgments.is_urgent.toFixed(2)}</b></span>
                        <span className="chip">user-facing <b>{e.judgments.is_user_facing.toFixed(2)}</b></span>
                        <span className="chip">novel <b>{e.judgments.is_novel.toFixed(2)}</b></span>
                      </span>
                      <span className={`verdict ${e.paged ? "paged" : "suppressed"}`}>
                        {e.paged ? "PAGED" : "SUPPRESSED"}
                      </span>
                      <span className="by">by {e.judgedBy}</span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="counts">
            <span><b>{feed.length}</b> events</span>
            <span className="rp"><b className="rp">{paged}</b> paged</span>
            <span><b>{suppressed}</b> suppressed</span>
          </div>
        </div>
      </div>
    </div>
  );
}
