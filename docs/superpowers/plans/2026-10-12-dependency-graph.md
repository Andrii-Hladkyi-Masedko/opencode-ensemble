# Dependency Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved live task dependency graph with agent ownership to Ensemble's dashboard.

**Architecture:** Reuse `/api/state` and existing polling. Add dependency-free browser JS modules for graph layout and rendering, assembled into the existing HTML response. Keep the overview, agent drawer, project navigation, and host integration intact.

**Tech Stack:** TypeScript, embedded browser JavaScript, SVG, existing Tailwind CSS, Bun tests.

**Spec:** `docs/superpowers/specs/2026-10-12-dependency-graph-design.md`

## Global Constraints

- No new runtime dependencies; use HTML/CSS cards and SVG connectors.
- No database or `/api/state` schema changes; no new OpenCode tools.
- Escape all task and member data used in HTML and attributes.
- Use the existing OpenCode V2-compatible plugin entrypoint, unchanged.
- Do not publish to npm or change the user's installed plugin/configuration.
- Branch must use `feature/`; verify with `bun run typecheck`, `bun test`, `bun run build`.

## Review Focus

- Cycles and self-dependencies: terminate, warn, retain every task card (Task 1).
- Missing or duplicate prerequisites: warn for missing IDs, deduplicate arrows (Task 1).
- Hostile content and IDs: escape labels and data attributes; no interpolated inline JS (Task 2).
- Live/team changes: preserve tab and scroll; clear stale task selection (Task 2).
- Unassigned or removed agents and wide graphs: retain usable cards and horizontal scrolling (Task 2).

---

### Task 1: Dependency layout

**Files:**
- Create `src/dashboard-js-graph-layout.ts`
- Create `test/dashboard-graph-layout.test.ts`

**Interfaces:**
- Export `DASHBOARD_JS_GRAPH_LAYOUT: string`, a browser script defining `graphLayout(tasks)`.
- Input: tasks with `id`, `content`, `status`, `assignee`, `dependsOn: string[]`.
- Output: `{ nodes, edges, missing, cyclic, width, height }`.
- Nodes: `{ task, x, y }`; edges: `{ from, to }` task IDs.
- `missing`: `{ taskId, dependencyId }[]`; `cyclic`: unresolved task IDs.
- Card width 280, height 172; horizontal gap 88, vertical gap 32; padding 24.

- [ ] **Step 1:** Create an empty-returning compilable layout script and failing Bun tests evaluating its actual browser script with `new Function`. Pin chain `a→b→c` to increasing x, fork/join edge count 4, no overlapping cards per column, disconnected task inclusion, empty dimensions, and stable input ordering.
- [ ] **Step 2:** Run `bun test test/dashboard-graph-layout.test.ts`; confirm assertion failures, not import/syntax failures.
- [ ] **Step 3:** Implement a deterministic iterative topological layout using Maps. Place unresolved cyclic tasks in a fallback column. Never recurse through task dependencies.
- [ ] **Step 4:** Add and run tests for two-task cycles, self-cycle, missing IDs, duplicate dependencies, a 1,000-task chain, and IDs like `__proto__`. Assert every task appears once and coordinates/dimensions are finite.
- [ ] **Step 5:** Run `bun test test/dashboard-graph-layout.test.ts`; require all passing, then commit layout and tests.

### Task 2: Live graph tab and inspection

**Files:**
- Create `src/dashboard-js-graph.ts`
- Create `test/dashboard-graph.test.ts`
- Modify `src/dashboard-html.ts`, `src/dashboard-js-events.ts`, `src/dashboard.ts`
- Update `test/dashboard-ui-contract.test.ts`, `test/dashboard.test.ts`, `README.md`

**Interfaces:**
- Consumes Task 1's `graphLayout(tasks)` and core `E`, `chip`, `si`, `cur`, `patch`.
- Export `DASHBOARD_JS_GRAPH: string`, defining browser state and functions:
  `selectDashboardTab(view)`, `rGraph(team)`, `selectGraphTask(id)`, `resetGraphView()`.
- `view`: `overview | dependencies`; `rGraph` derives data from the selected team only.
- `graphMarkup(team, layout, selectedId)` returns escaped graph HTML for direct tests.
- Use existing `openDrawer(name)` through safe dataset-based agent buttons.

- [ ] **Step 1:** Add failing tests for Overview/Dependency graph tab semantics, graph panel, card labels and prerequisite arrows, empty state, agent metadata, and script assembly. Use fake DOM nodes where necessary to execute actual browser handlers without adding a package.
- [ ] **Step 2:** Run targeted dashboard tests; confirm meaningful failures.
- [ ] **Step 3:** Implement native tab buttons and associated panels; enforce `[hidden]` for these panels despite grid classes. Add graph CSS with horizontal scrolling, card focus states, and responsive/reduced-motion behavior. Preserve all existing overview markup.
- [ ] **Step 4:** Implement SVG connectors, full task cards, missing/cycle warnings, and an inline task detail region. Show member status separately from task status. Unassigned/missing members never open a nonexistent drawer.
- [ ] **Step 5:** Integrate script constants into `dashboard.ts` before event initialization. Refresh the active graph through `render()`; preserve scroll and focus during updates and reset selected task on team change. Add tab Arrow/Home/End handling; avoid existing global agent shortcuts intercepting graph controls.
- [ ] **Step 6:** Add tests asserting escaping for hostile text/IDs, multiple tasks per agent, deleted assignees, dependency completion, selection disappearance, team switches, scroll preservation, and tab keyboard behavior. Run targeted tests and require all passing.
- [ ] **Step 7:** Document graph features and Git/local installation from the fork in `README.md`; do not change package publishing identity or global config.
- [ ] **Step 8:** Run `bun run typecheck`, `bun test`, `bun run build`, and `git diff --check`; require all passing. Smoke-check served HTML and use a browser if available; otherwise explicitly report visual verification limits.
- [ ] **Step 9:** Review changes against the spec, commit, and push `feature/dependency-graph` to the user's fork. Do not open an upstream PR unless requested.

## Execution setup

- [ ] Create an isolated feature worktree using the using-git-worktrees skill.
- [ ] Obtain a project-local Bun executable if no installed copy is available; keep it outside versioned source.
- [ ] Run `bun install` and establish the baseline before changing product code.

## Plan self-review

Spec coverage, exact interfaces, five review-focus cases, and proportionality checked.
The implementation is intentionally limited to the dashboard; host compatibility and task scheduling remain unchanged.
