# Enforced Task Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the user's chosen native execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce recorded task ownership/dependencies, guard dependency depth with real user approval or lead resolution, and add completed-task filtering.

**Architecture:** Shared server implementations enforce policy for both hosts. A pure graph module validates topology; a runtime approval registry consumes actual question answers. Existing tools are extended, not multiplied. The graph toggle filters presentation only.

**Tech Stack:** TypeScript, SQLite adapter, existing OpenCode public SDKs, embedded browser JavaScript, Bun tests, SVG.

**Spec:** `docs/superpowers/specs/2026-10-12-enforced-task-tracking-design.md`

## Global Constraints

- Keep all 14 existing tools; do not add a fifteenth tool.
- Require explicit `depends_on`; `[]` means independent work, not an invented dependency.
- Require recorded, atomically claimed tasks for all new spawns, including read-only agents.
- `depth_limit` defaults to 4; `depth_limit_overflow_action` defaults to `user_resolve`, with `lead_resolve` also supported.
- Depth counts roots as 1 and includes completed/cancelled records.
- Never trust an agent-supplied token/boolean as human approval without an actual observed answer.
- No additional runtime dependencies, implicit live-board repair, installed-checkout updates, merges, or publication.
- Preserve branch protection and fire-and-forget prompt dispatch; existing running work may complete.

## Review Focus

- Alternate claim/completion paths must not bypass policy (Task 4).
- Failed or simultaneous spawns must leave no untracked sessions or stranded reservations (Task 4).
- Approval replay, question failure/denial, changed topology/payload/settings, and cross-session use must fail closed (Task 2).
- Legacy NULL declarations must block target ancestry, not unrelated valid independent work (Tasks 1, 3, 4).
- Filtering must not change depth/readiness or invent missing dependencies; hidden links and all-completed states remain usable (Task 5).

---

### Task 1: Configuration and graph validation

**Files:** Create `src/task-graph.ts`, `test/task-graph.test.ts`; modify `src/config.ts`, `test/config.test.ts`.

**Interfaces:**
- `TaskNode`: `{ id, content, priority, status, assignee, dependsOn: string[] | null }` (all scalar fields strings except nullable assignee).
- `inspectTaskGraph(tasks: readonly TaskNode[]): GraphReport` → `{ depth: number, chain: string[], fingerprint: string }`; empty depth 0.
- `requireDeclaredTask(tasks: readonly TaskNode[], taskId: string): TaskNode` validates the target and all prerequisite ancestors, including declaration/ID validity.
- JSON configuration uses the exact snake_case keys above; internal naming follows surrounding TypeScript conventions where practical.

- [ ] **Step 1:** Write compilable stubs and failing tests for root/chain/diamond depths, missing/cross-team references, cycles, duplicate edges, stable fingerprints, legacy NULL ancestry, unrelated legacy roots, and a 1,000-node iterative traversal.
  Pin representative assertions: `expect(report.depth).toBe(4)`, `expect(report.chain).toEqual(["a","b","c","d"])`, and `expect(() => requireDeclaredTask(nodes,"legacy")).toThrow("depends_on")`.
- [ ] **Step 2:** Run `bun test test/task-graph.test.ts test/config.test.ts`; confirm assertion failures, not import errors.
- [ ] **Step 3:** Implement iterative topological validation and ancestry traversal with Maps/Sets; fingerprint canonical IDs, declarations, and edges using built-in cryptographic hashing, excluding content/status/assignee/priority.
- [ ] **Step 4:** Add strict parsing for supplied depth settings. Test defaults, global/project precedence, positive integers, and clear errors for 0, negatives, fractions, null, non-numbers, infinity, and unknown action values. Preserve unrelated config behavior.
- [ ] **Step 5:** Run targeted tests and `bun run typecheck`; require green, then commit this unit.

### Task 2: Genuine human depth approvals

**Files:** Create `src/task-depth-approvals.ts`, `test/task-depth-approvals.test.ts`; modify `src/types.ts`, `src/index.ts`, `src/v2-setup.ts`, `test/helpers.ts`, and host hook tests.

**Interfaces:**
- `DepthScope`: `{ sessionId, teamId, operationKey, baseFingerprint, proposedFingerprint, depthLimit, action }`.
- `PendingTaskDepthApprovals` owns pending challenges and accepted topology fingerprints.
- Methods: `create(scope: DepthScope, preview: string): DepthChallenge`, `recordQuestionAnswer(sessionId: string, output: string, args: unknown): void`, `consume(scope: DepthScope, token: string): void`, `accept(teamId: string, fingerprint: string, depthLimit: number): void`, `isAccepted(teamId: string, fingerprint: string, depthLimit: number): boolean`.
- `DepthChallenge`: `{ token, question, approvalLabel, denialLabel }`; injectable clock/token factory; 10-minute pending TTL. A new registry starts with no accepted topology.
- Add a required `depthApprovals` registry to `ToolDeps` and wire both host setups/helpers. Feed only successful actual question results into it alongside existing purge approvals; preserve purge behavior.

- [ ] **Step 1:** Write failing tests: a raw token is unapproved; a successful question with the exact approval/denial choices authorizes once; denial, failed question, wrong session/team/payload/topology/settings, timeout, reuse, and prefix-like forged answers are rejected.
  Pin: `expect(() => registry.consume(scope,token)).toThrow("approved")` before the real-answer hook; after the approved answer, consumption succeeds exactly once.
- [ ] **Step 2:** Run `bun test test/task-depth-approvals.test.ts test/state.test.ts`; confirm RED on missing registry behavior.
- [ ] **Step 3:** Implement the registry using the existing purge-approval pattern, with clear approve/deny labels and complete offending-chain context. Keep depth challenges separate from purge challenges; never approve on an errored question event.
- [ ] **Step 4:** Test accepted-topology reuse, status/content changes versus topology/policy changes, restart expiration, and both host question-hook integrations. Run relevant host/registry tests and typecheck; require green, then commit.

### Task 3: Atomic task creation, dependency edits, and depth policy

**Files:** Create `src/task-policy.ts`, `test/task-policy.test.ts`; modify `src/tools/team-tasks-add.ts`, `src/v2-tools.ts`, `src/index.ts`; extend `test/tools/team-tasks-add.test.ts`, `test/v2-tools.test.ts` and adapter tests.

**Interfaces:**
- `readTaskNodes(db: Database, teamId: string): TaskNode[]` reads team-scoped task rows.
- `DepthDecision = { allowed: true; approveTopology: boolean } | { allowed: false; preview: string }`.
- `authorizeDepth(deps: ToolDeps, sessionId: string, teamId: string, tasks: readonly TaskNode[], operationKey: string, baseFingerprint: string, token?: string, allowChallenge?: boolean): DepthDecision` implements the two actions; `allowChallenge=false` is the claim path, which rejects with lead-resolution instructions instead of issuing a token.
- `team_tasks_add({ tasks: [{ task_id?, content?, priority?, depends_on }], depth_approval_token? })`; creation requires content; dependency updates require lead authorization and preserve omitted content/priority.
- Creation previews use deterministic non-persisted draft IDs and an operation key based on normalized input excluding the approval token. Dependencies may reference only real existing task IDs. Allocate final IDs after approval, commit, then remember the real accepted topology; token retries must not generate different preview fingerprints.

- [ ] **Step 1:** Write failing tests for missing dependency declarations, persisted `[]`, invalid/cross-team IDs, normalized duplicates, lead-only edits, preserved content/priority, pending↔blocked updates, terminal-state preservation, active-task rejection, and atomic failure of mixed batches.
  Pin: `expect(row.depends_on).toBe("[]")`; missing declaration produces zero task inserts; a failed second batch entry leaves the first unchanged.
- [ ] **Step 2:** Run `bun test test/tools/team-tasks-add.test.ts test/task-policy.test.ts`; confirm RED for new policy, not fixture/import mistakes.
- [ ] **Step 3:** Implement full candidate validation before writes, including reviewed ancestry; use a SQLite transaction and fresh reads at commit time. Return a preview without writes for user resolution; throw an offending-chain error for lead resolution.
- [ ] **Step 4:** Add boundary tests for depth 4 accepted/5 overflowing, both modes, no-token/no-human-answer rejection, successful approved retries, exact mutation binding, topology change while awaiting an answer, and accepted real-ID topology after task creation. Test that completed/cancelled ancestors still contribute depth but satisfy readiness.
- [ ] **Step 5:** Update both tool schemas/descriptions and runtime adapters. Require `depends_on` without schema defaults; conditional creation/update defaults live in shared validation, so omitted update priority is never normalized to medium. Add token input to tasks/spawn only; retain exactly 14 tools.
- [ ] **Step 6:** Run task/policy/adapter tests and typecheck. Update pre-existing creation fixtures to explicitly declare dependencies, preserving separate negative tests for missing declarations. Require green, then commit.

### Task 4: All-agent spawn and claim/completion enforcement

**Files:** Modify `src/tools/team-spawn.ts`, `src/tools/team-claim.ts`, `src/tools/team-tasks-complete.ts`, `src/system-prompt.ts`, `src/index.ts`, `src/v2-tools.ts`; extend their tests plus affected integration/spawn lifecycle fixtures.

**Interfaces:**
- Consumes Task 1 graph/declaration helpers, Task 2 registry, and Task 3 team-scoped policy.
- Spawn input requires `claim_task` in both schemas; shared runtime still checks omitted/empty/malformed values and optional `depth_approval_token`.
- Shared claim validation atomically claims a declared, ready, pending unassigned task. Avoid a policy bypass through the existing exported `claimTask` path; caller context/deps must carry depth policy.
- `releaseTaskReservation(db: Database, teamId: string, taskId: string, assignee: string): void` conditionally releases only the matching in-progress reservation; never revert completion or another owner's claim.
- Completion retains existing completed/cancelled/blocked/ownership errors and requires a claimed in-progress task, while permitting already-running legacy work to finish.

- [ ] **Step 1:** Write failing tests for spawn without/with invalid task, NULL target/ancestor declarations, blocked or already-owned tasks, cross-team IDs, all read-only agent types, missing schemas, and all ordinary worker/lead claim bypasses. Assert rejected spawns make zero worktree/session/prompt calls and register zero members.
- [ ] **Step 2:** Run affected spawn/claim/completion tests; confirm RED on enforcement behavior. Add explicit valid task fixtures to old lifecycle tests so they still exercise their original concern rather than fail at the new gate.
- [ ] **Step 3:** Reserve valid tasks before external operations and before any await. Enforce depth using the current topology; accept an approved spawn retry only after real human approval. All agents, including explore/plan, own their task. Duplicate task/name races must produce one valid tracked winner.
- [ ] **Step 4:** Cover session/workspace failure, no returned session ID, DB/member setup failure, and asynchronous prompt rejection. Wrap cleanup so reservations are released on every failure; preserve worktree branches before aborting sessions. Keep prompt dispatch fire-and-forget and retain existing timeout/circuit-breaker behavior.
- [ ] **Step 5:** Test ordinary claims without accepted overflowing topology, unclaimed completion rejection, same-task concurrent claims/spawns, completed-after-dispatch-failure protection, and claimed legacy completion. Test that unrelated NULL records do not block a valid root task.
- [ ] **Step 6:** Update built-in lead/teammate guidance and companion skill examples: explicit declarations, returned real IDs, task ownership/completion, default depth 4, both actions, real-question approval flow, and no filesystem/config bypasses. Keep teammate context concise and preserve tool permissions/communication rules.
- [ ] **Step 7:** Run full `bun test`, `bun run typecheck`, `bun run build`; read all failures and repair expectations only where contracts intentionally changed. Require green, then commit.

### Task 5: Hide completed tasks and user-facing documentation

**Files:** Modify `src/dashboard-html.ts`, `src/dashboard-js-graph.ts`, `src/dashboard-js-events.ts`, `test/dashboard-graph.test.ts`, `test/dashboard-ui-contract.test.ts`, `README.md`; add browser smoke coverage in this plan's scratch workspace.

**Interfaces:**
- `setGraphHideCompleted(hide: boolean): void`; default false; localStorage key `ensemble-graph-hide-completed`, safe in-memory fallback.
- `graphMarkup(team, layout, selectedId, hideCompleted=false)` preserves existing callers; renderer derives a compact visible layout but uses original tasks for metadata, readiness, warnings, and details.
- Static toolbar checkbox `graph-hide-completed` with an associated Hide completed tasks label; empty state exposes a show-completed action. Completed detail links become noninteractive text/status while hidden.

- [ ] **Step 1:** Write failing tests for filtering only completed cards/incident edges, retained cancelled tasks, compact layout, unchanged full prerequisite readiness/depth, no false missing-parent warnings, hidden detail links, all-completed state, preference persistence/storage failure, and live completion while selected/focused.
  Pin: hiding completed parent A leaves child B visible with `Prerequisites satisfied`, no A card/incident arrow, and A still listed as completed in B's detail.
- [ ] **Step 2:** Run `bun test test/dashboard-graph.test.ts test/dashboard-ui-contract.test.ts`; confirm RED for missing filtering behavior.
- [ ] **Step 3:** Implement the checkbox/state/persistence/filter and event delegation. Preserve generated-markup caching, tab state, scroll/focus, keyboard operation, and existing overview counts. Filter presentation, never the underlying server state.
- [ ] **Step 4:** Run targeted tests and a real browser smoke test for checkbox/keyboard operation, reload persistence, all-completed recovery, live updates, and mobile layout; use fixture data and a separate port, never the user's live team.
- [ ] **Step 5:** Document strict task contracts, existing-task dependency edits, legacy review, overflow actions/defaults/approval expiration, and completed filtering. Update misleading fork installation guidance to main/local source entry where needed; do not alter installed configuration.
- [ ] **Step 6:** Run `bun run typecheck`, full `bun test`, `bun run build`, new-source lint, and `git diff --check`; require green. Obtain one fresh read-only whole-branch review, fix Important/Critical findings with RED→GREEN regressions, and verify again.
- [ ] **Step 7:** Commit and push the feature branch to the user's fork. Preserve the worktree for review; no merge, upstream PR, npm publication, live-board repair, or installed checkout update without authorization.

## Execution setup and self-review

- [ ] Reuse the existing native isolated worktree if safe; fetch merged main and create `feature/enforced-task-tracking` from `origin/main`, preserving the draft spec/plan.
- [ ] Use the existing scratch Bun executable, install frozen dependencies, and establish a clean main baseline.
- [ ] Initialize this plan's git-ignored ledger with per-task status and pre-flight interfaces; record every implementation ruling.

Spec coverage, signatures, input boundaries, five review-focus risks, host parity, and task ordering checked.
Configuration, graph validation, approvals, mutations, ownership gates, and filtering all have explicit test owners.
