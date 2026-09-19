// JEV client (TypeSafe System One). One function: ask(state, questions) → answers.
//
// What makes it production-shaped:
//   • every judgment about one subject goes in ONE request (JEV reads the state once and
//     answers all questions in parallel — that is the whole cost model)
//   • bounded concurrency + a requests-per-minute pacer that stays under the account limit
//   • timeout, exponential backoff with jitter, Retry-After honoured on 429 / 529
//   • circuit breaker: after repeated failures callers fall back to the heuristic for a
//     while instead of queueing behind a dead upstream
//   • answers are validated against the questions, so a malformed reply can never leak through
import { sleep } from "./util.js";
import { bumpUsage } from "./db.js";

const URL_ = process.env.TYPESAFE_API_URL || "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = process.env.JEV_MODEL || "jev-latest";
export const JEV_USD_PER_MTOK = 0.042; // input tokens only; output is free (docs.typesafe.ai/models)

const MAX_CONCURRENT = Number(process.env.JEV_MAX_CONCURRENT || 6);
const MAX_RPM = Number(process.env.JEV_MAX_RPM || 600); // half the documented 1,200 rpm limit
const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS || 10_000);
const MAX_ATTEMPTS = 4;

function st() {
  return (globalThis.__s98_jev ||= {
    active: 0, waiters: [], stamps: [],
    failures: 0, openUntil: 0,
    lastError: null, lastOkAt: 0, lastLatencyMs: null, resolvedModel: null,
  });
}

export const jevEnabled = () => !!process.env.TYPESAFE_API_KEY;

export function jevStatus() {
  const s = st();
  return {
    enabled: jevEnabled(),
    model: s.resolvedModel || JEV_MODEL,
    circuit: Date.now() < s.openUntil ? "open" : "closed",
    lastError: s.lastError,
    lastOkAt: s.lastOkAt || null,
    lastLatencyMs: s.lastLatencyMs,
    inFlight: s.active,
    queued: s.waiters.length,
  };
}

async function acquire() {
  const s = st();
  if (s.active >= MAX_CONCURRENT) await new Promise((r) => s.waiters.push(r));
  s.active++;
  // pacing: at most MAX_RPM request starts in any rolling minute
  for (;;) {
    const now = Date.now();
    while (s.stamps.length && now - s.stamps[0] > 60_000) s.stamps.shift();
    if (s.stamps.length < MAX_RPM) break;
    await sleep(60_000 - (now - s.stamps[0]) + 5);
  }
  s.stamps.push(Date.now());
}

function release() {
  const s = st();
  s.active--;
  const next = s.waiters.shift();
  if (next) next();
}

export class JevUnavailable extends Error {}

function validate(questions, answers) {
  if (!answers || typeof answers !== "object") throw new Error("JEV reply has no answers");
  for (const [id, qn] of Object.entries(questions)) {
    const a = answers[id];
    if (!a) throw new Error(`JEV reply is missing "${id}"`);
    if (qn.type === "noul" && !(a.noul >= 0 && a.noul <= 1)) throw new Error(`bad noul for "${id}"`);
    if (qn.type === "choice" && !(a.choice in qn.criteria)) throw new Error(`bad choice for "${id}"`);
    if (qn.type === "score" && !(a.score >= 0 && a.score <= qn.criteria.length - 1 + 1e-6)) throw new Error(`bad score for "${id}"`);
  }
}

export async function ask(state, questions, { projectId = 0, signal } = {}) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new JevUnavailable("TYPESAFE_API_KEY is not set");
  const s = st();
  if (Date.now() < s.openUntil) throw new JevUnavailable("JEV circuit breaker is open");

  const body = JSON.stringify({ model: JEV_MODEL, state, questions });
  let lastErr;
  await acquire();
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      signal?.addEventListener("abort", () => ctl.abort(), { once: true });
      const t0 = Date.now();
      let retryAfterMs = 0;
      try {
        const res = await fetch(URL_, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body,
          signal: ctl.signal,
        });
        if (res.ok) {
          const data = await res.json();
          validate(questions, data.answers);
          s.failures = 0;
          s.lastOkAt = Date.now();
          s.lastLatencyMs = Date.now() - t0;
          s.lastError = null;
          s.resolvedModel = data.model || s.resolvedModel;
          bumpUsage(projectId, { requests: 1, input_tokens: data.usage?.input_tokens || 0 });
          return { answers: data.answers, usage: data.usage || {}, model: data.model, latencyMs: s.lastLatencyMs };
        }
        const text = await res.text().catch(() => "");
        lastErr = new Error(`JEV ${res.status}: ${text.slice(0, 200)}`);
        // 401 / 422 are our bug or a bad key: retrying cannot help.
        if (![408, 429, 500, 502, 503, 504, 529].includes(res.status)) {
          lastErr.fatal = true;
          lastErr.auth = res.status === 401 || res.status === 403;
          break;
        }
        const ra = Number(res.headers.get("retry-after"));
        if (ra > 0) retryAfterMs = Math.min(ra * 1000, 30_000);
      } catch (err) {
        lastErr = err.name === "AbortError" ? new Error(`JEV timed out after ${TIMEOUT_MS} ms`) : err;
        if (signal?.aborted) break;
      } finally {
        clearTimeout(timer);
      }
      if (attempt < MAX_ATTEMPTS) {
        const backoff = Math.min(8000, 400 * 2 ** (attempt - 1));
        await sleep(Math.max(retryAfterMs, backoff / 2 + Math.random() * (backoff / 2)));
      }
    }
  } finally {
    release();
  }
  s.failures++;
  s.lastError = String(lastErr?.message || lastErr);
  bumpUsage(projectId, { failures: 1 });
  // A bad key trips the breaker at once and for longer: there is no point hammering a 401.
  // (A 422 is a malformed question set — our bug, scoped to one caller — so it does not.)
  if (lastErr?.auth) s.openUntil = Date.now() + 120_000;
  else if (s.failures >= 5 && !lastErr?.fatal) s.openUntil = Date.now() + 30_000;
  throw lastErr;
}

// A setup probe uses the candidate key without replacing the working classifier key.
export async function verifyJevKey(key, projectId) {
  const questions = { connected: { type: "noul", instructions: "Does the state describe a Signal98 connection test?", criteria: {true:"The purpose explicitly says Signal98 connection test.",false:"The purpose describes something else."} } };
  const start = Date.now();
  let response;
  try {
    response = await fetch(URL_, {method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},signal:AbortSignal.timeout(12000),body:JSON.stringify({model:JEV_MODEL,state:{purpose:"Signal98 connection test"},questions})});
  } catch { throw new JevUnavailable("Could not reach JEV. Check the server connection and try again."); }
  if (!response.ok) {
    if ([401,403].includes(response.status)) throw new JevUnavailable("JEV did not accept that key. Check the key and its account access.");
    if (response.status===429) throw new JevUnavailable("JEV is rate limited. Please try again shortly.");
    throw new JevUnavailable(`JEV connection check failed (HTTP ${response.status}). Please try again.`);
  }
  let data;
  try { data=await response.json();validate(questions,data.answers); } catch { throw new JevUnavailable("JEV returned an unexpected response. The key has not been saved."); }
  bumpUsage(projectId,{requests:1,input_tokens:data.usage?.input_tokens || 0});
  return {model:data.model || JEV_MODEL,latencyMs:Date.now()-start};
}
export function recordJevConnection(result) {
  const s=st();s.failures=0;s.openUntil=0;s.lastError=null;s.lastOkAt=Date.now();s.lastLatencyMs=result.latencyMs;s.resolvedModel=result.model;
}
