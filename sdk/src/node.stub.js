// Stand-in for node.js in the script-tag bundle (see build.js): same exports,
// no process hooks, no Express middleware, fewer bytes.

export const installNode = () => () => {};
const passthrough = () => (a, b, c, d) => (typeof d === "function" ? d(a) : typeof c === "function" && c());
export const errorHandler = passthrough;
export const requestHandler = passthrough;
