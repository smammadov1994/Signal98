"use client";
// Insights — product analytics: Trends, Funnels, Retention and the JEV lifecycle view.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, useApi, fmtNum, fmtPct, fmtDuration, fmtDateTime, ago, label, SERIES } from "../lib/client";
import { LineChart, FunnelChart, BarList, Meter, StatTile, JudgedBy } from "../components/charts";

const RANGES = ["1h", "6h", "24h", "7d", "30d"];
const BUILTINS = [
  { v: "$pageview", t: "Pageview" }, { v: "$autocapture", t: "Autocapture (clicks)" }, { v: "$exception", t: "Exception" },
  { v: "$rageclick", t: "Rage click" }, { v: "*", t: "All events" },
];
const MATHS = [{ v: "total", t: "Total count" }, { v: "users", t: "Unique users" }, { v: "sessions", t: "Unique sessions" }];
const BREAKDOWNS = ["browser", "os", "device", "pathname", "referrer_domain", "service", "environment", "release"];
const STAGE_ORDER = ["acquisition", "activation", "engagement", "revenue", "retention", "referral", "churn_signal", "system", "unclassified"];
const bucketWord = (b) => (b >= 86_400_000 ? "day" : b >= 3_600_000 ? "hour" : "5 min");
const dayLabel = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const eventTitle = (v) => BUILTINS.find((b) => b.v === v)?.t || v;

function RangeButtons({ value, onChange }) {
  return <>{RANGES.map((r) => <button key={r} className={`tool-btn${value === r ? " on" : ""}`} onClick={() => onChange(r)}>{r}</button>)}</>;
}

function EventSelect({ value, onChange, custom, all = true, style }) {
  return (
    <select className="in98" value={value} onChange={(e) => onChange(e.target.value)} style={style}>
      <optgroup label="Built in">{BUILTINS.filter((b) => all || b.v !== "*").map((b) => <option key={b.v} value={b.v}>{b.t}</option>)}</optgroup>
      {custom.length ? <optgroup label="Your events">{custom.map((n) => <option key={n} value={n}>{n}</option>)}</optgroup> : null}
      {value && !BUILTINS.some((b) => b.v === value) && !custom.includes(value) ? <option value={value}>{value}</option> : null}
    </select>
  );
}

// ------------------------------------------------------------------ Trends
function Trends({ custom, setStatus, active }) {
  const [event, setEvent] = useState("$pageview");
  const [math, setMath] = useState("total");
  const [range, setRange] = useState("24h");
  const [by, setBy] = useState("");
  const [prop, setProp] = useState("");
  const [propLive, setPropLive] = useState("");
  useEffect(() => { const t = setTimeout(() => setPropLive(prop.trim().replace(/^prop:/, "")), 400); return () => clearTimeout(t); }, [prop]);

  const breakdown = by === "prop" ? (propLive ? `prop:${propLive}` : "") : by;
  const qs = new URLSearchParams({ event, math, range });
  if (breakdown) qs.set("breakdown", breakdown);
  const path = `insights/trend?${qs}`;
  const { data, error, loading } = useApi(path, { every: active ? 15_000 : 0 });

  // Colour follows the series, not its rank: remember the order keys first appeared in
  // (per question), so a refresh that reshuffles the top 6 does not repaint the lines.
  const orderRef = useRef({ sig: "", keys: [] });
  const sig = `${event}|${math}|${breakdown}`;
  const rows = useMemo(() => {
    if (!data) return [];
    if (Array.isArray(data.breakdown)) {
      const list = (Array.isArray(data.breakdown) ? data.breakdown : []).map((b) => ({ key: String(b.key ?? "(none)"), total: b.total ?? 0, pts: Array.isArray(b.series) ? b.series : [] }));
      if (orderRef.current.sig !== sig) orderRef.current = { sig, keys: [] };
      for (const r of list) if (!orderRef.current.keys.includes(r.key)) orderRef.current.keys.push(r.key);
      const pos = (k) => orderRef.current.keys.indexOf(k);
      return list.sort((a, b) => pos(a.key) - pos(b.key));
    }
    return [{ key: eventTitle(event), total: data.total ?? 0, pts: Array.isArray(data.series) ? data.series : [] }];
  }, [data, breakdown, sig, event]);

  const bucket = data?.bucket || 3_600_000;
  const series = rows.map((r) => ({ name: r.key, points: r.pts.map((p) => ({ t: p.t, v: p.n ?? 0 })) }));
  const sum = rows.reduce((s, r) => s + r.total, 0);
  const mathWord = MATHS.find((m) => m.v === math)?.t.toLowerCase() || math;

  useEffect(() => {
    if (active) setStatus(error && data ? `refresh failed: ${error}` : loading ? "loading…" : `${eventTitle(event)} · ${mathWord} · last ${range} · one point per ${bucketWord(bucket)}${breakdown ? ` · top ${rows.length} by ${breakdown}` : ""}`);
  }, [error, loading, data, event, mathWord, range, bucket, breakdown, rows.length, setStatus, active]);

  return (
    <>
      <div className="an-bar">
        <span>Event</span><EventSelect value={event} onChange={setEvent} custom={custom} />
        <span>Math</span>
        <select className="in98" value={math} onChange={(e) => setMath(e.target.value)}>{MATHS.map((m) => <option key={m.v} value={m.v}>{m.t}</option>)}</select>
        <span>Breakdown</span>
        <select className="in98" value={by} onChange={(e) => setBy(e.target.value)}>
          <option value="">none</option>
          {BREAKDOWNS.map((b) => <option key={b} value={b}>{label(b)}</option>)}
          <option value="prop">custom property…</option>
        </select>
        {by === "prop" ? <input className="in98" style={{ width: 110 }} value={prop} onChange={(e) => setProp(e.target.value)} placeholder="e.g. plan" spellCheck={false} title="a property name on the event, sent as prop:<name>" /> : null}
        <span className="an-sep" />
        <RangeButtons value={range} onChange={setRange} />
      </div>
      <div className="grow scroll">
        {error && !data ? <div className="err">could not load the trend: {error}</div> : !data ? <div className="muted pad">…</div> : (
          <>
            <div className="panel sunken-thin">
              <h4>{eventTitle(event)} — {mathWord} per {bucketWord(bucket)}{breakdown ? `, by ${breakdown.replace(/^prop:/, "property ")}` : ""}</h4>
              <div style={{ padding: "4px 4px 0" }}><LineChart series={series} bucket={bucket} height={190} area /></div>
              {by === "prop" && !propLive ? <div className="muted" style={{ padding: "0 8px 6px" }}>type a property name to break down by it (for example <span className="mono">plan</span> on <span className="mono">add_to_cart</span>)</div>
                : sum === 0 && !loading ? <div className="muted" style={{ padding: "0 8px 6px" }}>nothing matched in this range — open the demo shop at :3000 and click around, or pick a longer range</div> : null}
            </div>
            <div className="panel sunken-thin">
              <h4>Totals</h4>
              <table className="t98">
                <thead><tr><th>{breakdown ? label(breakdown.replace(/^prop:/, "")) : "Series"}</th><th className="num">Total</th>{breakdown && math === "total" ? <th className="num">Share</th> : null}<th className="num">Avg / {bucketWord(bucket)}</th><th className="num">Peak</th><th>Peak at</th></tr></thead>
                <tbody>
                  {rows.length === 0 ? <tr><td colSpan={6} className="muted">no series</td></tr> : rows.map((r, i) => {
                    const vals = r.pts.map((p) => p.n ?? 0);
                    const peak = vals.length ? Math.max(...vals) : 0;
                    const at = peak > 0 ? r.pts[vals.indexOf(peak)]?.t : null;
                    const bucketSum = vals.reduce((s, v) => s + v, 0);
                    return (
                      <tr key={r.key}>
                        <td><i className="an-sw" style={{ background: SERIES[i % SERIES.length] }} />{r.key}</td>
                        <td className="num"><b>{fmtNum(r.total)}</b></td>
                        {breakdown && math === "total" ? <td className="num">{sum ? fmtPct(r.total / sum) : "–"}</td> : null}
                        <td className="num">{vals.length ? fmtNum(Math.round((bucketSum / vals.length) * 100) / 100) : "–"}</td>
                        <td className="num">{fmtNum(peak)}</td>
                        <td>{at ? (bucket >= 86_400_000 ? `${dayLabel(at)} (UTC day)` : fmtDateTime(at)) : <span className="muted">–</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {math !== "total" ? <div className="muted" style={{ padding: "3px 6px" }}>Total is {mathWord} over the whole range, so it is not the sum of the points.</div> : null}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Funnels
const SHOP_PRESET = [{ event: "$pageview", pathname: "/" }, { event: "$pageview", pathname: "/cart" }, { event: "$pageview", pathname: "/checkout" }, { event: "order_completed", pathname: "" }];
const WINDOWS = [{ v: 5, t: "5 minutes" }, { v: 30, t: "30 minutes" }, { v: 60, t: "1 hour" }, { v: 1440, t: "1 day" }, { v: 10080, t: "7 days" }];
const stepLabel = (s) => (s.event === "$pageview" ? `Pageview ${s.pathname || "(any page)"}` : eventTitle(s.event));
let stepSeq = 0;
const withIds = (steps) => steps.map((s) => ({ ...s, id: ++stepSeq }));

function Funnels({ custom, setStatus, active }) {
  const [steps, setSteps] = useState(() => withIds(SHOP_PRESET));
  const [range, setRange] = useState("7d");
  const [win, setWin] = useState(1440);
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);

  const payload = useMemo(() => JSON.stringify({
    steps: steps.map((s) => ({ event: s.event, ...(s.event === "$pageview" && s.pathname.trim() ? { pathname: s.pathname.trim() } : {}) })),
    range, windowMinutes: win,
  }), [steps, range, win]);

  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(async () => {
      try {
        const data = await api("insights/funnel", { method: "POST", body: JSON.parse(payload) });
        if (mine === seq.current) setState({ data, error: null, loading: false });
      } catch (err) {
        if (mine === seq.current) setState((s) => ({ ...s, error: err.message, loading: false }));
      }
    }, 350);
    return () => clearTimeout(t);
  }, [payload, tick]);
  useEffect(() => { if (!active) return; const t = setInterval(() => setTick((n) => n + 1), 20_000); return () => clearInterval(t); }, [active]);

  const { data, error, loading } = state;
  const res = (Array.isArray(data?.steps) ? data.steps : []).map((s) => ({ ...s, label: stepLabel(s), count: s.count ?? 0, conversion: s.conversion ?? 0, step_conversion: s.step_conversion ?? 0 }));
  const entered = res[0]?.count ?? 0, done = res.length ? res[res.length - 1].count : 0;
  let worst = null;
  res.forEach((s, i) => { if (i > 0 && res[i - 1].count > 0 && (!worst || s.step_conversion < worst.step_conversion)) worst = { ...s, i }; });

  useEffect(() => {
    if (active) setStatus(error && data ? `refresh failed: ${error}` : loading ? "running…" : `${steps.length} steps · last ${range} · each person must finish within ${WINDOWS.find((w) => w.v === win)?.t || `${win} min`}`);
  }, [error, loading, data, steps.length, range, win, setStatus, active]);

  const patch = (id, p) => setSteps((list) => list.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const move = (i, d) => setSteps((list) => { const out = [...list]; const j = i + d; if (j < 0 || j >= out.length) return list; [out[i], out[j]] = [out[j], out[i]]; return out; });

  return (
    <>
      <div className="an-bar">
        <button className="btn98 small" onClick={() => { setSteps(withIds(SHOP_PRESET)); setRange("7d"); setWin(1440); }} title="the demo shop at :3000 emits exactly these">Preset: Shop checkout  / → /cart → /checkout → order_completed</button>
        <span className="an-sep" />
        <span>Finish within</span>
        <select className="in98" value={win} onChange={(e) => setWin(Number(e.target.value))}>{WINDOWS.map((w) => <option key={w.v} value={w.v}>{w.t}</option>)}</select>
        <span className="an-sep" />
        <RangeButtons value={range} onChange={setRange} />
      </div>
      <div className="grow scroll">
        <div className="group98">
          <span className="gl">Steps, in order ({steps.length} of 8)</span>
          {steps.map((s, i) => (
            <div key={s.id} className="row" style={{ marginBottom: 4 }}>
              <b style={{ width: 16, textAlign: "right" }}>{i + 1}.</b>
              <EventSelect value={s.event} onChange={(v) => patch(s.id, { event: v })} custom={custom} all={false} style={{ width: 190 }} />
              <span className={s.event === "$pageview" ? "" : "muted"}>on path</span>
              <input className="in98 mono" style={{ width: 150 }} value={s.event === "$pageview" ? s.pathname : ""} disabled={s.event !== "$pageview"} onChange={(e) => patch(s.id, { pathname: e.target.value })} placeholder={s.event === "$pageview" ? "any page" : "pageviews only"} spellCheck={false} />
              <button className="btn98 small" disabled={i === 0} onClick={() => move(i, -1)} title="move up">▲</button>
              <button className="btn98 small" disabled={i === steps.length - 1} onClick={() => move(i, 1)} title="move down">▼</button>
              <button className="btn98 small" disabled={steps.length <= 2} onClick={() => setSteps((l) => l.filter((x) => x.id !== s.id))} title={steps.length <= 2 ? "a funnel needs at least 2 steps" : "remove this step"}>Remove</button>
            </div>
          ))}
          <button className="btn98 small" disabled={steps.length >= 8} onClick={() => setSteps((l) => [...l, ...withIds([{ event: custom[0] || "$pageview", pathname: "" }])])}>Add step</button>
        </div>
        {error && !data ? <div className="err">could not run the funnel: {error}</div> : !data ? <div className="muted pad">…</div> : res.length === 0 ? <div className="muted pad">a funnel needs at least two steps</div> : (
          <>
            <div className="stats">
              <StatTile label="entered" value={fmtNum(entered)} sub="people at step 1" />
              <StatTile label="converted" value={fmtNum(done)} sub={`reached step ${res.length}`} />
              <StatTile label="conversion" value={entered ? fmtPct(done / entered, 1) : "–"} sub="step 1 → last step" />
              <StatTile label="biggest drop" value={worst ? `step ${worst.i} → ${worst.i + 1}` : "–"} sub={worst ? `${fmtPct(1 - worst.step_conversion)} lost` : undefined} />
            </div>
            <div className="panel sunken-thin">
              <h4>People reaching each step</h4>
              <FunnelChart steps={res} />
              {entered === 0 ? <div className="muted" style={{ padding: "0 8px 6px" }}>nobody entered this funnel in the last {range} — open the demo shop at :3000, add something to the cart and check out</div> : null}
            </div>
            <div className="panel sunken-thin">
              <h4>Between steps</h4>
              <table className="t98">
                <thead><tr><th>From → to</th><th className="num">Continued</th><th className="num">Dropped off</th><th className="num">Step conversion</th><th className="num">Median time</th></tr></thead>
                <tbody>
                  {res.slice(1).map((s, i) => (
                    <tr key={i}>
                      <td><b>{i + 1}.</b> {res[i].label} → <b>{i + 2}.</b> {s.label}</td>
                      <td className="num">{fmtNum(s.count)}</td>
                      <td className="num">{fmtNum(Math.max(0, res[i].count - s.count))}</td>
                      <td className="num">{res[i].count ? fmtPct(s.step_conversion) : "–"}</td>
                      <td className="num">{fmtDuration(s.median_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Retention
// Sequential ramp: ONE hue, light → dark (dataviz blue 100→550). Ink flips to white once the cell is dark.
const RAMP = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab"];
const shade = (v) => (v == null ? null : v <= 0 ? { bg: "#fff", ink: "#6b6b6b" } : (() => { const i = Math.min(RAMP.length - 1, Math.floor(v * RAMP.length)); return { bg: RAMP[i], ink: i >= 8 ? "#fff" : "#000" }; })());

function Retention({ setStatus, active }) {
  const [days, setDays] = useState(8);
  const { data, error, loading } = useApi(`insights/retention?days=${days}`, { every: active ? 30_000 : 0 });
  const cohorts = Array.isArray(data?.cohorts) ? data.cohorts : [];
  const n = data?.days || days;
  const cols = Array.from({ length: n }, (_, i) => i);
  // weighted average per day across the cohorts old enough to have that day
  const avg = cols.map((d) => {
    let back = 0, size = 0;
    for (const c of cohorts) { const v = c.values?.[d]; if (v != null && c.size) { back += v * c.size; size += c.size; } }
    return size ? back / size : null;
  });
  const people = cohorts.reduce((s, c) => s + (c.size || 0), 0);

  useEffect(() => {
    if (active) setStatus(error && data ? `refresh failed: ${error}` : loading ? "loading…" : `${cohorts.length} cohort(s) · ${fmtNum(people)} new people in the last ${n} days · days are UTC`);
  }, [error, loading, data, cohorts.length, people, n, setStatus, active]);

  const cell = (v, title, key) => {
    const s = shade(v);
    return <td key={key} className="rc" title={title} style={s ? { background: s.bg, color: s.ink } : undefined}>{v == null ? "" : fmtPct(v)}</td>;
  };

  return (
    <>
      <div className="an-bar">
        <span>Look back</span>
        {[7, 8, 14].map((d) => <button key={d} className={`tool-btn${days === d ? " on" : ""}`} onClick={() => setDays(d)}>{d} days</button>)}
        <span className="an-sep" />
        <span className="muted">of the people first seen on a day, the share who came back n days later</span>
      </div>
      <div className="grow scroll">
        {error && !data ? <div className="err">could not load retention: {error}</div> : !data ? <div className="muted pad">…</div> : cohorts.length === 0 ? (
          <div className="muted pad">no new people in the last {n} days — open the demo shop at :3000 and click around; come back tomorrow to see day 1 fill in</div>
        ) : (
          <div className="panel sunken-thin">
            <h4>Cohort retention</h4>
            <div className="scroll">
              <table className="ret">
                <thead><tr><th className="rl">First seen</th><th className="rn">People</th>{cols.map((d) => <th key={d}>Day {d}</th>)}</tr></thead>
                <tbody>
                  <tr className="avg"><td className="rl"><b>All cohorts</b></td><td className="rn"><b>{fmtNum(people)}</b></td>
                    {avg.map((v, d) => cell(v, v == null ? "" : `all cohorts · day ${d}: ${fmtPct(v, 1)} came back (weighted by cohort size)`, d))}
                  </tr>
                  {cohorts.map((c) => (
                    <tr key={c.day}>
                      <td className="rl">{dayLabel(c.day)}</td><td className="rn">{fmtNum(c.size ?? 0)}</td>
                      {cols.map((d) => { const v = c.values?.[d] ?? null; return cell(v, v == null ? "not reached yet" : `${dayLabel(c.day)} cohort · day ${d}: ${fmtNum(Math.round(v * (c.size || 0)))} of ${fmtNum(c.size || 0)} came back (${fmtPct(v, 1)})`, d); })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row muted" style={{ padding: "4px 6px" }}>
              <span>0%</span><span className="ret-ramp">{RAMP.map((c) => <i key={c} style={{ background: c }} />)}</span><span>100%</span>
              <span style={{ marginLeft: 8 }}>blank = that day has not happened yet · hover a cell for the head count</span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Lifecycle (JEV)
function Lifecycle({ defs, defsError, stagesHelp, jevOn, setStatus, active }) {
  const [range, setRange] = useState("7d");
  const [pick, setPick] = useState(null);
  const { data, error, loading } = useApi(`insights/lifecycle?range=${range}`, { every: active ? 15_000 : 0 });
  const stages = (Array.isArray(data?.stages) ? [...data.stages] : []).sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a.stage), ib = STAGE_ORDER.indexOf(b.stage);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const rows = stages.map((s) => ({ k: label(s.stage), n: s.n ?? 0, sub: `· ${fmtNum(s.users ?? 0)} user${s.users === 1 ? "" : "s"}`, stage: s.stage }));
  const list = Array.isArray(defs) ? defs : null;
  const shown = list ? list.filter((d) => !pick || (d.stage || "unclassified") === pick) : [];
  const byJev = list ? list.filter((d) => d.judged_by && !String(d.judged_by).startsWith("heuristic")).length : 0;
  const total = list ? list.reduce((s, d) => s + (d.count || 0), 0) : 0;

  useEffect(() => {
    if (active) setStatus(error && data ? `refresh failed: ${error}` : loading ? "loading…" : list ? `${list.length} event name(s) classified once · ${fmtNum(total)} events covered${list.length ? ` · ${fmtNum(Math.round(total / list.length))} events per judgment` : ""}` : "…");
  }, [error, loading, data, list, total, setStatus, active]);

  return (
    <>
      <div className="an-bar">
        <span>Range</span><RangeButtons value={range} onChange={setRange} />
        <span className="an-sep" />
        {pick ? <button className="btn98 small" onClick={() => setPick(null)}>Show all stages</button> : <span className="muted">click a stage to filter the table</span>}
      </div>
      <div className="grow scroll">
        <div className="muted" style={{ padding: "2px 8px 0" }}>
          JEV classified each event NAME once — its lifecycle stage and whether it is a conversion — and the answer is cached forever, so a million events cost the same as one.
          {jevOn === false ? " No TypeSafe key is configured right now, so a keyword heuristic is standing in (labelled below)." : ""}
        </div>
        <div className="panel sunken-thin">
          <h4>Custom events by lifecycle stage — last {range}</h4>
          {error && !data ? <div className="err">could not load the lifecycle: {error}</div> : !data ? <div className="muted pad">…</div>
            : <BarList rows={rows} onPick={(r) => setPick((p) => (p === r.stage ? null : r.stage))} empty="no custom events in this range — the demo shop at :3000 sends add_to_cart, checkout_started and order_completed" />}
        </div>
        <div className="panel sunken-thin">
          <h4>Event definitions{pick ? ` — ${label(pick)}` : ""}</h4>
          {defsError && !list ? <div className="err">could not load event definitions: {defsError}</div> : !list ? <div className="muted pad">…</div> : (
            <table className="t98">
              <thead><tr><th>Event</th><th className="num">Count</th><th>Stage</th><th className="num">Confidence</th><th>Is conversion</th><th>Last seen</th><th>Judged by</th></tr></thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr><td colSpan={7} className="wrap muted" style={{ textAlign: "center", padding: 16 }}>
                    {list.length ? "no event names in this stage" : "no custom events yet — call signal98.capture(\"order_completed\", { total }) in the host app, or use the demo shop at :3000"}
                  </td></tr>
                ) : shown.map((d) => {
                  const judged = d.judge_status === "judged" && d.stage;
                  const conf = d.classification?.stage_conf;
                  return (
                    <tr key={d.name}>
                      <td className="selectable" title={Object.keys(d.sample_props || {}).length ? `sample properties: ${Object.keys(d.sample_props).join(", ")}` : ""}><b>{d.name}</b></td>
                      <td className="num">{fmtNum(d.count ?? 0)}</td>
                      {judged ? (
                        <>
                          <td title={stagesHelp?.[d.stage] || ""}>{label(d.stage)}</td>
                          <td className="num">{conf == null ? <span className="muted" title="the heuristic does not report a confidence">–</span> : fmtPct(conf)}</td>
                          <td style={{ minWidth: 150 }}><div className="an-conv"><Meter label="" value={d.is_conversion} hint="probability this event is a goal completion (signup, purchase, upgrade)" /></div></td>
                        </>
                      ) : <td colSpan={3}><span className="vtag judging">judging…</span></td>}
                      <td title={d.last_seen ? fmtDateTime(d.last_seen) : ""}>{d.last_seen ? ago(d.last_seen) : "–"}</td>
                      <td>{judged ? <JudgedBy by={d.judged_by} /> : <span className="muted">–</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {list && list.length ? <div className="muted" style={{ padding: "3px 6px" }}>{fmtNum(byJev)} of {fmtNum(list.length)} name(s) judged by JEV{list.length - byJev ? `, ${fmtNum(list.length - byJev)} by the heuristic or still pending` : ""}. The is-conversion bar turns red past 0.7: that event counts as a conversion.</div> : null}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ window
const TABS = [{ id: "trends", t: "Trends" }, { id: "funnels", t: "Funnels" }, { id: "retention", t: "Retention" }, { id: "lifecycle", t: "Lifecycle (JEV)" }];

export default function Insights({ params, nonce }) {
  const [tab, setTab] = useState(TABS.some((t) => t.id === params?.tab) ? params.tab : "trends");
  useEffect(() => { if (TABS.some((t) => t.id === params?.tab)) setTab(params.tab); }, [params?.tab, nonce]);
  const [seen, setSeen] = useState(() => new Set([tab]));
  useEffect(() => { setSeen((s) => (s.has(tab) ? s : new Set(s).add(tab))); }, [tab]);
  const [status, setStatus] = useState("…");
  const defs = useApi("insights/events", { every: 30_000 });
  const meta = useApi("meta");
  const custom = useMemo(() => (Array.isArray(defs.data?.events) ? defs.data.events.map((d) => d.name).filter(Boolean) : []), [defs.data]);

  return (
    <>
      <div className="tabs">
        {TABS.map((t) => <div key={t.id} className={`tab${tab === t.id ? " on" : ""}`} role="tab" tabIndex={0} aria-selected={tab === t.id} onClick={() => setTab(t.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setTab(t.id); }}>{t.t}</div>)}
      </div>
      <div className="tab-body an-tab">
        {TABS.filter((t) => seen.has(t.id) || t.id === tab).map((t) => {
          const active = t.id === tab;
          const common = { setStatus, active };
          return (
            <div key={t.id} className="col grow" style={{ display: active ? "flex" : "none" }}>
              {t.id === "trends" ? <Trends custom={custom} {...common} />
                : t.id === "funnels" ? <Funnels custom={custom} {...common} />
                : t.id === "retention" ? <Retention {...common} />
                : <Lifecycle defs={defs.data?.events} defsError={defs.error} stagesHelp={meta.data?.taxonomy?.stages} jevOn={meta.data?.jev?.enabled} {...common} />}
            </div>
          );
        })}
      </div>
      <div className="statusbar">
        <div className="cell grow sunken-thin">{status}</div>
        <div className="cell sunken-thin">{fmtNum(custom.length)} custom event name(s)</div>
      </div>
    </>
  );
}
