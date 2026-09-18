"use client";

export default function Readme() {
  return (
    <>
      <div className="menubar"><span>File</span><span>Edit</span><span>Search</span><span>Help</span></div>
      <div className="notepad sunken">
        <h3>signal.txt — what is this?</h3>
        <p>
          signal is a toy for a different kind of observability. Traditional alerting
          (Datadog, PagerDuty) watches <b>metrics</b> and fires when a hand-tuned
          threshold breaks. That gives you alert fatigue: static rules can&apos;t tell a
          real incident from noise that happens to look spiky.
        </p>
        <p>
          signal flips it: every log event is judged by <b>JEV</b> (TypeSafe&apos;s System
          One model) the moment it arrives. JEV returns typed judgments —{" "}
          <code>is_urgent?</code> <code>is_user_facing?</code> <code>is_novel?</code>{" "}
          <code>severity</code> — as probabilities, in real time. Paging becomes a
          small routing rule <b>over meaning</b>, not over metrics:
        </p>
        <p><code>page when urgent ≥ 0.70 and user-facing ≥ 0.60 and novel ≥ 0.55</code></p>
        <h3>the folders on this desktop</h3>
        <p>
          <b>JEV Verdicts</b> — every trace with its JEV classification values.
          Sort by any column. Filter to Paged or Suppressed.<br />
          <b>Raw Feed</b> — watch events get judged as they arrive.<br />
          <b>Pages</b> — the 3 events that crossed the rule, with the receipts.<br />
          <b>Recycle Bin</b> — the 13 suppressed alerts. Deleted. Bothering no one.
        </p>
        <h3>the interesting bit</h3>
        <p>
          <code>disk usage 91% on /var</code> scored urgent 0.71 and novel 0.73 —
          a threshold alerter pages you for this. But user-facing was 0.26, so
          signal suppressed it. That&apos;s the whole idea: the system distinguishes{" "}
          <i>&ldquo;something is wrong&rdquo;</i> from <i>&ldquo;something is wrong and users feel it&rdquo;</i>.
        </p>
        <h3>the ghost</h3>
        <p>
          The little 8-bit ghost on the desktop is the fixer. <b>Drag it and drop
          it</b> onto Pages, JEV Verdicts, or the Recycle Bin. JEV looks at the
          semantic judgments of whatever you dropped it on and <b>routes</b> — it
          picks one of 10 ghost versions (SLEUTH, PATCHER, WATCHER, ORACLE,
          QUARANTINE, SCRIBE, HERALD, JANITOR, SURGEON, DREAMER), each with its
          own permissions, system prompt, and color. The ghost asks if you want it
          unleashed; say yes and it fixes the issues (classic LLM under the hood —
          DeepSeek — JEV only chooses <i>which</i> ghost shows up). Fixed issues get
          marked <b>EXORCISED</b>.
        </p>
      </div>
    </>
  );
}
