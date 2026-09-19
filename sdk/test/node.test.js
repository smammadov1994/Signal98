import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { installNode, errorHandler, requestHandler } from "../src/node.js";
import { hub } from "../src/hub.js";
import { testClient } from "./helpers.js";

const EVENTS = ["uncaughtException", "unhandledRejection", "beforeExit", "SIGTERM"];
const counts = () => EVENTS.map((e) => process.listenerCount(e));

test("installNode adds context and its uninstall removes every listener", () => {
  const before = counts();
  const { client } = testClient({ service: undefined });
  const uninstall = installNode(client, { exitOnUncaught: false });
  assert.deepEqual(counts(), before.map((n) => n + 1));
  client.capture("job_done");
  const p = client._queue[0].properties;
  assert.equal(p.$node_version, process.version);
  assert.equal(p.$hostname, os.hostname());
  assert.ok(p.$service, "defaults to the package or host name");
  assert.equal(p.$lib, "signal98");
  assert.equal("$session_id" in p, false, "sessions are a browser concept");
  uninstall();
  assert.deepEqual(counts(), before);
});

test("uncaughtException / unhandledRejection are reported as fatal", () => {
  const { client } = testClient({ service: "worker" });
  const uninstall = installNode(client, { exitOnUncaught: false });
  try {
    process.listeners("uncaughtException").at(-1)(new Error("crash"));
    process.listeners("unhandledRejection").at(-1)("rejected with a string");
  } finally {
    uninstall();
  }
  const [a, b] = client._queue;
  assert.deepEqual([a.properties.$mechanism, a.properties.$exception_level, a.properties.$service], ["uncaughtException", "fatal", "worker"]);
  assert.equal(b.properties.$exception_list[0].value, "rejected with a string");
});

test("requestHandler adds one breadcrumb per request; errorHandler reports 5xx and always calls next(err)", () => {
  const { client } = testClient();
  const req = { method: "POST", originalUrl: "/api/orders?token=secret", url: "/orders?token=secret" };
  let nexts = 0;
  requestHandler(client)(req, {}, () => nexts++);
  assert.equal(nexts, 1);
  assert.equal(client._steps[0].$message, "POST /api/orders");
  assert.equal(client._steps[0].$category, "network");

  const passed = [];
  const err = new Error("db exploded");
  errorHandler(client)(err, req, {}, (e) => passed.push(e));
  const notFound = Object.assign(new Error("nope"), { status: 404 });
  errorHandler(client)(notFound, req, {}, (e) => passed.push(e));
  assert.deepEqual(passed, [err, notFound]);
  assert.equal(client._queue.length, 1, "4xx errors are not reported");
  const p = client._queue[0].properties;
  assert.deepEqual([p.$mechanism, p.$method, p.$url, p.$status, p.$handled], ["express", "POST", "/api/orders", 500, false]);
  assert.equal(p.$exception_steps[0].$message, "POST /api/orders");
  assert.equal(JSON.stringify(client._queue[0]).includes("secret"), false);
});

test("middleware without an explicit client uses the init() client, and survives having none", () => {
  let nexts = 0;
  hub.client = null;
  assert.doesNotThrow(() => errorHandler()(new Error("x"), {}, {}, () => nexts++));
  assert.doesNotThrow(() => requestHandler()({}, {}, () => nexts++));
  const { client } = testClient();
  hub.client = client;
  try {
    errorHandler()(new Error("late bound"), { method: "GET", url: "/" }, {}, () => nexts++);
  } finally {
    hub.client = null;
  }
  assert.equal(nexts, 3);
  assert.equal(client._queue.length, 1);
  // A client that throws must not take the request down with it.
  const hostile = { addStep() { throw new Error("bug"); }, captureException() { throw new Error("bug"); } }; // prettier-ignore
  assert.doesNotThrow(() => requestHandler(hostile)({}, {}, () => nexts++));
  assert.doesNotThrow(() => errorHandler(hostile)(new Error("x"), {}, {}, () => nexts++));
  assert.equal(nexts, 5);
});
