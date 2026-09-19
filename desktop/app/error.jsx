"use client";
export default function MonitorError({ reset }) {
  return <main style={{ padding: "10vh 8vw", fontFamily: "system-ui, sans-serif", background: "#f7f8fa", color: "#35414c", height: "100vh" }}><p style={{ fontSize: 13, marginBottom: 15 }}>SIGNAL 98</p><h1 style={{ fontSize: 28, marginBottom: 15 }}>This view couldn’t load.</h1><p style={{ fontSize: 15, lineHeight: 1.7, marginBottom: 24 }}>There was a problem displaying the dashboard. You can retry or return to the dashboard home.</p><button onClick={reset} style={{ padding: "12px 20px", border: 0, borderRadius: 6, color: "white", background: "#5748b2", fontSize: 14, marginRight: 20 }}>Try again</button><a href="/" style={{ fontSize: 14, color: "#5748b2" }}>Dashboard home</a></main>;
}
