import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUi } from "../src/ui-server.js";
import { request as httpRequest } from "node:http";

let handle;
let dir;
const base = () => handle.url.replace(/\/$/, "");

async function request(path, { method, body, header = true } = {}) {
  const verb = method ?? (body === undefined ? "GET" : "POST");
  const response = await fetch(`${base()}${path}`, {
    method: verb,
    headers: { "content-type": "application/json", ...(header ? { "x-oms": "1" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "oms-ui-"));
  process.env.OMS_HOME = join(dir, "home");
  handle = await startUi({ port: 0, ctx: { cwd: dir, home: dir, platform: "linux", env: {} } });
});

after(async () => {
  await handle.close();
  delete process.env.OMS_HOME;
});

test("api rejects posts without the local header", async () => {
  const response = await request("/api/onboard", { body: { clients: ["opencode"], scope: "project" }, header: false });
  assert.equal(response.status, 403);
});

test("local API rejects a foreign Origin before reading state or writing", async () => {
  for (const method of ["GET", "POST"]) {
    const response = await fetch(base() + (method === "GET" ? "/api/state" : "/api/active"), {
      method,
      headers: { origin: "https://other.example", "x-oms": "1", "content-type": "application/json" },
      body: method === "POST" ? '{"names":[]}' : undefined,
    });
    assert.equal(response.status, 403);
    await response.text();
  }
});

test("local API rejects a Host used for DNS rebinding", async () => {
  const status = await new Promise((resolve, reject) => {
    httpRequest(`${base()}/api/state`, { headers: { host: `other.example:${handle.port}` } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    }).on("error", reject).end();
  });
  assert.equal(status, 403);
});

test("API rejects non-object JSON instead of clearing the active set", async () => {
  for (const body of [null, [], "names", 12, true]) {
    const response = await request("/api/active", { body });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /JSON object/);
  }
});

test("fresh state is not onboarded", async () => {
  const { status, body } = await request("/api/state");
  assert.equal(status, 200);
  assert.equal(body.onboarded, false);
  assert.deepEqual(body.servers, []);
  assert.ok(body.clients.find((client) => client.id === "opencode").paths.project);
});

test("client choices alone do not finish first-run setup", async () => {
  const saved = await request("/api/onboard", { body: { clients: ["opencode"], scope: "project" } });
  assert.equal(saved.status, 200);

  const { body } = await request("/api/state");
  assert.equal(body.onboarded, false);
  assert.deepEqual(body.install, { clients: ["opencode"], scope: "project" });
});

test("servers are added with the documented urls", async () => {
  const odc = await request("/api/servers", { body: { kind: "odc", name: "acme", tenant: "https://acme.outsystems.dev/mcp" } });
  assert.equal(odc.status, 200);

  const o11 = await request("/api/servers", { body: { kind: "o11", name: "studio", port: 41821 } });
  assert.equal(o11.status, 200);
  assert.equal(o11.body.server.url, "http://127.0.0.1:41821/mcp");

  const badName = await request("/api/servers", { body: { kind: "odc", name: "Bad Name", tenant: "acme.outsystems.dev" } });
  assert.equal(badName.status, 400);

  const badPort = await request("/api/servers", { body: { kind: "o11", name: "studio2", port: 70000 } });
  assert.equal(badPort.status, 400);

  const { body } = await request("/api/state");
  assert.deepEqual(body.servers.map((server) => server.name).sort(), ["acme", "studio"]);
  assert.equal(body.servers.find((server) => server.name === "acme").url, "https://acme.outsystems.dev/mcp");
});

test("apply writes the active set and prunes the rest", async () => {
  const applied = await request("/api/apply", { body: {} });
  assert.equal(applied.status, 200);
  assert.ok(applied.body.results.every((result) => result.ok));

  const file = join(dir, "opencode.json");
  let config = JSON.parse(await readFile(file, "utf8"));
  assert.ok(config.mcp.servers.acme);
  assert.ok(config.mcp.servers.studio);

  await request("/api/active", { body: { names: ["acme"] } });
  const second = await request("/api/apply", { body: {} });
  assert.equal(second.status, 200);

  config = JSON.parse(await readFile(file, "utf8"));
  assert.ok(config.mcp.servers.acme);
  assert.equal(config.mcp.servers.studio, undefined);
});

test("an empty active set prunes saved servers from client config", async () => {
  await request("/api/active", { body: { names: [] } });
  const { status, body } = await request("/api/apply", { body: {} });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "opencode.json"), "utf8")).mcp.servers, {});
});

test("delete removes a server", async () => {
  const removed = await request("/api/servers/studio", { method: "DELETE" });
  assert.equal(removed.status, 200);
  const { body } = await request("/api/state");
  assert.deepEqual(body.servers.map((server) => server.name), ["acme"]);
});

test("the dashboard html is served", async () => {
  const response = await fetch(base() + "/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(await response.text(), /OutSystems MCP/);

  const asset = await fetch(base() + "/app.js");
  assert.equal(asset.status, 200);
});

test("unknown api routes are 404", async () => {
  const { status } = await request("/api/nope", { body: {} });
  assert.equal(status, 404);
});

test("desktop readiness lasts until graceful shutdown", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "oms-ready-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const readyFile = join(temp, "data", "desktop.json");
  const desktop = await startUi({ port: 0, readyFile });
  t.after(() => desktop.close());
  const ready = JSON.parse(await readFile(readyFile, "utf8"));
  assert.equal(ready.url, desktop.url);
  assert.equal(ready.pid, process.pid);

  const blocked = await fetch(`${desktop.url}api/shutdown`, { method: "POST" });
  assert.equal(blocked.status, 403);
  await blocked.text();
  const stopped = await fetch(`${desktop.url}api/shutdown`, {
    method: "POST",
    headers: { "x-oms": "1", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(stopped.status, 200);
  assert.deepEqual(await stopped.json(), { ok: true });
  await desktop.close();
  await assert.rejects(() => readFile(readyFile), { code: "ENOENT" });
  await assert.rejects(() => fetch(desktop.url));
});
