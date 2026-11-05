const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const KIND_DEFAULTS = { odc: "outsystems", o11: "servicestudio" };
const HEALTH_LABEL = {
  ok: "Endpoint replied",
  auth: "HTTP 401/403",
  unreachable: "Unreachable",
  error: "Error",
  unknown: "Not checked",
  busy: "Checking…",
};

let state = null;
const health = new Map();
let wizardKind = "odc";
let addKind = "odc";
let selectionBusy = false;

/* ---------- api ---------- */

async function getState() {
  const response = await fetch("/api/state");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function api(path, body, method = "POST") {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-oms": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

/* ---------- helpers ---------- */

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function ledClass(name) {
  const entry = health.get(name);
  if (!entry) return "";
  if (entry.state === "ok") return "ok";
  if (entry.state === "auth") return "auth";
  if (entry.state === "unreachable" || entry.state === "error") return "down";
  if (entry.state === "busy") return "busy";
  return "";
}

function healthLabel(name) {
  const entry = health.get(name);
  return HEALTH_LABEL[entry?.state ?? "unknown"];
}

function toast(title, detail = "", kind = "") {
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.innerHTML = `<strong>${esc(title)}</strong>${detail ? `<span>${esc(detail)}</span>` : ""}`;
  $("#toasts").append(node);
  setTimeout(() => node.remove(), 6500);
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function hideError(element) {
  element.hidden = true;
  element.textContent = "";
}

function restoreFocus(previous) {
  const attribute = ["data-toggle", "data-chip", "data-check", "data-remove", "data-change-target"]
    .find((name) => previous?.hasAttribute(name));
  if (!attribute) {
    if (previous?.isConnected && !previous.disabled) previous.focus();
    return;
  }
  const replacement = $$(`[${attribute}]`).find((node) => node.getAttribute(attribute) === previous.getAttribute(attribute));
  (replacement ?? $("#btnAdd")).focus();
}

/* ---------- render ---------- */

function render() {
  const focused = document.activeElement;
  const { servers, active, registryPath, install, clients } = state;
  const activeCount = active.length;

  $("#subtitle").textContent = `${servers.length} server${servers.length === 1 ? "" : "s"} · ${registryPath}`;
  $("#activeHint").textContent = servers.length
    ? `${activeCount} of ${servers.length} selected. ${activeCount ? "Apply writes this selection to the client config." : "Apply removes registered servers from the client config."}`
    : "Add a server, then apply its config to your MCP client.";
  $("#installationLocation").hidden = !state.installationDirectory;
  $("#installationLocation").textContent = `Application folder: ${state.installationDirectory ?? ""}`;
  $("#loadingState").hidden = true;
  $("#loadError").hidden = true;
  $("#btnAdd").disabled = false;
  $("#btnApply").disabled = !install;
  $("#btnProbe").disabled = !servers.length || servers.every((server) => health.get(server.name)?.state === "busy");

  renderInstallTarget(install, clients);
  renderRows(servers, active);
  renderTray(servers, active);

  $("#emptyState").hidden = servers.length > 0;
  $(".table-wrap").hidden = servers.length === 0;
  restoreFocus(focused);
}

function renderInstallTarget(install, clients) {
  const node = $("#installTarget");
  if (!install) {
    node.innerHTML = `<span class="target">Client config <b>not set</b></span><button class="link" type="button" data-change-target>Choose clients</button>`;
    return;
  }
  const labels = install.clients
    .map((id) => clients.find((client) => client.id === id)?.label ?? id)
    .join(", ");
  node.innerHTML = `
    <span class="target">Client config: <b>${esc(labels)}</b> · ${esc(install.scope)}</span>
    <button class="link" type="button" data-change-target>Change clients</button>`;
}

function renderRows(servers, active) {
  $("#serverRows").innerHTML = servers
    .map((server) => {
      const isActive = active.includes(server.name);
      return `
      <tr>
        <td data-label="Server">
          <div class="name">${esc(server.name)}<small>${server.kind === "odc" ? "ODC tenant" : "Service Studio"}</small></div>
        </td>
        <td data-label="Type"><span class="badge ${server.kind}">${server.kind.toUpperCase()}</span></td>
        <td data-label="Endpoint"><div class="endpoint" title="${esc(server.url)}">${esc(server.url)}</div></td>
        <td data-label="Endpoint check">
          <span class="health" title="${esc(health.get(server.name)?.detail ?? "")}">
            <span class="led ${ledClass(server.name)}"></span>${healthLabel(server.name)}
          </span>
          ${health.get(server.name)?.detail ? `<small class="check-detail">${esc(health.get(server.name).detail)}</small>` : ""}
        </td>
        <td data-label="Selected">
          <button class="switch" type="button" role="switch" aria-checked="${isActive}"
            aria-label="Select ${esc(server.name)}" data-toggle="${esc(server.name)}" ${selectionBusy ? "disabled" : ""}></button>
        </td>
        <td data-label="Actions">
          <div class="row-actions">
            <button class="icon-btn" type="button" data-check="${esc(server.name)}" ${health.get(server.name)?.state === "busy" ? "disabled" : ""}>Check</button>
            <button class="icon-btn danger" type="button" data-remove="${esc(server.name)}">Remove</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");
}

function renderTray(servers, active) {
  const list = $("#trayList");
  $("#trayHint").textContent = state.installationDirectory
    ? "Reopen from the Windows tray icon. Apply and reload your MCP client after changes."
    : "Select a server, then Apply and reload your MCP client.";
  if (!servers.length) {
    list.innerHTML = `<li class="tray-empty">No servers yet. Add one to see it here.</li>`;
    return;
  }
  list.innerHTML = servers
    .map((server) => {
      const isActive = active.includes(server.name);
      return `<li>
        <button class="chip" type="button" aria-pressed="${isActive}" data-chip="${esc(server.name)}"
          ${selectionBusy ? "disabled" : ""}
          title="${isActive ? "Deselect" : "Select"} ${esc(server.name)}">
          <span class="led ${ledClass(server.name)}"></span>${esc(server.name)}
          <span class="kind">${server.kind.toUpperCase()}</span>
        </button>
      </li>`;
    })
    .join("");
}

/* ---------- actions ---------- */

async function refresh() {
  state = await getState();
  render();
}

async function toggleActive(name) {
  if (selectionBusy) return;
  const focused = document.activeElement;
  selectionBusy = true;
  $$("[data-toggle], [data-chip]").forEach((button) => { button.disabled = true; });
  const isOdc = state.servers.find((server) => server.name === name)?.kind === "odc";
  const names = state.active.includes(name)
    ? state.active.filter((item) => item !== name)
    : [...state.active.filter((item) => !isOdc || state.servers.find((server) => server.name === item)?.kind !== "odc"), name];
  try {
    await api("/api/active", { names });
    await refresh();
    hideError($("#actionError"));
    toast(state.active.includes(name) ? "Server selected" : "Server deselected", "Run Apply to write this to the client config.");
  } catch (error) {
    showError($("#actionError"), `Could not save the server selection: ${error.message}`);
    toast("Could not change active set", error.message, "bad");
  } finally {
    selectionBusy = false;
    $$("[data-toggle], [data-chip]").forEach((button) => { button.disabled = false; });
    restoreFocus(focused);
  }
}

async function applyAll() {
  const button = $("#btnApply");
  button.disabled = true;
  button.textContent = "Applying…";
  try {
    reportApply((await api("/api/apply", {})).results);
  } catch (error) {
    showError($("#applyError"), error.message);
    toast("Apply failed", error.message, "bad");
  } finally {
    button.disabled = false;
    button.textContent = "Apply to clients";
  }
}

function reportApply(results) {
  const failed = results.filter((result) => !result.ok);
  if (failed.length) {
    showError($("#applyError"), failed.map((result) => `${result.label ?? result.client}: ${result.error}`).join("\n"));
  } else {
    hideError($("#applyError"));
  }
  for (const result of results.filter((item) => item.ok)) {
    const summary = result.changes?.filter((change) => change.action !== "unchanged")
      .map((change) => `${change.action} ${change.name}`).join(", ") || "already up to date";
    toast(`${result.label}: ${summary}`, result.file);
  }
  return failed.length === 0;
}

async function probeServers(names) {
  const targets = (names?.length ? names : state.servers.map((server) => server.name))
    .filter((name) => health.get(name)?.state !== "busy");
  if (!targets.length) return;
  const focused = document.activeElement;
  for (const name of targets) health.set(name, { state: "busy" });
  render();
  try {
    const { results } = await api("/api/probe", { names: targets });
    for (const result of results) health.set(result.name, { state: result.state, detail: result.detail });
    hideError($("#actionError"));
  } catch (error) {
    for (const name of targets) health.set(name, { state: "error", detail: error.message });
    showError($("#actionError"), `Endpoint check failed: ${error.message}`);
  }
  render();
  restoreFocus(focused);
}

async function removeServer(name) {
  if (!confirm(`Remove ${name} from the registry? The client config is cleaned up on the next Apply.`)) return;
  try {
    await api(`/api/servers/${encodeURIComponent(name)}`, undefined, "DELETE");
    health.delete(name);
    await refresh();
    hideError($("#actionError"));
    toast("Server removed", name);
  } catch (error) {
    showError($("#actionError"), `Could not remove the server: ${error.message}`);
    toast("Could not remove server", error.message, "bad");
  }
}

/* ---------- wizard ---------- */

function renderClientChoices() {
  const node = $("#clientChoices");
  node.innerHTML = state.clients
    .map((client) => `
      <label class="choice">
        <input type="checkbox" value="${esc(client.id)}" ${(state.install?.clients ?? ["opencode"]).includes(client.id) ? "checked" : ""}>
        <span>${esc(client.label)}<small data-path="${esc(client.id)}" title=""></small></span>
      </label>`)
    .join("");
  updateScopeRules();
}

function currentScope() {
  return $('input[name="wizScope"]:checked')?.value ?? "user";
}

function updateScopeRules() {
  const scope = currentScope();
  $("#wizProjectField").hidden = scope !== "project";
  $("#wizProjectDir").disabled = scope !== "project";
  $("#wizProjectDir").required = scope === "project";
  for (const client of state.clients) {
    const input = $(`#clientChoices input[value="${client.id}"]`);
    const hint = $(`#clientChoices small[data-path="${client.id}"]`);
    const supported = client.scopes.includes(scope);
    input.disabled = !supported;
    if (!supported) input.checked = false;
    hint.textContent = supported
      ? client.paths[scope]
      : `${scope} scope not supported; use ${client.scopes.join(" or ")}`;
    if (supported && scope === "project") {
      const directory = $("#wizProjectDir").value.trim().replace(/[/\\]+$/, "");
      hint.textContent = directory
        ? directory + client.paths.project.slice(state.projectDirectory.replace(/[/\\]+$/, "").length)
        : "Choose a project folder to see this config path.";
    }
    hint.title = hint.textContent;
  }
}

function showWizard(step) {
  const dialog = $("#wizard");
  $$("input[name='wizScope']").forEach((input) => { input.checked = input.value === (state.install?.scope ?? "user"); });
  $("#wizProjectDir").value = state.install?.projectDir ?? (state.installationDirectory ? "" : state.projectDirectory);
  renderClientChoices();
  $("#wizardLocation").hidden = !state.installationDirectory;
  $("#wizardLocation").textContent = `Installed in ${state.installationDirectory ?? ""}`;
  hideError($("#wizError"));
  hideError($("#wizServerError"));
  if (!dialog.open) dialog.showModal();
  setWizardStep(step);
}

function setWizardStep(step) {
  $$("#wizardSteps li").forEach((item) => item.classList.toggle("is-on", Number(item.dataset.stepDot) === step));
  $$("#wizard .wizard-step").forEach((section) => {
    section.hidden = Number(section.dataset.step) !== step;
  });
  const title = $("#wizardTitle");
  const sub = $("#wizardSub");
  if (step === 1) {
    title.textContent = "Add your first server";
    sub.textContent = "ODC needs a tenant hostname. Service Studio needs the port it shows.";
  } else {
    title.textContent = "Choose MCP clients";
    sub.textContent = "Review the config paths before writing. Existing files get a .bak backup.";
  }
  $("#wizBack").hidden = state.servers.length > 0;
  $("#wizardSteps").hidden = state.servers.length > 0;
  $("#wizFinish").textContent = state.servers.length ? "Save client settings" : "Add server and apply";
  if (step === 1) $("#wizName").focus();
  else $('input[name="wizScope"]:checked').focus();
}

async function wizardContinue() {
  const error = $("#wizServerError");
  hideError(error);
  try {
    if (!$("#wizardServerForm").reportValidity()) return;
    serverPayload(wizardKind, "wiz", $("#wizName").value.trim());
    setWizardStep(2);
  } catch (problem) {
    showError(error, problem.message);
  }
}

async function wizardFinish() {
  const button = $("#wizFinish");
  if (button.disabled) return;
  const error = $("#wizError");
  hideError(error);
  if (!$("#wizardClientForm").reportValidity()) return;
  const clients = $$("#clientChoices input:checked").map((input) => input.value);
  if (!clients.length) {
    showError(error, "Choose at least one MCP client.");
    return;
  }
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const scope = currentScope();
    const payload = { clients, scope };
    if (scope === "project") payload.projectDir = $("#wizProjectDir").value.trim();
    const first = !state.servers.length;
    if (first) payload.server = serverPayload(wizardKind, "wiz", $("#wizName").value.trim());
    const result = await api("/api/onboard", payload);
    $("#wizard").close();
    await refresh();
    if (first) {
      const applied = reportApply(result.results);
      toast("Server saved", applied ? "Client config updated. Reload your MCP client, then sign in there." : "Client config needs attention. Fix the error above, then Apply.", applied ? "" : "bad");
    } else {
      toast("Client settings saved", "Apply to write the selected servers to these clients.");
    }
  } catch (problem) {
    showError($("#wizard").open ? error : $("#actionError"), problem.message);
  } finally {
    button.disabled = false;
    button.textContent = state.servers.length ? "Save client settings" : "Add server and apply";
  }
}

/* ---------- add dialog ---------- */

function serverPayload(kind, prefix, name) {
  const reject = (field, message) => invalidField($(`#${prefix}${field}`), prefix === "wiz" ? "wizServerError" : "addError", message);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    reject("Name", "Use a server name with lowercase letters, digits, hyphens, and underscores, starting with a letter or digit.");
  }
  if (state.servers.some((server) => server.name === name)) reject("Name", "That server name is already saved. Choose another name.");
  const payload = { kind, name, activate: true };
  if (kind === "odc") {
    const tenant = $(`#${prefix}Tenant`).value.trim();
    const host = tenant.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0].replace(/^www\./i, "").replace(/:\d+$/, "");
    if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
      reject("Tenant", "Enter a tenant hostname, for example mycompany.outsystems.dev.");
    }
    payload.tenant = tenant;
  } else {
    const port = Number($(`#${prefix}Port`).value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) reject("Port", "Enter the Service Studio port, a whole number between 1 and 65535.");
    payload.port = port;
  }
  return payload;
}

function invalidField(input, errorId, message) {
  input.setAttribute("aria-invalid", "true");
  input.setAttribute("aria-describedby", errorId);
  input.focus();
  throw new Error(message);
}

function openAdd() {
  const dialog = $("#addDialog");
  hideError($("#addError"));
  $("#addName").value = KIND_DEFAULTS[addKind];
  if (!dialog.open) dialog.showModal();
  $("#addName").focus();
  $("#addName").select();
}

async function submitAdd() {
  const button = $("#addSubmit");
  if (button.disabled) return;
  const error = $("#addError");
  hideError(error);
  if (!$("#addForm").reportValidity()) return;
  const name = $("#addName").value.trim();
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    await api("/api/servers", serverPayload(addKind, "add", name));
    $("#addDialog").close();
    await refresh();
    toast("Server selected", "Run Apply and reload your MCP client. Endpoint checks run only when you choose Check.");
  } catch (problem) {
    showError($("#addDialog").open ? error : $("#actionError"), problem.message);
  } finally {
    button.disabled = false;
    button.textContent = "Add server";
  }
}

/* ---------- wiring ---------- */

function bindKind(containerId, prefix, onChange) {
  $(`#${containerId}`).addEventListener("click", (event) => {
    const button = event.target.closest(".seg-btn");
    if (!button) return;
    const kind = button.dataset.kind;
    $$(`#${containerId} .seg-btn`).forEach((item) => {
      const on = item === button;
      item.classList.toggle("is-on", on);
      item.setAttribute("aria-pressed", String(on));
    });
    const nameInput = $(`#${prefix}Name`);
    if (!nameInput.value.trim() || Object.values(KIND_DEFAULTS).includes(nameInput.value.trim())) {
      nameInput.value = KIND_DEFAULTS[kind];
    }
    $$(`[data-for]`, $(`#${prefix}Name`).closest("dialog")).forEach((field) => {
      field.hidden = field.dataset.for !== kind;
      $$("input", field).forEach((input) => { input.disabled = field.hidden; });
    });
    onChange(kind);
  });
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (target.closest("[data-open-add]") || target.closest("#btnAdd")) return openAdd();
  if (target.closest("[data-close-add]")) return $("#addDialog").close();
   if (target.closest("[data-change-target]")) return showWizard(2);
  const toggle = target.closest("[data-toggle]");
  if (toggle) return toggleActive(toggle.dataset.toggle);
  const chip = target.closest("[data-chip]");
  if (chip) return toggleActive(chip.dataset.chip);
  const remove = target.closest("[data-remove]");
  if (remove) return removeServer(remove.dataset.remove);
  const check = target.closest("[data-check]");
  if (check) return probeServers([check.dataset.check]);
});

$("#btnApply").addEventListener("click", applyAll);
$("#btnProbe").addEventListener("click", () => probeServers());
$("#wizardServerForm").addEventListener("submit", (event) => { event.preventDefault(); wizardContinue(); });
$("#wizBack").addEventListener("click", () => setWizardStep(1));
$("#wizardClientForm").addEventListener("submit", (event) => { event.preventDefault(); wizardFinish(); });
$("#wizSkip").addEventListener("click", () => $("#wizard").close());
$("#addForm").addEventListener("submit", (event) => { event.preventDefault(); submitAdd(); });
$("#wizProjectDir").addEventListener("input", updateScopeRules);

for (const id of ["wizardServerForm", "wizardClientForm", "addForm"]) {
  const form = $(`#${id}`);
  form.addEventListener("invalid", (event) => {
    const error = $(".form-error", form);
    event.target.setAttribute("aria-invalid", "true");
    event.target.setAttribute("aria-describedby", error.id);
    if (error.hidden) showError(error, event.target.validationMessage);
  }, true);
  form.addEventListener("input", (event) => event.target.removeAttribute("aria-invalid"));
}

$$('input[name="wizScope"]').forEach((input) => input.addEventListener("change", updateScopeRules));

bindKind("wizKind", "wiz", (kind) => { wizardKind = kind; });
bindKind("addKind", "add", (kind) => { addKind = kind; });

async function boot() {
  $("#loadingState").hidden = false;
  $("#loadError").hidden = true;
  try {
    await refresh();
    if (!state.servers.length) showWizard(1);
  } catch (error) {
    $("#loadingState").hidden = true;
    $("#loadError").hidden = false;
    $("#loadErrorText").textContent = `Cannot read the registry: ${error.message}`;
    $("#subtitle").textContent = "Registry unavailable";
  }
}
$("#btnRetry").addEventListener("click", boot);
boot();
