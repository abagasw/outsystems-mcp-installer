import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

// DOM and fetch are the browser boundary; execute the real UI functions without a DOM dependency.
const source = await readFile(new URL("../ui/app.js", import.meta.url), "utf8");
function ui(initial, result = { ok: true, results: [] }) {
  const elements = new Map();
  const queries = new Map();
  const calls = [];
  const toasts = [];
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, {
      value: "", hidden: true, disabled: false, textContent: "", innerHTML: "", open: true,
      focus() { document.activeElement = this; }, select() {}, close() { this.open = false; }, showModal() { this.open = true; },
      attributes: {}, classList: { toggle() {} }, reportValidity: () => true,
      setAttribute(key, value) { this.attributes[key] = value; },
      getAttribute(key) { return this.attributes[key] ?? null; },
      hasAttribute(key) { return Object.hasOwn(this.attributes, key); },
      removeAttribute(key) { delete this.attributes[key]; },
      append(node) { toasts.push(node.innerHTML); },
    });
    return elements.get(selector);
  };
  const document = {
    querySelector: element,
    querySelectorAll: (selector) => queries.get(selector) ?? (selector === "#clientChoices input:checked" ? [{ value: "opencode" }] : []),
    createElement: () => ({ remove() {} }),
  };
  const context = createContext({
    document, setTimeout() {}, console, confirm: () => true,
    fetch: async (path, options) => {
      if (options) {
        calls.push({ path, body: options.body ? JSON.parse(options.body) : undefined });
        if (typeof result === "function") return result(path, options);
        if (path === "/api/active") initial.active = JSON.parse(options.body).names;
        return { ok: true, json: async () => result };
      }
      return { ok: true, json: async () => initial };
    },
  });
  runInContext(source.slice(0, source.indexOf("/* ---------- wiring ---------- */")), context);
  context.initial = initial;
  runInContext("state = initial", context);
  element("#wizName").value = "tenant-a";
  element("#wizTenant").value = "tenant-a.outsystems.dev";
  element('input[name="wizScope"]:checked').value = "user";
  return { element, calls, toasts, queries, document, run: (code) => runInContext(code, context) };
}

const fresh = () => ({ servers: [], active: [], clients: [{ id: "opencode", label: "OpenCode", scopes: ["user"], paths: { user: "isolated/opencode.json" } }], registryPath: "isolated/servers.json", install: null });

test("wizard defers writes until the server and client settings are confirmed", async () => {
  const app = ui(fresh(), { ok: false, results: [{ client: "opencode", label: "OpenCode", ok: false, error: "fixture write failed" }] });
  await app.run("wizardContinue()");
  assert.deepEqual(app.calls, []);
  await app.run("wizardFinish()");
  assert.deepEqual(app.calls.map((call) => call.path), ["/api/onboard"]);
  assert.equal(app.calls[0].body.server.tenant, "tenant-a.outsystems.dev");
  assert.match(app.element("#applyError").textContent, /fixture write failed/);
  assert.equal(app.toasts.some((text) => /Written to the clients you chose/.test(text)), false);
});

test("server type buttons enable only the matching required fields", () => {
  for (const prefix of ["wiz", "add"]) {
    let click;
    const tenant = { disabled: false };
    const port = { disabled: true };
    const fields = [
      { dataset: { for: "odc" }, hidden: false, querySelectorAll: () => [tenant] },
      { dataset: { for: "o11" }, hidden: true, querySelectorAll: () => [port] },
    ];
    const buttons = ["odc", "o11"].map((kind) => ({
      dataset: { kind }, classList: { toggle() {} }, setAttribute() {},
      closest() { return this; },
    }));
    const name = { value: "custom-name", closest: () => ({ querySelectorAll: () => fields }) };
    const context = createContext({ document: {
      querySelector: (selector) => selector === `#${prefix}Name` ? name : { addEventListener: (_, handler) => { click = handler; } },
      querySelectorAll: () => buttons,
    } });
    const wiring = source.slice(source.indexOf("function bindKind("), source.indexOf('document.addEventListener("click"'));
    runInContext(source.slice(0, source.indexOf("/* ---------- wiring ---------- */")) + wiring, context);
    runInContext(`bindKind("${prefix}Kind", "${prefix}", () => {})`, context);
    click({ target: buttons[1] });
    assert.equal(port.disabled, false, `${prefix}: visible O11 port must accept input`);
    assert.equal(tenant.disabled, true, `${prefix}: hidden tenant must not block validation`);
    assert.equal(fields[0].hidden, true);
    assert.equal(fields[1].hidden, false);
    assert.equal(name.value, "custom-name");
    click({ target: buttons[0] });
    assert.equal(tenant.disabled, false);
    assert.equal(port.disabled, true);
  }
});

test("installed setup does not suggest the application folder as a project", () => {
  const app = ui({ ...fresh(), installationDirectory: "C:/Application", projectDirectory: "C:/Application" });
  app.run("showWizard(1)");
  assert.equal(app.element("#wizProjectDir").value, "");
});

test("selecting an ODC tenant replaces the previous ODC selection but keeps O11", async () => {
  const app = ui({ ...fresh(), active: ["tenant-a", "studio"], servers: [
    { name: "tenant-a", kind: "odc" }, { name: "tenant-b", kind: "odc" }, { name: "studio", kind: "o11" },
  ] });
  await app.run('toggleActive("tenant-b")');
  assert.deepEqual(app.calls[0].body.names, ["studio", "tenant-b"]);
  await app.run('toggleActive("tenant-b")');
  assert.deepEqual(app.calls[1].body.names, ["studio"]);
});

for (const action of ["submitAdd", "wizardFinish"]) {
  test(`${action} ignores duplicate submits while saving`, async () => {
    let complete;
    const pending = new Promise((resolve) => { complete = resolve; });
    const app = ui(fresh(), pending);
    app.element("#addName").value = "tenant-a";
    app.element("#addTenant").value = "tenant-a.outsystems.dev";
    const first = app.run(`${action}()`);
    const duplicate = app.run(`${action}()`);
    const saves = app.calls.filter((call) => call.path === "/api/servers" || call.path === "/api/onboard").length;
    complete({ ok: true, results: [] });
    await Promise.all([first, duplicate]);
    assert.equal(saves, 1, action);
    assert.equal(app.element(action === "submitAdd" ? "#addSubmit" : "#wizFinish").disabled, false);
  });
}

test("saving a server does not send an endpoint probe", async () => {
  const app = ui(fresh());
  app.element("#addName").value = "tenant-a";
  app.element("#addTenant").value = "tenant-a.outsystems.dev";
  await app.run("submitAdd()");
  assert.deepEqual(app.calls.map((call) => call.path), ["/api/servers"]);
});

test("endpoint labels do not claim the client's sign-in status", () => {
  const app = ui(fresh());
  assert.equal(app.run('health.set("tenant-a", { state: "ok" }); healthLabel("tenant-a")'), "Endpoint replied");
  assert.equal(app.run('health.set("tenant-a", { state: "auth" }); healthLabel("tenant-a")'), "HTTP 401/403");
});

for (const [kind, field, value, message] of [
  ["odc", "Name", "Bad Name", /name/],
  ["odc", "Tenant", "https:///mcp", /tenant/],
  ["o11", "Port", "65536", /port/],
]) {
  test(`add form rejects an invalid ${field.toLowerCase()} before saving`, async () => {
    const app = ui(fresh());
    app.element("#addName").value = "studio";
    app.element("#addTenant").value = "a.outsystems.dev";
    app.element(`#add${field}`).value = value;
    await app.run(`addKind = "${kind}"; submitAdd()`);
    assert.equal(app.calls.length, 0);
    assert.match(app.element("#addError").textContent, message);
    assert.equal(app.element(`#add${field}`).getAttribute("aria-invalid"), "true");
    assert.equal(app.document.activeElement, app.element(`#add${field}`));
  });
}

test("wizard keeps an invalid tenant on the server step", async () => {
  const app = ui(fresh());
  app.element("#wizTenant").value = "bad host";
  await app.run("wizardContinue()");
  assert.match(app.element("#wizServerError").textContent, /tenant/);
  assert.notEqual(app.element("#wizardTitle").textContent, "Choose MCP clients");
  assert.equal(app.document.activeElement, app.element("#wizTenant"));
});

for (const [action, form] of [["submitAdd", "#addForm"], ["wizardFinish", "#wizardClientForm"]]) {
  test(`${action} respects native form validation`, async () => {
    const app = ui(fresh());
    app.element("#addName").value = "studio";
    app.element(form).reportValidity = () => false;
    await app.run(`${action}()`);
    assert.equal(app.calls.length, 0);
  });
}

test("project scope requires a folder and does not preview an application config path", () => {
  const app = ui({ ...fresh(), installationDirectory: "C:/Application", projectDirectory: "C:/Application",
    clients: [{ id: "opencode", label: "OpenCode", scopes: ["user", "project"], paths: {
      user: "isolated/opencode.json", project: "C:/Application/opencode.json",
    } }],
  });
  app.element('input[name="wizScope"]:checked').value = "project";
  app.run("updateScopeRules()");
  assert.equal(app.element("#wizProjectDir").required, true);
  assert.equal(app.element("#wizProjectDir").disabled, false);
  assert.match(app.element('#clientChoices small[data-path="opencode"]').textContent, /Choose a project folder/);
  app.element("#wizProjectDir").value = "C:/Source project";
  app.run("updateScopeRules()");
  assert.equal(app.element('#clientChoices small[data-path="opencode"]').textContent, "C:/Source project/opencode.json");
  app.element('input[name="wizScope"]:checked').value = "user";
  app.run("updateScopeRules()");
  assert.equal(app.element("#wizProjectDir").disabled, true);
  assert.equal(app.element("#wizProjectDir").required, false);
});

test("client step focuses its first control instead of the submit button", () => {
  const app = ui(fresh());
  app.run("setWizardStep(2)");
  assert.equal(app.document.activeElement, app.element('input[name="wizScope"]:checked'));
});

for (const attribute of ["data-toggle", "data-chip", "data-check", "data-change-target"]) {
  test(`render preserves keyboard focus on ${attribute}`, () => {
    const app = ui(fresh());
    const before = app.element("#old-control");
    const after = app.element("#new-control");
    before.setAttribute(attribute, "tenant-a");
    after.setAttribute(attribute, "tenant-a");
    app.queries.set(`[${attribute}]`, [after]);
    before.focus();
    app.run("render()");
    assert.equal(app.document.activeElement, after);
  });
}

for (const action of ['toggleActive("studio")', 'removeServer("studio")', 'probeServers(["studio"])']) {
  test(`${action} keeps API failures visible in the dashboard`, async () => {
    const app = ui({ ...fresh(), servers: [{ name: "studio", kind: "o11" }], active: ["studio"] }, () => ({
      ok: false, status: 503, json: async () => ({ error: "fixture backend unavailable" }),
    }));
    await app.run(action);
    assert.equal(app.element("#actionError").hidden, false);
    assert.match(app.element("#actionError").textContent, /fixture backend unavailable/);
  });
}

for (const [action, dialog] of [["submitAdd", "#addDialog"], ["wizardFinish", "#wizard"]]) {
  test(`${action} keeps errors visible if the dialog closes during saving`, async () => {
    let complete;
    const pending = new Promise((resolve) => { complete = resolve; });
    const app = ui(fresh(), () => pending);
    app.element("#addName").value = "tenant-a";
    app.element("#addTenant").value = "a.outsystems.dev";
    const saving = app.run(`${action}()`);
    app.element(dialog).close();
    complete({ ok: false, status: 503, json: async () => ({ error: "fixture save failed" }) });
    await saving;
    assert.equal(app.element("#actionError").hidden, false);
    assert.match(app.element("#actionError").textContent, /fixture save failed/);
  });
}

test("selection waits for its current save before accepting another toggle", async () => {
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const app = ui({ ...fresh(), servers: [{ name: "a", kind: "o11" }, { name: "b", kind: "o11" }] }, pending);
  const first = app.run('toggleActive("a")');
  const second = app.run('toggleActive("b")');
  const saves = app.calls.length;
  complete({ ok: true });
  await Promise.all([first, second]);
  assert.equal(saves, 1);
  await app.run('toggleActive("b")');
  assert.deepEqual(app.calls[1].body.names, ["a", "b"]);
});

test("an endpoint check cannot start twice for the same server", async () => {
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const app = ui({ ...fresh(), servers: [{ name: "studio", kind: "o11" }] }, pending);
  const first = app.run('probeServers(["studio"])');
  const duplicate = app.run('probeServers(["studio"])');
  const checks = app.calls.length;
  complete({ results: [{ name: "studio", state: "ok", detail: "HTTP 200" }] });
  await Promise.all([first, duplicate]);
  assert.equal(checks, 1);
});

test("endpoint check details are visible rather than only a tooltip", () => {
  const app = ui({ ...fresh(), servers: [{ name: "studio", kind: "o11" }] });
  app.run('health.set("studio", { state: "unreachable", detail: "connection refused" }); render()');
  assert.match(app.element("#serverRows").innerHTML, /<small class="check-detail">connection refused<\/small>/);
});

for (const action of ['toggleActive("studio")', 'removeServer("studio")', 'probeServers(["studio"])']) {
  test(`${action} clears its error after a successful retry`, async () => {
    let attempt = 0;
    const app = ui({ ...fresh(), servers: [{ name: "studio", kind: "o11" }], active: ["studio"] }, () => ({
      ok: ++attempt > 1, status: 503,
      json: async () => ({ error: "fixture failure", results: [{ name: "studio", state: "ok" }] }),
    }));
    await app.run(action);
    assert.equal(app.element("#actionError").hidden, false);
    await app.run(action);
    assert.equal(app.element("#actionError").hidden, true);
  });
}
