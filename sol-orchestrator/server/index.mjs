#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";

const SERVER = { name: "sol-orchestrator", version: "0.2.1" };
const REASONING_EFFORTS = ["default", "none", "minimal", "low", "medium", "high", "xhigh"];
const TOKEN_MODES = ["economy", "balanced", "quality"];
const EXECUTION_BACKENDS = ["auto", "api-parallel", "host-agents"];
const MIB = 1024 * 1024;
const MAX_JSON_FILE_BYTES = 16 * MIB;
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
const MAX_MODEL_RESPONSE_BYTES = 2 * MIB;
const MAX_MODELS_RESPONSE_BYTES = 4 * MIB;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const MAX_COMPACT_SOURCE_BYTES = 8 * MIB;
const MAX_GOAL_CHARS = 256 * 1024;
const MAX_CONTEXT_CHARS = 512 * 1024;
const MAX_USAGE_CALLS = 4096;
const MAX_MCP_BUFFER_BYTES = 4 * MIB;
const TOKEN_POLICIES = {
  economy: { planning: 1400, worker: 1200, review: 420, final: 500, goalChars: 6000, delegatedGoalChars: 1200, contextChars: 6000, planChars: 1800, taskChars: 4000, dependencyChars: 3000, reviewResultChars: 7000, reviewBatchChars: 10000, reviewBatchSize: 4, finalReviewChars: 1800, reviewSummaryChars: 900, progressLedgerChars: 5000 },
  balanced: { planning: 2400, worker: 2400, review: 700, final: 900, goalChars: 12000, delegatedGoalChars: 4000, contextChars: 12000, planChars: 3500, taskChars: 8000, dependencyChars: 6000, reviewResultChars: 14000, reviewBatchChars: 18000, reviewBatchSize: 2, finalReviewChars: 3200, reviewSummaryChars: 1600, progressLedgerChars: 9000 },
  quality: { planning: 4200, worker: 5000, review: 1200, final: 1800, goalChars: 24000, delegatedGoalChars: 12000, contextChars: 24000, planChars: 7000, taskChars: 16000, dependencyChars: 12000, reviewResultChars: 24000, reviewBatchChars: 24000, reviewBatchSize: 1, finalReviewChars: 6000, reviewSummaryChars: 2800, progressLedgerChars: 16000 }
};
const DEFAULTS = {
  enabled: true,
  mode: "auto",
  tokenMode: "economy",
  artifactMode: "compact",
  artifactDirectory: "sol-orchestrator-projects",
  executionBackend: "auto",
  tasksPerBatch: 0,
  maxTasksPerRun: 8,
  maxParallel: 2,
  requestTimeoutMs: 180000,
  maxRetries: 2,
  retryBaseMs: 750,
  solModel: "sol-5.6",
  reviewModel: "sol-5.6",
  workerModels: ["terra-5.6", "luna-5.6"],
  models: {
    "sol-5.6": { model: "5.6sol", baseUrl: "", apiKeyEnv: "SOL_API_KEY", reasoningEffort: "high", reasoningField: "reasoning_effort", maxTokensField: "max_tokens", temperatureEnabled: false },
    "terra-5.6": { model: "5.6terra", baseUrl: "", apiKeyEnv: "TERRA_API_KEY", reasoningEffort: "medium", reasoningField: "reasoning_effort", maxTokensField: "max_tokens", temperatureEnabled: false },
    "luna-5.6": { model: "5.6luna", baseUrl: "", apiKeyEnv: "LUNA_API_KEY", reasoningEffort: "medium", reasoningField: "reasoning_effort", maxTokensField: "max_tokens", temperatureEnabled: false }
  }
};

const TOOLS = [
  {
    name: "open_config_window",
    description: "Open a local Chinese configuration window for models, reasoning effort, task count, token mode, and automatic execution.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Project root. Defaults to the current workspace." },
        launchBrowser: { type: "boolean", description: "Open the system browser automatically. Defaults to true." }
      }
    }
  },
  {
    name: "get_config",
    description: "Read whether orchestration is enabled and the workspace configuration without exposing API key values.",
    inputSchema: workspaceSchema()
  },
  {
    name: "configure",
    description: "Enable or disable orchestration and configure task routing plus deployed OpenAI-compatible model profiles.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Project root. Defaults to the current workspace." },
        enabled: { type: "boolean", description: "Defaults to true. False blocks classification workflows, planning, execution, review, continuation, and status tools until re-enabled." },
        mode: { type: "string", enum: ["auto", "manual", "documents"] },
        tokenMode: { type: "string", enum: TOKEN_MODES, description: "economy is the default; quality restores larger context and output limits." },
        artifactMode: { type: "string", enum: ["compact", "expanded"], description: "compact keeps two files after review; expanded keeps every handoff file." },
        artifactDirectory: { type: "string", description: "Workspace-relative folder for project documents and run bundles." },
        executionBackend: { type: "string", enum: EXECUTION_BACKENDS, description: "auto uses API parallelism unless the host skill explicitly selects host-agents." },
        tasksPerBatch: { type: "integer", minimum: 0, maximum: 64, description: "0 lets Sol choose automatically; otherwise use 1..N." },
        maxTasksPerRun: { type: "integer", minimum: 1, maximum: 64 },
        maxParallel: { type: "integer", minimum: 1, maximum: 16 },
        requestTimeoutMs: { type: "integer", minimum: 1000, maximum: 1800000 },
        maxRetries: { type: "integer", minimum: 0, maximum: 8 },
        retryBaseMs: { type: "integer", minimum: 100, maximum: 30000 },
        solModel: { type: "string" },
        reviewModel: { type: "string" },
        workerModels: { type: "array", minItems: 1, items: { type: "string" } },
        replaceProfiles: { type: "boolean", description: "Replace the complete model profile list instead of merging it. Used by the configuration window." },
        profiles: {
          type: "array",
          items: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              model: { type: "string" },
              baseUrl: { type: "string" },
              apiKeyEnv: { type: "string" },
              reasoningEffort: { type: "string", enum: REASONING_EFFORTS },
              reasoningField: { type: "string", description: "Request body field, normally reasoning_effort. Empty disables it." },
              maxTokensField: { type: "string", description: "Usually max_tokens or max_completion_tokens. Empty disables output caps." },
              temperatureEnabled: { type: "boolean", description: "Send temperature only when the endpoint supports it." }
            }
          }
        }
      }
    }
  },
  {
    name: "plan_workflow",
    description: "Ask Sol to plan one to N tasks and write detailed local prompt documents without executing workers.",
    inputSchema: runSchema(false)
  },
  {
    name: "run_workflow",
    description: "Run planning, dependency-aware Sol/Terra/Luna execution, one retry, and mandatory Sol review.",
    inputSchema: runSchema(true)
  },
  {
    name: "execute_run",
    description: "Execute a previously displayed plan, then return a final project review card for chat.",
    inputSchema: {
      type: "object",
      required: ["runDirectory"],
      properties: {
        runDirectory: { type: "string" },
        workerModel: { type: "string" },
        reasoningEffort: { type: "string", enum: REASONING_EFFORTS },
        reasoningByModel: { type: "object", additionalProperties: { type: "string", enum: REASONING_EFFORTS } },
        tokenMode: { type: "string", enum: TOKEN_MODES },
        executionBackend: { type: "string", enum: EXECUTION_BACKENDS }
      }
    }
  },
  {
    name: "resume_run",
    description: "Resume failed, interrupted, or host-agent runs from task checkpoints without repeating approved tasks.",
    inputSchema: {
      type: "object",
      required: ["runDirectory"],
      properties: {
        runDirectory: { type: "string" },
        workerModel: { type: "string" },
        reasoningEffort: { type: "string", enum: REASONING_EFFORTS },
        reasoningByModel: { type: "object", additionalProperties: { type: "string", enum: REASONING_EFFORTS } },
        tokenMode: { type: "string", enum: TOKEN_MODES },
        executionBackend: { type: "string", enum: EXECUTION_BACKENDS }
      }
    }
  },
  {
    name: "continue_goal",
    description: "For a long-running /gaol project, decide completion from compact Sol reviews or create the next task batch under the same project ID.",
    inputSchema: {
      type: "object",
      required: ["runDirectory"],
      properties: {
        runDirectory: { type: "string" },
        taskCount: { type: "integer", minimum: 1, maximum: 64 },
        workerModel: { type: "string" },
        tokenMode: { type: "string", enum: TOKEN_MODES },
        executionBackend: { type: "string", enum: EXECUTION_BACKENDS },
        reasoningEffort: { type: "string", enum: REASONING_EFFORTS },
        reasoningByModel: { type: "object", additionalProperties: { type: "string", enum: REASONING_EFFORTS } }
      }
    }
  },
  {
    name: "review_run",
    description: "Review existing local result documents with Sol and write per-task plus final review documents.",
    inputSchema: {
      type: "object",
      required: ["runDirectory"],
      properties: {
        runDirectory: { type: "string" },
        reasoningEffort: { type: "string", enum: REASONING_EFFORTS },
        reasoningByModel: { type: "object", additionalProperties: { type: "string", enum: REASONING_EFFORTS } },
        tokenMode: { type: "string", enum: TOKEN_MODES }
      }
    }
  },
  {
    name: "run_status",
    description: "Read a run state document and list missing result files.",
    inputSchema: {
      type: "object",
      required: ["runDirectory"],
      properties: { runDirectory: { type: "string" } }
    }
  }
];

function workspaceSchema() {
  return {
    type: "object",
    properties: { workspace: { type: "string", description: "Project root. Defaults to the current workspace." } }
  };
}

function runSchema(withExecution) {
  return {
    type: "object",
    required: ["goal"],
    properties: {
      goal: { type: "string", maxLength: MAX_GOAL_CHARS, description: "The complete project goal and constraints. Refer to large workspace files by path instead of embedding them." },
      projectName: { type: "string", maxLength: 256, description: "Short project name shown in chat review cards." },
      longRunning: { type: "boolean", description: "Keep the /gaol active and request another batch until Sol proves the final goal complete." },
      workspace: { type: "string" },
      taskCount: { type: "integer", minimum: 1, maximum: 64 },
      workerModel: { type: "string", description: "Manual worker selection; omit in auto mode." },
      reasoningEffort: { type: "string", enum: REASONING_EFFORTS, description: "Temporary effort override for every model in this run." },
      reasoningByModel: { type: "object", additionalProperties: { type: "string", enum: REASONING_EFFORTS }, description: "Per-profile effort overrides, for example sol-5.6: high." },
      tokenMode: { type: "string", enum: TOKEN_MODES, description: "Temporary token policy override." },
      executionBackend: { type: "string", enum: EXECUTION_BACKENDS, description: "host-agents prepares subagent task packets; api-parallel calls deployed model endpoints." },
      context: { type: "string", maxLength: MAX_CONTEXT_CHARS, description: "Optional concise project context. Refer to large workspace files by path." },
      execute: withExecution ? { type: "boolean", const: true } : { type: "boolean", const: false }
    }
  };
}

function workspaceRoot(raw) {
  return path.resolve(raw || process.env.SOL_ORCHESTRATOR_WORKSPACE || process.env.CODEX_WORKSPACE_ROOT || process.cwd());
}

function controlRoot(workspace) {
  return path.join(workspace, ".sol-orchestrator");
}

function artifactRoot(workspace, config) {
  return path.resolve(workspace, config.artifactDirectory);
}

function projectArtifactRoot(workspace, config, projectId) {
  return path.join(artifactRoot(workspace, config), projectId);
}

async function writeProjectDocument(state, plan, dir, config) {
  const projectRoot = state.projectRoot || projectArtifactRoot(state.workspace, config, state.projectId);
  const file = path.join(projectRoot, "PROJECT.md");
  const tasks = plan.tasks.length
    ? plan.tasks.map((task) => `- ${task.id}｜${task.title}｜${state.tasks?.[task.id]?.model || task.assignedModel || "pending"}｜${state.tasks?.[task.id]?.status || "planned"}`).join("\n")
    : "- No pending tasks.";
  const continuation = state.goalComplete
    ? "The final goal is complete. Review the completion evidence before reopening it."
    : `Use $sol-orchestrator to continue /gaol ${state.goal}. Read run ${dir}; if needsContinuation is true, call continue_goal, display its project card, then call execute_run.`;
  await writeText(file, [
    `# ${state.projectId}: ${state.projectName}`,
    "",
    `/gaol ${state.goal}`,
    "",
    `- Status: ${state.status}`,
    `- Current batch: B${String(state.batchNumber || 1).padStart(2, "0")}`,
    `- Progress ledger batches: ${Array.isArray(state.progressLedger) ? state.progressLedger.length : 0}`,
    `- Deduplicated tasks: ${Array.isArray(state.deduplicatedTasks) ? state.deduplicatedTasks.length : 0}`,
    `- Run directory: ${dir}`,
    `- Token mode: ${state.tokenMode || config.tokenMode}`,
    `- Artifact mode: ${state.artifactMode || config.artifactMode}`,
    `- Compaction: ${state.compaction?.mode || "pending"}${state.compaction?.reason ? ` (${state.compaction.reason})` : ""}`,
    "",
    "## Current tasks",
    "",
    tasks,
    "",
    "## Continue prompt",
    "",
    continuation
  ].join("\n"));
  state.projectRoot = projectRoot;
  state.projectDocument = file;
  return file;
}

function sizeLimitError(file, size, limit, kind = "File") {
  const error = new Error(`${kind} exceeds the in-memory safety limit: ${file} (${size} bytes > ${limit} bytes). Keep large inputs as workspace files and pass paths or bounded excerpts.`);
  error.code = "FILE_SIZE_LIMIT";
  error.size = size;
  error.limit = limit;
  return error;
}

async function readUtf8Bounded(file, maxBytes, kind = "File") {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > maxBytes) throw sizeLimitError(file, stat.size, maxBytes, kind);
    if (!stat.size) return "";
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

function headTail(text, maxChars, marker) {
  if (text.length <= maxChars) return text;
  const separator = `\n${marker}\n`;
  const remaining = Math.max(0, maxChars - separator.length);
  const headChars = Math.ceil(remaining * 0.65);
  const tailChars = remaining - headChars;
  return `${text.slice(0, headChars)}${separator}${tailChars ? text.slice(-tailChars) : ""}`;
}

async function readTextPreview(file, maxChars, optional = false) {
  const handle = await fs.open(file, "r").catch((error) => {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return "";
  try {
    const stat = await handle.stat();
    if (!stat.size) return "";
    const maxBytes = Math.min(MAX_TEXT_PREVIEW_BYTES, Math.max(4096, maxChars * 4));
    if (stat.size <= maxBytes) {
      const buffer = Buffer.allocUnsafe(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return headTail(buffer.subarray(0, bytesRead).toString("utf8"), maxChars, "[middle omitted from review preview]");
    }
    const headBytes = Math.ceil(maxBytes * 0.65);
    const tailBytes = maxBytes - headBytes;
    const head = Buffer.allocUnsafe(headBytes);
    const tail = Buffer.allocUnsafe(tailBytes);
    const [{ bytesRead: headRead }, { bytesRead: tailRead }] = await Promise.all([
      handle.read(head, 0, head.length, 0),
      handle.read(tail, 0, tail.length, stat.size - tail.length)
    ]);
    const marker = `[${stat.size - headRead - tailRead} file bytes omitted from review preview]`;
    const combined = `${head.subarray(0, headRead).toString("utf8")}\n${marker}\n${tail.subarray(0, tailRead).toString("utf8")}`;
    return headTail(combined, maxChars, marker);
  } finally {
    await handle.close();
  }
}

async function hasNonEmptyFile(file) {
  try { return (await fs.stat(file)).size > 0; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function readJson(file, maxBytes = MAX_JSON_FILE_BYTES) {
  return JSON.parse(await readUtf8Bounded(file, maxBytes, "JSON file"));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function writeText(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

function deepMerge(base, extra) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(extra || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object") {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function loadConfig(workspace) {
  const file = path.join(controlRoot(workspace), "config.json");
  try {
    const saved = await readJson(file);
    const merged = deepMerge(DEFAULTS, saved);
    if (saved._replaceDefaultProfiles) merged.models = structuredClone(saved.models || {});
    for (const [name, profile] of Object.entries(merged.models || {})) {
      merged.models[name] = {
        apiKeyEnv: "",
        reasoningEffort: "default",
        reasoningField: "reasoning_effort",
        maxTokensField: "max_tokens",
        temperatureEnabled: false,
        ...profile
      };
    }
    return validateConfig(merged);
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(DEFAULTS);
    throw error;
  }
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config must be an object");
  if (typeof config.enabled !== "boolean") throw new Error("enabled must be a boolean");
  if (!["auto", "manual", "documents"].includes(config.mode)) throw new Error("mode must be auto, manual, or documents");
  if (!TOKEN_MODES.includes(config.tokenMode)) throw new Error("tokenMode must be economy, balanced, or quality");
  if (!["compact", "expanded"].includes(config.artifactMode)) throw new Error("artifactMode must be compact or expanded");
  if (!EXECUTION_BACKENDS.includes(config.executionBackend)) throw new Error("executionBackend must be auto, api-parallel, or host-agents");
  if (!config.artifactDirectory || path.isAbsolute(config.artifactDirectory) || config.artifactDirectory.split(/[\\/]+/).some((part) => part === "..")) throw new Error("artifactDirectory must be a safe workspace-relative path");
  for (const key of ["tasksPerBatch", "maxTasksPerRun", "maxParallel", "requestTimeoutMs"]) {
    if (!Number.isInteger(config[key])) throw new Error(`${key} must be an integer`);
  }
  if (config.tasksPerBatch < 0 || config.tasksPerBatch > config.maxTasksPerRun) throw new Error("tasksPerBatch must be 0 or between 1 and maxTasksPerRun");
  if (config.maxTasksPerRun < 1 || config.maxTasksPerRun > 64) throw new Error("maxTasksPerRun must be between 1 and 64");
  if (config.maxParallel < 1 || config.maxParallel > 16) throw new Error("maxParallel must be between 1 and 16");
  if (config.requestTimeoutMs < 1000 || config.requestTimeoutMs > 1800000) throw new Error("requestTimeoutMs must be between 1000 and 1800000");
  if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 8) throw new Error("maxRetries must be between 0 and 8");
  if (!Number.isInteger(config.retryBaseMs) || config.retryBaseMs < 100 || config.retryBaseMs > 30000) throw new Error("retryBaseMs must be between 100 and 30000");
  if (!config.models || typeof config.models !== "object" || Array.isArray(config.models) || !Object.keys(config.models).length) throw new Error("At least one model profile is required");
  if (Object.keys(config.models).length > 64) throw new Error("At most 64 model profiles are allowed");
  if (typeof config.solModel !== "string" || typeof config.reviewModel !== "string") throw new Error("solModel and reviewModel must be strings");
  if (!Array.isArray(config.workerModels) || !config.workerModels.length || config.workerModels.some((name) => typeof name !== "string")) throw new Error("workerModels must contain at least one profile name");
  for (const name of [config.solModel, config.reviewModel, ...config.workerModels]) {
    if (!config.models[name]) throw new Error(`Unknown model profile: ${name}`);
  }
  for (const [name, profile] of Object.entries(config.models)) {
    if (!name.trim() || name !== name.trim()) throw new Error("Model profile names must be non-empty and cannot start or end with spaces");
    if (name.length > 128) throw new Error("Model profile names cannot exceed 128 characters");
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error(`Model profile '${name}' must be an object`);
    if (!profile.model || typeof profile.model !== "string" || !profile.model.trim()) throw new Error(`Model profile '${name}' requires model`);
    if (profile.model.length > 512) throw new Error(`model for '${name}' cannot exceed 512 characters`);
    if (typeof profile.baseUrl !== "string") throw new Error(`Model profile '${name}' requires baseUrl`);
    if (profile.baseUrl.length > 2048) throw new Error(`baseUrl for '${name}' cannot exceed 2048 characters`);
    if (profile.baseUrl) {
      let endpointUrl;
      try { endpointUrl = new URL(profile.baseUrl); }
      catch { throw new Error(`baseUrl for '${name}' must be a valid URL`); }
      if (!["http:", "https:"].includes(endpointUrl.protocol)) throw new Error(`baseUrl for '${name}' must use http or https`);
    }
    if (typeof profile.apiKeyEnv !== "string" || (profile.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv))) throw new Error(`apiKeyEnv for '${name}' must be a valid environment variable name`);
    if (!REASONING_EFFORTS.includes(profile.reasoningEffort)) throw new Error(`Invalid reasoningEffort for '${name}'`);
    if (typeof profile.reasoningField !== "string" || profile.reasoningField.length > 128) throw new Error(`reasoningField for '${name}' must be a string of at most 128 characters`);
    if (typeof profile.maxTokensField !== "string" || profile.maxTokensField.length > 128) throw new Error(`maxTokensField for '${name}' must be a string of at most 128 characters`);
    if (typeof profile.temperatureEnabled !== "boolean") throw new Error(`temperatureEnabled for '${name}' must be a boolean`);
  }
  return config;
}

async function configure(args) {
  const workspace = workspaceRoot(args.workspace);
  const current = await loadConfig(workspace);
  const next = structuredClone(current);
  for (const key of ["enabled", "mode", "tokenMode", "artifactMode", "artifactDirectory", "executionBackend", "tasksPerBatch", "maxTasksPerRun", "maxParallel", "requestTimeoutMs", "maxRetries", "retryBaseMs", "solModel", "reviewModel", "workerModels"]) {
    if (args[key] !== undefined) next[key] = args[key];
  }
  if (args.replaceProfiles) {
    next.models = {};
    next._replaceDefaultProfiles = true;
  }
  for (const profile of args.profiles || []) {
    if (!profile.name || typeof profile.name !== "string") throw new Error("Every model profile requires a non-empty name");
    const existing = next.models[profile.name] || {
      model: "",
      baseUrl: "",
      apiKeyEnv: "",
      reasoningEffort: "default",
      reasoningField: "reasoning_effort",
      maxTokensField: "max_tokens",
      temperatureEnabled: false
    };
    next.models[profile.name] = {
      ...existing,
      ...(profile.model !== undefined ? { model: profile.model } : {}),
      ...(profile.baseUrl !== undefined ? { baseUrl: profile.baseUrl } : {}),
      ...(profile.apiKeyEnv !== undefined ? { apiKeyEnv: profile.apiKeyEnv } : {}),
      ...(profile.reasoningEffort !== undefined ? { reasoningEffort: profile.reasoningEffort } : {}),
      ...(profile.reasoningField !== undefined ? { reasoningField: profile.reasoningField } : {}),
      ...(profile.maxTokensField !== undefined ? { maxTokensField: profile.maxTokensField } : {}),
      ...(profile.temperatureEnabled !== undefined ? { temperatureEnabled: profile.temperatureEnabled } : {})
    };
  }
  validateConfig(next);
  const file = path.join(controlRoot(workspace), "config.json");
  await writeJsonAtomic(file, next);
  return { configured: true, configPath: file, revision: configRevision(next), config: redactConfig(next) };
}

function requireEnabled(config) {
  if (config.enabled) return config;
  const error = new Error("Sol Orchestrator is disabled for this workspace. Re-enable it in the tuning dashboard or with configure({ enabled: true }).");
  error.code = "SOL_ORCHESTRATOR_DISABLED";
  throw error;
}

function configRevision(config) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  };
  return createHash("sha256").update(JSON.stringify(canonical(config))).digest("hex").slice(0, 16);
}

function redactConfig(config) {
  const { _replaceDefaultProfiles, ...publicConfig } = config;
  return {
    ...publicConfig,
    models: Object.fromEntries(Object.entries(config.models).map(([name, profile]) => [name, {
      ...profile,
      apiKeyAvailable: Boolean(profile.apiKeyEnv && process.env[profile.apiKeyEnv])
    }]))
  };
}

let configUiServer;
const configUiSessions = new Map();
const CONFIG_UI_SESSION_MS = 30 * 60 * 1000;
const CONFIG_UI_MAX_BODY = 64 * 1024;
const CONFIG_UI_MAX_SESSIONS = 32;
const CONFIG_UI_MAX_PROFILE_TESTS = 4;
const PROFILE_TEST_TIMEOUT_MS = 9000;
let activeProfileTests = 0;

function sendHttpJson(response, status, value) {
  if (response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function configUiSession(url) {
  const token = url.searchParams.get("session") || "";
  const session = configUiSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) configUiSessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + CONFIG_UI_SESSION_MS;
  return session;
}

async function readHttpJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > CONFIG_UI_MAX_BODY) throw new Error("Request body is too large");
  }
  const value = JSON.parse(body || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object");
  return value;
}

function responseLimitError(limit) {
  const error = new Error(`HTTP response exceeded the ${limit}-byte in-memory safety limit.`);
  error.code = "RESPONSE_SIZE_LIMIT";
  error.limit = limit;
  return error;
}

async function readResponseTextBounded(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw responseLimitError(maxBytes);
  }
  if (!response.body) return "";
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    if (total + buffer.length > maxBytes) throw responseLimitError(maxBytes);
    chunks.push(buffer);
    total += buffer.length;
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function cancelResponseBody(response) {
  try { await response.body?.cancel(); }
  catch {}
}

async function configUiAsset(name) {
  return fs.readFile(new URL(`./${name}`, import.meta.url));
}

function trustedConfigUiOrigin(request) {
  const host = request.headers.host || "";
  return Boolean(host && request.headers.origin === `http://${host}`);
}

function profileModelsEndpoint(baseUrl) {
  const url = new URL(baseUrl.trim());
  const cleanPath = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
  url.pathname = `${cleanPath}/models`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url;
}

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function normalizeProfileTestInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("模型测试参数必须是对象。");
  const profile = {
    name: typeof raw.name === "string" ? raw.name.trim() : "",
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "",
    apiKeyEnv: typeof raw.apiKeyEnv === "string" ? raw.apiKeyEnv.trim() : ""
  };
  if (!profile.model || profile.model.length > 512) throw new Error("模型 ID 不能为空且不能超过 512 个字符。");
  if (!profile.baseUrl || profile.baseUrl.length > 2048) throw new Error("Base URL 不能为空且不能超过 2048 个字符。");
  if (profile.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv)) throw new Error("API Key 环境变量名格式不正确。");
  let url;
  try { url = profileModelsEndpoint(profile.baseUrl); }
  catch { throw new Error("Base URL 格式不正确。"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Base URL 只能使用 HTTP 或 HTTPS。");
  if (url.username || url.password) throw new Error("Base URL 不能包含用户名或密码。");
  return { ...profile, url };
}

function profileTestResult(code, message, extra = {}) {
  return { ok: code === "available", code, message, tokenUsage: 0, ...extra };
}

async function testProfileConnection(rawProfile) {
  const profile = normalizeProfileTestInput(rawProfile);
  if (profile.url.protocol === "http:" && !isLoopbackHost(profile.url.hostname)) {
    return profileTestResult("insecure_http", "已阻止远程明文 HTTP 测试，请改用 HTTPS，避免泄露密钥。", { endpointReachable: false });
  }
  const key = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : "";
  if (profile.apiKeyEnv && !key) {
    return profileTestResult("api_key_missing", `环境变量 ${profile.apiKeyEnv} 尚未加载。`, { endpointReachable: false });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROFILE_TEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const headers = { accept: "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    const response = await fetch(profile.url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    const common = { endpointReachable: true, upstreamStatus: response.status, latencyMs };
    if ([401, 403].includes(response.status)) {
      await cancelResponseBody(response);
      return profileTestResult("auth_failed", `鉴权失败（HTTP ${response.status}），请检查密钥环境变量。`, common);
    }
    if ([404, 405].includes(response.status)) {
      await cancelResponseBody(response);
      return profileTestResult("models_unsupported", `端点可达，但不支持 GET /models（HTTP ${response.status}），请手工确认模型 ID。`, common);
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      return profileTestResult("endpoint_error", `端点返回 HTTP ${response.status}，请检查服务状态。`, common);
    }
    let payload;
    try { payload = JSON.parse(await readResponseTextBounded(response, MAX_MODELS_RESPONSE_BYTES)); }
    catch (error) {
      const message = error?.code === "RESPONSE_SIZE_LIMIT"
        ? "端点可达，但 /models 响应过大，已停止读取以保护内存。"
        : "端点可达，但 /models 未返回有效 JSON。";
      return profileTestResult("invalid_response", message, common);
    }
    const entries = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload)
          ? payload
          : null;
    if (!entries) return profileTestResult("invalid_response", "端点可达，但 /models 响应中没有模型列表。", common);
    const modelIds = entries.map((item) => typeof item === "string" ? item : item?.id).filter((id) => typeof id === "string");
    const modelCount = modelIds.length;
    if (!modelIds.includes(profile.model)) {
      return profileTestResult("model_not_found", `端点可用，但模型列表中未找到 ${profile.model}（共 ${modelCount} 个模型）。`, { ...common, modelCount });
    }
    return profileTestResult("available", `连接可用，已找到模型 ${profile.model}（${modelCount} 个模型，${latencyMs} 毫秒）。`, { ...common, modelCount });
  } catch (error) {
    if (error?.name === "AbortError") {
      return profileTestResult("timeout", `连接测试超过 ${PROFILE_TEST_TIMEOUT_MS / 1000} 秒。`, { endpointReachable: false, latencyMs: Date.now() - startedAt });
    }
    return profileTestResult("unreachable", "无法连接端点，请检查地址、服务和网络。", { endpointReachable: false, latencyMs: Date.now() - startedAt });
  } finally {
    clearTimeout(timer);
  }
}

async function handleConfigUiRequest(request, response) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("referrer-policy", "no-referrer");
  if (request.method === "GET" && url.pathname === "/config-ui.css") {
    response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(await configUiAsset("config-ui.css"));
    return;
  }
  if (request.method === "GET" && url.pathname === "/config-ui.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(await configUiAsset("config-ui.js"));
    return;
  }
  const session = configUiSession(url);
  if (!session) {
    sendHttpJson(response, 403, { error: "配置会话已失效，请从 Codex 重新打开配置窗口。" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(await configUiAsset("config-ui.html"));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    const config = await loadConfig(session.workspace);
    sendHttpJson(response, 200, { workspace: session.workspace, revision: configRevision(config), config: redactConfig(config) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/test-profile") {
    if (!trustedConfigUiOrigin(request)) {
      sendHttpJson(response, 403, { error: "连接测试来源不受信任。" });
      return;
    }
    if (activeProfileTests >= CONFIG_UI_MAX_PROFILE_TESTS) {
      sendHttpJson(response, 429, { error: "同时进行的连接测试过多，请稍后重试。" });
      return;
    }
    requireEnabled(await loadConfig(session.workspace));
    activeProfileTests += 1;
    try {
      const body = await readHttpJson(request);
      sendHttpJson(response, 200, await testProfileConnection(body.profile));
    } finally {
      activeProfileTests -= 1;
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/config") {
    if (!trustedConfigUiOrigin(request)) {
      sendHttpJson(response, 403, { error: "配置写入来源不受信任。" });
      return;
    }
    const body = await readHttpJson(request);
    delete body.workspace;
    const expectedRevision = typeof body.expectedRevision === "string" ? body.expectedRevision : "";
    delete body.expectedRevision;
    const current = await loadConfig(session.workspace);
    if (expectedRevision && expectedRevision !== configRevision(current)) {
      sendHttpJson(response, 409, { error: "配置已在其他窗口或对话中更新，请重新打开配置窗口。", revision: configRevision(current) });
      return;
    }
    const saved = await configure({ ...body, workspace: session.workspace, replaceProfiles: true });
    sendHttpJson(response, 200, { workspace: session.workspace, ...saved });
    return;
  }
  sendHttpJson(response, 404, { error: "Not found" });
}

async function ensureConfigUiServer() {
  if (configUiServer) return configUiServer;
  const server = createServer((request, response) => {
    void handleConfigUiRequest(request, response).catch((error) => sendHttpJson(response, 400, { error: error?.message || String(error) }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  configUiServer = server;
  return server;
}

function launchConfigBrowser(url) {
  try {
    const options = { detached: true, stdio: "ignore", windowsHide: true };
    const child = process.platform === "win32"
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", "start", "", url], options)
      : process.platform === "darwin"
        ? spawn("open", [url], options)
        : spawn("xdg-open", [url], options);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function openConfigWindow(args = {}) {
  const workspace = workspaceRoot(args.workspace);
  await loadConfig(workspace);
  const server = await ensureConfigUiServer();
  const address = server.address();
  const token = randomBytes(24).toString("hex");
  const expiresAt = Date.now() + CONFIG_UI_SESSION_MS;
  configUiSessions.set(token, { workspace, expiresAt });
  for (const [key, session] of configUiSessions) if (session.expiresAt <= Date.now()) configUiSessions.delete(key);
  while (configUiSessions.size > CONFIG_UI_MAX_SESSIONS) configUiSessions.delete(configUiSessions.keys().next().value);
  const url = `http://127.0.0.1:${address.port}/?session=${token}`;
  const opened = args.launchBrowser === false ? false : launchConfigBrowser(url);
  return {
    workspace,
    url,
    opened,
    expiresAt: new Date(expiresAt).toISOString(),
    chatDisplay: [
      "### Sol Orchestrator 模型配置",
      `- 项目：${workspace}`,
      `- [打开配置窗口](${url})`,
      `- 浏览器：${opened ? "已请求打开" : "请点击上方链接"}`,
      "- 会话：30 分钟内有效"
    ].join("\n")
  };
}

function endpoint(baseUrl) {
  const clean = baseUrl.replace(/\/+$/, "");
  if (!clean) return "";
  if (clean.endsWith("/chat/completions")) return clean;
  return `${clean}/chat/completions`;
}

function selectedReasoning(config, profileName, options = {}) {
  const effort = options.reasoningByModel?.[profileName] ?? options.reasoningEffort ?? config.models[profileName]?.reasoningEffort ?? "default";
  if (!REASONING_EFFORTS.includes(effort)) throw new Error(`Invalid reasoning effort '${effort}' for '${profileName}'`);
  return effort;
}

function selectedTokenMode(config, options = {}) {
  const mode = options.tokenMode || config.tokenMode || "economy";
  if (!TOKEN_MODES.includes(mode)) throw new Error(`Invalid token mode '${mode}'`);
  return mode;
}

function selectedExecutionBackend(config, options = {}) {
  const requested = options.executionBackend || config.executionBackend || "auto";
  if (!EXECUTION_BACKENDS.includes(requested)) throw new Error(`Invalid execution backend '${requested}'`);
  return requested === "auto" ? "api-parallel" : requested;
}

function tokenPolicy(config, options = {}) {
  return TOKEN_POLICIES[selectedTokenMode(config, options)];
}

function clipped(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated locally to save tokens]`;
}

function outputBudget(config, profile, options = {}) {
  const phase = options.phase === "planning" || options.phase === "review" || options.phase === "final" ? options.phase : "worker";
  const standard = tokenPolicy(config, options)[phase];
  return Number.isInteger(options.outputTokenOverride) && options.outputTokenOverride > 0 ? options.outputTokenOverride : standard;
}

const usageWrites = new Map();

function emptyUsage() {
  return { calls: [], totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, byPhase: {} };
}

function addUsageEntry(usage, entry) {
  if (usage.calls.length < MAX_USAGE_CALLS) usage.calls.push(entry);
  else usage.omittedCalls = (usage.omittedCalls || 0) + 1;
  usage.totals.promptTokens += Number(entry.promptTokens) || 0;
  usage.totals.completionTokens += Number(entry.completionTokens) || 0;
  usage.totals.totalTokens += Number(entry.totalTokens) || 0;
  const phaseName = entry.phase || "unknown";
  const phase = usage.byPhase[phaseName] || { calls: 0, totalTokens: 0 };
  phase.calls += 1;
  phase.totalTokens += Number(entry.totalTokens) || 0;
  usage.byPhase[phaseName] = phase;
}

async function recordUsage(file, entry) {
  if (!file) return;
  const previous = usageWrites.get(file) || Promise.resolve();
  const next = previous.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  });
  usageWrites.set(file, next);
  try { await next; }
  finally { if (usageWrites.get(file) === next) usageWrites.delete(file); }
}

async function readUsage(dir) {
  let usage = emptyUsage();
  try {
    const legacy = await readJson(path.join(dir, "usage.json"));
    if (legacy && typeof legacy === "object") {
      usage = {
        calls: Array.isArray(legacy.calls) ? legacy.calls.slice(-MAX_USAGE_CALLS) : [],
        totals: {
          promptTokens: Number(legacy.totals?.promptTokens) || 0,
          completionTokens: Number(legacy.totals?.completionTokens) || 0,
          totalTokens: Number(legacy.totals?.totalTokens) || 0
        },
        byPhase: legacy.byPhase && typeof legacy.byPhase === "object" ? structuredClone(legacy.byPhase) : {},
        ...(Array.isArray(legacy.calls) && legacy.calls.length > MAX_USAGE_CALLS ? { omittedCalls: legacy.calls.length - MAX_USAGE_CALLS } : {})
      };
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const logFile = path.join(dir, "usage.jsonl");
  let logStat;
  try { logStat = await fs.stat(logFile); }
  catch (error) { if (error.code === "ENOENT") return usage; throw error; }
  if (logStat.size > MAX_JSON_FILE_BYTES) throw sizeLimitError(logFile, logStat.size, MAX_JSON_FILE_BYTES, "Usage log");
  const lines = createInterface({ input: createReadStream(logFile, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try { addUsageEntry(usage, JSON.parse(line)); }
    catch { usage.droppedEntries = (usage.droppedEntries || 0) + 1; }
  }
  return usage;
}

async function readBundle(dir) {
  return readJson(path.join(dir, "run-bundle.json"));
}

async function readRunState(dir) {
  try { return await readJson(path.join(dir, "state.json")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return (await readBundle(dir)).state;
  }
}

async function readRunDocuments(dir) {
  let state;
  let plan;
  try { state = await readJson(path.join(dir, "state.json")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  try { plan = await readJson(path.join(dir, "plan.json")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (state && plan) return { state, plan, bundle: null };
  const bundle = await readBundle(dir);
  return { state: bundle.state, plan: bundle.plan, bundle };
}

async function readOptionalText(file) {
  try { return await readUtf8Bounded(file, MAX_COMPACT_SOURCE_BYTES, "Artifact file"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

function compactSourceFiles(dir, plan) {
  const files = [
    path.join(dir, "request.md"),
    path.join(dir, "plan.json"),
    path.join(dir, "plan.md"),
    path.join(dir, "state.json"),
    path.join(dir, "usage.json"),
    path.join(dir, "usage.jsonl"),
    path.join(dir, "final-review.md")
  ];
  for (const task of plan.tasks) {
    files.push(path.join(dir, "tasks", `${task.id}.prompt.md`));
    files.push(path.join(dir, "results", `${task.id}.result.md`));
    files.push(path.join(dir, "reviews", `${task.id}.review.md`));
  }
  return files;
}

async function totalExistingBytes(files) {
  let total = 0;
  for (const file of files) {
    try { total += (await fs.stat(file)).size; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return total;
}

async function compactRun(dir, state, plan, config) {
  if (state.artifactMode !== "compact") return state;
  const resolvedDir = path.resolve(dir);
  const allowedRoot = path.resolve(state.projectRoot || path.join(controlRoot(state.workspace), "runs"));
  if (resolvedDir === allowedRoot || !resolvedDir.startsWith(`${allowedRoot}${path.sep}`)) throw new Error("Refusing to compact a directory outside the workspace run root");
  const bundleFile = path.join(dir, "run-bundle.json");
  const sourceBytes = await totalExistingBytes(compactSourceFiles(dir, plan));
  if (sourceBytes > MAX_COMPACT_SOURCE_BYTES) {
    await fs.rm(bundleFile, { force: true });
    state.bundlePath = null;
    state.compaction = { mode: "split", reason: "large_run", sourceBytes, limitBytes: MAX_COMPACT_SOURCE_BYTES };
    await writeJsonAtomic(path.join(dir, "state.json"), state);
    await writeProjectDocument(state, plan, dir, config);
    return state;
  }
  const prompts = {};
  const results = {};
  const reviews = {};
  for (const task of plan.tasks) {
    prompts[task.id] = await readOptionalText(path.join(dir, "tasks", `${task.id}.prompt.md`));
    results[task.id] = await readOptionalText(path.join(dir, "results", `${task.id}.result.md`));
    reviews[task.id] = await readOptionalText(path.join(dir, "reviews", `${task.id}.review.md`));
  }
  state.bundlePath = bundleFile;
  state.compaction = { mode: "bundle", sourceBytes, limitBytes: MAX_COMPACT_SOURCE_BYTES };
  const bundle = {
    schemaVersion: 2,
    archivedAt: new Date().toISOString(),
    state,
    plan,
    request: await readOptionalText(path.join(dir, "request.md")),
    prompts,
    results,
    reviews,
    finalReview: await readOptionalText(path.join(dir, "final-review.md")),
    usage: state.usage || await readUsage(dir)
  };
  await writeJsonAtomic(bundleFile, bundle);
  const bundleBytes = (await fs.stat(bundleFile)).size;
  if (bundleBytes > MAX_JSON_FILE_BYTES) {
    await fs.rm(bundleFile, { force: true });
    state.bundlePath = null;
    state.compaction = { mode: "split", reason: "bundle_expansion", sourceBytes, bundleBytes, limitBytes: MAX_JSON_FILE_BYTES };
    await writeJsonAtomic(path.join(dir, "state.json"), state);
    await writeProjectDocument(state, plan, dir, config);
    return state;
  }
  await writeProjectDocument(state, plan, dir, config);
  for (const folder of ["tasks", "results", "reviews"]) await fs.rm(path.join(dir, folder), { recursive: true, force: true });
  for (const file of ["request.md", "plan.json", "plan.md", "state.json", "usage.json", "usage.jsonl"]) await fs.rm(path.join(dir, file), { force: true });
  return state;
}

async function expandBundleForReview(dir, bundle) {
  await writeJson(path.join(dir, "state.json"), bundle.state);
  await writeJson(path.join(dir, "plan.json"), bundle.plan);
  await writeText(path.join(dir, "request.md"), bundle.request || "# Restored request");
  await writeText(path.join(dir, "plan.md"), planDocument(bundle.plan, bundle.state));
  await writeJson(path.join(dir, "usage.json"), bundle.usage || { calls: [], totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, byPhase: {} });
  await fs.rm(path.join(dir, "usage.jsonl"), { force: true });
  for (const task of bundle.plan.tasks) {
    const policy = TOKEN_POLICIES[bundle.state.tokenMode] || TOKEN_POLICIES.economy;
    await writeText(path.join(dir, "tasks", `${task.id}.prompt.md`), bundle.prompts?.[task.id] || promptDocument(bundle.state.goal, bundle.plan, task, policy));
    if (bundle.results?.[task.id]) await writeText(path.join(dir, "results", `${task.id}.result.md`), bundle.results[task.id]);
    if (bundle.reviews?.[task.id]) await writeText(path.join(dir, "reviews", `${task.id}.review.md`), bundle.reviews[task.id]);
  }
  if (bundle.finalReview) await writeText(path.join(dir, "final-review.md"), bundle.finalReview);
  await fs.rm(path.join(dir, "run-bundle.json"), { force: true });
}

function estimateTokens(value) {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of String(value || "")) {
    if (char.codePointAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 1.5));
}

function estimateMessageTokens(messages) {
  return messages.reduce((total, message) => total + estimateTokens(message.role) + estimateTokens(message.content) + 4, 0);
}

async function callModel(config, profileName, messages, temperature = 0.2, options = {}) {
  const profile = config.models[profileName];
  if (!profile) throw new Error(`Unknown model profile: ${profileName}`);
  const url = endpoint(profile.baseUrl);
  if (!url) throw new Error(`Model profile '${profileName}' has no baseUrl. Run configure first.`);
  const headers = { "content-type": "application/json" };
  if (profile.apiKeyEnv) {
    const key = process.env[profile.apiKeyEnv];
    if (key) headers.authorization = `Bearer ${key}`;
  }
  const body = { model: profile.model, messages };
  if (profile.temperatureEnabled) body.temperature = temperature;
  const effort = selectedReasoning(config, profileName, options);
  if (effort !== "default" && profile.reasoningField) body[profile.reasoningField] = effort;
  if (profile.maxTokensField) body[profile.maxTokensField] = outputBudget(config, profile, options);
  const requestBody = JSON.stringify(body);
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: requestBody
      });
      const raw = await readResponseTextBounded(response, response.ok ? MAX_MODEL_RESPONSE_BYTES : MAX_ERROR_RESPONSE_BYTES);
      if (!response.ok) {
        const error = new Error(`${profileName} returned HTTP ${response.status}: ${raw.slice(0, 300)}`);
        error.retryable = [408, 409, 425, 429].includes(response.status) || response.status >= 500;
        error.retryAfterMs = Math.min(Number(response.headers.get("retry-after")) * 1000 || 0, 30000);
        throw error;
      }
      const payload = JSON.parse(raw);
      const content = payload.choices?.[0]?.message?.content ?? payload.output_text;
      if (typeof content !== "string" || !content.trim()) throw new Error(`${profileName} returned no text content`);
      const reported = payload.usage || {};
      const promptTokens = Number(reported.prompt_tokens ?? reported.input_tokens) || estimateMessageTokens(messages);
      const completionTokens = Number(reported.completion_tokens ?? reported.output_tokens) || estimateTokens(content);
      await recordUsage(options.usageFile, {
        at: new Date().toISOString(),
        phase: options.phase || "worker",
        profile: profileName,
        model: profile.model,
        tokenMode: selectedTokenMode(config, options),
        attempts: attempt + 1,
        reported: Boolean(payload.usage),
        promptTokens,
        completionTokens,
        totalTokens: Number(reported.total_tokens) || promptTokens + completionTokens
      });
      return content.trim();
    } catch (error) {
      const retryable = error.retryable || error.name === "AbortError" || error instanceof TypeError;
      if (!retryable || attempt >= config.maxRetries) throw error;
      const delayMs = error.retryAfterMs || Math.min(config.retryBaseMs * (2 ** attempt), 30000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${profileName} request failed after retries`);
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate) throw new Error("Model response did not contain JSON");
  return JSON.parse(candidate);
}

async function callJson(config, profileName, messages, options = {}) {
  return extractJson(await callModel(config, profileName, messages, 0.1, options));
}

function requestedCount(args, config) {
  const count = args.taskCount ?? config.tasksPerBatch;
  if (count === 0) return null;
  if (!Number.isInteger(count) || count < 1 || count > config.maxTasksPerRun) {
    throw new Error(`taskCount must be between 1 and ${config.maxTasksPerRun}`);
  }
  return count;
}

function planningMessages(goal, context, count, config, options = {}) {
  const policy = tokenPolicy(config, options);
  const countRule = count
    ? `Create exactly ${count} total tasks.`
    : `Choose 1 to ${config.maxTasksPerRun} total tasks according to complexity.`;
  return [
    {
      role: "system",
      content: [
        "You are Sol 5.6, the accountable lead.",
        countRule,
        "Prefer fewer tasks. Split only when parallelism or specialization clearly repays another model call.",
        "Assign the hardest, highest-risk, security-sensitive, or integrative task to owner 'sol'.",
        "Delegate only bounded work. Make prompts self-contained but concise; avoid repeating the goal.",
        "Every worker prompt must restate all task-relevant constraints because delegated goal context may be clipped.",
        "Return JSON only: {summary, tasks:[{id,title,owner,preferredModel,description,prompt,acceptanceCriteria,dependsOn,deliverable}] }.",
        "Use T01, T02, ...; arrays for criteria/dependencies; at least one sol task.",
        "Match the user's language. Do not include secrets."
      ].join("\n")
    },
    { role: "user", content: `Goal:\n${clipped(goal, policy.goalChars)}\n\nContext:\n${clipped(context || "None provided", policy.contextChars)}\n\nWorkers: ${config.workerModels.join(", ")}` }
  ];
}

function normalizePlan(raw, goal, count, config) {
  if (!raw || !Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new Error("Sol returned an empty plan");
  let tasks = raw.tasks.slice(0, config.maxTasksPerRun).map((task, index) => ({
    id: `T${String(index + 1).padStart(2, "0")}`,
    title: String(task.title || `Task ${index + 1}`),
    owner: task.owner === "sol" ? "sol" : "worker",
    preferredModel: typeof task.preferredModel === "string" ? task.preferredModel : "",
    description: String(task.description || ""),
    prompt: String(task.prompt || task.description || ""),
    acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria.map(String) : [],
    dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : [],
    deliverable: String(task.deliverable || "A complete result document")
  }));
  if (count && tasks.length !== count) throw new Error(`Sol returned ${tasks.length} tasks; expected ${count}`);
  if (!tasks.some((task) => task.owner === "sol")) tasks[0].owner = "sol";
  const validIds = new Set(tasks.map((task) => task.id));
  tasks = tasks.map((task, index) => ({
    ...task,
    dependsOn: task.dependsOn
      .map((id) => /^T\d+$/i.test(id) ? `T${String(Number(id.slice(1))).padStart(2, "0")}` : id)
      .filter((id) => validIds.has(id) && id !== task.id),
    assignedModel: task.owner === "sol" ? config.solModel : ""
  }));
  return { summary: String(raw.summary || goal), tasks };
}

function taskSignature(task) {
  const canonical = [task.title, task.description, task.prompt, ...(task.acceptanceCriteria || []), task.deliverable]
    .map((value) => String(value || "").normalize("NFKC").toLowerCase())
    .join("\n")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

function deduplicatePlan(plan, completedSignatures = []) {
  const completed = new Set(completedSignatures.filter((value) => typeof value === "string"));
  const seen = new Set(completed);
  const representativeBySignature = new Map([...completed].map((signature) => [signature, null]));
  const representativeByTaskId = new Map();
  const requiredTaskIds = new Set(plan.tasks.flatMap((task) => task.dependsOn));
  const kept = [];
  const removed = [];
  for (const task of plan.tasks) {
    const signature = task.signature || taskSignature(task);
    if (seen.has(signature)) {
      const representative = representativeBySignature.get(signature) || null;
      if (!(completed.has(signature) && requiredTaskIds.has(task.id) && !representative)) {
        representativeByTaskId.set(task.id, representative);
        removed.push({ id: task.id, title: task.title, signature, reason: completed.has(signature) && !representative ? "completed" : "same_batch" });
        continue;
      }
    }
    seen.add(signature);
    representativeBySignature.set(signature, task.id);
    representativeByTaskId.set(task.id, task.id);
    kept.push({ ...task, signature, originalId: task.id });
  }
  const idMap = new Map(kept.map((task, index) => [task.originalId, `T${String(index + 1).padStart(2, "0")}`]));
  const tasks = kept.map((task) => ({
    ...task,
    id: idMap.get(task.originalId),
    dependsOn: task.dependsOn
      .map((id) => representativeByTaskId.get(id))
      .map((id) => id ? idMap.get(id) : null)
      .filter((id) => id && id !== idMap.get(task.originalId))
  })).map(({ originalId, ...task }) => task);
  if (tasks.length && !tasks.some((task) => task.owner === "sol")) tasks[0].owner = "sol";
  return { plan: { ...plan, tasks }, removed };
}

function completedTaskSignatures(state, plan) {
  const signatures = Array.isArray(state.completedTaskSignatures) ? state.completedTaskSignatures.filter((value) => typeof value === "string") : [];
  for (const task of plan.tasks) {
    if (state.tasks?.[task.id]?.status !== "approved") continue;
    signatures.push(task.signature || taskSignature(task));
  }
  return [...new Set(signatures)].slice(-512);
}

function topologicalTaskOrder(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map(tasks.map((task) => [task.id, 0]));
  const children = new Map(tasks.map((task) => [task.id, []]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) continue;
      indegree.set(task.id, indegree.get(task.id) + 1);
      children.get(dependency).push(task.id);
    }
  }
  const queue = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  const ordered = [];
  while (queue.length) {
    const id = queue.shift();
    ordered.push(id);
    for (const child of children.get(id)) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }
  for (const task of tasks) if (!ordered.includes(task.id)) ordered.push(task.id);
  return ordered;
}

function runId(goal) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const hash = createHash("sha256").update(goal).digest("hex").slice(0, 6);
  return `${stamp}-${hash}-${randomBytes(2).toString("hex")}`;
}

const projectCounterWrites = new Map();

async function acquireFileLock(lockFile, staleAfterMs = 30000) {
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, "wx");
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); }
      catch (error) {
        await handle.close();
        await fs.rm(lockFile, { force: true });
        throw error;
      }
      return handle;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockFile);
        if (Date.now() - stat.mtimeMs > staleAfterMs) {
          await fs.rm(lockFile, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code !== "ENOENT") throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(10 * (attempt + 1), 250)));
    }
  }
  throw new Error(`Timed out waiting for project counter lock: ${lockFile}`);
}

async function nextProjectId(workspace, config) {
  let projectId;
  const file = path.join(controlRoot(workspace), "counter.json");
  const previous = projectCounterWrites.get(file) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const lockFile = path.join(controlRoot(workspace), "counter.lock");
    const lock = await acquireFileLock(lockFile);
    let current = 0;
    let counterTrusted = false;
    try {
      try {
        const stored = Number((await readJson(file)).lastProjectNumber);
        if (Number.isInteger(stored) && stored >= 0) {
          current = stored;
          counterTrusted = true;
        }
      }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      let needsScan = !counterTrusted;
      if (!needsScan) {
        const candidate = path.join(artifactRoot(workspace, config), `P${String(current + 1).padStart(4, "0")}`);
        try { await fs.access(candidate); needsScan = true; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (needsScan) {
        let directory;
        try { directory = await fs.opendir(artifactRoot(workspace, config)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (directory) {
          for await (const entry of directory) {
            const number = Number(entry.name.match(/^P(\d+)$/)?.[1]) || 0;
            current = Math.max(current, number);
          }
        }
      }
      current += 1;
      await writeJsonAtomic(file, { lastProjectNumber: current });
      projectId = `P${String(current).padStart(4, "0")}`;
    } finally {
      await lock.close();
      await fs.rm(lockFile, { force: true });
    }
  });
  projectCounterWrites.set(file, next);
  try { await next; }
  finally { if (projectCounterWrites.get(file) === next) projectCounterWrites.delete(file); }
  return projectId;
}

function compactText(value, length = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

function projectName(args) {
  return compactText(args.projectName || args.goal.split(/\r?\n/)[0], 72) || "Untitled project";
}

function chatCard(dir, state, plan, config, stage) {
  const lines = [
    `/gaol ${compactText(state.goal, 320)}`,
    "",
    `### 项目 ${state.projectId} · ${state.projectName} · 批次 B${String(state.batchNumber || 1).padStart(2, "0")}`,
    `状态：${stage || state.status}｜任务：${plan.tasks.length}｜后端：${state.executionBackend || selectedExecutionBackend(config)}｜Token：${state.tokenMode || config.tokenMode}｜归档：${state.artifactMode || config.artifactMode}｜压缩：${state.compaction?.mode || "pending"}｜目录：${dir}`,
    ""
  ];
  for (const task of plan.tasks) {
    const taskState = state.tasks?.[task.id] || {};
    const modelName = taskState.model || task.assignedModel || "pending";
    const profile = config.models[modelName];
    const actualModel = taskState.modelId || profile?.model;
    const effort = taskState.reasoningEffort || task.assignedReasoning || (profile ? selectedReasoning(config, modelName) : "default");
    lines.push(`- ${state.projectId}/${task.id}｜模型：${modelName}${actualModel ? ` (${actualModel})` : ""}｜推理：${effort}｜状态：${taskState.status || "planned"}`);
    lines.push(`  > 内容：${compactText(task.description || task.prompt, 220)}`);
    if (taskState.error) lines.push(`  > 错误：${compactText(taskState.error, 220)}`);
  }
  const reviewModel = state.reviewModel || config.reviewModel;
  const reviewProfile = config.models[reviewModel];
  const reviewModelId = state.reviewModelId || reviewProfile?.model;
  lines.push("", `审查模型：${reviewModel}${reviewModelId ? ` (${reviewModelId})` : ""}｜推理：${state.reviewReasoning || selectedReasoning(config, reviewModel)}`);
  if (state.usage?.calls?.length) {
    const source = state.usage.calls.every((call) => call.reported) ? "API" : "API/估算";
    lines.push(`Token用量：${state.usage.totals.totalTokens}｜调用：${state.usage.calls.length}｜来源：${source}`);
  }
  if (state.deduplicatedTasks?.length) lines.push(`任务去重：已跳过 ${state.deduplicatedTasks.length} 个重复或已完成任务。`);
  if (state.finalReview) lines.push("", `审查：${state.finalReview}`);
  if (state.projectDocument) lines.push(`主文档：${state.projectDocument}`);
  if (state.executionBackend === "host-agents" && state.hostAgentTasks?.length) {
    lines.push("", `对话队列（仅限项目 ${state.projectId}，禁止跨项目复用）：`);
    for (const packet of state.hostAgentTasks) lines.push(`- ${packet.conversationTitle}`);
  }
  if (state.needsContinuation) lines.push("续批：需要调用 continue_goal 生成下一批任务。");
  if (state.goalComplete) lines.push("目标：goal_complete，已由 Sol 给出完成判定。");
  if (state.executionBackend === "host-agents") lines.push("并发说明：使用宿主子代理任务包；不是独立的顶层 Codex UI 对话。");
  return lines.join("\n");
}

function requestDocument(goal, context, projectId, name) {
  return `# ${projectId}: ${name}\n\n/gaol ${goal}\n\n## Context\n\n${context || "None provided."}`;
}

function planDocument(plan, state) {
  const lines = [`# ${state.projectId}: ${state.projectName}`, "", `/gaol ${state.goal}`, "", plan.summary, ""];
  for (const task of plan.tasks) {
    lines.push(`## ${task.id}: ${task.title}`, "", `- Owner: ${task.owner}`, `- Model: ${task.assignedModel || "assigned at execution"}`, `- Reasoning: ${task.assignedReasoning || "default"}`, `- Depends on: ${task.dependsOn.join(", ") || "none"}`, `- Deliverable: ${task.deliverable}`, "", task.description, "");
  }
  return lines.join("\n");
}

function goalContextForTask(goal, task, policy) {
  const limit = task.owner === "sol" ? policy.goalChars : policy.delegatedGoalChars;
  return clipped(goal, limit);
}

function promptDocument(goal, plan, task, policy = TOKEN_POLICIES.economy) {
  return [
    `# ${task.id}: ${task.title}`,
    "",
    `Owner: ${task.owner}`,
    `Assigned model: ${task.assignedModel || "pending"}`,
    `Reasoning effort: ${task.assignedReasoning || "default"}`,
    `Dependencies: ${task.dependsOn.join(", ") || "none"}`,
    "",
    "## Project goal",
    "",
    goalContextForTask(goal, task, policy),
    "",
    "## Plan context",
    "",
    plan.summary,
    "",
    "## Detailed prompt",
    "",
    task.prompt,
    "",
    "## Acceptance criteria",
    "",
    ...(task.acceptanceCriteria.length ? task.acceptanceCriteria.map((item) => `- ${item}`) : ["- Satisfy the detailed prompt completely."]),
    "",
    "## Deliverable",
    "",
    task.deliverable,
    "",
    "Return only the deliverable and concise evidence. Do not change the project plan or claim work you did not verify."
  ].join("\n");
}

async function createPlan(args) {
  if (typeof args.goal !== "string" || !args.goal.trim()) throw new Error("goal must be a non-empty string");
  if (args.goal.length > MAX_GOAL_CHARS) throw new Error(`goal exceeds ${MAX_GOAL_CHARS} characters; keep large content in workspace files and pass their paths.`);
  if (typeof args.context === "string" && args.context.length > MAX_CONTEXT_CHARS) throw new Error(`context exceeds ${MAX_CONTEXT_CHARS} characters; keep large content in workspace files and pass their paths.`);
  const workspace = workspaceRoot(args.workspace);
  const config = await loadConfig(workspace);
  requireEnabled(config);
  const count = requestedCount(args, config);
  const projectId = await nextProjectId(workspace, config);
  const id = runId(args.goal);
  const projectRoot = projectArtifactRoot(workspace, config, projectId);
  const dir = path.join(projectRoot, `B01-${id}`);
  await fs.mkdir(path.join(dir, "tasks"), { recursive: true });
  await fs.mkdir(path.join(dir, "results"), { recursive: true });
  await fs.mkdir(path.join(dir, "reviews"), { recursive: true });
  const runOptions = { ...args, tokenMode: args.tokenMode || config.tokenMode, usageFile: path.join(dir, "usage.jsonl"), phase: "planning" };
  let raw;
  try {
    raw = await callJson(config, config.solModel, planningMessages(args.goal, args.context, count, config, runOptions), runOptions);
  } catch (error) {
    const malformedJson = error instanceof SyntaxError || String(error.message).includes("did not contain JSON");
    if (runOptions.tokenMode !== "economy" || !malformedJson) throw error;
    const retryOptions = { ...runOptions, tokenMode: "balanced" };
    raw = await callJson(config, config.solModel, planningMessages(args.goal, args.context, count, config, retryOptions), retryOptions);
  }
  const deduplicated = deduplicatePlan(normalizePlan(raw, args.goal, count, config));
  const plan = deduplicated.plan;
  let workerIndex = 0;
  for (const task of plan.tasks) {
    task.assignedModel = task.owner === "sol" ? config.solModel : selectWorker(task, workerIndex++, args, config);
    task.assignedReasoning = selectedReasoning(config, task.assignedModel, args);
  }
  const state = {
    runId: id,
    projectId,
    projectName: projectName(args),
    goal: args.goal,
    status: "planned",
    mode: config.mode,
    tokenMode: runOptions.tokenMode,
    artifactMode: config.artifactMode,
    executionBackend: selectedExecutionBackend(config, args),
    longRunning: Boolean(args.longRunning),
    batchNumber: 1,
    projectRoot,
    projectDocument: path.join(projectRoot, "PROJECT.md"),
    rootRun: dir,
    previousRun: null,
    progressLedger: [],
    completedTaskSignatures: [],
    deduplicatedTasks: deduplicated.removed,
    goalComplete: false,
    needsContinuation: false,
    reviewModel: config.reviewModel,
    reviewReasoning: selectedReasoning(config, config.reviewModel, args),
    reviewModelId: config.models[config.reviewModel]?.model,
    createdAt: new Date().toISOString(),
    workspace,
    usage: await readUsage(dir),
    tasks: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "planned", owner: task.owner, model: task.assignedModel, modelId: config.models[task.assignedModel]?.model, reasoningEffort: task.assignedReasoning }]))
  };
  await writeText(path.join(dir, "request.md"), requestDocument(args.goal, args.context, state.projectId, state.projectName));
  await writeJson(path.join(dir, "plan.json"), plan);
  await writeText(path.join(dir, "plan.md"), planDocument(plan, state));
  const promptPolicy = tokenPolicy(config, runOptions);
  for (const task of plan.tasks) await writeText(path.join(dir, "tasks", `${task.id}.prompt.md`), promptDocument(args.goal, plan, task, promptPolicy));
  await writeProjectDocument(state, plan, dir, config);
  await writeJson(path.join(dir, "state.json"), state);
  return { workspace, config, plan, runDirectory: dir, state };
}

function selectWorker(task, index, args, config) {
  const requested = args.workerModel;
  if (requested) {
    if (!config.models[requested]) throw new Error(`Unknown worker model profile: ${requested}`);
    return requested;
  }
  if (task.preferredModel && config.workerModels.includes(task.preferredModel)) return task.preferredModel;
  return config.workerModels[index % config.workerModels.length];
}

async function prepareHostAgentRun(created, args = {}) {
  const { runDirectory: dir, config, plan } = created;
  const stateFile = path.join(dir, "state.json");
  const state = await readJson(stateFile);
  state.status = "awaiting_host_agents";
  state.executionBackend = "host-agents";
  state.hostAgentNotice = "Child-agent task packets are prepared. These are not top-level Codex UI conversations.";
  const packets = [];
  const approved = new Set(plan.tasks.filter((task) => state.tasks[task.id]?.status === "approved").map((task) => task.id));
  const orderedTasks = topologicalTaskOrder(plan.tasks).map((id) => plan.tasks.find((task) => task.id === id));
  let resultsReady = 0;
  let waitingDependencies = 0;
  for (const task of orderedTasks) {
    if (state.tasks[task.id]?.status === "approved") continue;
    const failedDependency = task.dependsOn.find((id) => ["failed", "rejected", "blocked"].includes(state.tasks[id]?.status));
    if (failedDependency) {
      state.tasks[task.id] = { ...state.tasks[task.id], status: "blocked", error: `Dependency ${failedDependency} did not pass Sol review` };
      continue;
    }
    const resultPath = path.join(dir, "results", `${task.id}.result.md`);
    if (await hasNonEmptyFile(resultPath)) {
      state.tasks[task.id] = { ...state.tasks[task.id], status: "result_ready", resultPath };
      resultsReady += 1;
      continue;
    }
    if (!task.dependsOn.every((id) => approved.has(id))) {
      state.tasks[task.id] = { ...state.tasks[task.id], status: "waiting_dependency", error: null };
      waitingDependencies += 1;
      continue;
    }
    const requestedModel = state.tasks[task.id]?.model || task.assignedModel;
    const conversationTitle = `${state.projectId} | ${requestedModel} | ${compactText(state.goal, 96)} | ${task.id}`;
    const packet = {
      projectId: state.projectId,
      batchNumber: state.batchNumber,
      taskId: task.id,
      title: task.title,
      conversationTitle,
      conversationKey: `${state.projectId}-B${String(state.batchNumber || 1).padStart(2, "0")}-${task.id}-${requestedModel}`,
      conversationScope: "single-project",
      conversationProjectId: state.projectId,
      reusePolicy: "same-project-only",
      dispatch: task.owner === "sol" ? "main-sol" : "subagent",
      requestedModel,
      requestedModelId: state.tasks[task.id]?.modelId || config.models[requestedModel]?.model,
      promptPath: path.join(dir, "tasks", `${task.id}.prompt.md`),
      resultPath,
      fileAccessMode: "isolated-results",
      sharedWorkspaceAccess: "read-only",
      exclusiveWritePath: resultPath
    };
    const originalPrompt = await readTextPreview(packet.promptPath, 128000, true);
    const dependencyResults = await dependencyContext(dir, task, config, args);
    const conversationHeader = [
      `# ${conversationTitle}`,
      "",
      "## File isolation",
      "",
      `- Conversation key: ${packet.conversationKey}`,
      `- This conversation is permanently bound to project: ${packet.conversationProjectId}`,
      "- Never send work from another project into this conversation; create a new conversation instead.",
      `- Read the shared project only; do not modify shared project files during parallel execution.`,
      `- Write only to: ${packet.exclusiveWritePath}`,
      "- Put proposed source changes or patches in the result file. Main Sol applies approved changes sequentially."
    ].join("\n");
    const dependencySection = dependencyResults ? `\n\n## Approved dependency results\n\n${dependencyResults}` : "";
    if (!originalPrompt.startsWith(`# ${conversationTitle}`)) await writeText(packet.promptPath, `${conversationHeader}\n\n${originalPrompt}${dependencySection}`);
    packets.push(packet);
    state.tasks[task.id] = {
      ...state.tasks[task.id],
      status: task.owner === "sol" ? "awaiting_main_sol" : "awaiting_subagent",
      dispatch: packet.dispatch,
      promptPath: packet.promptPath,
      resultPath: packet.resultPath
    };
  }
  state.hostAgentTasks = packets;
  if (!packets.length) {
    state.status = resultsReady ? "host_results_ready" : "host_dispatch_blocked";
    if (!resultsReady && waitingDependencies) state.hostAgentNotice = "No dependency-ready host tasks remain; inspect blocked or cyclic dependencies.";
  }
  await writeProjectDocument(state, plan, dir, config);
  await writeJson(stateFile, state);
  return {
    runDirectory: dir,
    projectId: state.projectId,
    status: state.status,
    executionBackend: "host-agents",
    requiresHostDispatch: packets.length > 0,
    hostAgentTasks: packets,
    nextTool: packets.length ? "After every resultPath in this dependency-ready wave exists, call review_run. If host agents are unavailable, call resume_run with executionBackend api-parallel." : (resultsReady ? "All available host results exist. Call review_run." : "Inspect blocked dependencies before resuming."),
    chatDisplay: chatCard(dir, state, plan, config, state.status)
  };
}

async function dependencyContext(dir, task, config, options) {
  const policy = tokenPolicy(config, options);
  const parts = [];
  for (const id of task.dependsOn) {
    const value = await readTextPreview(path.join(dir, "results", `${id}.result.md`), policy.dependencyChars);
    parts.push(`## Dependency ${id}\n${clipped(value, policy.dependencyChars)}`);
  }
  return parts.join("\n\n");
}

async function executeTask(dir, goal, plan, task, model, config, options = {}) {
  const policy = tokenPolicy(config, options);
  const dependencyResults = await dependencyContext(dir, task, config, options);
  const prompt = [
    `Goal:\n${goalContextForTask(goal, task, policy)}`,
    `Plan:\n${clipped(plan.summary, policy.planChars)}`,
    `Task ${task.id}: ${task.title}\n${clipped(task.prompt || task.description, policy.taskChars)}`,
    `Acceptance:\n${clipped(task.acceptanceCriteria.join("\n"), Math.floor(policy.taskChars / 2))}`,
    `Deliverable:\n${clipped(task.deliverable, 1200)}`,
    dependencyResults
  ].filter(Boolean).join("\n\n");
  const effort = selectedReasoning(config, model, options);
  const content = await callModel(config, model, [
    { role: "system", content: task.owner === "sol" ? "You are Sol. Complete this core task rigorously and concisely." : "Complete only this bounded task. Return the deliverable and concise evidence." },
    { role: "user", content: prompt }
  ], 0.2, { ...options, phase: "worker" });
  await writeText(path.join(dir, "results", `${task.id}.result.md`), `# ${task.id} Result\n\nModel: ${model}\nReasoning: ${effort}\n\n${content}`);
  return content;
}

function reviewMessages(goal, task, result, config, options) {
  const policy = tokenPolicy(config, options);
  const taskContract = {
    id: task.id,
    title: task.title,
    description: clipped(task.description, Math.floor(policy.taskChars / 2)),
    acceptanceCriteria: task.acceptanceCriteria,
    deliverable: task.deliverable
  };
  return [
    {
      role: "system",
      content: "You are Sol's reviewer. Check evidence and every criterion. progressDigest must state concrete completed work, artifacts, and remaining gaps for the next batch. JSON only: {decision:'approved'|'revise'|'rejected',summary,progressDigest,findings:[string],revisionPrompt}."
    },
    {
      role: "user",
      content: `Goal:\n${clipped(goal, policy.goalChars)}\n\nContract:\n${JSON.stringify(taskContract)}\n\nResult:\n${clipped(result, policy.reviewResultChars)}`
    }
  ];
}

function normalizeReview(review) {
  const decision = ["approved", "revise", "rejected"].includes(review.decision) ? review.decision : "revise";
  return {
    decision,
    summary: String(review.summary || ""),
    progressDigest: String(review.progressDigest || review.summary || ""),
    findings: Array.isArray(review.findings) ? review.findings.map(String) : [],
    revisionPrompt: String(review.revisionPrompt || "")
  };
}

async function writeTaskReview(dir, task, normalized) {
  await writeText(path.join(dir, "reviews", `${task.id}.review.md`), [
    `# ${task.id} Sol Review`,
    "",
    `Decision: ${normalized.decision}`,
    "",
    normalized.summary,
    "",
    "## Progress digest",
    "",
    normalized.progressDigest,
    "",
    "## Findings",
    "",
    ...(normalized.findings.length ? normalized.findings.map((item) => `- ${item}`) : ["- None."]),
    "",
    "## Revision prompt",
    "",
    normalized.revisionPrompt || "None."
  ].join("\n"));
}

async function reviewTask(dir, goal, task, result, config, options = {}) {
  const review = await callJson(config, config.reviewModel, reviewMessages(goal, task, result, config, options), { ...options, phase: "review" });
  const normalized = normalizeReview(review);
  await writeTaskReview(dir, task, normalized);
  return normalized;
}

function batchReviewMessages(goal, items, config, options) {
  const policy = tokenPolicy(config, options);
  const perResultChars = Math.max(1200, Math.floor(policy.reviewBatchChars / items.length));
  const packets = items.map(({ task, result }) => ({
    id: task.id,
    contract: {
      title: task.title,
      description: clipped(task.description, Math.floor(policy.taskChars / 3)),
      acceptanceCriteria: task.acceptanceCriteria,
      deliverable: task.deliverable
    },
    result: clipped(result, Math.min(policy.reviewResultChars, perResultChars))
  }));
  return [
    {
      role: "system",
      content: "You are Sol's batch reviewer. Review every task independently against its own contract. Never let one strong result hide another weak result. progressDigest must state concrete completed work, artifacts, and remaining gaps. JSON only: {reviews:[{id,decision:'approved'|'revise'|'rejected',summary,progressDigest,findings:[string],revisionPrompt}]}"
    },
    { role: "user", content: `Goal:\n${clipped(goal, policy.goalChars)}\n\nTask packets:\n${JSON.stringify(packets)}` }
  ];
}

async function reviewTasks(dir, goal, items, config, options = {}) {
  if (!items.length) return new Map();
  const policy = tokenPolicy(config, options);
  const reviews = new Map();
  for (let offset = 0; offset < items.length; offset += policy.reviewBatchSize) {
    const batch = items.slice(offset, offset + policy.reviewBatchSize);
    if (batch.length === 1 || policy.reviewBatchSize === 1) {
      const item = batch[0];
      reviews.set(item.task.id, await reviewTask(dir, goal, item.task, item.result, config, options));
      continue;
    }
    try {
      const raw = await callJson(config, config.reviewModel, batchReviewMessages(goal, batch, config, options), {
        ...options,
        phase: "review",
        outputTokenOverride: policy.review * batch.length
      });
      if (!Array.isArray(raw.reviews)) throw new SyntaxError("Batch review JSON is missing reviews[]");
      const byId = new Map(raw.reviews.map((review) => [String(review.id || ""), review]));
      for (const item of batch) {
        const rawReview = byId.get(item.task.id);
        if (!rawReview) throw new SyntaxError(`Batch review JSON is missing ${item.task.id}`);
        const normalized = normalizeReview(rawReview);
        await writeTaskReview(dir, item.task, normalized);
        reviews.set(item.task.id, normalized);
      }
    } catch (error) {
      const malformed = error instanceof SyntaxError || /JSON|reviews\[\]|missing T\d+/i.test(String(error.message));
      if (!malformed) throw error;
      for (const item of batch) reviews.set(item.task.id, await reviewTask(dir, goal, item.task, item.result, config, options));
    }
  }
  return reviews;
}

async function executeRun(created, args) {
  const { runDirectory: dir, config, plan } = created;
  const stateFile = path.join(dir, "state.json");
  const state = await readJson(stateFile);
  const runOptions = { ...args, executionBackend: "api-parallel", tokenMode: args.tokenMode || state.tokenMode || config.tokenMode, usageFile: path.join(dir, "usage.jsonl") };
  state.status = "running";
  state.executionBackend = "api-parallel";
  state.tokenMode = runOptions.tokenMode;
  state.reviewModel = config.reviewModel;
  state.reviewReasoning = selectedReasoning(config, config.reviewModel, runOptions);
  state.reviewModelId = config.models[config.reviewModel]?.model;
  state.startedAt = new Date().toISOString();
  await writeJsonAtomic(stateFile, state);
  const complete = new Set(plan.tasks.filter((task) => state.tasks[task.id]?.status === "approved").map((task) => task.id));
  const failed = new Set();
  const pending = new Map(plan.tasks.filter((task) => !complete.has(task.id)).map((task) => [task.id, task]));
  let workerIndex = 0;
  while (pending.size) {
    const blocked = [...pending.values()].filter((task) => task.dependsOn.some((id) => failed.has(id)));
    for (const task of blocked) {
      state.tasks[task.id] = { ...state.tasks[task.id], status: "blocked", error: "A dependency failed or was rejected" };
      failed.add(task.id);
      pending.delete(task.id);
    }
    if (blocked.length) await writeJsonAtomic(stateFile, state);
    if (!pending.size) break;
    const ready = [...pending.values()].filter((task) => task.dependsOn.every((id) => complete.has(id)));
    if (!ready.length) {
      for (const task of pending.values()) {
        state.tasks[task.id] = { ...state.tasks[task.id], status: "blocked", error: "Dependency cycle or missing dependency" };
        failed.add(task.id);
      }
      pending.clear();
      await writeJsonAtomic(stateFile, state);
      break;
    }
    for (let offset = 0; offset < ready.length; offset += config.maxParallel) {
      const batch = ready.slice(offset, offset + config.maxParallel);
      const executionInputs = batch.map((task) => {
        const model = task.owner === "sol" ? config.solModel : (runOptions.workerModel || task.assignedModel || selectWorker(task, workerIndex++, runOptions, config));
        const reasoningEffort = selectedReasoning(config, model, runOptions);
        task.assignedModel = model;
        task.assignedReasoning = reasoningEffort;
        const attempts = (state.tasks[task.id]?.attempts || 0) + 1;
        state.tasks[task.id] = { ...state.tasks[task.id], status: "running", owner: task.owner, model, modelId: config.models[model]?.model, reasoningEffort, attempts, error: null };
        return { task, model, reasoningEffort, attempts };
      });
      await writeJsonAtomic(stateFile, state);
      const executions = await Promise.all(executionInputs.map(async ({ task, model, reasoningEffort, attempts }) => {
        try {
          const result = await executeTask(dir, state.goal, plan, task, model, config, runOptions);
          return { task, model, reasoningEffort, attempts, result };
        } catch (error) {
          state.tasks[task.id] = { ...state.tasks[task.id], status: "failed", owner: task.owner, model, modelId: config.models[model]?.model, reasoningEffort, attempts, error: compactText(error?.message || String(error), 500) };
          failed.add(task.id);
          pending.delete(task.id);
          return null;
        }
      }));
      await writeJsonAtomic(stateFile, state);
      const completedExecutions = executions.filter(Boolean);
      if (!completedExecutions.length) continue;
      let reviews;
      try {
        reviews = await reviewTasks(dir, state.goal, completedExecutions.map(({ task, result }) => ({ task, result })), config, runOptions);
      } catch (error) {
        for (const execution of completedExecutions) {
          const { task, model, reasoningEffort, attempts } = execution;
          state.tasks[task.id] = { ...state.tasks[task.id], status: "failed", owner: task.owner, model, modelId: config.models[model]?.model, reasoningEffort, attempts, error: compactText(error?.message || String(error), 500) };
          failed.add(task.id);
          pending.delete(task.id);
        }
        await writeJsonAtomic(stateFile, state);
        continue;
      }
      const revisions = await Promise.all(completedExecutions.filter(({ task }) => reviews.get(task.id)?.decision === "revise").map(async (execution) => {
        const { task, model, reasoningEffort, attempts, result } = execution;
        const review = reviews.get(task.id);
        const policy = tokenPolicy(config, runOptions);
        try {
          const revisedResult = await callModel(config, model, [
            { role: "system", content: "Revise concisely. Address every Sol finding and preserve valid work." },
            { role: "user", content: `Result:\n${clipped(result, policy.reviewResultChars)}\n\nReview:\n${clipped(JSON.stringify(review), policy.finalReviewChars)}` }
          ], 0.2, { ...runOptions, phase: "worker" });
          await writeText(path.join(dir, "results", `${task.id}.result.md`), `# ${task.id} Result (revised)\n\nModel: ${model}\nReasoning: ${reasoningEffort}\n\n${revisedResult}`);
          return { ...execution, result: revisedResult };
        } catch (error) {
          state.tasks[task.id] = { ...state.tasks[task.id], status: "failed", owner: task.owner, model, modelId: config.models[model]?.model, reasoningEffort, attempts, error: compactText(error?.message || String(error), 500) };
          failed.add(task.id);
          pending.delete(task.id);
          return null;
        }
      }));
      const completedRevisions = revisions.filter(Boolean);
      if (completedRevisions.length) {
        try {
          const revisedReviews = await reviewTasks(dir, state.goal, completedRevisions.map(({ task, result }) => ({ task, result })), config, runOptions);
          for (const [taskId, review] of revisedReviews) reviews.set(taskId, review);
        } catch (error) {
          for (const execution of completedRevisions) {
            const { task, model, reasoningEffort, attempts } = execution;
            state.tasks[task.id] = { ...state.tasks[task.id], status: "failed", owner: task.owner, model, modelId: config.models[model]?.model, reasoningEffort, attempts, error: compactText(error?.message || String(error), 500) };
            failed.add(task.id);
            pending.delete(task.id);
          }
        }
      }
      for (const execution of completedExecutions) {
        const { task, model, reasoningEffort, attempts } = execution;
        if (state.tasks[task.id]?.status === "failed") continue;
        const review = reviews.get(task.id);
        state.tasks[task.id] = { ...state.tasks[task.id], status: review.decision, owner: task.owner, model, modelId: config.models[model]?.model, reasoningEffort, attempts, progressDigest: review.progressDigest };
        if (review.decision === "approved") complete.add(task.id);
        else failed.add(task.id);
        pending.delete(task.id);
      }
      await writeJsonAtomic(stateFile, state);
    }
  }
  await writeJsonAtomic(path.join(dir, "plan.json"), plan);
  if (failed.size) {
    state.status = "partial_failure";
    state.failedTasks = [...failed];
    state.resumable = true;
    state.needsContinuation = false;
    state.usage = await readUsage(dir);
    await writeProjectDocument(state, plan, dir, config);
    await writeJsonAtomic(stateFile, state);
    return {
      runDirectory: dir,
      projectId: state.projectId,
      status: state.status,
      resumable: true,
      failedTasks: state.failedTasks,
      nextTool: "Call resume_run after correcting endpoint or task issues.",
      usage: state.usage,
      chatDisplay: chatCard(dir, state, plan, config, state.status)
    };
  }
  return finalizeReview(dir, config, runOptions);
}

async function finalizeReview(dir, config, options = {}) {
  const plan = await readJson(path.join(dir, "plan.json"));
  const stateFile = path.join(dir, "state.json");
  const state = await readJson(stateFile);
  const finalOptions = { ...options, tokenMode: options.tokenMode || state.tokenMode || config.tokenMode, usageFile: options.usageFile || path.join(dir, "usage.jsonl"), phase: "final" };
  const policy = tokenPolicy(config, finalOptions);
  const packets = [];
  for (const task of plan.tasks) {
    const resultFile = path.join(dir, "results", `${task.id}.result.md`);
    let result;
    try { result = await readTextPreview(resultFile, policy.reviewResultChars); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const reviewFile = path.join(dir, "reviews", `${task.id}.review.md`);
    let review;
    try { review = await readTextPreview(reviewFile, Math.max(16000, policy.finalReviewChars * 2)); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      await reviewTask(dir, state.goal, task, result, config, finalOptions);
      review = await readTextPreview(reviewFile, Math.max(16000, policy.finalReviewChars * 2));
    }
    packets.push(`${task.id} ${task.title} | owner=${task.owner} | status=${state.tasks[task.id]?.status || "unknown"}\n${clipped(review, policy.finalReviewChars)}`);
  }
  if (!packets.length) throw new Error(`No result documents found in ${path.join(dir, "results")}`);
  const planSummary = plan.tasks.map((task) => `${task.id}:${task.title}[${task.owner}]`).join("; ");
  const taskEntries = plan.tasks.map((task) => `${task.id} ${task.title}: ${state.tasks[task.id]?.status || "unknown"}`);
  const blocked = taskEntries.filter((entry) => !entry.endsWith(": approved"));
  const final = finalOptions.tokenMode === "economy"
    ? [
        `Decision: ${blocked.length ? "REVIEW_REQUIRED" : "APPROVED"}`,
        "",
        "## Task decisions",
        ...taskEntries.map((entry) => `- ${entry}`),
        "",
        "## Integration order",
        `- ${topologicalTaskOrder(plan.tasks).join(" -> ")}`,
        "",
        blocked.length ? "## Blockers\n" + blocked.map((entry) => `- ${entry}`).join("\n") : "## Remaining risks\n- See the individual Sol review documents for evidence and task-specific risks."
      ].join("\n")
    : await callModel(config, config.reviewModel, [
        { role: "system", content: "Give a concise release decision from Sol reviews only: approved items, blockers, integration order, risks. Never override a failed review." },
        { role: "user", content: `Goal:\n${clipped(state.goal, policy.goalChars)}\n\nPlan:\n${clipped(planSummary, policy.planChars)}\n\nReviews:\n${packets.join("\n\n")}` }
      ], 0.2, finalOptions);
  const finalFile = path.join(dir, "final-review.md");
  await writeText(finalFile, `# ${state.projectId}: Final Sol Review\n\n/gaol ${state.goal}\n\n${final}`);
  state.status = Object.values(state.tasks).some((task) => task.status !== "approved") ? "review_required" : "approved";
  state.needsContinuation = Boolean(state.longRunning && !state.goalComplete && ["approved", "review_required"].includes(state.status));
  state.completedAt = new Date().toISOString();
  state.finalReview = finalFile;
  state.usage = await readUsage(dir);
  await writeProjectDocument(state, plan, dir, config);
  await writeJson(stateFile, state);
  await compactRun(dir, state, plan, config);
  const chatDisplay = chatCard(dir, state, plan, config, state.status);
  return { runDirectory: dir, projectId: state.projectId, status: state.status, needsContinuation: state.needsContinuation, bundle: state.bundlePath || null, finalReview: finalFile, tasks: state.tasks, usage: state.usage, chatDisplay };
}

async function reviewRun(args) {
  const dir = path.resolve(args.runDirectory);
  let archived = null;
  try { archived = await readBundle(dir); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (archived) requireEnabled(await loadConfig(archived.state.workspace));
  if (archived) await expandBundleForReview(dir, archived);
  const state = await readJson(path.join(dir, "state.json"));
  const config = await loadConfig(state.workspace);
  requireEnabled(config);
  const runOptions = { ...args, tokenMode: args.tokenMode || state.tokenMode || config.tokenMode, usageFile: path.join(dir, "usage.jsonl") };
  const policy = tokenPolicy(config, runOptions);
  state.tokenMode = runOptions.tokenMode;
  state.reviewModel = config.reviewModel;
  state.reviewReasoning = selectedReasoning(config, config.reviewModel, runOptions);
  state.reviewModelId = config.models[config.reviewModel]?.model;
  const plan = await readJson(path.join(dir, "plan.json"));
  const missingResults = [];
  const pendingReviews = [];
  for (const task of plan.tasks) {
    const resultFile = path.join(dir, "results", `${task.id}.result.md`);
    try {
      const result = await readTextPreview(resultFile, policy.reviewResultChars);
      if (state.tasks[task.id]?.status === "approved" && await hasNonEmptyFile(path.join(dir, "reviews", `${task.id}.review.md`))) continue;
      pendingReviews.push({ task, result });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state.tasks[task.id] = { ...state.tasks[task.id], status: "missing_result" };
      missingResults.push(task.id);
    }
  }
  const reviews = await reviewTasks(dir, state.goal, pendingReviews, config, runOptions);
  for (const { task } of pendingReviews) {
    const review = reviews.get(task.id);
    state.tasks[task.id] = { ...state.tasks[task.id], status: review.decision, progressDigest: review.progressDigest };
  }
  await writeJson(path.join(dir, "state.json"), state);
  if (missingResults.length) {
    if (state.executionBackend === "host-agents") return prepareHostAgentRun({ workspace: state.workspace, config, plan, runDirectory: dir, state }, { ...args, executionBackend: "host-agents" });
    state.status = "missing_results";
    state.resumable = true;
    await writeJson(path.join(dir, "state.json"), state);
    return { runDirectory: dir, projectId: state.projectId, status: state.status, resumable: true, missingResults, nextTool: "Call resume_run after supplying or regenerating missing results.", chatDisplay: chatCard(dir, state, plan, config, state.status) };
  }
  return finalizeReview(dir, config, runOptions);
}

async function reviewSummaries(dir, plan, config, options, archivedBundle = null) {
  const policy = tokenPolicy(config, options);
  let bundle = archivedBundle;
  if (!bundle) {
    try { bundle = await readBundle(dir); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const summaries = [];
  for (const task of plan.tasks) {
    const review = bundle?.reviews?.[task.id] || await readTextPreview(path.join(dir, "reviews", `${task.id}.review.md`), Math.max(16000, policy.reviewSummaryChars * 4), true);
    const decision = review.match(/^Decision:\s*([^\r\n]+)/im)?.[1]?.trim() || "unknown";
    const summary = review.match(/^Decision:[^\r\n]*\r?\n+([\s\S]*?)(?=\r?\n## Progress digest|$)/im)?.[1]?.trim() || "";
    const progress = review.match(/## Progress digest\s*\r?\n+([\s\S]*?)(?=\r?\n## |$)/i)?.[1]?.trim() || "";
    const findings = review.match(/## Findings\s*\r?\n+([\s\S]*?)(?=\r?\n## |$)/i)?.[1]?.trim() || "";
    const compact = [
      `Decision: ${decision}`,
      summary ? `Summary: ${summary}` : "",
      progress ? `Progress: ${progress}` : "",
      findings && !/^[-\s]*None\.?$/i.test(findings) ? `Findings: ${findings}` : ""
    ].filter(Boolean).join("\n");
    summaries.push(`${task.id} ${task.title}\n${clipped(compact || "No review document", policy.reviewSummaryChars)}`);
  }
  return summaries.join("\n\n");
}

function progressLedgerText(ledger, policy) {
  const entries = Array.isArray(ledger) ? ledger.filter((entry) => typeof entry === "string" && entry.trim()) : [];
  return entries.length ? clipped(entries.join("\n\n"), policy.progressLedgerChars) : "None recorded.";
}

function appendProgressLedger(previousState, previousPlan, summaries, policy) {
  const ledger = Array.isArray(previousState.progressLedger) ? previousState.progressLedger.filter((entry) => typeof entry === "string" && entry.trim()) : [];
  const taskDigests = previousPlan.tasks.map((task) => {
    const digest = previousState.tasks?.[task.id]?.progressDigest;
    return digest ? `- ${task.id} ${task.title}: ${compactText(digest, policy.reviewSummaryChars)}` : "";
  }).filter(Boolean);
  const fallback = compactText(summaries, policy.reviewSummaryChars);
  const entry = `B${String(previousState.batchNumber || 1).padStart(2, "0")}\n${taskDigests.length ? taskDigests.join("\n") : fallback}`;
  const next = [...ledger, entry];
  while (next.join("\n\n").length > policy.progressLedgerChars && next.length > 2) next.splice(1, 1);
  if (next.join("\n\n").length > policy.progressLedgerChars) {
    const perEntry = Math.max(400, Math.floor(policy.progressLedgerChars / next.length) - 2);
    return next.map((item) => clipped(item, perEntry));
  }
  return next;
}

async function markContinued(dir, nextDir, documents = null) {
  if (documents?.bundle) {
    documents.bundle.state.needsContinuation = false;
    documents.bundle.state.continuedBy = nextDir;
    await writeJsonAtomic(path.join(dir, "run-bundle.json"), documents.bundle);
    return;
  }
  if (documents?.state) {
    documents.state.needsContinuation = false;
    documents.state.continuedBy = nextDir;
    await writeJsonAtomic(path.join(dir, "state.json"), documents.state);
    return;
  }
  try {
    const file = path.join(dir, "state.json");
    const state = await readJson(file);
    state.needsContinuation = false;
    state.continuedBy = nextDir;
    await writeJsonAtomic(file, state);
    return;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const file = path.join(dir, "run-bundle.json");
  const bundle = await readJson(file);
  bundle.state.needsContinuation = false;
  bundle.state.continuedBy = nextDir;
  await writeJsonAtomic(file, bundle);
}

function continuationMessages(state, plan, summaries, count, config, options) {
  const policy = tokenPolicy(config, options);
  const countRule = count ? `If incomplete, create exactly ${count} next tasks.` : `If incomplete, create 1 to ${config.maxTasksPerRun} next tasks.`;
  return [
    {
      role: "system",
      content: [
        "You are Sol maintaining a long-running goal.",
        "Decide goalComplete=true only when the final goal is fully satisfied and cite concrete completionEvidence.",
        countRule,
        "If incomplete, generate the smallest useful next batch; never return an empty task list.",
        "Do not recreate work already completed in the historical progress ledger or current Sol reviews.",
        "Keep core/high-risk work with owner 'sol'.",
        "JSON only: {goalComplete,completionEvidence:[string],progressSummary,tasks:[{id,title,owner,preferredModel,description,prompt,acceptanceCriteria,dependsOn,deliverable}]}."
      ].join("\n")
    },
    {
      role: "user",
      content: `Goal:\n${clipped(state.goal, policy.goalChars)}\n\nHistorical progress ledger:\n${progressLedgerText(state.progressLedger, policy)}\n\nPrevious batch:\n${clipped(plan.summary, policy.planChars)}\n\nCurrent Sol reviews:\n${clipped(summaries, policy.reviewResultChars)}`
    }
  ];
}

async function verifyGoalCompletion(state, raw, evidence, summaries, config, options) {
  const policy = tokenPolicy(config, options);
  try {
    const review = await callJson(config, config.reviewModel, [
      {
        role: "system",
        content: "Independently verify final-goal completion. Reject vague, circular, or unsupported evidence. JSON only: {approved:boolean,summary,findings:[string]}."
      },
      {
        role: "user",
        content: `Goal:\n${clipped(state.goal, policy.goalChars)}\n\nHistorical progress ledger:\n${progressLedgerText(state.progressLedger, policy)}\n\nClaimed progress:\n${clipped(raw.progressSummary, policy.planChars)}\n\nCompletion evidence:\n${clipped(evidence.join("\n"), policy.finalReviewChars)}\n\nCurrent Sol reviews:\n${clipped(summaries, policy.reviewResultChars)}`
      }
    ], { ...options, phase: "review" });
    return {
      approved: review.approved === true,
      summary: String(review.summary || ""),
      findings: Array.isArray(review.findings) ? review.findings.map(String) : []
    };
  } catch (error) {
    return { approved: false, summary: "Completion verification failed", findings: [compactText(error?.message || String(error), 500)] };
  }
}

async function existingContinuation(previousState) {
  if (!previousState.continuedBy) return null;
  const dir = path.resolve(previousState.continuedBy);
  const { state, plan } = await readRunDocuments(dir);
  const config = await loadConfig(state.workspace);
  return {
    runDirectory: dir,
    projectId: state.projectId,
    status: state.status,
    goalComplete: Boolean(state.goalComplete),
    batchNumber: state.batchNumber,
    idempotent: true,
    chatDisplay: chatCard(dir, state, plan, config, state.status)
  };
}

async function continueGoal(args) {
  const previousDir = path.resolve(args.runDirectory);
  let previousDocuments = await readRunDocuments(previousDir);
  let previousState = previousDocuments.state;
  const lockConfig = await loadConfig(previousState.workspace);
  requireEnabled(lockConfig);
  const existing = await existingContinuation(previousState);
  if (existing) return existing;
  const lockRoot = previousState.projectRoot || path.dirname(previousDir);
  const lockFile = path.join(lockRoot, `.continue-${createHash("sha256").update(previousDir).digest("hex").slice(0, 12)}.lock`);
  let lock;
  try {
    lock = await fs.open(lockFile, "wx");
    await lock.writeFile(JSON.stringify({ previousDir, createdAt: new Date().toISOString() }));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const lockStat = await fs.stat(lockFile);
    const staleAfterMs = lockConfig.requestTimeoutMs * (lockConfig.maxRetries + 1) + 60000;
    if (Date.now() - lockStat.mtimeMs > staleAfterMs) {
      await fs.rm(lockFile, { force: true });
      return continueGoal(args);
    }
    previousDocuments = await readRunDocuments(previousDir);
    previousState = previousDocuments.state;
    const completed = await existingContinuation(previousState);
    if (completed) return completed;
    return { runDirectory: previousDir, projectId: previousState.projectId, status: "continuation_in_progress", idempotent: true, message: "Another continuation call is already creating the next batch." };
  }
  try {
    return await continueGoalUnlocked(args, previousDocuments);
  } finally {
    await lock.close();
    await fs.rm(lockFile, { force: true });
  }
}

async function continueGoalUnlocked(args, loadedDocuments = null) {
  const previousDir = path.resolve(args.runDirectory);
  const previousDocuments = loadedDocuments || await readRunDocuments(previousDir);
  const previousState = previousDocuments.state;
  if (!previousState.longRunning) throw new Error("This run is not marked longRunning. Start /gaol with longRunning: true.");
  if (!["approved", "review_required"].includes(previousState.status)) throw new Error(`Run must be reviewed before continuation; current status is '${previousState.status}'`);
  const config = await loadConfig(previousState.workspace);
  const previousPlan = previousDocuments.plan;
  const completedSignatures = completedTaskSignatures(previousState, previousPlan);
  const count = requestedCount(args, config);
  const id = runId(previousState.goal);
  const batchNumber = (previousState.batchNumber || 1) + 1;
  const projectRoot = previousState.projectRoot || projectArtifactRoot(previousState.workspace, config, previousState.projectId);
  const dir = path.join(projectRoot, `B${String(batchNumber).padStart(2, "0")}-${id}`);
  await fs.mkdir(path.join(dir, "tasks"), { recursive: true });
  await fs.mkdir(path.join(dir, "results"), { recursive: true });
  await fs.mkdir(path.join(dir, "reviews"), { recursive: true });
  const runOptions = { ...args, tokenMode: args.tokenMode || previousState.tokenMode || config.tokenMode, usageFile: path.join(dir, "usage.jsonl"), phase: "planning" };
  const summaries = await reviewSummaries(previousDir, previousPlan, config, runOptions, previousDocuments.bundle);
  const policy = tokenPolicy(config, runOptions);
  const progressLedger = appendProgressLedger(previousState, previousPlan, summaries, policy);
  let raw;
  try {
    raw = await callJson(config, config.solModel, continuationMessages(previousState, previousPlan, summaries, count, config, runOptions), runOptions);
  } catch (error) {
    const malformedJson = error instanceof SyntaxError || String(error.message).includes("did not contain JSON");
    if (runOptions.tokenMode !== "economy" || !malformedJson) throw error;
    const retryOptions = { ...runOptions, tokenMode: "balanced" };
    raw = await callJson(config, config.solModel, continuationMessages(previousState, previousPlan, summaries, count, config, retryOptions), retryOptions);
  }
  const evidence = Array.isArray(raw.completionEvidence) ? raw.completionEvidence.map(String).filter(Boolean) : [];
  if (raw.goalComplete && !evidence.length) raw.goalComplete = false;
  let completionVerification = null;
  if (raw.goalComplete) {
    completionVerification = await verifyGoalCompletion(previousState, raw, evidence, summaries, config, runOptions);
    if (!completionVerification.approved) raw.goalComplete = false;
  }
  let synthesizedFallback = false;
  if (!raw.goalComplete && (!Array.isArray(raw.tasks) || !raw.tasks.length)) {
    synthesizedFallback = true;
    const verificationContext = completionVerification?.findings?.length ? ` Address these completion-review findings: ${completionVerification.findings.join("; ")}` : "";
    raw.tasks = [{
      title: "Advance and verify the next milestone",
      owner: "sol",
      description: `Determine the next unmet milestone, execute it, and produce evidence.${verificationContext}`,
      prompt: `Identify the highest-priority unmet part of the final goal, complete it, and document verifiable evidence.${verificationContext}`,
      acceptanceCriteria: ["An unmet milestone is identified", "Concrete progress and evidence are produced"],
      dependsOn: [],
      deliverable: "Verified next-milestone result"
    }];
  }
  const baseState = {
    runId: id,
    projectId: previousState.projectId,
    projectName: previousState.projectName,
    goal: previousState.goal,
    mode: config.mode,
    tokenMode: runOptions.tokenMode,
    artifactMode: config.artifactMode,
    executionBackend: selectedExecutionBackend(config, args),
    longRunning: true,
    batchNumber,
    projectRoot,
    projectDocument: path.join(projectRoot, "PROJECT.md"),
    rootRun: previousState.rootRun || previousDir,
    previousRun: previousDir,
    progressLedger,
    completedTaskSignatures: completedSignatures,
    deduplicatedTasks: [],
    reviewModel: config.reviewModel,
    reviewReasoning: selectedReasoning(config, config.reviewModel, runOptions),
    reviewModelId: config.models[config.reviewModel]?.model,
    createdAt: new Date().toISOString(),
    workspace: previousState.workspace,
    goalComplete: Boolean(raw.goalComplete),
    needsContinuation: false,
    completionVerification
  };
  if (raw.goalComplete) {
    const plan = { summary: String(raw.progressSummary || "Goal complete"), tasks: [] };
    const state = { ...baseState, status: "goal_complete", completionEvidence: evidence, tasks: {}, usage: await readUsage(dir) };
    const finalFile = path.join(dir, "final-review.md");
    state.finalReview = finalFile;
    const continuationContext = `Historical progress:\n${progressLedgerText(progressLedger, policy)}\n\nCurrent reviews:\n${summaries}`;
    await writeText(path.join(dir, "request.md"), requestDocument(state.goal, continuationContext, state.projectId, state.projectName));
    await writeJson(path.join(dir, "plan.json"), plan);
    await writeText(path.join(dir, "plan.md"), planDocument(plan, state));
    await writeText(finalFile, `# ${state.projectId}: Goal Complete\n\n/gaol ${state.goal}\n\n## Evidence\n\n${evidence.map((item) => `- ${item}`).join("\n")}\n\n## Independent verification\n\n${completionVerification.summary}`);
    await writeProjectDocument(state, plan, dir, config);
    await writeJson(path.join(dir, "state.json"), state);
    await compactRun(dir, state, plan, config);
    const chatDisplay = chatCard(dir, state, plan, config, state.status);
    await markContinued(previousDir, dir, previousDocuments);
    return { runDirectory: dir, projectId: state.projectId, status: state.status, goalComplete: true, bundle: state.bundlePath || null, chatDisplay };
  }
  let deduplicated = deduplicatePlan(
    normalizePlan({ ...raw, summary: raw.progressSummary || "Next goal batch" }, previousState.goal, synthesizedFallback ? null : count, config),
    completedSignatures
  );
  if (!deduplicated.plan.tasks.length) {
    synthesizedFallback = true;
    const batchLabel = `B${String(previousState.batchNumber || 1).padStart(2, "0")}`;
    const fallback = normalizePlan({
      summary: `Advance beyond completed work after ${batchLabel}`,
      tasks: [{
        title: `Advance the next unmet milestone after ${batchLabel}`,
        owner: "sol",
        description: "Use the progress ledger to identify work not already completed, advance it, and produce new evidence.",
        prompt: "Do not repeat any completed task. Identify the highest-priority unmet milestone, complete it, and document new verifiable evidence.",
        acceptanceCriteria: ["Previously completed work is not repeated", "A new unmet milestone is advanced", "New evidence is recorded"],
        dependsOn: [],
        deliverable: "New verified progress beyond the completed-task ledger"
      }]
    }, previousState.goal, null, config);
    const fallbackDeduplicated = deduplicatePlan(fallback, completedSignatures);
    deduplicated = { plan: fallbackDeduplicated.plan, removed: [...deduplicated.removed, ...fallbackDeduplicated.removed] };
  }
  const plan = deduplicated.plan;
  let workerIndex = 0;
  for (const task of plan.tasks) {
    task.assignedModel = task.owner === "sol" ? config.solModel : selectWorker(task, workerIndex++, args, config);
    task.assignedReasoning = selectedReasoning(config, task.assignedModel, runOptions);
  }
  const state = {
    ...baseState,
    status: "planned",
    deduplicatedTasks: deduplicated.removed,
    tasks: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "planned", owner: task.owner, model: task.assignedModel, modelId: config.models[task.assignedModel]?.model, reasoningEffort: task.assignedReasoning }])),
    usage: await readUsage(dir)
  };
  const continuationContext = `Historical progress:\n${progressLedgerText(progressLedger, policy)}\n\nCurrent reviews:\n${summaries}`;
  await writeText(path.join(dir, "request.md"), requestDocument(state.goal, continuationContext, state.projectId, state.projectName));
  await writeJson(path.join(dir, "plan.json"), plan);
  await writeText(path.join(dir, "plan.md"), planDocument(plan, state));
  const promptPolicy = tokenPolicy(config, runOptions);
  for (const task of plan.tasks) await writeText(path.join(dir, "tasks", `${task.id}.prompt.md`), promptDocument(state.goal, plan, task, promptPolicy));
  await writeProjectDocument(state, plan, dir, config);
  await writeJson(path.join(dir, "state.json"), state);
  await markContinued(previousDir, dir, previousDocuments);
  return { runDirectory: dir, projectId: state.projectId, status: "planned", goalComplete: false, batchNumber, taskCount: plan.tasks.length, chatDisplay: chatCard(dir, state, plan, config, "planned") };
}

async function statusRun(args) {
  const dir = path.resolve(args.runDirectory);
  const { state, plan, bundle } = await readRunDocuments(dir);
  const missingResults = [];
  for (const task of plan.tasks) {
    if (bundle) {
      if (!bundle.results?.[task.id]) missingResults.push(task.id);
    } else {
      try { await fs.access(path.join(dir, "results", `${task.id}.result.md`)); }
      catch { missingResults.push(task.id); }
    }
  }
  const config = await loadConfig(state.workspace);
  requireEnabled(config);
  state.usage = bundle?.usage || state.usage || await readUsage(dir);
  return { runDirectory: dir, state, missingResults, chatDisplay: chatCard(dir, state, plan, config, state.status) };
}

async function resumeRun(args) {
  const dir = path.resolve(args.runDirectory);
  const { state, plan } = await readRunDocuments(dir);
  const config = await loadConfig(state.workspace);
  requireEnabled(config);
  const allowed = ["partial_failure", "running", "awaiting_host_agents", "host_results_ready", "host_dispatch_blocked", "missing_results"];
  if (!allowed.includes(state.status)) throw new Error(`Run ${state.projectId || state.runId} is '${state.status}' and does not need resume_run`);
  state.status = "planned";
  state.resumable = false;
  state.failedTasks = [];
  for (const task of plan.tasks) {
    if (state.tasks[task.id]?.status === "approved") continue;
    const resultFile = path.join(dir, "results", `${task.id}.result.md`);
    const reviewFile = path.join(dir, "reviews", `${task.id}.review.md`);
    const existingReview = await readTextPreview(reviewFile, 4096, true);
    if (existingReview.includes("Decision: approved") && await hasNonEmptyFile(resultFile)) {
      state.tasks[task.id] = { ...state.tasks[task.id], status: "approved", error: null };
      continue;
    }
    state.tasks[task.id] = { ...state.tasks[task.id], status: "planned", error: null };
  }
  await writeProjectDocument(state, plan, dir, config);
  await writeJson(path.join(dir, "state.json"), state);
  const created = { workspace: state.workspace, config, plan, runDirectory: dir, state };
  if (selectedExecutionBackend(config, args) === "host-agents") return prepareHostAgentRun(created, args);
  return executeRun(created, { ...args, executionBackend: "api-parallel" });
}

async function executeExistingRun(args) {
  const dir = path.resolve(args.runDirectory);
  const { state, plan } = await readRunDocuments(dir);
  const config = await loadConfig(state.workspace);
  requireEnabled(config);
  if (state.status !== "planned") throw new Error(`Run ${state.projectId || state.runId} is '${state.status}', not 'planned'`);
  if (config.mode === "documents") {
    return { runDirectory: dir, projectId: state.projectId, status: "planned", chatDisplay: chatCard(dir, state, plan, config, "planned") };
  }
  const created = { workspace: state.workspace, config, plan, runDirectory: dir, state };
  if (selectedExecutionBackend(config, args) === "host-agents") return prepareHostAgentRun(created, args);
  return executeRun(created, { ...args, executionBackend: "api-parallel" });
}

async function invokeTool(name, args) {
  if (name === "open_config_window") return openConfigWindow(args);
  if (name === "get_config") {
    const workspace = workspaceRoot(args.workspace);
    const config = await loadConfig(workspace);
    return { workspace, configPath: path.join(controlRoot(workspace), "config.json"), revision: configRevision(config), config: redactConfig(config) };
  }
  if (name === "configure") return configure(args);
  if (name === "plan_workflow") {
    const created = await createPlan(args);
    return { runDirectory: created.runDirectory, projectId: created.state.projectId, status: "planned", taskCount: created.plan.tasks.length, plan: path.join(created.runDirectory, "plan.md"), taskDirectory: path.join(created.runDirectory, "tasks"), chatDisplay: chatCard(created.runDirectory, created.state, created.plan, created.config, "planned") };
  }
  if (name === "run_workflow") {
    const created = await createPlan(args);
    if (created.config.mode === "documents") {
      return {
        runDirectory: created.runDirectory,
        status: "planned",
        taskCount: created.plan.tasks.length,
        plan: path.join(created.runDirectory, "plan.md"),
        taskDirectory: path.join(created.runDirectory, "tasks"),
        message: "Documents mode is enabled; place worker results under results/ and call review_run.",
        chatDisplay: chatCard(created.runDirectory, created.state, created.plan, created.config, "planned")
      };
    }
    if (selectedExecutionBackend(created.config, args) === "host-agents") return prepareHostAgentRun(created, args);
    return executeRun(created, { ...args, executionBackend: "api-parallel" });
  }
  if (name === "execute_run") return executeExistingRun(args);
  if (name === "resume_run") return resumeRun(args);
  if (name === "continue_goal") return continueGoal(args);
  if (name === "review_run") return reviewRun(args);
  if (name === "run_status") return statusRun(args);
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: SERVER } });
    return;
  }
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === "tools/call") {
    try {
      const result = await invokeTool(message.params?.name, message.params?.arguments || {});
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: result.chatDisplay || JSON.stringify(result, null, 2) }], structuredContent: result } });
    } catch (error) {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: error?.message || String(error) }], isError: true } });
    }
    return;
  }
  if (message.id !== undefined && !message.method?.startsWith("notifications/")) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try { void handle(JSON.parse(line)); }
    catch (error) { console.error(`Invalid MCP message: ${error.message}`); }
  }
  if (Buffer.byteLength(buffer, "utf8") > MAX_MCP_BUFFER_BYTES) {
    console.error(`MCP message exceeded the ${MAX_MCP_BUFFER_BYTES}-byte safety limit; pass large workspace files by path.`);
    buffer = "";
    process.exitCode = 1;
    process.stdin.destroy();
  }
});

process.stdin.on("end", () => {
  const finish = () => { process.exitCode = 0; };
  if (configUiServer) configUiServer.close(finish);
  else finish();
});
