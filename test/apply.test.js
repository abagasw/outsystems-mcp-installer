import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addServer, emptyRegistry, makeServer, removeServer } from "../src/registry.js";
import { applyToClients } from "../src/apply.js";

test("removing the last saved server still cleans client config and keeps unrelated entries", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "oms-prune-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "opencode.json");
  await writeFile(file, JSON.stringify({ model: "keep", mcp: { servers: { manual: { type: "local", command: ["keep"] } } } }));
  let registry = addServer(emptyRegistry(), "studio", makeServer({ kind: "o11" }));
  const options = { clients: ["opencode"], scope: "project", ctx: { cwd: dir, env: {} } };
  assert.equal((await applyToClients(registry, options))[0].ok, true);
  const before = await readFile(file, "utf8");
  registry = removeServer(registry, "studio");
  const result = await applyToClients(registry, options);
  assert.equal(result[0].ok, true);
  const config = JSON.parse(await readFile(file, "utf8"));
  assert.equal(config.mcp.servers.studio, undefined);
  assert.deepEqual(config.mcp.servers.manual, { type: "local", command: ["keep"] });
  assert.equal(config.model, "keep");
  assert.equal(await readFile(`${file}.bak`, "utf8"), before);
});

test("malformed client config structures stay unchanged", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "oms-invalid-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = addServer(emptyRegistry(), "studio", makeServer({ kind: "o11" }));
  const cases = [
    ["opencode", []], ["opencode", null], ["opencode", "text"], ["opencode", true],
    ["opencode", { mcp: [] }], ["opencode", { mcp: null }], ["opencode", { mcp: "text" }],
    ["opencode", { mcp: { servers: [] } }], ["opencode", { mcp: { servers: null } }],
    ["cursor", { mcpServers: [] }], ["vscode", { servers: false }],
  ];
  for (const [client, doc] of cases) {
    const file = client === "opencode" ? join(dir, "opencode.json")
      : join(dir, client === "cursor" ? ".cursor" : ".vscode", "mcp.json");
    const before = JSON.stringify(doc);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, before);
    await writeFile(`${file}.bak`, "previous backup");
    const results = await applyToClients(registry, {
      clients: [client], scope: "project", ctx: { cwd: dir, env: {} },
    });
    assert.equal(results[0].ok, false, `${client}: ${before}`);
    assert.match(results[0].error, /JSON object/);
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(await readFile(`${file}.bak`, "utf8"), "previous backup");
  }
});
