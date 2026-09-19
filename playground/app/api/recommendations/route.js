// Deliberately slow: the SDK reports requests slower than `slowRequestMs` as $network_error { $slow: true }.
export async function GET() {
  await new Promise((r) => setTimeout(r, 5200));
  return Response.json({ items: ["sheet", "chains"] });
}
