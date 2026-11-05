import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
export const DEFAULT_O11_URL = "http://127.0.0.1:41820/mcp";

export function registryPath(env = process.env) {
  const base = env.OMS_HOME || join(homedir(), ".outsystems-mcp");
  return join(base, "servers.json");
}

export function emptyRegistry() {
  return { version: 1, onboarded: false, install: null, servers: {}, active: [], removed: [] };
}

/** Strip scheme, www., trailing slash, path and query. Keeps only the bare host. */
export function normalizeTenant(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("tenant hostname is empty");

  let host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  host = host.split(/[/?#]/)[0];
  host = host.replace(/^www\./i, "");
  host = host.replace(/:\d+$/, "");

  if (!HOST_PATTERN.test(host)) {
    throw new Error(`invalid tenant hostname: ${JSON.stringify(raw)} (expected something like mycompany.outsystems.dev)`);
  }
  return host;
}

export function normalizeO11Url(input = DEFAULT_O11_URL) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new Error(`invalid URL: ${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`URL must be http or https: ${input}`);
  }
  // Service Studio only listens on loopback.
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") {
    throw new Error(`Service Studio MCP server is loopback only, got ${url.hostname}`);
  }
  if (!url.pathname || url.pathname === "/") url.pathname = "/mcp";
  if (!/^https?:\/\/[A-Za-z0-9:/.\[\]_~-]+$/.test(url.toString())) {
    throw new Error("Service Studio URL contains unsupported characters; use a loopback URL without credentials, query, or fragments");
  }
  return url.toString();
}

export function makeServer({ kind, tenant, url }) {
  if (kind === "odc") {
    const host = normalizeTenant(tenant);
    return { kind, tenant: host, url: `https://${host}/mcp` };
  }
  if (kind === "o11") {
    return { kind, url: normalizeO11Url(url) };
  }
  throw new Error(`unknown server kind: ${kind}`);
}

export function addServer(registry, name, server, { activate = true, force = false } = {}) {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`invalid name: ${JSON.stringify(name)} (use lowercase letters, digits, "-" and "_")`);
  }
  if (registry.servers[name] && !force) {
    throw new Error(`server "${name}" already exists; pass --force to replace it`);
  }
  const next = structuredClone(registry);
  next.servers[name] = server;
  next.removed = (next.removed ?? []).filter((item) => item !== name);
  if (activate && !next.active.includes(name)) next.active.push(name);
  return next;
}

export function removeServer(registry, name) {
  if (!registry.servers[name]) throw new Error(`unknown server: ${name}`);
  const next = structuredClone(registry);
  delete next.servers[name];
  next.active = next.active.filter((item) => item !== name);
  // Keep ownership after removal so a later apply can clean every client.
  next.removed = [...new Set([...(next.removed ?? []), name])];
  return next;
}

export function useServers(registry, names) {
  const unique = [...new Set(names)];
  for (const name of unique) {
    if (!registry.servers[name]) throw new Error(`unknown server: ${name}`);
  }
  return { ...structuredClone(registry), active: unique };
}

/** Remember where the next "apply" writes, so the dashboard and CLI agree. */
export function setInstall(registry, { clients, scope }) {
  if (!Array.isArray(clients) || !clients.length) throw new Error("choose at least one client");
  if (scope !== "user" && scope !== "project") throw new Error(`invalid scope: ${scope}`);
  const next = structuredClone(registry);
  next.install = { clients: [...clients], scope };
  next.onboarded = Object.keys(next.servers).length > 0;
  return next;
}

export async function readRegistry(file = registryPath()) {
  if (!existsSync(file)) return emptyRegistry();
  const text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
  if (!text.trim()) return emptyRegistry();
  try {
    const parsed = JSON.parse(text);
    return {
      ...emptyRegistry(),
      ...parsed,
      servers: parsed.servers ?? {},
      active: parsed.active ?? [],
      clients: parsed.clients ?? {},
    };
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error.message}`);
  }
}

export async function writeRegistry(registry, file = registryPath()) {
  await writeJsonAtomic(file, registry);
}

export async function writeJsonAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const body = `${JSON.stringify(data, null, 2)}\n`;
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, body, "utf8");
  await rename(temp, file);
}

/** Snapshot the file as it is before this write, so one undo is always available. */
export async function backupFile(file) {
  if (!existsSync(file)) return;
  await copyFile(file, `${file}.bak`);
}
