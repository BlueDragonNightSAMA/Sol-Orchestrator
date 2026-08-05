import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function startServer() {
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const pending = new Map();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    handler.resolve(message);
  });

  function call(id, name, args) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${name}. ${stderr}`));
      }, 5000);
      pending.set(id, {
        resolve: (message) => { clearTimeout(timer); resolve(message); }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    });
  }

  async function close() {
    if (child.exitCode !== null) return;
    child.stdin.end();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(() => { child.kill(); resolve(); }, 3000))
    ]);
  }

  return { child, call, close, stderr: () => stderr };
}

function configBody(config, expectedRevision, artifactDirectory) {
  return {
    expectedRevision,
    enabled: config.enabled,
    mode: config.mode,
    executionBackend: config.executionBackend,
    artifactMode: config.artifactMode,
    artifactDirectory,
    tokenMode: config.tokenMode,
    tasksPerBatch: config.tasksPerBatch,
    maxTasksPerRun: config.maxTasksPerRun,
    maxParallel: config.maxParallel,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    retryBaseMs: config.retryBaseMs,
    solModel: config.solModel,
    reviewModel: config.reviewModel,
    workerModels: config.workerModels,
    profiles: Object.entries(config.models).map(([name, profile]) => ({
      name,
      model: profile.model,
      baseUrl: profile.baseUrl,
      apiKeyEnv: profile.apiKeyEnv,
      reasoningEffort: profile.reasoningEffort,
      reasoningField: profile.reasoningField,
      maxTokensField: profile.maxTokensField,
      temperatureEnabled: profile.temperatureEnabled
    }))
  };
}

test("configuration dashboard loads, saves, and rejects stale or cross-origin writes", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sol-orchestrator-ui-"));
  const server = startServer();
  t.after(async () => {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const opened = await server.call(1, "open_config_window", { workspace, launchBrowser: false });
  assert.equal(opened.result?.isError, undefined, server.stderr());
  const url = opened.result.structuredContent.url;
  const parsed = new URL(url);
  const session = parsed.searchParams.get("session");
  const api = `${parsed.origin}/api/config?session=${encodeURIComponent(session)}`;

  const [pageResponse, cssResponse, scriptResponse, configResponse] = await Promise.all([
    fetch(url),
    fetch(`${parsed.origin}/config-ui.css`),
    fetch(`${parsed.origin}/config-ui.js`),
    fetch(api)
  ]);
  assert.equal(pageResponse.status, 200);
  assert.equal(cssResponse.status, 200);
  assert.equal(scriptResponse.status, 200);
  assert.equal(configResponse.status, 200);
  const page = await pageResponse.text();
  assert.match(page, /id="orchestrator-map"/);
  assert.match(page, /id="enabled"/);
  assert.match(page, /id="artifact-directory"/);
  assert.match(page, /单次调用输出上限/);

  const current = await configResponse.json();
  assert.equal(current.config.enabled, true);
  const body = configBody(current.config, current.revision, "artifacts-ui-test");
  body.enabled = false;
  const rejected = await fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://untrusted.invalid" },
    body: JSON.stringify(body)
  });
  assert.equal(rejected.status, 403);

  const saved = await fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json", origin: parsed.origin },
    body: JSON.stringify(body)
  });
  assert.equal(saved.status, 200);
  const savedPayload = await saved.json();
  assert.equal(savedPayload.config.enabled, false);
  assert.equal(savedPayload.config.artifactDirectory, "artifacts-ui-test");
  assert.notEqual(savedPayload.revision, current.revision);

  const stale = await fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json", origin: parsed.origin },
    body: JSON.stringify(body)
  });
  assert.equal(stale.status, 409);

  const testProfile = await fetch(`${parsed.origin}/api/test-profile?session=${encodeURIComponent(session)}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: parsed.origin },
    body: JSON.stringify({ profile: { name: "blocked", model: "blocked", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "" } })
  });
  assert.equal(testProfile.status, 400);
  assert.match((await testProfile.json()).error, /disabled/);

  const blockedPlan = await server.call(2, "plan_workflow", { workspace, goal: "This must not create files or call a model." });
  assert.equal(blockedPlan.result?.isError, true);
  assert.match(blockedPlan.result.content[0].text, /disabled/);
  await assert.rejects(fs.access(path.join(workspace, "artifacts-ui-test")), { code: "ENOENT" });

  const disabledConfig = await server.call(3, "get_config", { workspace });
  assert.equal(disabledConfig.result?.structuredContent?.config?.enabled, false);
  const reenabled = await server.call(4, "configure", { workspace, enabled: true });
  assert.equal(reenabled.result?.isError, undefined);
  assert.equal(reenabled.result?.structuredContent?.config?.enabled, true);
});
