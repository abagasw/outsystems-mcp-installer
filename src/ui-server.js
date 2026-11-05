import { createServer } from "node:http";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENTS, DEFAULT_CLIENTS, clientPath } from "./clients.js";
import {
  addServer,
  makeServer,
  readRegistry,
  registryPath,
  removeServer,
  setInstall,
  useServers,
  writeRegistry,
  writeJsonAtomic,
} from "./registry.js";
import { applyToClients } from "./apply.js";
import { probe } from "./probe.js";

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const MAX_BODY = 256 * 1024;

export async function startUi({ port = 4780, ctx = {}, readyFile } = {}) {
  const server = createServer((request, response) => {
    handle(request, response, ctx, close, action).catch((error) => {
      sendJson(response, 500, { error: error.message });
    });
  });
  let closing;
  let published = false;
  let writes = Promise.resolve();
  const action = (path, method, body) => {
    if (path === "/api/probe") return apiAction(path, method, body, ctx);
    // Two dashboard tabs must not read and replace the same registry concurrently.
    const result = writes.then(() => apiAction(path, method, body, ctx));
    writes = result.catch(() => {});
    return result;
  };
  const close = () => {
    closing ??= new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }).then(async () => {
      if (published) await rm(readyFile, { force: true });
    });
    return closing;
  };

  await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`port ${port} is busy. Run 'oms ui --port <other>' or stop the other process.`)
          : error,
      );
    });
    server.listen(port, "127.0.0.1", resolve);
  });

  const actual = server.address().port;
  const url = `http://127.0.0.1:${actual}/`;
  if (readyFile !== undefined) {
    try {
      await writeJsonAtomic(readyFile, { pid: process.pid, url });
      published = true;
    } catch (error) {
      await close();
      throw error;
    }
  }
  return {
    url,
    port: actual,
    close,
  };
}

async function handle(request, response, ctx, close, action) {
  if (request.headers.host !== `127.0.0.1:${request.socket.localPort}`) {
    return sendJson(response, 403, { error: "use the dashboard's 127.0.0.1 URL" });
  }
  if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
    return sendJson(response, 403, { error: "foreign origin is not allowed" });
  }
  const url = new URL(request.url, "http://127.0.0.1");
  const path = url.pathname;

  if (path.startsWith("/api/")) {
    response.setHeader("cache-control", "no-store");
    if (request.method === "GET") {
      if (path === "/api/state") return sendJson(response, 200, await getState(ctx));
      return sendJson(response, 404, { error: "not found" });
    }

    // Local-only server; the custom header blocks cross-site form/fetch posts.
    if (request.headers["x-oms"] !== "1") {
      return sendJson(response, 403, { error: "missing x-oms header" });
    }
    try {
      const body = await readJsonBody(request);
      if (path === "/api/shutdown" && request.method === "POST") {
        response.once("finish", () => {
          close().catch((error) => console.error(`Dashboard shutdown failed: ${error.message}`));
        });
        return sendJson(response, 200, { ok: true });
      }
      return sendJson(response, 200, await action(path, request.method, body));
    } catch (error) {
      const status = error.message.startsWith("unknown api route") ? 404 : 400;
      return sendJson(response, status, { error: error.message });
    }
  }

  return serveStatic(path, response);
}

async function getState(ctx = {}) {
  const registry = await readRegistry();
  return {
    onboarded: registry.onboarded,
    install: registry.install,
    active: registry.active,
    registryPath: registryPath(),
    installationDirectory: (ctx.env ?? process.env).OMS_INSTALL_DIR ?? null,
    projectDirectory: registry.install?.projectDir ?? ctx.cwd ?? process.cwd(),
    clients: Object.entries(CLIENTS).map(([id, client]) => ({
      id,
      label: client.label,
      scopes: client.scopes,
      paths: Object.fromEntries(
        client.scopes.map((scope) => {
          try {
            return [scope, clientPath(id, scope, { ...ctx, cwd: registry.install?.projectDir ?? ctx.cwd })];
          } catch {
            return [scope, null];
          }
        }),
      ),
    })),
    servers: Object.entries(registry.servers).map(([name, server]) => ({
      name,
      kind: server.kind,
      url: server.url,
      tenant: server.tenant ?? null,
      active: registry.active.includes(name),
    })),
  };
}

async function apiAction(path, method, body, ctx = {}) {
  const registry = await readRegistry();

  if (path === "/api/onboard" && method === "POST") {
    const configured = body.server ? addInput(registry, body.server).next : registry;
    const next = await configureTarget(configured, body, ctx);
    await writeRegistry(next);
    if (body.server) {
      const results = await applyToClients(next, {
        ...next.install, ctx: { ...ctx, cwd: next.install.projectDir ?? ctx.cwd },
      });
      return { ok: results.every((result) => result.ok), results };
    }
    return { ok: true };
  }

  if (path === "/api/servers" && method === "POST") {
    const { next, server, name } = addInput(registry, body);
    await writeRegistry(next);
    return { ok: true, server: { name, ...server } };
  }

  if (path.startsWith("/api/servers/") && method === "DELETE") {
    const name = decodeURIComponent(path.slice("/api/servers/".length));
    const next = removeServer(registry, name);
    await writeRegistry(next);
    return { ok: true };
  }

  if (path === "/api/active" && method === "POST") {
    const next = useServers(registry, Array.isArray(body.names) ? body.names : []);
    await writeRegistry(next);
    return { ok: true };
  }

  if (path === "/api/apply" && method === "POST") {
    const saved = registry.install ?? {};
    const clients = Array.isArray(body.clients) && body.clients.length ? body.clients : saved.clients ?? DEFAULT_CLIENTS;
    const scope = body.scope ?? saved.scope ?? "user";
    const target = (await configureTarget(registry, { clients, scope, projectDir: body.projectDir ?? saved.projectDir }, ctx)).install;
    const results = await applyToClients(registry, {
      clients,
      scope,
      prune: body.prune !== false,
      dryRun: Boolean(body.dryRun),
      ctx: { ...ctx, cwd: target.projectDir ?? ctx.cwd },
    });
    return { ok: results.every((result) => result.ok), results };
  }

  if (path === "/api/probe" && method === "POST") {
    const names = Array.isArray(body.names) && body.names.length ? body.names : Object.keys(registry.servers);
    const results = await Promise.all(
      names.map(async (name) => {
        const server = registry.servers[name];
        if (!server) return { name, state: "unknown", detail: "not in registry" };
        const result = await probe(server.url);
        return { name, kind: server.kind, ...result };
      }),
    );
    return { ok: true, results };
  }

  throw new Error(`unknown api route: ${method} ${path}`);
}

function addInput(registry, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("server must be a JSON object");
  if (body.kind === "o11" && body.url === undefined &&
      !((typeof body.port === "number" || typeof body.port === "string") && /^\d+$/.test(String(body.port)))) {
    throw new Error("enter the Service Studio port, a whole number between 1 and 65535");
  }
  const port = body.port === undefined || body.port === "" ? undefined : Number(body.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("port must be a whole number between 1 and 65535");
  }
  const server = makeServer({
    kind: body.kind,
    tenant: body.tenant,
    url: body.url ?? (port ? `http://127.0.0.1:${port}/mcp` : undefined),
  });
  const name = String(body.name ?? "").trim();
  const next = addServer(registry, name, server, {
    activate: body.activate !== false,
    force: Boolean(body.force),
  });
  if (server.kind === "odc" && body.activate !== false) {
    next.active = next.active.filter((item) => item === name || next.servers[item]?.kind !== "odc");
  }
  next.onboarded = Boolean(next.install);
  return { next, server, name };
}

async function configureTarget(registry, { clients, scope, projectDir }, ctx) {
  const next = setInstall(registry, { clients, scope });
  for (const id of clients) {
    if (!Object.hasOwn(CLIENTS, id)) throw new Error(`unknown client: ${id}`);
    if (!CLIENTS[id].scopes.includes(scope)) throw new Error(`${CLIENTS[id].label} does not support ${scope} scope`);
  }
  if (scope === "project") {
    if (projectDir === undefined && (ctx.env ?? process.env).OMS_INSTALL_DIR) {
      throw new Error("choose the project folder; the application folder is not your project");
    }
    if (projectDir !== undefined) {
      if (typeof projectDir !== "string" || !isAbsolute(projectDir.trim())) {
        throw new Error("choose an absolute project folder");
      }
      const directory = resolve(projectDir.trim());
      const info = await stat(directory).catch(() => null);
      if (!info?.isDirectory()) throw new Error("choose an existing project folder");
      const installation = (ctx.env ?? process.env).OMS_INSTALL_DIR;
      if (installation) {
        let application = await realpath(installation).catch(() => resolve(installation));
        let project = await realpath(directory);
        if (process.platform === "win32") {
          application = application.toLowerCase();
          project = project.toLowerCase();
        }
        if (project === application || project.startsWith(`${application}${sep}`)) {
          throw new Error("choose your source project, not the application folder or its subfolders");
        }
      }
      next.install.projectDir = directory;
    }
  }
  return next;
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body is not valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("request body must be a JSON object");
  }
  return body;
}

async function serveStatic(path, response) {
  const relative = path === "/" ? "index.html" : normalize(path).replace(/^([/\\])+/, "");
  if (relative.split(/[/\\]/).includes("..")) {
    response.writeHead(403).end("forbidden");
    return;
  }
  const file = join(UI_DIR, relative);
  if (!file.startsWith(UI_DIR.endsWith(sep) ? UI_DIR : `${UI_DIR}${sep}`)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
