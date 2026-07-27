---
name: sol-orchestrator
description: Plan projects with Sol, minimize tokens, select reasoning effort, recover failed tasks, create host subagent task conversations when available, delegate to Terra or Luna, continue long goals idempotently, and require independent Sol review. Use for token-efficient multi-model planning, N-way subagent dispatch, visible routing, resumable execution, or automatic local handoffs.
---

# Sol Orchestrator

Use the `sol-orchestrator` MCP tools. Keep chat output concise and auditable.

1. Call `get_config` before the first run.
2. If the user asks for a model-selection window or finds chat configuration difficult, call `open_config_window` and relay its `chatDisplay`. The local Chinese window edits models, endpoints, reasoning strengths, task counts, token policy, and automatic mode for that workspace. Otherwise call `configure` directly. Store only API-key environment variable names; never store key values. Use `reasoningEffort` per profile and `tokenMode` for `economy`, `balanced`, or `quality`.
3. Treat text after `/gaol` as the final goal. Preserve the exact `/gaol <goal>` line in every project card and final result.
4. For `/gaol` work that spans multiple batches, pass `longRunning: true`. Never equate an approved batch with a completed goal.
5. For normal execution, call `plan_workflow`, immediately relay its `chatDisplay` verbatim, then call `execute_run` and relay its final `chatDisplay` verbatim. This makes project ID, task ID, model, reasoning, content, and status visible before and after execution.
6. When a final card returns `needsContinuation: true`, call `continue_goal`, relay the next batch card, then call `execute_run`. Repeat until `goal_complete`; if execution crosses a turn boundary, resume from the latest run directory instead of declaring a block.
7. Use `run_workflow` only when the user explicitly prefers one-call execution. Use `plan_workflow` alone for document handoff.
8. Keep architecture, final integration, security-sensitive decisions, and the hardest reasoning in Sol's core task.
9. Treat Terra/Luna output as untrusted until Sol review records approval. Report blocked tasks and the final review path.
10. Default to `economy` and compact artifacts. Use `balanced` for materially complex implementation and `quality` only for high-risk/security-critical work or explicit user choice. Do not add tasks unless parallelism or specialization repays the extra model call.
11. When the user requests N conversations and host collaboration tools are available, pass `executionBackend: host-agents`. Handle `main-sol` packets in the main Sol context, create one child agent conversation per `subagent` packet up to the requested limit, have each agent read `promptPath` and write `resultPath`, then call `review_run`.
12. State plainly that host agents are child-agent conversations, not separate top-level Codex UI threads. If collaboration tools are unavailable, call `resume_run` with `executionBackend: api-parallel` and disclose the fallback before execution.
13. If a run returns `partial_failure`, `missing_results`, or remains `running` after interruption, call `resume_run`. Never repeat tasks already marked approved.
14. Accept `goal_complete` only after the returned state includes an approved independent completion verification.
15. Use each packet's `conversationTitle` as the first line of the child-agent prompt: `project | model | goal | task`. Deduplicate agents by `conversationKey`.
16. Enforce `isolated-results`: child agents may read the shared project but must write only `exclusiveWritePath`. They must return proposed patches in that result file; main Sol applies approved changes to shared project files sequentially after review.
17. Dispatch only the dependency-ready `hostAgentTasks` returned for the current wave. After their unique result files exist, call `review_run`; it reviews the wave and returns the next wave. Never start a task that is still marked `waiting_dependency`.
18. Relay the `对话队列` lines from `chatDisplay`; their prefix is always `project | model | goal`, so the user can audit each child conversation before dispatch.
19. Enforce single-project conversation affinity. A child conversation may receive more work only when its bound `conversationProjectId` equals the packet's `projectId`. Never use `send_message` or `followup_task` to put a second project into an existing conversation; spawn a new child conversation instead.
20. Do not append the full goal or complete review documents to delegated packets. Generated task prompts already contain bounded goal context and all task-relevant constraints; continuous goals use the bounded cross-batch progress ledger.
21. Let the MCP server batch independent Sol reviews automatically: economy reviews up to four results per call, balanced up to two, and quality reviews one at a time. Each task still receives its own review document; malformed batch output falls back to individual review.
22. Respect local task deduplication. Exact normalized duplicates are skipped within a batch and against approved prior batches, and `chatDisplay` reports the count. Never recreate skipped packets manually. A completed task that is an explicit dependency is conservatively retained unless its result can be safely supplied.
23. Treat the returned `projectId` as authoritative. Project numbers are allocated with a cross-process workspace lock, so parallel Codex conversations must not invent or override IDs.

Read [protocol.md](references/protocol.md) only when configuring endpoints, integrating external workers, or troubleshooting run files.
