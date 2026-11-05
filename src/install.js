import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./registry.js";

const SOURCE = fileURLToPath(new URL("../", import.meta.url));
const FILES = ["bin", "src", "ui", "windows", "Install.cmd", "Launch.vbs", "package.json", "README.md"];

export async function installApplication(input) {
  if (typeof input !== "string" || !isAbsolute(input.trim())) {
    throw new Error("choose an absolute installation path");
  }
  const directory = resolve(input.trim());
  const source = await realpath(SOURCE);
  const checkLocation = (target) => {
    const a = process.platform === "win32" ? target.toLowerCase() : target;
    const b = process.platform === "win32" ? source.toLowerCase() : source;
    if (a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`)) {
      throw new Error("choose a folder outside the source project");
    }
  };
  checkLocation(directory);
  if (existsSync(directory)) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(directory)).length) {
      throw new Error("choose a new or empty folder; existing files will not be overwritten");
    }
  }

  await mkdir(dirname(directory), { recursive: true });
  checkLocation(join(await realpath(dirname(directory)), basename(directory)));
  const staging = await mkdtemp(join(dirname(directory), ".oms-install-"));
  try {
    for (const file of FILES) {
      await cp(join(SOURCE, file), join(staging, file), { recursive: true, dereference: true });
    }
    await mkdir(join(staging, "data"));
    await writeJsonAtomic(join(staging, "installation.json"), {
      version: 1,
      directory,
      nodePath: process.execPath,
    });
    // rmdir refuses a folder populated after our check; never remove user files recursively.
    if (existsSync(directory)) await rmdir(directory);
    await rename(staging, directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { directory, launcher: join(directory, "Launch.vbs") };
}
