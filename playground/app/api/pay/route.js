// The shop's payment endpoint. Large orders take the "fraud review" branch, which was
// never finished: it reads a config value that does not exist.
const config = { limits: { review: 10_000 } };

export async function POST(req) {
  const { total } = await req.json();
  if (total > config.limits.review) {
    const reviewer = config.fraud.reviewer; // TypeError: config.fraud is undefined → 500
    return Response.json({ ok: false, reviewer }, { status: 202 });
  }
  await new Promise((r) => setTimeout(r, 300));
  return Response.json({ ok: true, order: `GM-${Date.now().toString(36).toUpperCase()}` });
}
