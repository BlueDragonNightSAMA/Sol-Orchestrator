const session = new URLSearchParams(window.location.search).get("session") || "";
const apiUrl = (path) => `${path}?session=${encodeURIComponent(session)}`;

const TOKEN_POLICIES = {
  economy: { label: "经济", planning: 1400, worker: 1200, review: 420, final: 500, reviewBatchSize: 4 },
  balanced: { label: "均衡", planning: 2400, worker: 2400, review: 700, final: 900, reviewBatchSize: 2 },
  quality: { label: "质量", planning: 4200, worker: 5000, review: 1200, final: 1800, reviewBatchSize: 1 }
};
const EFFORT_LABELS = { default: "默认", none: "无", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "极高" };
const BACKEND_LABELS = { auto: "自动路由", "host-agents": "Codex 子代理", "api-parallel": "API 并发" };
const MODE_LABELS = { auto: "自动", manual: "手动", documents: "仅文档" };

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
  enabled: document.querySelector("#enabled"),
  enabledState: document.querySelector("#enabled-state"),
  mode: document.querySelector("#mode"),
  executionBackend: document.querySelector("#execution-backend"),
  artifactMode: document.querySelector("#artifact-mode"),
  artifactDirectory: document.querySelector("#artifact-directory"),
  taskAuto: document.querySelector("#task-auto"),
  tasksPerBatch: document.querySelector("#tasks-per-batch"),
  maxTasks: document.querySelector("#max-tasks"),
  maxParallel: document.querySelector("#max-parallel"),
  requestTimeout: document.querySelector("#request-timeout"),
  maxRetries: document.querySelector("#max-retries"),
  retryBase: document.querySelector("#retry-base"),
  previewSol: document.querySelector("#preview-sol"),
  previewSolEffort: document.querySelector("#preview-sol-effort"),
  previewWorkers: document.querySelector("#preview-workers"),
  previewWorkerEffort: document.querySelector("#preview-worker-effort"),
  previewReview: document.querySelector("#preview-review"),
  previewReviewEffort: document.querySelector("#preview-review-effort"),
  routingSummary: document.querySelector("#routing-summary"),
  summaryTasks: document.querySelector("#summary-tasks"),
  summaryTaskLimit: document.querySelector("#summary-task-limit"),
  summaryParallel: document.querySelector("#summary-parallel"),
  summaryBackend: document.querySelector("#summary-backend"),
  summaryBudget: document.querySelector("#summary-budget"),
  summaryTokenMode: document.querySelector("#summary-token-mode"),
  reviewBatchSummary: document.querySelector("#review-batch-summary")
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

function profileByName(name) {
  return profiles.find((profile) => profile.name === name);
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
      renderSummary();
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
          if (field === "model") {
            profile.connectionTest = null;
            renderEndpoints();
          }
        }
        renderSummary();
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
      renderSummary();
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
    const detail = row.querySelector('[data-label="detail"]');
    const testButton = row.querySelector(".test-profile-button");
    const updateStatus = () => {
      const test = profile.connectionTest;
      if (test?.code === "testing") {
        status.dataset.state = "testing";
        status.textContent = "测试中";
        detail.dataset.state = "";
        detail.textContent = "正在检查端点…";
      } else if (test) {
        const warningCodes = new Set(["model_not_found", "models_unsupported"]);
        const labels = {
          available: "可用",
          model_not_found: "模型未找到",
          models_unsupported: "接口不支持",
          auth_failed: "鉴权失败",
          api_key_missing: "密钥未加载",
          timeout: "连接超时",
          insecure_http: "HTTP 已阻止",
          invalid_response: "响应异常",
          endpoint_error: "端点错误",
          unreachable: "无法连接",
          request_failed: "测试失败"
        };
        const state = test.ok ? "ready" : warningCodes.has(test.code) ? "warning" : "error";
        status.dataset.state = state;
        status.textContent = labels[test.code] || "不可用";
        detail.dataset.state = state;
        detail.textContent = `${test.message} 生成 Token：0。`;
      } else if (!profile.baseUrl) {
        status.dataset.state = "missing";
        status.textContent = "待配置端点";
        detail.dataset.state = "";
        detail.textContent = "";
      } else if (!profile.apiKeyEnv) {
        status.dataset.state = "ready";
        status.textContent = "端点已设置";
        detail.dataset.state = "";
        detail.textContent = "";
      } else if (profile.apiKeyAvailable === true) {
        status.dataset.state = "ready";
        status.textContent = "密钥可用";
        detail.dataset.state = "";
        detail.textContent = "";
      } else if (profile.apiKeyAvailable === null) {
        status.dataset.state = "warning";
        status.textContent = "保存后检查";
        detail.dataset.state = "";
        detail.textContent = "";
      } else {
        status.dataset.state = "warning";
        status.textContent = "密钥未加载";
        detail.dataset.state = "";
        detail.textContent = "";
      }
    };
    for (const input of row.querySelectorAll("[data-field]")) {
      const field = input.dataset.field;
      if (input.type === "checkbox") input.checked = Boolean(profile[field]);
      else input.value = profile[field] ?? "";
      input.addEventListener("input", () => {
        profile[field] = input.type === "checkbox" ? input.checked : input.value;
        if (field === "apiKeyEnv") profile.apiKeyAvailable = null;
        if (["baseUrl", "apiKeyEnv"].includes(field)) {
          profile.connectionTest = null;
          updateStatus();
        }
      });
    }
    testButton.addEventListener("click", async () => {
      const baseUrlInput = row.querySelector('[data-field="baseUrl"]');
      if (!profile.model.trim()) {
        setMessage(`${profile.name || "未命名模型"}：请先填写模型 ID。`, "error");
        return;
      }
      if (!baseUrlInput.reportValidity() || !profile.baseUrl.trim()) {
        setMessage(`${profile.name || "未命名模型"}：请先填写有效的 Base URL。`, "error");
        return;
      }
      const fingerprint = JSON.stringify([profile.model, profile.baseUrl, profile.apiKeyEnv]);
      profile.connectionTest = { code: "testing" };
      testButton.disabled = true;
      testButton.textContent = "测试中…";
      updateStatus();
      try {
        const response = await fetch(apiUrl("/api/test-profile"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile: { name: profile.name, model: profile.model, baseUrl: profile.baseUrl, apiKeyEnv: profile.apiKeyEnv } })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "连接测试失败");
        if (fingerprint !== JSON.stringify([profile.model, profile.baseUrl, profile.apiKeyEnv])) return;
        profile.connectionTest = payload;
        updateStatus();
        setMessage(`${profile.name || "未命名模型"}：${payload.message}`, payload.ok ? "success" : "");
      } catch (error) {
        profile.connectionTest = { code: "request_failed", message: error.message || "连接测试失败" };
        updateStatus();
        setMessage(error.message || "连接测试失败", "error");
      } finally {
        testButton.disabled = false;
        testButton.textContent = "测试连接";
      }
    });
    updateStatus();
    elements.endpointList.append(row);
  });
}

function effortSummary(names) {
  const efforts = [...new Set(names.map((name) => profileByName(name)?.reasoningEffort || "default"))];
  return efforts.map((effort) => EFFORT_LABELS[effort] || effort).join(" / ");
}

function renderSummary() {
  normalizeAssignments();
  const tokenMode = document.querySelector('input[name="token-mode"]:checked')?.value || "economy";
  const policy = TOKEN_POLICIES[tokenMode];
  const solProfile = profileByName(assignments.solModel);
  const reviewProfile = profileByName(assignments.reviewModel);
  const workerNames = assignments.workerModels;
  const autoTasks = elements.taskAuto.checked;
  const maxTasks = Number.parseInt(elements.maxTasks.value, 10) || 1;
  const taskCount = Number.parseInt(elements.tasksPerBatch.value, 10) || 1;
  const maxParallel = Number.parseInt(elements.maxParallel.value, 10) || 1;

  elements.previewSol.textContent = solProfile?.name || "未分配";
  elements.previewSolEffort.textContent = `${solProfile?.model || "未设置模型"} · 推理${EFFORT_LABELS[solProfile?.reasoningEffort] || "默认"}`;
  elements.previewWorkers.textContent = workerNames.length ? workerNames.join("、") : "未分配";
  elements.previewWorkerEffort.textContent = `${workerNames.length} 个模型 · 推理${effortSummary(workerNames) || "默认"}`;
  elements.previewReview.textContent = reviewProfile?.name || "未分配";
  elements.previewReviewEffort.textContent = `${reviewProfile?.model || "未设置模型"} · 推理${EFFORT_LABELS[reviewProfile?.reasoningEffort] || "默认"}`;

  const enabled = elements.enabled.checked;
  elements.enabledState.textContent = enabled ? "已启用" : "已关闭";
  elements.routingSummary.textContent = enabled ? `${MODE_LABELS[elements.mode.value] || "自动"} · ${BACKEND_LABELS[elements.executionBackend.value] || "自动路由"}` : "分类与编排已关闭";
  document.querySelector("#orchestrator-map").dataset.enabled = String(enabled);
  document.querySelector(".summary-grid").dataset.enabled = String(enabled);
  document.querySelector(".budget-section").dataset.enabled = String(enabled);
  elements.summaryTasks.textContent = autoTasks ? "自动" : String(taskCount);
  elements.summaryTaskLimit.textContent = `单批最多 ${maxTasks} 项`;
  elements.summaryParallel.textContent = String(maxParallel);
  elements.summaryBackend.textContent = BACKEND_LABELS[elements.executionBackend.value] || "自动路由";
  elements.summaryBudget.textContent = `${policy.worker.toLocaleString("zh-CN")} tokens`;
  elements.summaryTokenMode.textContent = `${policy.label}模式`;
  elements.reviewBatchSummary.textContent = policy.reviewBatchSize === 1 ? "每项结果独立调用审查" : `每次最多批量审查 ${policy.reviewBatchSize} 项结果`;

  const maxBudget = Math.max(...Object.values(TOKEN_POLICIES).flatMap((item) => [item.planning, item.worker, item.review, item.final]));
  for (const phase of ["planning", "worker", "review", "final"]) {
    document.querySelector(`[data-budget="${phase}"]`).style.width = `${Math.max(3, policy[phase] / maxBudget * 100)}%`;
    document.querySelector(`[data-budget-value="${phase}"]`).textContent = policy[phase].toLocaleString("zh-CN");
  }

  document.querySelector("#tasks-per-batch-value").textContent = autoTasks ? "自动" : String(taskCount);
  document.querySelector("#max-tasks-value").textContent = String(maxTasks);
  document.querySelector("#max-parallel-value").textContent = String(maxParallel);
  document.querySelector("#request-timeout-value").textContent = `${Math.round((Number(elements.requestTimeout.value) || 1000) / 1000)} 秒`;
  document.querySelector("#max-retries-value").textContent = `${elements.maxRetries.value} 次`;
  document.querySelector("#retry-base-value").textContent = `${((Number(elements.retryBase.value) || 100) / 1000).toLocaleString("zh-CN")} 秒`;
}

function syncEnabledState() {
  const enabled = elements.enabled.checked;
  for (const control of document.querySelectorAll(".panel input, .panel select, .panel button")) {
    if (control === elements.enabled) continue;
    control.disabled = !enabled;
  }
  if (enabled) elements.tasksPerBatch.disabled = elements.taskAuto.checked;
  renderSummary();
}

function applyConfig(workspace, config, nextRevision) {
  elements.workspace.textContent = workspace;
  elements.enabled.checked = config.enabled !== false;
  profiles = Object.entries(config.models).map(([name, profile]) => ({
    name,
    model: profile.model || "",
    baseUrl: profile.baseUrl || "",
    apiKeyEnv: profile.apiKeyEnv || "",
    reasoningEffort: profile.reasoningEffort || "default",
    reasoningField: profile.reasoningField ?? "reasoning_effort",
    maxTokensField: profile.maxTokensField ?? "max_tokens",
    temperatureEnabled: Boolean(profile.temperatureEnabled),
    apiKeyAvailable: Boolean(profile.apiKeyAvailable),
    connectionTest: null
  }));
  assignments = { solModel: config.solModel, reviewModel: config.reviewModel, workerModels: [...config.workerModels] };
  elements.mode.value = config.mode;
  elements.executionBackend.value = config.executionBackend;
  elements.artifactMode.value = config.artifactMode;
  elements.artifactDirectory.value = config.artifactDirectory;
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
  syncEnabledState();
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
  const artifactDirectory = elements.artifactDirectory.value.trim();
  if (!artifactDirectory || /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(artifactDirectory) || artifactDirectory.split(/[\\/]+/).includes("..")) {
    throw new Error("项目文档目录必须是项目内的相对路径，且不能包含 ..。");
  }
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
    enabled: elements.enabled.checked,
    mode: elements.mode.value,
    executionBackend: elements.executionBackend.value,
    artifactMode: elements.artifactMode.value,
    artifactDirectory,
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
    item.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    const active = panel.dataset.panel === name;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
  if (name === "endpoints") {
    renderEndpoints();
    syncEnabledState();
  }
  if (updateLocation) history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${name}`);
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll(".tab")];
    const current = tabs.indexOf(tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    activateTab(tabs[next].dataset.tab);
    tabs[next].focus();
  });
});

const initialTab = window.location.hash.slice(1);
activateTab(["overview", "models", "execution", "endpoints"].includes(initialTab) ? initialTab : "overview", false);

document.querySelector("#add-profile").addEventListener("click", () => {
  if (profiles.length >= 64) {
    setMessage("最多可以添加 64 个模型配置。", "error");
    return;
  }
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
    apiKeyAvailable: false,
    connectionTest: null
  });
  renderProfiles();
  renderAssignments();
  renderEndpoints();
  renderSummary();
  setDirty(true);
});

elements.solModel.addEventListener("change", () => { assignments.solModel = elements.solModel.value; renderSummary(); });
elements.reviewModel.addEventListener("change", () => { assignments.reviewModel = elements.reviewModel.value; renderSummary(); });
elements.taskAuto.addEventListener("change", () => { elements.tasksPerBatch.disabled = elements.taskAuto.checked; });
elements.enabled.addEventListener("change", syncEnabledState);
elements.maxTasks.addEventListener("input", () => {
  elements.tasksPerBatch.max = elements.maxTasks.value;
  if (numberValue(elements.tasksPerBatch) > numberValue(elements.maxTasks)) elements.tasksPerBatch.value = elements.maxTasks.value;
});

elements.form.addEventListener("input", () => { renderSummary(); setDirty(true); });
elements.form.addEventListener("change", () => { renderSummary(); setDirty(true); });

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

function reportFirstInvalidControl() {
  if (elements.form.checkValidity()) return true;
  const invalid = elements.form.querySelector(":invalid");
  const panel = invalid?.closest(".panel");
  if (panel) activateTab(panel.dataset.panel);
  invalid?.reportValidity();
  invalid?.focus();
  return false;
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!reportFirstInvalidControl()) return;
  let body;
  try {
    body = buildPayload();
  } catch (error) {
    setMessage(error.message, "error");
    return;
  }
  saving = true;
  elements.save.disabled = true;
  setMessage("正在保存…");
  try {
    const response = await fetch(apiUrl("/api/config"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
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

renderSummary();
void load();
