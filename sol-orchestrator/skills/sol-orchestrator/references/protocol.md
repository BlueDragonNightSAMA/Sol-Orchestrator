# Local Orchestration Protocol

## Model profiles

Each profile uses an OpenAI-compatible chat-completions endpoint:

```json
{
  "name": "sol-5.6",
  "model": "your-deployed-model-id",
  "baseUrl": "http://127.0.0.1:8000/v1",
  "apiKeyEnv": "SOL_API_KEY",
  "reasoningEffort": "high",
  "reasoningField": "reasoning_effort",
  "maxTokensField": "max_tokens",
  "temperatureEnabled": false
}
```

`apiKeyEnv` is optional. A base URL may end in `/v1` or `/v1/chat/completions`.
Reasoning values are `default`, `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`. `default` omits the request field. Set `reasoningField` to an empty string when the endpoint does not support reasoning controls.
Use `maxTokensField: "max_completion_tokens"` when required by the endpoint, or an empty string to disable output caps.
`temperatureEnabled` defaults to false because many reasoning endpoints reject temperature. Enable it only for compatible models.

## Configuration window

Call `open_config_window` when the user wants visual model selection or orchestration tuning. It starts an ephemeral Chinese configuration page on `127.0.0.1`, binds it to the requested workspace, and returns a clickable URL. Each random session expires after 30 minutes. The page previews the active Sol-worker-review route and phase output budgets. It can add, remove, or rename profiles; choose Sol, reviewer, and worker roles; select reasoning effort; set automatic or fixed task counts; and edit execution, token, archive directory, retry, and endpoint options.

The workspace `enabled` setting defaults to `true`, so implicit skill invocation can classify each new conversation before choosing direct handling or orchestration. Setting it to `false` is a functional kill switch: planning, execution, review, continuation, status, connection tests, agent dispatch, artifact creation, and model calls are blocked. `get_config`, `configure`, and `open_config_window` remain available only so the user can inspect the state or re-enable it. To prevent the skill and MCP server from loading at all, disable the installed plugin in Codex; a running plugin cannot unload itself.

The page stores only API-key environment variable names. It never accepts or persists API-key values. A visual save replaces the complete profile list so deleted profiles do not remain as hidden configuration. Configuration writes are atomic and carry a revision token: a stale window receives HTTP 409 instead of overwriting a newer chat or window update. The page marks unsaved changes, warns before closing, and validates task limits and environment-variable names locally.

Each profile has a zero-generation-token connection test. It calls the OpenAI-compatible `GET /models` endpoint with a nine-second timeout, checks whether the configured model ID exists, and distinguishes authentication failure, missing environment keys, unsupported model-list endpoints, malformed responses, timeouts, and unreachable services. Remote plaintext HTTP is blocked; loopback HTTP and HTTPS are allowed. The test route is protected by the same expiring configuration session and strict same-origin POST checks as configuration writes. At most four tests run concurrently; excess requests receive HTTP 429 instead of forming an unbounded queue.

## Token modes

- `economy` (default): compact context and capped outputs; delegated tasks receive at most 1,200 goal characters while Sol core tasks retain the full economy goal budget. Final status is generated locally from mandatory Sol reviews, avoiding a redundant synthesis call.
- `balanced`: delegated tasks receive at most 4,000 goal characters, with larger task/review budgets plus a Sol final synthesis.
- `quality`: delegated tasks receive at most 12,000 goal characters and the largest budgets for high-risk work.

Every API call appends one small record to `usage.jsonl` instead of reading and serializing the complete usage history after every request. Usage is aggregated into `run-bundle.json` or the final state during archiving. Legacy `usage.json` files remain readable. When the endpoint returns usage metadata it is used directly; otherwise the plugin records a conservative local estimate. Local task and result documents remain complete even when inter-model context is clipped.

Independent reviews share context without sharing decisions. Economy mode reviews up to four task results per Sol call, balanced mode up to two, and quality mode keeps one result per call. The server writes one review document per task in every mode. Missing task IDs or malformed batch JSON triggers an automatic individual-review fallback. This batching applies to both API-parallel waves and host-agent result collection.

## Continuous goals

Pass `longRunning: true` for a long-lived `/gaol`. An approved batch returns `needsContinuation: true`, not goal completion. Call `continue_goal` with the latest run directory. Sol receives only the goal and compact review summaries; it either creates the next batch under the same project ID or returns `goal_complete` with completion evidence. Empty continuation plans are replaced with a Sol-owned progress task so task exhaustion cannot block the project.

`continue_goal` is idempotent. Repeating it for the same batch returns the existing successor; a project lock prevents concurrent calls from creating two B02 branches. A completion claim is sent to `reviewModel` in a separate call and becomes `goal_complete` only when that independent verification approves it.

Within one continuation call, the previous state, plan, reviews, and optional compact bundle are loaded once and reused through planning and the final `continuedBy` checkpoint. This avoids repeatedly parsing and serializing the same archive during long goals.

Each successor stores a bounded cross-batch progress ledger. Continuation calls send compact review decisions, progress digests, and unresolved findings instead of complete review templates. Economy mode caps the ledger at 5,000 characters while preserving the first and most recent progress entries, preventing both long-goal amnesia and unbounded prompt growth.

## Task deduplication

Every normalized task receives a stable 24-character signature derived from its title, description, prompt, criteria, and deliverable. Exact normalized duplicates in the same batch share the retained representative task. Approved signatures are carried across continuation batches, capped at 512 entries; an exact completed duplicate is skipped before creating documents, conversations, worker calls, or reviews. The chat card and project document report the skipped count.

Dependencies pointing to a same-batch duplicate are remapped to the retained representative. If a new task explicitly depends on a previously completed duplicate, that dependency task is conservatively retained rather than dropping required result context. If every proposed continuation task is already complete, the server creates one Sol-owned task that must advance a new unmet milestone, so deduplication cannot block `/gaol` progress.

## Execution backends

- `api-parallel`: execute tasks with parallel OpenAI-compatible API calls inside one Codex conversation.
- `host-agents`: return task packets for host child agents. `main-sol` stays in the lead context; each `subagent` packet may use one child-agent conversation. These are not top-level Codex UI threads.
- `auto`: resolve to `api-parallel` in the MCP server. The skill selects `host-agents` only after detecting host collaboration tools.

Host-agent packets contain `conversationTitle`, stable `conversationKey`, `promptPath`, and a unique `exclusiveWritePath`. Use the title format `P0001 | model | final goal | T02` as the first line of the child-agent prompt and never create two agents for the same key. The same titles are listed under `对话队列` in the chat card. Agents may read shared project files but must write only their own result path. Proposed code changes remain patches in the result document; main Sol applies approved changes sequentially.

Every packet also carries `conversationScope: single-project`, an immutable `conversationProjectId`, and `reusePolicy: same-project-only`. One project may use N child conversations, but one child conversation must never receive packets from more than one project. When the project ID changes, create a new child conversation even if the model or task type is unchanged.

Packets are returned in dependency-ready waves. Independent tasks can create N child conversations, while a task with unresolved dependencies stays `waiting_dependency`. After the current wave writes its unique result files, call `review_run`; approved results are not reviewed again, and the next dependency-ready wave is returned. This prevents dependent conversations from reading or changing files before their inputs are stable. If host agents are unavailable, call `resume_run` with `executionBackend: api-parallel` and disclose the fallback.

## Recovery

Retryable HTTP 408/409/425/429/5xx, timeouts, and transport failures use exponential backoff. A failed task is checkpointed without discarding successful peers. Dependency failures become `blocked`; the run returns `partial_failure`. Call `resume_run` to retry only failed, blocked, interrupted, or missing tasks. Approved tasks and valid approved review files are reused.

## Project storage

User-facing files live inside the original workspace:

```text
sol-orchestrator-projects/
  P0001/
    PROJECT.md
    B01-<run-id>/
      run-bundle.json
      final-review.md
```

`PROJECT.md` contains the final goal, latest batch, task/model summary, and the prompt required to continue. In default `compact` mode, completed batch files are merged into `run-bundle.json`; only the bundle and final review remain. Set `artifactMode: expanded` only when every intermediate handoff file must remain separate.

## Large-file memory safety

Large workspace inputs should be referenced by path rather than embedded in `goal` or `context`. The plugin caps embedded goal and context sizes before creating project documents. Host-agent results remain complete on disk, but Sol review reads bounded head/tail previews, including an explicit omitted-byte marker. Dependency context uses the same bounded preview strategy.

Model responses are streamed with a two-MiB hard limit, `/models` responses with a four-MiB limit, plugin JSON reads with a sixteen-MiB limit, and an incomplete MCP input buffer with a four-MiB limit. Oversized responses fail cleanly instead of being buffered without bound. Token usage is append-only during execution, and API-parallel state is checkpointed per wave rather than once per task transition.

Before compacting, the server sums source artifact sizes. Runs up to eight MiB use the normal two-file compact layout. Larger runs automatically keep their split task/result/review files and record `compaction.mode: split`; this avoids constructing and serializing a giant `run-bundle.json`. The final chat card and `PROJECT.md` show whether the run was bundled or kept split.

Project numbers use an atomic cross-process counter lock. When multiple Codex conversations plan simultaneously, each receives a different `Pxxxx`. A healthy counter uses an `O(1)` candidate check. If `counter.json` is missing, damaged, or collides with an existing candidate, the allocator streams existing `Pxxxx` entries without loading the full directory list. The temporary lock is removed after allocation and stale locks are recoverable.

## Modes

- `auto`: choose the configured worker for each delegated task and use the configured default task count.
- `manual`: use the requested worker and task count. The count must be between 1 and the configured maximum.
- `documents`: generate task documents without calling workers. External workers write matching files under `results/`, then `review_run` performs the Sol review.

For visible execution, call `plan_workflow`, display its `chatDisplay`, then call `execute_run`. The one-call `run_workflow` remains available for automation.

## Chat review card

Every plan, status, and final result returns a compact Markdown card:

```text
/gaol <final goal>
### 项目 P0001 · <project name>
- P0001/T01｜模型：sol-5.6 (5.6sol)｜推理：high｜状态：planned
  > 内容：<task summary>
```

## Run documents

During an active batch, the batch directory temporarily contains:

```text
request.md
plan.json
plan.md
tasks/<task-id>.prompt.md
results/<task-id>.result.md
reviews/<task-id>.review.md
final-review.md
state.json
usage.jsonl
```

Workers receive only their prompt document. Sol receives the original request, plan, worker result, and acceptance criteria during review.

## Security

Use loopback or trusted HTTPS endpoints. Put keys in environment variables. Do not store secrets in plugin configuration or task documents.
