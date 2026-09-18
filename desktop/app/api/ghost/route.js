import { getGhost } from "../../../lib/ghosts";

export const dynamic = "force-dynamic";

// POST { variantId, events } -> the chosen ghost (classic LLM, DeepSeek)
// does its thing and returns a fix report. Without DEEPSEEK_API_KEY the
// ghost "dreams": it returns a deterministic template plan instead.
function templateFixes(variant, events) {
  return events.map((e) => {
    const m = e.message.toLowerCase();
    if (m.includes("login")) {
      return {
        event: e.message,
        diagnosis:
          "auth service throwing 500s at a 34% error rate. Smells like a bad deploy or a saturated session store, not credential issues.",
        steps: [
          "Roll back auth to the previous deploy and watch the error rate for 5 minutes.",
          "Check session-store / DB connection pool saturation and slow queries.",
          "If the rollback heals it, diff the deploy for auth-path changes.",
        ],
        patch: "# roll back auth\nkubectl rollout undo deploy/auth\n# watch the error rate\nwatch -n 5 \"curl -s -o /dev/null -w '%{http_code}' https://api.internal/v1/login\"",
      };
    }
    if (m.includes("payout")) {
      return {
        event: e.message,
        diagnosis:
          "payout path failing after a run of payout rejections. Likely a downstream provider issue or a broken deploy in the payments service.",
        steps: [
          "Pause the payout worker queue to stop the bleed.",
          "Check the payment provider status page and recent deploys of the payments service.",
          "Replay one failed payout manually to capture the real error.",
        ],
        patch: "# pause payouts\nredis-cli set payouts:paused 1\n# tail the failures\nkubectl logs -l app=payments --tail=200 | grep -i payout",
      };
    }
    if (m.includes("disk")) {
      return {
        event: e.message,
        diagnosis:
          "/var at 91% on a worker. Usually runaway logs or unrotated artifacts, not real data growth.",
        steps: [
          "Find the top disk hogs on /var and confirm they are logs or tmp artifacts.",
          "Rotate/truncate the offending logs and verify logrotate is actually running.",
          "Add a disk-usage alert at 80% so this never surprises anyone again.",
        ],
        patch: "# find the hogs\ndu -xh /var 2>/dev/null | sort -rh | head\n# rotate now\nlogrotate -f /etc/logrotate.conf",
      };
    }
    return {
      event: e.message,
      diagnosis: `${variant.name} notes "${e.message}" (severity ${e.judgments.severity.toFixed(2)}). Correlate with deploys in the last hour.`,
      steps: [
        "Check for a deploy or config change in the 30 minutes before the first occurrence.",
        "Pull the full trace for one occurrence and look for the first failing span.",
        "If user-facing, prepare a rollback before digging deeper.",
      ],
      patch: "",
    };
  });
}

export async function POST(req) {
  const { variantId, events } = await req.json();
  const variant = getGhost(variantId);
  const key = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";

  if (!key) {
    return Response.json({
      offline: true,
      variant,
      fixes: templateFixes(variant, events),
      fixedCount: events.length,
    });
  }

  const userPrompt =
    `Incidents to handle (JSON, each with JEV semantic judgments):\n` +
    JSON.stringify(events, null, 2) +
    `\n\nYour permissions: ${variant.permissions.join(", ")}. Stay inside them. ` +
    `Output a fix report: per incident, diagnosis, concrete fix steps, and exact snippets/commands where useful.`;

  try {
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: variant.temperature,
        max_tokens: variant.maxTokens,
        messages: [
          { role: "system", content: variant.systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!r.ok) throw new Error(`deepseek ${r.status}`);
    const data = await r.json();
    const report = data.choices?.[0]?.message?.content || "(empty response)";
    return Response.json({ offline: false, variant, report, fixedCount: events.length });
  } catch (err) {
    return Response.json({
      offline: true,
      variant,
      fixes: templateFixes(variant, events),
      fixedCount: events.length,
      error: String(err),
    });
  }
}
