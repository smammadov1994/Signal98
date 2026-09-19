"use client";
// Recycle Bin (app id `recycle`) — what nobody has to look at:
//   • "in the bin": open issues the judge said to ignore (verdict = ignore)
//   • "ignored":    issues a human ignored, or that were emptied out of the bin
// Restore = reopen + re-judge. Empty = mark every open ignore-verdict issue `ignored`.
// onEmptyChange(count) reports the number of items still IN the bin (the desktop icon uses it).
import { useEffect, useMemo, useState } from "react";
import { api, useApi, ago, fmtNum, label } from "../lib/client";
import { JudgedBy } from "../components/charts";
import { ConfirmDialog, patchIssue, headline, num, useSelection } from "./Issues";

const LIVE = { on: ["verdict", "issue", "event"], every: 15000 };
const VIEWS = [["all", "Everything"], ["bin", "In the bin"], ["ignored", "Ignored"]];

async function inChunks(items, size, fn) {
  let failed = 0;
  for (let i = 0; i < items.length; i += size) {
    const res = await Promise.allSettled(items.slice(i, i + size).map(fn));
    failed += res.filter((r) => r.status === "rejected").length;
  }
  return failed;
}

export default function RecycleBin({ wm, onEmptyChange }) {
  const binQ = useApi("issues?status=open&verdict=ignore&sort=last_seen", LIVE);
  const ignQ = useApi("issues?status=ignored&sort=last_seen", LIVE);
  const [view, setView] = useState("all");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const bin = useMemo(() => (Array.isArray(binQ.data?.issues) ? binQ.data.issues : []), [binQ.data]);
  const ignored = useMemo(() => (Array.isArray(ignQ.data?.issues) ? ignQ.data.issues : []), [ignQ.data]);
  const rows = useMemo(() => {
    const tagged = [...(view !== "ignored" ? bin.map((i) => ({ ...i, _where: "bin" })) : []), ...(view !== "bin" ? ignored.map((i) => ({ ...i, _where: "ignored" })) : [])];
    return tagged.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
  }, [bin, ignored, view]);

  const open = (i) => i && wm?.open?.("issue", { id: i.id });
  const { selId, setSelId, selected, wrapProps } = useSelection(rows, open);

  // Tell the desktop icon how full the bin is — only once we actually know.
  const known = !!binQ.data;
  useEffect(() => { if (known) onEmptyChange?.(bin.length); }, [known, bin.length, onEmptyChange]);

  const reloadAll = () => { binQ.reload(); ignQ.reload(); };
  const restore = async () => {
    if (!selected || busy) return;
    setBusy(true); setNote(null);
    try {
      await patchIssue(selected.id, { status: "open" });
      await api(`issues/${selected.id}/rejudge`, { method: "POST" });
      setNote(`#${selected.id} reopened and sent back to the judge — if it still says IGNORE, it comes back here`);
      reloadAll();
    } catch (err) { setNote(`could not restore #${selected.id}: ${err.message}`); }
    finally { setBusy(false); }
  };
  const empty = async () => {
    setBusy(true); setNote(null);
    const failed = await inChunks(bin, 6, (i) => patchIssue(i.id, { status: "ignored" }));
    setNote(failed ? `${failed} of ${bin.length} could not be updated — try again` : `${bin.length} item(s) marked ignored. Ahh, silence.`);
    setBusy(false); setConfirm(false); reloadAll();
  };

  const error = binQ.error || ignQ.error;
  const loading = (binQ.loading && !binQ.data) || (ignQ.loading && !ignQ.data);
  return (
    <div className="iw-root">
      <div className="toolbar iw-wrap">
        <button className="tool-btn" disabled={!bin.length || busy} onClick={() => setConfirm(true)}>Empty Recycle Bin</button>
        <button className="tool-btn" disabled={!selected || busy} onClick={restore} title="reopen it and have it judged again">Restore</button>
        <button className="tool-btn" disabled={!selected} onClick={() => open(selected)}>Open</button>
        <span className="iw-sep" />
        {VIEWS.map(([k, name]) => <button key={k} className={`tool-btn${view === k ? " on" : ""}`} onClick={() => setView(k)}>{name}</button>)}
        <span className="muted">they bothered no one.</span>
      </div>
      <div className="pane sunken iw-table" style={{ margin: "0 3px 3px" }} {...wrapProps}>
        <table className="t98">
          <thead><tr><th>Why it is here</th><th>Judged by</th><th>Issue</th><th className="num">Noise</th><th>Cause</th><th>Category</th><th className="num">Events</th><th>Last seen</th></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id} className={i.id === selId ? "sel" : ""} onMouseDown={() => setSelId(i.id)} onDoubleClick={() => open(i)}>
                <td>{i._where === "bin" ? <span className="vtag" style={{ color: "#606060", borderColor: "#808080" }}>IGNORE</span> : <span className="tag">ignored by a human</span>}</td>
                <td><JudgedBy by={i.judged_by} /></td>
                <td className="iw-fill" title={`#${i.id} ${headline(i)}`}>{i.type ? <b>{i.type}: </b> : null}{i.title || "(no message)"}{i.culprit ? <span className="muted"> — {i.culprit}</span> : null}</td>
                <td className="num" title="the judge's is_noise answer, 0–1 (see Judged by)">{num(i.classification?.is_noise, 2)}</td>
                <td>{i.cause ? label(i.cause) : <span className="muted">…</span>}</td>
                <td>{i.category ? label(i.category) : <span className="muted">…</span>}</td>
                <td className="num">{fmtNum(i.count)}</td>
                <td>{i.last_seen ? ago(i.last_seen) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          error ? <div className="err">Cannot load the Recycle Bin: {error}. Retrying…</div>
          : loading ? <div className="iw-empty">…</div>
          : <div className="iw-empty">The Recycle Bin is empty. Ahh, silence.<br />Noise the judge filters out (extensions, bots, cancelled requests) and issues you ignore land here.</div>
        )}
      </div>
      <div className="statusbar">
        <div className="cell sunken-thin">{bin.length} in the bin</div>
        <div className="cell sunken-thin">{ignored.length}{ignored.length >= 200 ? "+" : ""} ignored</div>
        <div className="cell grow sunken-thin" style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
          {error && rows.length ? <span style={{ color: "#a00000" }}>API unreachable, showing last known list — {error}</span> : note || "Restore reopens an item and has it judged again"}
        </div>
      </div>
      {confirm && (
        <ConfirmDialog title="Confirm Empty" yes="Yes" no="No" busy={busy} onYes={empty} onNo={() => setConfirm(false)}>
          Mark these <b>{bin.length}</b> item(s) as ignored?<br /><br />
          The judge already decided they do not matter. They stay listed under “Ignored”, stop counting as open issues, and can be restored at any time.
        </ConfirmDialog>
      )}
    </div>
  );
}
