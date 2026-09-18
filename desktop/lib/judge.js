// Judges one captured event: urgent? user-facing? novel?
// Uses the real JEV API when TYPESAFE_API_KEY is set, otherwise falls back
// to a local keyword heuristic so the playground works with zero config.

const RULE = { urgent: 0.7, userFacing: 0.6, novelty: 0.55 };

function verdictOf(urgent, userFacing, novelty) {
  return urgent >= RULE.urgent && userFacing >= RULE.userFacing && novelty >= RULE.novelty
    ? "paged"
    : "suppressed";
}

function describe(evt) {
  const first = evt.properties?.$exception_list?.[0];
  if (first) return `${first.type}: ${first.value}`;
  const props = evt.properties ? ` ${JSON.stringify(evt.properties).slice(0, 120)}` : "";
  return `${evt.event}${props}`;
}

// --- heuristic stand-in (no key needed) ---
export function judgeHeuristic(evt) {
  const text = describe(evt).toLowerCase();
  const urgent = /uncaught|unhandled|crash|failed|timeout|declined|500|error|throw/.test(text) ? 0.8 : 0.35;
  const userFacing = /user|payment|checkout|login|render|profile|page|click|signup/.test(text) ? 0.8 : 0.3;
  const novelty = 0.6;
  return {
    urgent,
    userFacing,
    novelty,
    verdict: verdictOf(urgent, userFacing, novelty),
    judgedBy: "heuristic",
  };
}

// --- real JEV judgment via TypeSafe System One ---
export async function judgeWithJEV(evt, apiKey) {
  const summary = describe(evt);
  const mechanism = evt.properties?.$exception_list?.[0]?.mechanism?.type || "manual";
  const state =
    `An application event was captured by the signal98 error-tracking SDK.\n` +
    `Event: ${summary}\n` +
    `Capture mechanism: ${mechanism} (unhandled = the error escaped the app; handled = it was caught).\n` +
    `Judge this event for on-call paging: should it wake someone up?`;

  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "jev-latest",
      state,
      questions: {
        is_urgent: {
          type: "noul",
          instructions: "Is this urgent — does it need attention right now?",
          criteria: {
            true: "Something is broken or failing and needs immediate attention",
            false: "Routine, informational, or can wait",
          },
        },
        is_user_facing: {
          type: "noul",
          instructions: "Does this affect end users' experience?",
          criteria: {
            true: "Users directly feel this: broken page, failed payment/login/signup, crash on a user screen",
            false: "Internal or background only; users notice nothing",
          },
        },
        is_novel: {
          type: "noul",
          instructions: "Is this new or unusual, as opposed to routine noise?",
          criteria: {
            true: "New, unusual, or unexpected",
            false: "Routine, expected, or repetitive noise",
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`JEV request failed: ${res.status}`);
  const data = await res.json();
  const urgent = data.answers.is_urgent.noul;
  const userFacing = data.answers.is_user_facing.noul;
  const novelty = data.answers.is_novel.noul;
  return {
    urgent,
    userFacing,
    novelty,
    verdict: verdictOf(urgent, userFacing, novelty),
    judgedBy: "jev",
  };
}

export async function judgeEvent(evt) {
  const key = process.env.TYPESAFE_API_KEY;
  if (key) {
    try {
      return await judgeWithJEV(evt, key);
    } catch {
      return judgeHeuristic(evt); // JEV hiccup -> still judge, honestly labeled
    }
  }
  return judgeHeuristic(evt);
}
