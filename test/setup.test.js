import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUi } from "../src/ui-server.js";

async function openApp(t, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "oms-setup-"));
  const oldHome = process.env.OMS_HOME;
  process.env.OMS_HOME = join(dir, "data");
  const app = await startUi({ port: 0, ctx: { cwd: dir, home: dir, platform: "linux", env } });
  t.after(async () => {
    await app.close();
    if (oldHome === undefined) delete process.env.OMS_HOME;
    else process.env.OMS_HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  });
  const post = async (path, body) => {
    const response = await fetch(`${app.url}api/${path}`, {
      method: "POST",
      headers: { "x-oms": "1", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { dir, app, post };
}

test("first-run setup saves server details and applies the selected clients", async (t) => {
  const { dir, app, post } = await openApp(t);
  const { status, body: result } = await post("onboard", {
    clients: ["opencode"], scope: "project",
    server: { name: "studio", kind: "o11", port: 41821 },
  });
  assert.equal(status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.results?.[0].ok, true);
  const config = JSON.parse(await readFile(join(dir, "opencode.json"), "utf8"));
  assert.equal(config.mcp.servers.studio.url, "http://127.0.0.1:41821/mcp");
  const state = await fetch(`${app.url}api/state`).then((res) => res.json());
  assert.equal(state.onboarded, true);
  assert.equal(state.servers[0].name, "studio");
});

test("invalid client targets do not save the first server", async (t) => {
  const { dir, post } = await openApp(t);
  for (const clients of [["missing"], ["constructor"], ["claude"]]) {
    const result = await post("onboard", {
      clients, scope: "user", server: { name: "studio", kind: "o11", port: 41820 },
    });
    assert.equal(result.status, 400);
    await assert.rejects(() => readFile(join(dir, "data", "servers.json")), { code: "ENOENT" });
  }
});

test("installed dashboard applies project config to the chosen project, not the application folder", async (t) => {
  const installationDirectory = "C:\\Installed\\OutSystems MCP";
  const { dir, app, post } = await openApp(t, { OMS_INSTALL_DIR: installationDirectory });
  const projectDir = join(dir, "Project with spaces");
  await mkdir(projectDir);
  const missing = await post("onboard", { clients: ["opencode"], scope: "project" });
  assert.equal(missing.status, 400);

  const result = await post("onboard", {
    clients: ["opencode"], scope: "project", projectDir,
    server: { name: "studio", kind: "o11", port: 41821 },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.results[0].file, join(projectDir, "opencode.json"));
  await assert.rejects(() => readFile(join(dir, "opencode.json")), { code: "ENOENT" });
  const state = await fetch(`${app.url}api/state`).then((res) => res.json());
  assert.equal(state.installationDirectory, installationDirectory);
  assert.equal(state.install.projectDir, projectDir);
  assert.equal(state.clients.find((client) => client.id === "opencode").paths.project, join(projectDir, "opencode.json"));
  assert.equal((await post("apply", {})).body.results[0].file, join(projectDir, "opencode.json"));
});

test("installed dashboard rejects the application folder as a project target", async (t) => {
  const env = {};
  const { dir, post } = await openApp(t, env);
  env.OMS_INSTALL_DIR = dir;
  await mkdir(join(dir, "ui"));
  const targets = [dir, join(dir, "ui"), ...(process.platform === "win32" ? [dir.toUpperCase()] : [])];
  for (const projectDir of targets) {
    const result = await post("onboard", {
      clients: ["opencode"], scope: "project", projectDir,
      server: { name: "studio", kind: "o11", port: 41820 },
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /application folder/);
    await assert.rejects(() => readFile(join(dir, "data", "servers.json")), { code: "ENOENT" });
    await assert.rejects(() => readFile(join(projectDir, "opencode.json")), { code: "ENOENT" });
  }
});

test("dashboard requires an explicit integer O11 port", async (t) => {
  const { post } = await openApp(t);
  for (const port of [undefined, "", null, true, 0, 1.5, 65536, "41820junk"]) {
    const result = await post("servers", { kind: "o11", name: "studio", port });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /port/);
  }
  const valid = await post("servers", { kind: "o11", name: "studio", port: "41821" });
  assert.equal(valid.status, 200);
  assert.equal(valid.body.server.url, "http://127.0.0.1:41821/mcp");
});

test("setup reports each client write failure without claiming full success", async (t) => {
  const env = {};
  const { dir, post } = await openApp(t, env);
  await writeFile(join(dir, "blocked"), "keep this");
  env.OPENCODE_CONFIG = join(dir, "blocked", "opencode.json");
  const result = await post("onboard", {
    clients: ["opencode", "cursor"], scope: "user",
    server: { name: "studio", kind: "o11", port: 41820 },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.results[0].ok, false);
  assert.match(result.body.results[0].error, /ENOTDIR|EEXIST/);
  assert.equal(result.body.results[1].ok, true);
  assert.equal(await readFile(join(dir, "blocked"), "utf8"), "keep this");
  const cursor = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf8"));
  assert.equal(cursor.mcpServers.studio.url, "http://127.0.0.1:41820/mcp");
});

test("concurrent dashboard saves retain every server", async (t) => {
  const { app, post } = await openApp(t);
  const names = Array.from({ length: 12 }, (_, index) => `studio-${index}`);
  const results = await Promise.all(names.map((name) => post("servers", { name, kind: "o11", port: 41820 })));
  assert.deepEqual(results.map((result) => result.status), names.map(() => 200));
  const state = await fetch(`${app.url}api/state`).then((res) => res.json());
  assert.deepEqual(state.servers.map((server) => server.name).sort(), names.sort());
});

test("adding an ODC tenant in the dashboard replaces only the ODC selection", async (t) => {
  const { app, post } = await openApp(t);
  await post("servers", { name: "tenant-a", kind: "odc", tenant: "a.outsystems.dev" });
  await post("servers", { name: "studio", kind: "o11", port: 41820 });
  await post("servers", { name: "tenant-b", kind: "odc", tenant: "b.outsystems.dev" });
  await post("servers", { name: "tenant-c", kind: "odc", tenant: "c.outsystems.dev", activate: false });
  const state = await fetch(`${app.url}api/state`).then((res) => res.json());
  assert.deepEqual(state.active, ["studio", "tenant-b"]);
  assert.equal(state.servers.length, 4);
});
