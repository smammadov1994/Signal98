// Server half of the integration. The browser SDK (app/signal.jsx) cannot see a crash that
// happens while Next renders on the SERVER: the user gets a 500 and no client code ever runs.
// Next calls `onRequestError` for every such failure — server components, the server render of
// client components, route handlers, server actions — so this is where they get reported,
// with the real server stack (the true throw site, which is what a fixer needs).
const HOST = process.env.NEXT_PUBLIC_SIGNAL98_HOST || "http://localhost:3001";
const KEY = process.env.NEXT_PUBLIC_SIGNAL98_KEY || "s98_pk_local_dev";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { init } = await import("signal98");
  init({ host: HOST, apiKey: KEY, service: "ghost-mart", environment: "playground", release: "shop@0.2.0" });
}

export async function onRequestError(error, request, context) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { captureException, flush } = await import("signal98");
    const pathname = String(request?.path || "").split("?")[0];
    captureException(error, {
      $handled: false,
      $mechanism: "next-server",
      $pathname: pathname,
      $current_url: pathname,
      $method: request?.method,
      $next_route: context?.routePath,       // e.g. /product/[id]
      $next_route_type: context?.routeType,  // render | route | action | middleware
      $next_render_source: context?.renderSource,
      $error_digest: error?.digest,
    });
    await flush(); // dev servers and serverless functions may not live until the next timer tick
  } catch {
    /* reporting must never turn one failure into two */
  }
}
