"use client";
// Web analytics — visitors, pageviews, sources, tech and web vitals for one time range.
// Live: refreshes every 10 s and whenever the stream delivers new events.
import { useState } from "react";
import { useApi, fmtNum, fmtPct, fmtDuration, fmtTime } from "../lib/client";
import { LineChart, BarList, StatTile } from "../components/charts";

const RANGES = ["1h", "6h", "24h", "7d", "30d"];
// Core Web Vitals thresholds (p75): [good up to, needs improvement up to]
const VITALS = {
  LCP: { name: "Largest Contentful Paint", good: 2500, ni: 4000, what: "how long until the main content is visible" },
  INP: { name: "Interaction to Next Paint", good: 200, ni: 500, what: "how long the page takes to respond to input" },
  CLS: { name: "Cumulative Layout Shift", good: 0.1, ni: 0.25, what: "how much the layout jumps around (unitless)" },
  FCP: { name: "First Contentful Paint", good: 1800, ni: 3000, what: "how long until anything is painted" },
  TTFB: { name: "Time to First Byte", good: 800, ni: 1800, what: "how long the server takes to start answering" },
};
const VITAL_ORDER = ["LCP", "INP", "CLS", "FCP", "TTFB"];
// status colours — always shown WITH the rating word
const RATING = { good: { c: "#006300", w: "good" }, "needs-improvement": { c: "#b86a00", w: "needs improvement" }, poor: { c: "#d03b3b", w: "poor" } };
const fmtVital = (m, v) => (typeof v !== "number" || !Number.isFinite(v) ? "–" : m === "CLS" ? v.toFixed(2) : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const thresholdTip = (m) => {
  const t = VITALS[m];
  if (!t) return "no standard threshold for this metric";
  return `${t.name} — ${t.what}.\np75 thresholds: good ≤ ${fmtVital(m, t.good)} · needs improvement ≤ ${fmtVital(m, t.ni)} · poor above that`;
};

const list = (rows, sub) => (Array.isArray(rows) ? rows : []).map((r) => ({ k: r.k ?? "(none)", n: r.n ?? 0, sub: sub && r.u != null ? `· ${fmtNum(r.u)} visitor${r.u === 1 ? "" : "s"}` : undefined }));

function Panel({ title, hint, children }) {
  return <div className="panel sunken-thin"><h4 title={hint || ""}>{title}</h4>{children}</div>;
}

export default function WebAnalytics({ wm }) {
  const [range, setRange] = useState("24h");
  const { data, error, loading } = useApi(`web?range=${range}`, { every: 10_000, on: ["event"] });

  const t = data?.totals || {};
  const pts = Array.isArray(data?.series) ? data.series : [];
  const bucket = data?.range?.bucket || 3_600_000;
  const series = [
    { name: "Pageviews", points: pts.map((p) => ({ t: p.t, v: p.n ?? 0 })) },
    { name: "Visitors", points: pts.map((p) => ({ t: p.t, v: p.u ?? 0 })) },
  ];
  const vitals = (Array.isArray(data?.vitals) ? [...data.vitals] : []).sort((a, b) => {
    const ia = VITAL_ORDER.indexOf(a.metric), ib = VITAL_ORDER.indexOf(b.metric);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const nothing = data && !(t.pageviews > 0);
  const hint = "no pageviews in this range — open the demo shop at :3000 and click around, or pick a longer range";
  const bucketWord = bucket >= 86_400_000 ? "day" : bucket >= 3_600_000 ? "hour" : "5 min";

  return (
    <>
      <div className="toolbar an-wrap">
        <span>Range</span>
        {RANGES.map((r) => <button key={r} className={`tool-btn${range === r ? " on" : ""}`} onClick={() => setRange(r)}>{r}</button>)}
        <span className="an-sep" />
        <button className="tool-btn" onClick={() => wm?.open?.("sessions")}>Sessions…</button>
        <button className="tool-btn" onClick={() => wm?.open?.("insights")}>Insights…</button>
      </div>
      <div className="grow scroll">
        {error && !data ? <div className="err">could not load web analytics: {error}</div> : !data ? <div className="muted pad">…</div> : (
          <>
            <div className="stats">
              <StatTile label="visitors" value={fmtNum(t.visitors ?? 0)} sub="unique people" />
              <StatTile label="pageviews" value={fmtNum(t.pageviews ?? 0)} sub={t.visitors ? `${(t.pageviews / t.visitors).toFixed(1)} per visitor` : undefined} />
              <StatTile label="sessions" value={fmtNum(t.sessions ?? 0)} />
              <StatTile label="bounce rate" value={fmtPct(t.bounce_rate)} sub="sessions with one page" />
              <StatTile label="avg session" value={fmtDuration(t.avg_session_ms)} sub="first to last event" />
            </div>
            <Panel title={`Pageviews and visitors per ${bucketWord}`}>
              <div style={{ padding: "4px 4px 0" }}><LineChart series={series} bucket={bucket} height={170} /></div>
              {nothing ? <div className="muted" style={{ padding: "0 8px 6px" }}>{hint}</div> : null}
            </Panel>
            <div className="an-grid">
              <Panel title="Top pages" hint="pageviews per path"><BarList rows={list(data.pages, true)} empty={hint} /></Panel>
              <Panel title="Entry pages" hint="the first page of each session"><BarList rows={list(data.entry_pages)} empty="no sessions started in this range" /></Panel>
              <Panel title="Referrers" hint="pageviews by referring domain; direct visits have none"><BarList rows={list(data.referrers, true)} empty="no referred traffic — everything was direct" /></Panel>
              <Panel title="UTM sources" hint="sessions whose landing URL carried utm_source"><BarList rows={list(data.utm)} empty="no campaign traffic — add ?utm_source=… to a link" /></Panel>
              <Panel title="Browsers"><BarList rows={list(data.browsers, true)} empty="nothing yet" /></Panel>
              <Panel title="Operating systems"><BarList rows={list(data.os, true)} empty="nothing yet" /></Panel>
              <Panel title="Devices"><BarList rows={list(data.devices, true)} empty="nothing yet" /></Panel>
            </div>
            <Panel title="Web vitals (p75)" hint="75th percentile of what real visitors experienced in this range">
              {vitals.length === 0 ? <div className="muted pad">no web vitals yet — browsers report them a few seconds after a page loads (INP after the first interaction)</div> : (
                <table className="t98">
                  <thead><tr><th>Metric</th><th className="num">p75</th><th>Rating</th><th className="num">Good up to</th><th className="num">Poor above</th><th className="num">Samples</th></tr></thead>
                  <tbody>
                    {vitals.map((v) => {
                      const r = RATING[v.rating];
                      return (
                        <tr key={v.metric} title={thresholdTip(v.metric)}>
                          <td><b>{v.metric}</b> <span className="muted">{VITALS[v.metric]?.name || ""}</span></td>
                          <td className="num">{fmtVital(v.metric, v.p75)}</td>
                          <td>{r ? <span className="vtag" style={{ color: r.c, borderColor: r.c }}>{r.w.toUpperCase()}</span> : <span className="muted">{v.rating || "–"}</span>}</td>
                          <td className="num">{VITALS[v.metric] ? fmtVital(v.metric, VITALS[v.metric].good) : "–"}</td>
                          <td className="num">{VITALS[v.metric] ? fmtVital(v.metric, VITALS[v.metric].ni) : "–"}</td>
                          <td className="num">{fmtNum(v.samples ?? 0)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Panel>
          </>
        )}
      </div>
      <div className="statusbar">
        <div className="cell grow sunken-thin">{error && data ? `refresh failed: ${error}` : loading && data ? "loading…" : nothing ? hint : `last ${range} · one point per ${bucketWord}`}</div>
        <div className="cell sunken-thin">live · every 10 s</div>
        <div className="cell sunken-thin">{data?.range?.to ? `as of ${fmtTime(data.range.to)}` : "–"}</div>
      </div>
    </>
  );
}
