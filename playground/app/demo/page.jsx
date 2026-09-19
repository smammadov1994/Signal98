"use client";
import { useState } from "react";
import { captureException, getClient } from "signal98";
export default function GuidedDemo() {
  const [state, setState] = useState("ready");
  const trigger = async () => {
    setState("sending");
    // A caught exception goes through the same SDK pipeline as any app error.
    try { throw new Error("Demo checkout: payment service unavailable"); }
    catch (error) { captureException(error, { demo: "guided-checkout" }); }
    try { await getClient()?.flush(); setState("sent"); }
    catch { setState("retry"); }
  };
  return <div className="card wide guided-demo"><span className="demo-step">SIGNAL 98 · INTERACTIVE DEMO</span><h1>You trigger it. We catch it.</h1><p>This button creates one test checkout error. It uses the shop’s real monitoring SDK. Nothing is charged and this page stays open.</p><ol><li>Start a fresh demo on the dashboard.</li><li>Press the button below once.</li><li>Return to the dashboard to see the error arrive.</li></ol><button className="btn block" disabled={state === "sending"} onClick={trigger}>{state === "sending" ? "Sending test error…" : state === "sent" ? "Trigger it again" : "Trigger checkout error"}</button>{state === "sent" && <div className="demo-error" role="status"><strong>Test error triggered.</strong><p>Open the dashboard to confirm it arrived. Classification may take a few seconds.</p></div>}{state === "retry" && <p role="alert">Couldn’t send the test error. Check that the monitor is running and try again.</p>}<a className="demo-return" href="http://localhost:3001/">Back to Signal 98 dashboard →</a><small>This is a test scenario, not an actual payment failure.</small></div>;
}
