import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { probe } from "../src/probe.js";

test("endpoint replies never claim an MCP handshake or client sign-in status", async (t) => {
  let status = 200;
  let body = "";
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(status).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;

  for (const [code, reply] of [
    [200, '{"result":{}}'], [200, "event: message\ndata: {}\n\n"],
    [204, ""], [401, ""], [403, ""],
  ]) {
    status = code;
    body = reply;
    assert.deepEqual(await probe(url), {
      state: code === 401 || code === 403 ? "auth" : "ok",
      detail: `HTTP ${code}: endpoint replied; client sign-in not checked`,
    });
  }
});
