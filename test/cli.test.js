import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { emptyRegistry, writeRegistry } from "../src/registry.js";

test("help describes config writes without promising client connections", async (t) => {
  const messages = [];
  t.mock.method(console, "log", (message) => messages.push(message));
  await main(["help"]);
  assert.doesNotMatch(messages.join("\n"), /only the active set connects/);
  assert.match(messages.join("\n"), /reload the client/i);
});

test("doctor reports an unauthenticated HTTP check, not the client's OAuth session", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "oms-doctor-"));
  const previous = process.env.OMS_HOME;
  process.env.OMS_HOME = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.OMS_HOME;
    else process.env.OMS_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(401).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await writeRegistry({ ...emptyRegistry(), active: ["tenant"], servers: {
    tenant: { kind: "odc", url: `http://127.0.0.1:${server.address().port}/mcp` },
  } });
  const messages = [];
  t.mock.method(console, "log", (...args) => messages.push(args.join(" ")));
  t.mock.method(console, "error", (...args) => messages.push(args.join(" ")));

  await main(["doctor"]);
  const output = messages.join("\n");
  assert.match(output, /client sign-in not checked/);
  assert.doesNotMatch(output, /OAuth opens on the first|sign-in required|Sign in from your client/);
});
