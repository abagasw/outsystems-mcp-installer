import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { CLIENTS, clientPath, planClient } from "./clients.js";
import { backupFile, writeJsonAtomic } from "./registry.js";

export async function readJsonFile(file) {
  if (!existsSync(file)) return {};
  const text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error.message}. Fix or move the file, then retry.`);
  }
}

/**
 * Write the active servers into each client config. Returns one result per
 * client so the CLI and the dashboard can report the same way.
 */
export async function applyToClients(registry, { clients, scope = "user", prune = true, dryRun = false, ctx = {} } = {}) {
  const active = registry.active;
  const owned = [...Object.keys(registry.servers), ...(registry.removed ?? [])];
  if (!active.length && (!prune || !owned.length)) throw new Error("no active servers. add one first.");

  const servers = Object.fromEntries(active.map((name) => [name, registry.servers[name]]));
  const results = [];

  for (const clientId of clients) {
    const client = Object.hasOwn(CLIENTS, clientId) ? CLIENTS[clientId] : undefined;
    if (!client) {
      results.push({ client: clientId, ok: false, error: "unknown client" });
      continue;
    }
    if (!client.scopes.includes(scope)) {
      results.push({
        client: clientId,
        label: client.label,
        ok: false,
        error: `${scope} scope not supported (use --scope ${client.scopes.join("|")})`,
      });
      continue;
    }

    let file;
    try {
      file = clientPath(clientId, scope, ctx);
      const doc = await readJsonFile(file);
      const { doc: nextDoc, changes } = planClient(doc, clientId, servers, {
        prune,
        owned,
        ctx,
      });
      const changed = changes.filter((change) => change.action !== "unchanged");

      if (!dryRun && changed.length) {
        await backupFile(file);
        await writeJsonAtomic(file, nextDoc);
      }

      results.push({
        client: clientId,
        label: client.label,
        file,
        ok: true,
        written: !dryRun && changed.length > 0,
        changes,
      });
    } catch (error) {
      results.push({ client: clientId, label: client.label, file, ok: false, error: error.message });
    }
  }

  return results;
}
