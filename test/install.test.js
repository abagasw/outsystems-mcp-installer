import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("installation creates a separate application at the selected location", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "oms-install-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const target = join(temp, "Folder with spaces", "OutSystems MCP");
  const { installApplication } = await import("../src/install.js");

  const result = await installApplication(target);
  assert.equal(result.directory, target);
  await access(join(target, "bin", "oms.js"));
  await access(join(target, "ui", "index.html"));
  await access(join(target, "Launch.vbs"));
  const installation = JSON.parse(await readFile(join(target, "installation.json"), "utf8"));
  assert.equal(installation.directory, target);
  assert.equal(installation.nodePath, process.execPath);

  const userFile = join(target, "my-file.txt");
  await writeFile(userFile, "keep this", "utf8");
  await assert.rejects(() => installApplication(target), /empty folder/);
  assert.equal(await readFile(userFile, "utf8"), "keep this");
  await assert.rejects(() => installApplication("relative-folder"), /absolute/);
});

test("Windows installer accepts a folder with spaces without launching", { skip: process.platform !== "win32" }, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "oms-native-install-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const target = join(temp, "OutSystems MCP");
  const installer = fileURLToPath(new URL("../windows/Install.ps1", import.meta.url));
  await promisify(execFile)("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", installer,
    "-Destination", target, "-NoLaunch",
  ], { timeout: 30000 });
  const installation = JSON.parse(await readFile(join(target, "installation.json"), "utf8"));
  assert.equal(installation.directory, target);
});
