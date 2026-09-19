// The one piece of shared state: the client created by init(). It lives in
// its own module so node.js and react.js can find "the current client"
// without importing index.js (which imports them — a cycle).

export const hub = { client: null };

// An explicitly passed client wins, unless it is the inert placeholder that
// getClient() hands out before init().
export const resolveClient = (client) => (client && !client._noop ? client : hub.client);
