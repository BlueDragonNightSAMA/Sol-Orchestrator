const session = new URLSearchParams(window.location.search).get("session") || "";
const apiUrl = (path) => `${path}?session=${encodeURIComponent(session)}`;

const elements = {
  form: document.querySelector("#config-form"),
  workspace: document.querySelector("#workspace"),
  status: document.querySelector("#connection-status"),
  message: document.querySelector("#message"),
  save: document.querySelector("#save"),
  reload: document.querySelector("#reload"),
  profileList: document.querySelector("#profile-list"),
  endpointList: document.querySelector("#endpoint-list"),
  profileTemplate: document.querySelector("#profile-template"),
  endpointTemplate: document.querySelector("#endpoint-template"),
  solModel: document.querySelector("#sol-model"),
  reviewModel: document.querySelector("#review-model"),
  workerModels: document.querySelector("#worker-models"),
  mode: document.querySelector("#mode"),
  executionBackend: document.querySelector("#execution-backend"),
  artifactMode: document.querySelector("#artifact-mode"),
  taskAuto: document.querySelector("#task-auto"),
  tasksPerBatch: document.querySelector("#tasks-per-batch"),
  maxTasks: document.querySelector("#max-tasks"),
  maxParallel: document.querySelector("#max-parallel"),
  requestTimeout: document.querySelector("#request-timeout"),
  maxRetries: document.querySelector("#max-retries"),
  retryBase: document.querySelector("#retry-base")
};

let profiles = [];
let assignments = { solModel: "", reviewModel: "", workerModels: [] };
let revision = "";
let dirty = false;
let loaded = false;
let saving = false;

function setConnection(state, text) {
  elements.status.dataset.state = state;
  elements.status.textContent = text;
}

function setMessage(text, kind = "") {
  elements.message.textContent = text;
  elements.message.className = kind;
}

function setDirty(value) {
  dirty = value;
  elements.save.disabled = !dirty || saving;
  if (loaded) setConnection(dirty ? "dirty" : "ready", dirty ? "有改动" : "已保存");
}

function profileNames() {
  return profiles.map((profile) => profile.name).filter(Boolean);
}

function normalizeAssignments() {
  const names = profileNames();
  if (!names.includes(assignments.solModel)) assignments.solModel = names[0] || "";
  if (!names.includes(assignments.reviewModel)) assignments.reviewModel = assignments.solModel;
  assignments.workerModels = assignments.workerModels.filter((name) => names.includes(name));
  if (!assignments.workerModels.length && names.length) assignments.workerModels = [names.find((name) => name !== assignments.solModel) || names[0]];
}

function renderAssignments() {
  normalizeAssignments();
  const names = profileNames();
  for (const [select, selected] of [[elements.solModel, assignments.solModel], [elements.reviewModel, assignments.reviewModel]]) {
    select.replaceChildren(...names.map((name) => new Option(name, name, false, name === selected)));
  }
  elements.workerModels.replaceChildren(...names.map((name) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = name;
    input.checked = assignments.workerModels.includes(name);
    input.addEventListener("change", () => {
      assignments.workerModels = [...elements.workerModels.querySelectorAll("input:checked")].map((item) => item.value);
    });
    const text = document.createElement("span");
    text.textContent = name;
    label.append(input, text);
    return label;
  }));
}

function renderProfiles() {
  elements.profileList.replaceChildren();
  profiles.forEach((profile, index) => {
    const row = elements.profileTemplate.content.firstElementChild.cloneNode(true);
    for (const input of row.querySelectorAll("[data-field]")) {
      const field = input.dataset.field;
      input.value = profile[field] ?? "";
      input.addEventListener(field === "name" ? "change" : "input", () => {
        if (field === "name") {
          const oldName = profile.name;
          profile.name = input.value.trim();
          if (assignments.solModel === oldName) assignments.solModel = profile.name;
          if (assignments.reviewModel === oldName) assignments.reviewModel = profile.name;
          assignments.workerModels = assignments.workerModels.map((name) => name === oldName ? profile.name : name);
          renderAssignments();
          renderEndpoints();
        } else {
          profile[field] = input.value;
          if (field === "model") renderEndpoints();
        }
      });
    }
    row.querySelector(".remove-profile").addEventListener("click", () => {
      if (profiles.length === 1) {
        setMessage("至少保留一个模型配置。", "error");
        return;
      }
      profiles.splice(index, 1);
      renderProfiles();
      renderAssignments();
      renderEndpoints();
      setDirty(true);
    });
    elements.profileList.append(row);
  });
}

function renderEndpoints() {
  elements.endpointList.replaceChildren();
  profiles.forEach((profile) => {
    const row = elements.endpointTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector('[data-label="name"]').textContent = profile.name || "未命名模型";
    row.querySelector('[data-label="model"]').textContent = profile.model || "未设置模型 ID";
    const status = row.querySelector('[data-label="state"]');
    const updateStatus = () => {
      if (!profile.baseUrl) {
        status.dataset.state = "missing";
        status.textContent = "待配置端点";
      } else if (!profile.apiKeyEnv) {
        status.dataset.state = "ready";
        status.textContent = "端点已设置";
      } else if (profile.apiKeyAvailable === true) {
        status.dataset.state = "ready";
        status.textContent = "密钥可用";
      } else if (profile.apiKeyAvailable === null) {
        status.dataset.state = "warning";
        status.textContent = "保存后检查";
      } else {
        status.dataset.state = "warning";
        status.textContent = "密钥未加载";
      }
    };
    for (const input of row.querySelectorAll("[data-field]")) {
      const field = input.dataset.field;
      if (input.type === "checkbox") input.checked = Boolean(profile[field]);
      else input.value = profile[field] ?? "";
      input.addEventListener("input", () => {
        profile[field] = input.type === "checkbox" ? input.checked : input.value;
        if (field === "apiKeyEnv") profile.apiKeyAvailable = null;
        if (["baseUrl", "apiKeyEnv"].includes(field)) updateStatus();
      });
    }
    updateStatus();
    elements.endpointList.append(row);
  });
}

function applyConfig(workspace, config, nextRevision) {
  elements.workspace.textContent = workspace;
  profiles = Object.entries(config.models).map(([name, profile]) => ({
    name,
    model: profile.model || "",
    baseUrl: profile.baseUrl || "",
    apiKeyEnv: profile.apiKeyEnv || "",
    reasoningEffort: profile.reasoningEffort || "default",
    reasoningField: profile.reasoningField ?? "reasoning_effort",
    maxTokensField: profile.maxTokensField ?? "max_tokens",
    temperatureEnabled: Boolean(profile.temperatureEnabled),
    apiKeyAvailable: Boolean(profile.apiKeyAvailable)
  }));
  assignments = {
    solModel: config.solModel,
    reviewModel: config.reviewModel,
    workerModels: [...config.workerModels]
  };
  elements.mode.value = config.mode;
  elements.executionBackend.value = config.executionBackend;
  elements.artifactMode.value = config.artifactMode;
  const tokenInput = document.querySelector(`input[name="token-mode"][value="${config.tokenMode}"]`);
  if (tokenInput) tokenInput.checked = true;
  elements.taskAuto.checked = config.tasksPerBatch === 0;
  elements.tasksPerBatch.value = config.tasksPerBatch || Math.min(2, config.maxTasksPerRun);
  elements.tasksPerBatch.disabled = elements.taskAuto.checked;
  elements.maxTasks.value = config.maxTasksPerRun;
  elements.maxParallel.value = config.maxParallel;
  elements.requestTimeout.value = config.requestTimeoutMs;
  elements.maxRetries.value = config.maxRetries;
  elements.retryBase.value = config.retryBaseMs;
  renderProfiles();
  renderAssignments();
  renderEndpoints();
  revision = nextRevision || "";
  loaded = true;
  setDirty(false);
}

function numberValue(input) {
  return Number.parseInt(input.value, 10);
}

function buildPayload() {
  const names = profileNames();
  if (names.length !== profiles.length) throw new Error("模型配置名称不能为空。");
  if (new Set(names).size !== names.length) throw new Error("模型配置名称不能重复。");
  if (profiles.some((profile) => !profile.model.trim())) throw new Error("模型 ID 不能为空。");
  if (profiles.some((profile) => profile.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv))) throw new Error("API Key 环境变量名格式不正确。");
  assignments.solModel = elements.solModel.value;
  assignments.reviewModel = elements.reviewModel.value;
  assignments.workerModels = [...elements.workerModels.querySelectorAll("input:checked")].map((item) => item.value);
  if (!assignments.workerModels.length) throw new Error("至少选择一个工作模型。");
  const tokenMode = document.querySelector('input[name="token-mode"]:checked')?.value;
  if (!tokenMode) throw new Error("请选择 Token 模式。");
  const tasksPerBatch = elements.taskAuto.checked ? 0 : numberValue(elements.tasksPerBatch);
  const maxTasksPerRun = numberValue(elements.maxTasks);
  if (tasksPerBatch > maxTasksPerRun) throw new Error("每批任务数不能大于单批上限。");
  return {
    expectedRevision: revision,
    mode: elements.mode.value,
    executionBackend: elements.executionBackend.value,
    artifactMode: elements.artifactMode.value,
    tokenMode,
    tasksPerBatch,
    maxTasksPerRun,
    maxParallel: numberValue(elements.maxParallel),
    requestTimeoutMs: numberValue(elements.requestTimeout),
    maxRetries: numberValue(elements.maxRetries),
    retryBaseMs: numberValue(elements.retryBase),
    solModel: assignments.solModel,
    reviewModel: assignments.reviewModel,
    workerModels: assignments.workerModels,
    profiles: profiles.map(({ name, model, baseUrl, apiKeyEnv, reasoningEffort, reasoningField, maxTokensField, temperatureEnabled }) => ({
      name: name.trim(),
      model: model.trim(),
      baseUrl: baseUrl.trim(),
      apiKeyEnv: apiKeyEnv.trim(),
      reasoningEffort,
      reasoningField: reasoningField.trim(),
      maxTokensField: maxTokensField.trim(),
      temperatureEnabled
    }))
  };
}

async function load() {
  try {
    const response = await fetch(apiUrl("/api/config"), { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "加载配置失败");
    applyConfig(payload.workspace, payload.config, payload.revision);
    setMessage("配置已载入。");
  } catch (error) {
    setConnection("error", "连接失败");
    setMessage(error.message, "error");
  }
}

function activateTab(name, updateLocation = true) {
  const selected = document.querySelector(`.tab[data-tab="${name}"]`);
  if (!selected) return;
  document.querySelectorAll(".tab").forEach((item) => {
    const active = item === selected;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    const active = panel.dataset.panel === name;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
  if (name === "endpoints") renderEndpoints();
  if (updateLocation) history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${name}`);
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

const initialTab = window.location.hash.slice(1);
if (["models", "execution", "endpoints"].includes(initialTab)) activateTab(initialTab, false);

document.querySelector("#add-profile").addEventListener("click", () => {
  const used = new Set(profileNames());
  let index = profiles.length + 1;
  while (used.has(`model-${index}`)) index += 1;
  profiles.push({
    name: `model-${index}`,
    model: "new-model-id",
    baseUrl: "",
    apiKeyEnv: "",
    reasoningEffort: "medium",
    reasoningField: "reasoning_effort",
    maxTokensField: "max_tokens",
    temperatureEnabled: false,
    apiKeyAvailable: false
  });
  renderProfiles();
  renderAssignments();
  renderEndpoints();
  setDirty(true);
});

elements.solModel.addEventListener("change", () => { assignments.solModel = elements.solModel.value; });
elements.reviewModel.addEventListener("change", () => { assignments.reviewModel = elements.reviewModel.value; });
elements.taskAuto.addEventListener("change", () => {
  elements.tasksPerBatch.disabled = elements.taskAuto.checked;
});

elements.form.addEventListener("input", () => setDirty(true));
elements.form.addEventListener("change", () => setDirty(true));

elements.reload.addEventListener("click", () => {
  if (dirty && !window.confirm("放弃尚未保存的修改并重新载入？")) return;
  setConnection("loading", "正在载入");
  setMessage("");
  void load();
});

window.addEventListener("beforeunload", (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!elements.form.reportValidity()) return;
  saving = true;
  elements.save.disabled = true;
  setMessage("正在保存…");
  try {
    const response = await fetch(apiUrl("/api/config"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildPayload())
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "保存配置失败");
    applyConfig(payload.workspace, payload.config, payload.revision);
    setMessage("配置已保存。", "success");
  } catch (error) {
    if (error.message.includes("其他窗口")) setConnection("error", "配置冲突");
    setMessage(error.message, "error");
  } finally {
    saving = false;
    elements.save.disabled = !dirty;
  }
});

void load();
