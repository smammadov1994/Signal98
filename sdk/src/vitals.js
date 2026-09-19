// Core Web Vitals via PerformanceObserver, reported once when the page is
// first hidden (the only moment LCP / CLS / INP are final). Thresholds are
// the standard web.dev ones.

const THRESHOLDS = {
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

export function rateVital(metric, value) {
  const t = THRESHOLDS[metric];
  if (!t) return undefined;
  return value <= t[0] ? "good" : value <= t[1] ? "needs-improvement" : "poor";
}

// CLS is the worst "session window": shifts less than 1 s apart, 5 s at most.
export function createClsTracker() {
  let max = 0;
  let sum = 0;
  let first = 0;
  let last = 0;
  return (entry) => {
    if (!entry.hadRecentInput) {
      if (sum && (entry.startTime - last > 1000 || entry.startTime - first > 5000)) sum = 0;
      if (!sum) first = entry.startTime;
      sum += entry.value;
      last = entry.startTime;
      max = Math.max(max, sum);
    }
    return max;
  };
}

// INP approximation: the worst interaction latency, skipping one outlier per
// 50 interactions (what web-vitals does, minus its interaction-count polyfill).
// Only the 10 slowest interactions are kept, so memory stays flat.
export function createInpTracker() {
  const worst = new Map(); // interactionId -> longest event duration
  let count = 0;
  return {
    add(entry) {
      const id = entry.interactionId;
      if (!id) return;
      if (!worst.has(id)) count++;
      worst.set(id, Math.max(worst.get(id) || 0, entry.duration));
      if (worst.size > 10) {
        let minId;
        for (const [k, v] of worst) if (minId === undefined || v < worst.get(minId)) minId = k;
        worst.delete(minId);
      }
    },
    value() {
      if (!worst.size) return undefined;
      const sorted = Array.from(worst.values()).sort((a, b) => b - a);
      return sorted[Math.min(sorted.length - 1, Math.floor(count / 50))];
    },
  };
}

export function installVitals({ client, win, guard, cleanups, onHidden }) {
  const PO = win.PerformanceObserver;
  if (!PO) return;
  const values = {};
  const cls = createClsTracker();
  const inp = createInpTracker();
  let reported = false;

  function observe(type, each, extra) {
    try {
      const po = new PO((list) => guard(() => list.getEntries().forEach(each)));
      po.observe({ type, buffered: true, ...extra });
      cleanups.push(() => po.disconnect());
      return true;
    } catch {
      return false; // entry type not supported by this browser
    }
  }

  observe("largest-contentful-paint", (e) => (values.LCP = e.startTime));
  observe("paint", (e) => {
    if (e.name === "first-contentful-paint") values.FCP = e.startTime;
  });
  // A page with no shifts has a CLS of 0, which is worth reporting — but only
  // where the browser can measure it at all.
  if (observe("layout-shift", (e) => (values.CLS = cls(e)))) values.CLS = 0;
  observe("event", (e) => inp.add(e), { durationThreshold: 40 });

  onHidden.push(() => {
    if (reported) return;
    reported = true;
    const nav = win.performance && win.performance.getEntriesByType && win.performance.getEntriesByType("navigation")[0];
    if (nav && nav.responseStart > 0) values.TTFB = Math.max(0, nav.responseStart - (nav.activationStart || 0));
    values.INP = inp.value();
    for (const metric of Object.keys(THRESHOLDS)) {
      const v = values[metric];
      if (typeof v !== "number" || !isFinite(v)) continue;
      const $value = metric === "CLS" ? Math.round(v * 10000) / 10000 : Math.round(v);
      client.capture("$web_vitals", { $metric: metric, $value, $rating: rateVital(metric, $value) });
    }
  });
}
