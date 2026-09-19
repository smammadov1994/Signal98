"use client";
// Chart kit for the Win98 monitor. Hand-rolled SVG, no chart library.
// House rules (dataviz skill): one y-axis, thin marks, recessive grid, a legend whenever
// there are ≥ 2 series, hover tooltips everywhere, text in ink colours — never series colours.
// Win98 twist: square pixel-crisp ends instead of rounded ones, white sunken plot surface.
import { useEffect, useRef, useState } from "react";
import { SERIES, VERDICTS, fmtNum } from "../lib/client";

const INK = "#000", MUTED = "#6b6b6b", GRID = "#e4e4e4", AXIS = "#9a9a9a";

export function useWidth(initial = 400) {
  const ref = useRef(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const tickTime = (t, bucket) => {
  const d = new Date(t);
  if (bucket >= 86_400_000) return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
};

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

// series: [{ name, points: [{ t, v }] }]  — all series share the same t values
export function LineChart({ series = [], height = 160, bucket = 3_600_000, area = false, unit = "" }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const pad = { l: 34, r: 8, t: 8, b: 18 };
  const W = width, H = height, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const pts = series[0]?.points || [];
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.v))));
  const x = (i) => pad.l + (pts.length <= 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = (v) => pad.t + ih - (v / max) * ih;
  const empty = !pts.length || series.every((s) => s.points.every((p) => !p.v));

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - pad.l) / iw) * (pts.length - 1));
    setHover(Math.max(0, Math.min(pts.length - 1, i)));
  };
  const xticks = pts.length ? [0, Math.floor((pts.length - 1) / 2), pts.length - 1].filter((v, i, a) => a.indexOf(v) === i) : [];

  return (
    <div ref={ref} className="chart">
      {series.length > 1 && <Legend items={series.map((s, i) => ({ name: s.name, color: SERIES[i % SERIES.length] }))} />}
      <div style={{ position: "relative" }}>
        <svg width={W} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: "block" }} shapeRendering="crispEdges">
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke={f === 0 ? AXIS : GRID} />
              <text x={pad.l - 4} y={y(max * f) + 3} textAnchor="end" fontSize="9" fill={MUTED}>{fmtNum(max * f)}</text>
            </g>
          ))}
          {xticks.map((i) => (
            <text key={i} x={x(i)} y={H - 4} fontSize="9" fill={MUTED} textAnchor={i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}>{tickTime(pts[i].t, bucket)}</text>
          ))}
          {!empty && series.map((s, si) => {
            const c = SERIES[si % SERIES.length];
            const d = s.points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
            return (
              <g key={s.name} shapeRendering="geometricPrecision">
                {area && series.length === 1 && <path d={`${d}L${x(pts.length - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill={c} opacity="0.12" />}
                <path d={d} fill="none" stroke={c} strokeWidth="2" strokeLinejoin="round" />
              </g>
            );
          })}
          {hover != null && !empty && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke={INK} strokeDasharray="1 2" />
              {series.map((s, si) => <rect key={si} x={x(hover) - 3} y={y(s.points[hover]?.v || 0) - 3} width="6" height="6" fill={SERIES[si % SERIES.length]} stroke="#fff" />)}
            </g>
          )}
          {empty && <text x={W / 2} y={H / 2} textAnchor="middle" fontSize="11" fill={MUTED}>no data in this range yet</text>}
        </svg>
        {hover != null && !empty && (
          <div className="chart-tip" style={{ left: Math.min(W - 150, Math.max(0, x(hover) + 8)), top: 4 }}>
            <div style={{ color: MUTED }}>{bucket >= 86_400_000
              ? `${tickTime(pts[hover].t, bucket)} (UTC day)`
              : new Date(pts[hover].t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</div>
            {series.map((s, si) => (
              <div key={s.name} className="tip-row"><i style={{ background: SERIES[si % SERIES.length] }} />{s.name}<b>{fmtNum(s.points[hover]?.v ?? 0)}{unit}</b></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function Legend({ items }) {
  return (
    <div className="chart-legend">
      {items.map((it) => <span key={it.name}><i style={{ background: it.color }} />{it.name}</span>)}
    </div>
  );
}

// Tiny inline trend for table rows. values: number[]
export function Spark({ values = [], width = 72, height = 18, color = "#2a78d6" }) {
  const max = Math.max(1, ...values);
  const bw = width / Math.max(1, values.length);
  return (
    <svg width={width} height={height} shapeRendering="crispEdges" style={{ display: "block" }}>
      <title>{`last 24 h, peak ${max}/h`}</title>
      <line x1="0" x2={width} y1={height - 0.5} y2={height - 0.5} stroke={GRID} />
      {values.map((v, i) => v > 0 && <rect key={i} x={i * bw} y={height - Math.max(2, (v / max) * (height - 1))} width={Math.max(1, bw - 1)} height={Math.max(2, (v / max) * (height - 1))} fill={color} />)}
    </svg>
  );
}

// Ranked horizontal bars: [{ k, n, sub? }]. One hue (magnitude, not identity).
export function BarList({ rows = [], color = "#2a78d6", format = fmtNum, empty = "nothing yet", onPick }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  if (!rows.length) return <div className="muted pad">{empty}</div>;
  return (
    <div className="barlist">
      {rows.map((r) => (
        <div key={String(r.k)} className={`barrow${onPick ? " pick" : ""}`} onClick={onPick ? () => onPick(r) : undefined} title={`${r.k}: ${format(r.n)}`}>
          <div className="bar" style={{ width: `${Math.max(1.5, (r.n / max) * 100)}%`, background: color }} />
          <span className="k">{String(r.k)}</span>
          <span className="v">{format(r.n)}{r.sub ? <em> {r.sub}</em> : null}</span>
        </div>
      ))}
    </div>
  );
}

// A probability (0–1) or score as a labelled bar. Status colour only past `hot`.
export function Meter({ label, value, max = 1, hot = 0.7, digits = 2, hint }) {
  const v = value == null ? null : Math.max(0, Math.min(max, value));
  const ratio = v == null ? 0 : v / max;
  const color = ratio >= hot ? "#d03b3b" : ratio >= hot * 0.6 ? "#b86a00" : "#2a78d6";
  return (
    <div className="meter" title={hint || ""}>
      <span className="ml">{label}</span>
      <span className="mt sunken-thin"><i style={{ width: `${ratio * 100}%`, background: color }} /></span>
      <span className="mv">{v == null ? "–" : v.toFixed(digits)}{max !== 1 ? `/${max}` : ""}</span>
    </div>
  );
}

export function StatTile({ label, value, sub, tone }) {
  return (
    <div className="stat sunken">
      <div className="sv" style={tone ? { color: tone } : undefined}>{value}</div>
      <div className="sl">{label}</div>
      {sub ? <div className="ss">{sub}</div> : null}
    </div>
  );
}

// steps: [{ label, count, conversion, step_conversion, median_ms }]
export function FunnelChart({ steps = [] }) {
  const max = Math.max(1, steps[0]?.count || 0);
  return (
    <div className="funnel">
      {steps.map((s, i) => (
        <div key={i} className="frow">
          <div className="fl"><b>{i + 1}.</b> {s.label}</div>
          <div className="ft sunken-thin"><i style={{ width: `${(s.count / max) * 100}%` }} /></div>
          <div className="fv"><b>{fmtNum(s.count)}</b> · {(s.conversion * 100).toFixed(0)}%{i > 0 && <em> ({(s.step_conversion * 100).toFixed(0)}% of prev)</em>}</div>
        </div>
      ))}
    </div>
  );
}

export function VerdictTag({ issue }) {
  if (!issue) return null;
  if (issue.judge_status && issue.judge_status !== "judged") return <span className="vtag judging">judging…</span>;
  if (issue.status === "resolved") return <span className="vtag resolved">RESOLVED</span>;
  const v = VERDICTS[issue.verdict];
  if (!v) return <span className="vtag judging">judging…</span>;
  return <span className="vtag" style={{ color: v.color, borderColor: v.color }} title={v.hint}>{v.label}</span>;
}

// Who judged: the honest label. JEV model id, or "heuristic".
export function JudgedBy({ by }) {
  if (!by) return null;
  const jev = !String(by).startsWith("heuristic");
  return <span className={`judgedby ${jev ? "jev" : "heur"}`} title={jev ? "classified by JEV" : "no TypeSafe key (or JEV unreachable): a local keyword heuristic judged this"}>{jev ? `JEV · ${by}` : by}</span>;
}
