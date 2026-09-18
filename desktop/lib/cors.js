// CORS for the playground (http://localhost:3000) posting into the desktop
// (http://localhost:3001): the SDK uses sendBeacon/fetch with a JSON body,
// and the playground polls this API for the feed. Browsers require explicit
// opt-in for all of that cross-origin traffic.

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function withCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export function optionsResponse() {
  return withCors(new Response(null, { status: 204 }));
}
