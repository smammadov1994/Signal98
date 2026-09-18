// Node auto-capture: uncaughtException + unhandledRejection.

export function installNode(client, opts = {}) {
  const { errors = true, rejections = true } = opts;
  if (typeof process === "undefined" || typeof process.on !== "function") {
    return () => {};
  }
  const cleanups = [];

  if (errors) {
    const onEx = (err) => {
      client.captureException(err, {
        $handled: false,
        $mechanism: "uncaughtException",
        $node_version: process.version,
      });
    };
    process.on("uncaughtException", onEx);
    cleanups.push(() => process.removeListener("uncaughtException", onEx));
  }

  if (rejections) {
    const onRej = (reason) => {
      client.captureException(reason, {
        $handled: false,
        $mechanism: "unhandledRejection",
        $node_version: process.version,
      });
    };
    process.on("unhandledRejection", onRej);
    cleanups.push(() => process.removeListener("unhandledRejection", onRej));
  }

  // Flush on graceful shutdown; beforeExit allows async work to finish.
  const onBeforeExit = () => {
    client.flush();
  };
  process.on("beforeExit", onBeforeExit);
  cleanups.push(() => process.removeListener("beforeExit", onBeforeExit));

  return () => cleanups.forEach((fn) => fn());
}
