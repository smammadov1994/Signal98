// Small pure helpers: stack parsing, normalization, fingerprinting.

export function parseStack(stack) {
  if (!stack || typeof stack !== "string") return [];
  const frames = [];
  for (const line of stack.split("\n")) {
    const m = line.match(/^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/);
    if (m) {
      frames.push({
        function: (m[1] || "<anonymous>").trim(),
        file: m[2],
        line: Number(m[3]),
        column: Number(m[4]),
      });
    }
  }
  return frames.slice(0, 30);
}

export function normalizeException(input) {
  if (input instanceof Error) {
    return {
      type: input.name || "Error",
      value: input.message || String(input),
      stack: parseStack(input.stack),
    };
  }
  if (typeof input === "string") {
    return { type: "Error", value: input, stack: [] };
  }
  try {
    const asJson = JSON.stringify(input);
    return { type: "Error", value: asJson === undefined ? String(input) : asJson, stack: [] };
  } catch {
    return { type: "Error", value: String(input), stack: [] };
  }
}

// Stable grouping key: type + first line of message + top 3 frames.
// Same crash in the same place -> same fingerprint, like PostHog's
// $exception_fingerprint.
export function fingerprintOf(n) {
  const top = n.stack
    .slice(0, 3)
    .map((f) => `${f.file}:${f.line}`)
    .join("|");
  const base = `${n.type}:${n.value.split("\n")[0].slice(0, 200)}|${top}`;
  let h = 5381;
  for (let i = 0; i < base.length; i++) {
    h = ((h << 5) + h + base.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

export const nowIso = () => new Date().toISOString();

export const uuid = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);
