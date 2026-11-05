import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addServer,
  makeServer,
  normalizeO11Url,
  normalizeTenant,
  readRegistry,
  registryPath,
  removeServer,
  useServers,
  writeRegistry,
  emptyRegistry,
} from "../src/registry.js";
import { clientPath, planClient } from "../src/clients.js";

test("normalizeTenant keeps only the bare host", () => {
  assert.equal(normalizeTenant("https://www.MyCompany.outsystems.dev/mcp?x=1"), "MyCompany.outsystems.dev");
  assert.equal(normalizeTenant("tsel002.outsystems.dev/"), "tsel002.outsystems.dev");
  assert.equal(normalizeTenant("tsel002.outsystems.dev:443"), "tsel002.outsystems.dev");
  assert.throws(() => normalizeTenant("https:///mcp"), /invalid tenant hostname/);
  assert.throws(() => normalizeTenant(""), /empty/);
});

test("normalizeO11Url defaults the path and refuses non-loopback hosts", () => {
  assert.equal(normalizeO11Url("http://127.0.0.1:41821"), "http://127.0.0.1:41821/mcp");
  assert.equal(normalizeO11Url("http://localhost:41820/mcp"), "http://localhost:41820/mcp");
  assert.throws(() => normalizeO11Url("http://10.0.0.5:41820/mcp"), /loopback only/);
  assert.throws(() => normalizeO11Url("ftp://127.0.0.1/mcp"), /http or https/);
});

test("O11 URLs reject shell characters and credentials before saving", () => {
  for (const suffix of ["&calc", "|calc", "^calc", "%COMSPEC%", "!calc!", "(calc)", "?x=1", "#fragment", "/é"]) {
    assert.throws(() => normalizeO11Url(`http://127.0.0.1:41820/mcp${suffix}`), /URL.*characters/);
  }
  assert.throws(() => normalizeO11Url("http://user:secret@127.0.0.1:41820/mcp"), /URL.*characters/);
});

test("makeServer builds the documented URLs", () => {
  assert.deepEqual(makeServer({ kind: "odc", tenant: "https://acme.outsystems.dev/mcp" }), {
    kind: "odc",
    tenant: "acme.outsystems.dev",
    url: "https://acme.outsystems.dev/mcp",
  });
  assert.deepEqual(makeServer({ kind: "o11" }), { kind: "o11", url: "http://127.0.0.1:41820/mcp" });
});

test("registry add, use and remove keep active in sync", () => {
  const odc = makeServer({ kind: "odc", tenant: "acme.outsystems.dev" });
  const o11 = makeServer({ kind: "o11" });

  let registry = emptyRegistry();
  registry = addServer(registry, "outsystems", odc);
  registry = addServer(registry, "servicestudio", o11);
  assert.deepEqual(registry.active, ["outsystems", "servicestudio"]);

  registry = useServers(registry, ["servicestudio"]);
  assert.deepEqual(registry.active, ["servicestudio"]);

  registry = removeServer(registry, "servicestudio");
  assert.deepEqual(registry.active, []);
  assert.deepEqual(Object.keys(registry.servers), ["outsystems"]);

  assert.throws(() => addServer(registry, "outsystems", odc), /already exists/);
  assert.throws(() => addServer(registry, "Bad Name", odc), /invalid name/);
  assert.throws(() => useServers(registry, ["missing"]), /unknown server/);
});

test("registry round-trips through disk", async () => {
  const home = await mkdtemp(join(tmpdir(), "oms-"));
  const file = registryPath({ OMS_HOME: home });
  let registry = addServer(emptyRegistry(), "outsystems", makeServer({ kind: "odc", tenant: "acme.outsystems.dev" }));
  await writeRegistry(registry, file);

  const loaded = await readRegistry(file);
  assert.deepEqual(loaded.servers.outsystems.url, "https://acme.outsystems.dev/mcp");
  assert.deepEqual(loaded.active, ["outsystems"]);

  const broken = join(home, "broken.json");
  await writeFile(broken, "{ nope", "utf8");
  await assert.rejects(() => readRegistry(broken), /cannot parse/);

  const bom = join(home, "bom.json");
  await writeFile(bom, `\uFEFF${JSON.stringify(registry)}`, "utf8");
  assert.equal((await readRegistry(bom)).servers.outsystems.tenant, "acme.outsystems.dev");
});

test("opencode v2 writes under mcp.servers and preserves other keys", () => {
  const doc = { mcp: { servers: { codegraph: { type: "local", command: ["x"] } } }, model: "a/b" };
  const servers = { outsystems: { kind: "odc", url: "https://acme.outsystems.dev/mcp" } };
  const { doc: next, changes } = planClient(doc, "opencode", servers);

  assert.deepEqual(next.mcp.servers.outsystems, { type: "remote", url: "https://acme.outsystems.dev/mcp" });
  assert.deepEqual(next.mcp.servers.codegraph, { type: "local", command: ["x"] });
  assert.equal(next.model, "a/b");
  assert.deepEqual(changes, [{ name: "outsystems", action: "added" }]);
});

test("opencode v1 documents are detected and kept in place", () => {
  const doc = { mcp: { old: { type: "local", command: ["y"] } } };
  const { doc: next } = planClient(doc, "opencode", { outsystems: { kind: "odc", url: "https://acme.outsystems.dev/mcp" } });
  assert.ok(next.mcp.outsystems);
  assert.ok(!next.mcp.servers);
});

test("empty opencode config gets the v2 shape", () => {
  const { doc } = planClient({}, "opencode", { servicestudio: { kind: "o11", url: "http://127.0.0.1:41820/mcp" } });
  assert.deepEqual(doc.mcp.servers.servicestudio, { type: "remote", url: "http://127.0.0.1:41820/mcp" });
});

test("client schemas differ where the clients require it", () => {
  const server = { kind: "o11", url: "http://127.0.0.1:41820/mcp" };

  assert.deepEqual(planClient({}, "cursor", { o11: server }).doc.mcpServers.o11, { url: server.url });
  assert.deepEqual(planClient({}, "vscode", { o11: server }).doc.servers.o11, { type: "http", url: server.url });
  assert.deepEqual(planClient({}, "claude", { o11: server }).doc.mcpServers.o11, { type: "http", url: server.url });

  const desktop = planClient({}, "claude-desktop", { o11: server }, { ctx: { platform: "win32" } }).doc;
  assert.deepEqual(desktop.mcpServers.o11, {
    command: "cmd",
    args: ["/c", "npx mcp-remote@0.14.3 http://127.0.0.1:41820/mcp"],
  });
});

test("Windows proxy config refuses unsafe URLs from an existing registry", () => {
  for (const url of ["http://127.0.0.1:41820/mcp&calc", "http://127.0.0.1/%COMSPEC%", 'http://127.0.0.1/"&calc']) {
    assert.throws(() => planClient({}, "claude-desktop", { studio: { kind: "o11", url } }, {
      ctx: { platform: "win32" },
    }), /unsafe URL/);
  }
});

test("prune drops only names the registry owns", () => {
  const doc = {
    mcpServers: {
      stale: { url: "http://127.0.0.1:41820/mcp" },
      manual: { url: "https://example.com/mcp" },
    },
  };
  const { doc: next, changes } = planClient(doc, "cursor", {}, { prune: true, owned: ["stale"] });
  assert.ok(!next.mcpServers.stale);
  assert.ok(next.mcpServers.manual);
  assert.deepEqual(changes, [{ name: "stale", action: "removed" }]);
});

test("apply is idempotent", () => {
  const servers = { outsystems: { kind: "odc", url: "https://acme.outsystems.dev/mcp" } };
  const first = planClient({}, "opencode", servers).doc;
  const second = planClient(structuredClone(first), "opencode", servers);
  assert.deepEqual(second.changes, [{ name: "outsystems", action: "unchanged" }]);
});

test("client paths follow the scope", () => {
  const ctx = { home: "/home/dev", cwd: "/work/app", platform: "linux", env: {} };
  assert.equal(clientPath("opencode", "user", ctx), join("/home/dev", ".config/opencode/opencode.json"));
  assert.equal(clientPath("claude", "project", ctx), join("/work/app", ".mcp.json"));
  assert.equal(clientPath("vscode", "project", ctx), join("/work/app", ".vscode/mcp.json"));
  assert.throws(() => clientPath("claude", "user", ctx), /does not support user scope/);

  const win = { home: "C:\\Users\\dev", cwd: "C:\\work", platform: "win32", env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" } };
  assert.equal(clientPath("vscode", "user", win), "C:\\Users\\dev\\AppData\\Roaming\\Code\\User\\mcp.json");
  assert.equal(clientPath("claude-desktop", "user", win), "C:\\Users\\dev\\AppData\\Roaming\\Claude\\claude_desktop_config.json");
});
