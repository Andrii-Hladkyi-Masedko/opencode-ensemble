# Enforced task tracking, dependency-depth policy, and completed-task filtering

## Intent and user decisions

The user wants Ensemble itself to require recorded tasks and dependency declarations,
not rely on per-project instructions. Missing tracking must block spawning. They also
requested a Hide completed tasks toggle and configurable dependency-depth handling.

User-specified configuration keys and values:

```json
{
  "depth_limit": 4,
  "depth_limit_overflow_action": "user_resolve"
}
```

`depth_limit` defaults to 4. The action accepts `user_resolve` or `lead_resolve`.
**Builder call, approved with the design:** default action is `user_resolve`.

## Built-in tracking contract

- Enforce the contract in shared server tool implementations, not prompts alone.
- Every task creation must explicitly supply `depends_on`, including `[]` for
  independent work. Do not infer dependencies or force artificial links.
- Store explicit independent declarations as JSON `[]`, distinguishing them from
  legacy NULL dependencies. A legacy NULL record needs lead review before spawning.
- Require `claim_task` for every spawn, including explore/plan/read-only agents.
- The target must belong to the current team, have a valid explicit declaration,
  be pending and unassigned, and have all prerequisites completed or cancelled.
- Failure is an actionable error, never a warning followed by an untracked spawn.
- Reserve the task atomically before creating a session/worktree. Concurrent spawns
  must not double-claim. Release reservations on synchronous or asynchronous failure;
  preserve all existing branch-preservation and fire-and-forget prompt invariants.
- Read-only agents remain unable to edit code but can own and complete team tasks.
- Inject concise lead guidance describing task creation, dependency recording,
  claims, verification, completion, and overflow resolution. Update tool descriptions
  and the companion skill examples to teach the same workflow.
- Existing running agents are not interrupted or retrospectively reassigned.
- Builder call after design review: `team_claim` enforces the same declaration,
  ancestry, readiness, and depth checks as spawning, closing the follow-up-work
  bypass. If approval is needed, the worker must ask the lead to resolve it through
  a task review/update; `team_claim` itself does not accept human-approval tokens.
- Completion requires a claimed in-progress task under existing owner/lead rules.
  Legacy tasks already in progress may finish without declaration/depth reapproval,
  so ongoing work is not disrupted. Existing errors for already completed/cancelled
  tasks are retained (the implementation rejects these rather than being idempotent).
- Builder call after design review: declaration review covers the target and its
  prerequisite ancestry, not unrelated legacy NULL records elsewhere on the board.
  New tasks referencing an undeclared legacy prerequisite require its lead review
  first. The numeric depth guard still measures the team's full recorded topology.

## Maintain dependencies using the existing task tool

- Keep all 14 existing tools; do not add a fifteenth tool.
- Extend `team_tasks_add` entries with optional `task_id`. Without it, create a task;
  with it, update an existing task's explicit dependencies. Updates are lead-only.
- For updates, content and priority may be omitted and are preserved; supplied
  values replace those fields. `depends_on` remains required in both forms.
- Reject unknown/cross-team IDs, self-links, and cycles. Normalize duplicate links.
- Validate the entire candidate batch and apply it atomically, with no partial writes.
- Recompute pending/blocked status after dependency edits. Completed/cancelled tasks
  retain terminal status. An in-progress task cannot gain unfinished prerequisites;
  reject that update rather than silently disrupting an active worker.
- Human depth approval cannot override these structural or task-state constraints.
- Do not modify the existing live board automatically or invent its missing links.

## Depth policy

- Settings live in existing global/project `ensemble.json` files, with existing
  global → project precedence. Preserve the requested snake_case JSON keys.
- A valid limit is a positive finite integer. Unsupported action values and invalid
  supplied limits must produce clear configuration errors, not disable enforcement.
- A root task has depth 1. Depth is the longest prerequisite path in the team's DAG,
  including completed/cancelled records. UI filtering never changes policy depth.
- Inspect the proposed graph before task mutations, and the current graph before
  spawning. Depth equal to the limit is accepted; depth greater than it overflows.
- Errors/previews identify the limit, observed depth, and an offending task chain.

### user_resolve

- On overflow, return a preview and human-approval challenge without mutating tasks
  or starting an agent. Built-in lead guidance requires asking the user with the
  existing question tool and the preview's exact approval/denial options.
- Reuse the existing purge-approval pattern: observe actual question tool answers;
  an agent-supplied boolean or echoed token alone is never proof of user approval.
- Retry the existing task/spawn operation with an optional `depth_approval_token`.
  Bind the challenge to the lead session, team, exact proposed operation, current
  topology snapshot, and depth settings. Revalidate before applying it; stale,
  denied, mismatched, or consumed tokens cannot authorize anything.
- Approval accepts that specific deeper topology without changing configuration.
  Further spawns on the same accepted topology do not prompt repeatedly. Topology
  or policy changes require fresh approval when still over the configured limit.
- Status/assignee changes alone do not invalidate topology approval; readiness is
  always checked independently. Denial leaves task records and agents unchanged.
- Builder call: approval state is runtime-scoped like the existing purge registry.
  Restart/reload expires approvals, safely requiring a new approval for later
  operations on an overflowing graph; running agents are not stopped.

### lead_resolve

- Reject overflowing mutations/spawns with the offending chain and instructions
  for the lead to restructure the plan while preserving genuine prerequisites.
- No user question and no approval-token bypass in this mode. The lead must not
  change depth settings or discard real prerequisites merely to evade the guard.
- User-directed configuration changes remain possible; this is tool enforcement,
  not a security boundary against arbitrary filesystem/SQL access.

## Hide completed tasks

- Add a keyboard-accessible Hide completed tasks toggle in the graph toolbar.
- Builder call: default off; persist the user's preference in localStorage, with
  an in-memory fallback if storage is unavailable. Keep it across team changes.
- Hide only `completed` cards and edges incident on them; cancelled tasks remain.
- Lay out remaining cards compactly. Use the full task map for readiness, warnings,
  inspection, and depth policy, so hidden parents are never reported as missing.
- Keep completed prerequisites in task details. Hidden-task detail links must not
  navigate to an invisible card; expose their text/status instead.
- If every task is completed, show an explanatory empty state with a way to show
  them again. Do not alter Overview, progress counts, or stored task records.
- Preserve live refresh, scroll/focus handling, escaping, and agent-drawer access.

## Delivery and boundaries

- Develop from the fork's merged main on a fresh feature branch; keep public SDKs,
  existing style, dual-host adapters, and zero additional runtime dependencies.
- TDD covers schema bypasses, all-agent spawn gating, races/rollback, graph edits,
  cycles, depth boundaries and actions, real-answer approval gating, stale/replayed
  approvals, legacy declarations, and completed-task filtering/live interactions.
- Verify full tests, typecheck, build, and real browser behavior before delivery.
- Deliver a tested branch to the user's fork. Do not merge, publish, update the
  installed checkout, or rewrite live task data without separate user authorization.
