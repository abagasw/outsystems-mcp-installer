import { CLIENTS, DEFAULT_CLIENTS } from "./clients.js";
import {
  addServer,
  makeServer,
  readRegistry,
  registryPath,
  removeServer,
  useServers,
  writeRegistry,
} from "./registry.js";
import { applyToClients } from "./apply.js";
import { probe } from "./probe.js";
import { openBrowser } from "./open.js";
import { startUi } from "./ui-server.js";

const HELP = `oms - OutSystems MCP installer

Usage:
  oms ui [--port 4780] [--no-open] [--ready-file <path>]
  oms add odc <name> --tenant <host> [--force] [--no-activate]
  oms add o11 <name> [--url http://127.0.0.1:41820/mcp] [--force] [--no-activate]
  oms list
  oms use <name...>
  oms remove <name>
  oms apply [--clients ${DEFAULT_CLIENTS.join(",")}] [--scope user|project] [--no-prune] [--dry-run]
  oms doctor [--all]
  oms path
  oms help

Clients: ${Object.keys(CLIENTS).join(", ")}

Notes:
  - "active" is the set of servers that "oms apply" writes to a client config.
  - "apply" prunes inactive registered entries. Reload the client to load config changes.
    Stored OAuth tokens are not touched. The client may still require sign-in.
  - ODC sign-in is managed by the client. This installer stores no OAuth tokens or client_id.
  - "doctor" checks endpoint replies, not client connections or OAuth sessions.
  - O11 servers only exist while Service Studio has its MCP server started.`;

export async function main(argv) {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);

  switch (command) {
    case "ui":
      return uiCommand(flags);
    case "add":
      return addCommand(positional, flags);
    case "list":
    case "ls":
      return listCommand();
    case "use":
      return useCommand(positional);
    case "remove":
    case "rm":
      return removeCommand(positional);
    case "apply":
      return applyCommand(flags);
    case "doctor":
      return doctorCommand(flags);
    case "path":
      console.log(registryPath());
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      throw new Error(`unknown command: ${command}\n\n${HELP}`);
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inline] = arg.slice(2).split("=");
    if (inline !== undefined) {
      flags[rawKey] = inline;
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      flags[rawKey] = argv[++index];
    } else {
      flags[rawKey] = true;
    }
  }
  return { positional, flags };
}

async function uiCommand(flags) {
  const port = flags.port === undefined ? 4780 : Number(flags.port);
  const handle = await startUi({ port, readyFile: flags["ready-file"] });
  console.log(`oms dashboard: ${handle.url}`);
  console.log("press Ctrl+C to stop.");
  if (!flags["no-open"]) openBrowser(handle.url);
}

async function addCommand(positional, flags) {
  const [kind, name] = positional;
  if (!kind || !name) throw new Error("usage: oms add odc|o11 <name> [--tenant <host> | --url <url>]");

  const server = makeServer({ kind, tenant: flags.tenant, url: flags.url });
  const registry = await readRegistry();
  const next = addServer(registry, name, server, {
    activate: !flags["no-activate"],
    force: Boolean(flags.force),
  });
  await writeRegistry(next);

  console.log(`added ${name} (${kind}) -> ${server.url}`);
  if (next.active.includes(name)) console.log("active. run 'oms apply' to write it to a client config.");
}

async function listCommand() {
  const registry = await readRegistry();
  const entries = Object.entries(registry.servers);
  if (!entries.length) {
    console.log("no servers yet. run 'oms ui' or add one: oms add odc my-tenant --tenant mycompany.outsystems.dev");
    return;
  }

  const rows = entries.map(([name, server]) => [
    name,
    server.kind,
    registry.active.includes(name) ? "yes" : "no",
    server.url,
  ]);
  printTable(["NAME", "KIND", "ACTIVE", "URL"], rows);
  console.log(`\nregistry: ${registryPath()}`);
}

async function useCommand(names) {
  if (!names.length) throw new Error("usage: oms use <name...> (sets the active set; use 'oms list' to see names)");
  const registry = await readRegistry();
  const next = useServers(registry, names);
  await writeRegistry(next);
  console.log(`active: ${next.active.join(", ")}`);
  console.log("run 'oms apply' to write it to a client config.");
}

async function removeCommand(positional) {
  const [name] = positional;
  if (!name) throw new Error("usage: oms remove <name>");
  const registry = await readRegistry();
  const next = removeServer(registry, name);
  await writeRegistry(next);
  console.log(`removed ${name}`);
  console.log("run 'oms apply' to drop it from client configs.");
}

async function applyCommand(flags) {
  const registry = await readRegistry();
  const saved = registry.install ?? {};
  const scope = flags.scope ?? saved.scope ?? "user";
  if (scope !== "user" && scope !== "project") throw new Error(`invalid --scope: ${scope}`);

  const clients = String(flags.clients ?? (saved.clients ?? DEFAULT_CLIENTS).join(","))
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const results = await applyToClients(registry, {
    clients,
    scope,
    prune: !flags["no-prune"],
    dryRun: Boolean(flags["dry-run"]),
    ctx: flags.scope === undefined && saved.projectDir ? { cwd: saved.projectDir } : {},
  });

  let failed = false;
  for (const result of results) {
    if (!result.ok) {
      console.error(`skip ${result.client}: ${result.error}`);
      failed = true;
      continue;
    }
    const summary =
      result.changes
        .filter((change) => change.action !== "unchanged")
        .map((change) => `${change.action} ${change.name}`)
        .join(", ") || "no changes";
    console.log(`${flags["dry-run"] ? "[dry-run] " : ""}${result.label} ${result.file}: ${summary}`);
  }

  if (scope === "user" && clients.includes("claude")) {
    console.log("Claude Code uses project scope only: oms apply --clients claude --scope project");
  }
  if (failed) process.exitCode = 1;
}

async function doctorCommand(flags) {
  const registry = await readRegistry();
  const names = flags.all ? Object.keys(registry.servers) : registry.active;
  if (!names.length) throw new Error("no servers to check. add one with 'oms add'.");

  const results = await Promise.all(
    names.map(async (name) => ({ name, server: registry.servers[name], result: await probe(registry.servers[name].url) })),
  );

  const rows = results.map(({ name, server, result }) => [name, server.kind, result.state, result.detail]);
  printTable(["NAME", "KIND", "STATE", "DETAIL"], rows);

  for (const { name, server, result } of results) {
    if (result.state === "ok") continue;
    if (server.kind === "o11" && result.state === "unreachable") {
      console.error(`\n${name}: start the MCP server in Service Studio (Edit > MCP Configuration), then check the port in that dialog.`);
    }
    if (server.kind === "odc" && result.state === "auth") {
      console.error(`\n${name}: this check sends no client credentials. Check authentication and tenant access in your MCP client.`);
    }
    if (result.state === "error" || result.state === "unreachable") process.exitCode = 1;
  }
}

function printTable(headers, rows) {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => String(row[column]).length)));
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  ").trimEnd();
  console.log(line(headers));
  console.log(line(widths.map((width) => "-".repeat(width))));
  for (const row of rows) console.log(line(row));
}
