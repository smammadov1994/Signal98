"use client";
// The home screen: is anything on fire, how busy are we, what should I look at first.
// Everything here links into the window that owns the detail.
import { useApi, fmtNum, fmtUsd, fmtPct, ago, label, VERDICTS } from "../lib/client";
import { LineChart, StatTile, BarList, VerdictTag, JudgedBy, Spark } from "../components/charts";

const toSeries = (name, trend) => [{ name, points: (trend?.series || []).map((p) => ({ t: p.t, v: p.n })) }];

export default function Overview({ wm }) {
  const ov = useApi("overview", { every: 10_000, on: ["verdict", "issue"] });
  const issues = useApi("issues?status=open&sort=priority", { every: 20_000, on: ["verdict", "issue"] });
  const events = useApi("insights/trend?event=*&range=24h", { every: 30_000, on: ["event"] });
  const errors = useApi("insights/trend?event=$exception&range=24h", { every: 30_000, on: ["event"] });
  const web = useApi("web?range=24h", { every: 30_000 });

  const o = ov.data;
  const jev = o?.jev;
  const open = o?.open_issues || {};
  const top = (issues.data?.issues || []).slice(0, 7);
  const verdictRows = ["page", "notify", "ticket", "ignore"].map((v) => ({ k: VERDICTS[v].label, n: open[v] || 0, sub: VERDICTS[v].hint })).filter((r) => r.n > 0);

  if (ov.error && !o) return <div className="err">Can&apos;t reach the backend: {ov.error}</div>;

  return (
    <div className="ov-root grow scroll">
      <div className="stats">
        <StatTile label="need a page" value={o ? fmtNum(o.unread_pages) : "…"} tone={o?.unread_pages ? VERDICTS.page.color : undefined} sub={o?.unread_pages ? "open issues JEV would wake someone for" : "nobody needs to wake up"} />
        <StatTile label="open issues" value={o ? fmtNum(Object.values(open).reduce((s, n) => s + n, 0)) : "…"} sub={open.judging ? `${open.judging} being judged` : "all judged"} />
        <StatTile label="events · 24 h" value={o ? fmtNum(o.events_24h) : "…"} sub={o ? `${fmtNum(o.events_last_minute)} in the last minute` : ""} />
        <StatTile label="people · 24 h" value={o ? fmtNum(o.users_24h) : "…"} sub={o ? `${fmtNum(o.sessions_24h)} sessions` : ""} />
        <StatTile label="bounce rate" value={web.data ? fmtPct(web.data.totals.bounce_rate) : "…"} sub={web.data ? `${fmtNum(web.data.totals.pageviews)} pageviews` : ""} />
      </div>

      <div className="grid2">
        <div className="panel"><h4>All events per hour</h4><div className="pad"><LineChart series={toSeries("Events", events.data)} bucket={events.data?.bucket} height={130} area /></div></div>
        <div className="panel"><h4>Exceptions per hour</h4><div className="pad"><LineChart series={toSeries("Exceptions", errors.data)} bucket={errors.data?.bucket} height={130} area /></div></div>
      </div>

      <div className="ov-split">
        <div className="panel ov-main">
          <h4>Look at these first <button className="iw-link ov-more" onClick={() => wm.open("issues")}>all issues →</button></h4>
          {issues.loading && !top.length ? <div className="muted pad">…</div> : top.length === 0 ? (
            <div className="muted pad">No open issues. Break something in the demo shop (:3000) and it will show up here within a second.</div>
          ) : (
            <table className="t98">
              <thead><tr><th>Verdict</th><th className="num">Pri</th><th>Issue</th><th>Area</th><th className="num">Events</th><th>24 h</th><th>Last seen</th></tr></thead>
              <tbody>
                {top.map((i) => (
                  <tr key={i.id} onClick={() => wm.open("issue", { id: i.id })} style={{ cursor: "pointer" }}>
                    <td><VerdictTag issue={i} /></td>
                    <td className="num">{i.priority ?? "–"}</td>
                    <td className="wrap"><b>{i.type ? `${i.type}: ` : ""}</b>{i.title}<div className="muted mono">{i.culprit || ""}</div></td>
                    <td>{label(i.category) || "…"}</td>
                    <td className="num">{fmtNum(i.count)}</td>
                    <td><Spark values={i.spark} /></td>
                    <td>{ago(i.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="ov-side">
          <div className="panel"><h4>Open issues by verdict</h4><BarList rows={verdictRows} empty="nothing open" onPick={() => wm.open("issues")} /></div>
          <div className="panel">
            <h4>Classifier <button className="iw-link ov-more" onClick={() => wm.open("settings", { tab: "jev" })}>details →</button></h4>
            <dl className="iw-kv">
              <dt>judging with</dt><dd>{jev ? <JudgedBy by={jev.enabled ? jev.model : "heuristic"} /> : "…"}</dd>
              {jev && !jev.enabled && <><dt /><dd className="muted">No TYPESAFE_API_KEY yet — a labelled keyword heuristic is standing in for JEV.</dd></>}
              <dt>requests today</dt><dd>{jev ? fmtNum(jev.today.requests) : "…"}{jev?.today.heuristic ? <span className="muted"> · {fmtNum(jev.today.heuristic)} heuristic</span> : null}</dd>
              <dt>events per request</dt><dd>{jev?.leverage ? `${jev.leverage.toFixed(1)}×` : "–"} <span className="muted">(issues are judged, not events)</span></dd>
              <dt>cost · 30 d</dt><dd>{jev ? fmtUsd(jev.cost_30d_usd) : "…"}</dd>
            </dl>
          </div>
          <div className="panel"><h4>Top pages · 24 h</h4><BarList rows={web.data?.pages?.slice(0, 5) || []} empty="no pageviews yet" onPick={() => wm.open("web")} /></div>
        </div>
      </div>
    </div>
  );
}
