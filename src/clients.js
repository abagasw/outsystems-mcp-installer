import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Client adapters. Each one knows where its config lives, which object holds
 * the servers, and how one server is spelled in that client's schema.
 */
export const CLIENTS = {
  opencode: {
    label: "OpenCode",
    scopes: ["user", "project"],
    // OpenCode v2 keeps servers under mcp.servers; v1 kept them directly under mcp.
    container: opencodeContainer,
    entry: (server) => ({ type: "remote", url: server.url }),
  },
  claude: {
    label: "Claude Code",
    scopes: ["project"],
    rootKey: "mcpServers",
    entry: (server) => ({ type: "http", url: server.url }),
  },
  cursor: {
    label: "Cursor",
    scopes: ["user", "project"],
    rootKey: "mcpServers",
    entry: (server) => ({ url: server.url }),
  },
  vscode: {
    label: "VS Code Copilot",
    scopes: ["user", "project"],
    rootKey: "servers",
    entry: (server) => ({ type: "http", url: server.url }),
  },
  kiro: {
    label: "Kiro",
    scopes: ["user"],
    rootKey: "mcpServers",
    entry: (server) => ({ type: "http", url: server.url }),
  },
  "claude-desktop": {
    label: "Claude Desktop",
    scopes: ["user"],
    rootKey: "mcpServers",
    entry: claudeDesktopEntry,
  },
};

export const DEFAULT_CLIENTS = ["opencode"];

export function clientPath(clientId, scope = "user", ctx = {}) {
  const home = ctx.home ?? homedir();
  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;

  if (scope === "project") return join(cwd, projectPath(clientId));
  const path = userPath(clientId, platform, env, home);
  return isAbsolute(path) ? path : join(home, path);
}

function projectPath(clientId) {
  switch (clientId) {
    case "opencode":
      return "opencode.json";
    case "claude":
      return ".mcp.json";
    case "cursor":
      return join(".cursor", "mcp.json");
    case "vscode":
      return join(".vscode", "mcp.json");
    default:
      throw new Error(`${clientId} does not support project scope`);
  }
}

function userPath(clientId, platform, env, home) {
  const appData = env.APPDATA || join(home, "AppData", "Roaming");
  switch (clientId) {
    case "opencode":
      return env.OPENCODE_CONFIG || join(".config", "opencode", "opencode.json");
    case "cursor":
      return join(".cursor", "mcp.json");
    case "vscode":
      if (platform === "win32") return join(appData, "Code", "User", "mcp.json");
      if (platform === "darwin") return join("Library", "Application Support", "Code", "User", "mcp.json");
      return join(".config", "Code", "User", "mcp.json");
    case "kiro":
      return join(".kiro", "settings", "mcp.json");
    case "claude-desktop":
      if (platform === "win32") return join(appData, "Claude", "claude_desktop_config.json");
      if (platform === "darwin") return join("Library", "Application Support", "Claude", "claude_desktop_config.json");
      return join(".config", "Claude", "claude_desktop_config.json");
    default:
      throw new Error(`${clientId} does not support user scope`);
  }
}

function claudeDesktopEntry(server, ctx = {}) {
  const platform = ctx.platform ?? process.platform;
  if (platform === "win32") {
    // Tenant hostnames are validated before they get here, so the shell string is safe.
    if (!/^https?:\/\/[A-Za-z0-9:/.\[\]_~-]+$/.test(server.url)) {
      throw new Error("unsafe URL for the Windows proxy command; remove credentials, query, fragments, and shell characters");
    }
    return { command: "cmd", args: ["/c", `npx mcp-remote@0.14.3 ${server.url}`] };
  }
  return { command: "npx", args: ["mcp-remote@0.14.3", server.url] };
}

function opencodeContainer(doc) {
  const mcp = configObject(doc, "mcp");
  if (Object.hasOwn(mcp, "servers")) return configObject(mcp, "servers");
  const legacy = Object.values(mcp).some((value) => value && typeof value === "object" && typeof value.type === "string");
  return legacy ? mcp : configObject(mcp, "servers");
}

function configObject(doc, key) {
  if (!Object.hasOwn(doc, key)) doc[key] = {};
  const value = doc[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`client config ${key} must be a JSON object`);
  }
  return value;
}

function containerFor(doc, client) {
  if (client.container) return client.container(doc);
  return configObject(doc, client.rootKey);
}

/**
 * Merge the active servers into a client document. `owned` is every name the
 * registry knows about, so --prune only drops entries this tool wrote.
 */
export function planClient(doc, clientId, servers, { prune = false, owned = [], ctx = {} } = {}) {
  const client = CLIENTS[clientId];
  if (!client) throw new Error(`unknown client: ${clientId}`);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("client config must be a JSON object");

  const container = containerFor(doc, client);
  const changes = [];

  for (const [name, server] of Object.entries(servers)) {
    const entry = client.entry(server, ctx);
    const before = container[name];
    if (before && JSON.stringify(before) === JSON.stringify(entry)) {
      changes.push({ name, action: "unchanged" });
      continue;
    }
    container[name] = entry;
    changes.push({ name, action: before ? "updated" : "added" });
  }

  if (prune) {
    for (const name of owned) {
      if (!servers[name] && container[name]) {
        delete container[name];
        changes.push({ name, action: "removed" });
      }
    }
  }

  return { doc, changes };
}
