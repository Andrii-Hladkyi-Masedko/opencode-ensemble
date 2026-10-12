import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { generateId } from "../util"
import { inspectTaskGraph, requireDeclaredTask, fingerprintTaskGraph, type TaskNode } from "../task-graph"
import { authorizeDepth, readTaskNodes, teamDepthPolicy } from "../task-policy"

/** A creation or lead-only dependency review of an existing task. */
export interface TaskInput { task_id?: string; content?: string; priority?: string; depends_on?: string[] }

/** Atomically add/review tasks with explicit dependencies and depth policy. */
export async function executeTeamTasksAdd(deps: ToolDeps, args: { tasks: TaskInput[]; depth_approval_token?: string }, sessionId: string): Promise<string> {
  const team = requireTeamMember(deps, sessionId)
  if (!Array.isArray(args.tasks) || !args.tasks.length) throw new Error("Supply at least one task to create or review")
  const normalized = args.tasks.map(input => {
    if (!input || !Array.isArray(input.depends_on) || input.depends_on.some(id => typeof id !== "string" || !id.trim())) throw new Error("Every task requires explicit depends_on; use [] for independent work")
    if (input.task_id !== undefined && (typeof input.task_id !== "string" || !input.task_id.trim())) throw new Error("task_id must be a nonempty existing task ID")
    if (input.task_id && team.role !== "lead") throw new Error("Only the lead may update existing tasks")
    if (input.content !== undefined && (typeof input.content !== "string" || !input.content.trim())) throw new Error("Task content must be a nonempty string")
    if (!input.task_id && input.content === undefined) throw new Error("New tasks require content")
    if (input.priority !== undefined && !["high", "medium", "low"].includes(input.priority)) throw new Error(`Invalid priority "${input.priority}"; expected high, medium, or low`)
    return { ...input, depends_on: [...new Set(input.depends_on)].sort() }
  })
  const result = deps.db.transaction(() => {
    const original = readTaskNodes(deps.db, team.teamId), base = { fingerprint: fingerprintTaskGraph(original) }
    const originalMap = new Map(original.map(task => [task.id, task])), candidate = new Map(original.map(task => [task.id, { ...task }]))
    const changed = new Set<string>()
    const drafts = normalized.map((input, index) => {
      const id = input.task_id ?? `@ensemble-draft-${index}`
      if (!input.task_id && originalMap.has(id)) throw new Error("Reserved draft ID collision; review existing task IDs")
      const existing = input.task_id ? originalMap.get(input.task_id) : undefined
      if (input.task_id && !existing) throw new Error(`Task "${input.task_id}" not found in this team`)
      if (changed.has(id)) throw new Error(`Duplicate task update "${id}" in batch`)
      input.depends_on.forEach(parent => { if (!originalMap.has(parent)) throw new Error(`Missing prerequisite "${parent}"; use real task IDs from this team`) })
      const task: TaskNode = { id, content: input.content ?? existing?.content ?? "", priority: input.priority ?? existing?.priority ?? "medium", status: existing?.status ?? "pending", assignee: existing?.assignee ?? null, dependsOn: input.depends_on }
      candidate.set(id, task); changed.add(id)
      return task
    })
    const proposed = [...candidate.values()]
    inspectTaskGraph(proposed)
    drafts.forEach(task => { requireDeclaredTask(proposed, task.id) })
    proposed.forEach(task => {
      const waiting = (task.dependsOn ?? []).some(id => !["completed", "cancelled"].includes(candidate.get(id)?.status ?? ""))
      if (task.status === "in_progress" && waiting && changed.has(task.id)) throw new Error(`Task "${task.id}" is in_progress; cannot add unfinished prerequisites`)
      if (task.status === "pending" || task.status === "blocked") task.status = waiting ? "blocked" : "pending"
    })
    const decision = authorizeDepth(deps, sessionId, team.teamId, proposed, JSON.stringify(["tasks", normalized]), base.fingerprint, args.depth_approval_token)
    if (!decision.allowed) return { text: decision.preview }
    const ids: string[] = [], now = Date.now()
    drafts.forEach((task, index) => {
      if (normalized[index]?.task_id) {
        deps.db.run("UPDATE team_task SET content=?,priority=?,depends_on=?,status=?,time_updated=? WHERE id=? AND team_id=?", [task.content, task.priority, JSON.stringify(task.dependsOn), task.status, now, task.id, team.teamId])
      } else {
        const id = generateId("task"); ids.push(id)
        deps.db.run("INSERT INTO team_task (id,team_id,content,status,priority,depends_on,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?)", [id, team.teamId, task.content, task.status, task.priority, JSON.stringify(task.dependsOn), now, now])
      }
    })
    proposed.filter(task => !changed.has(task.id) && originalMap.get(task.id)?.status !== task.status).forEach(task => {
      deps.db.run("UPDATE team_task SET status=?,time_updated=? WHERE id=? AND team_id=?", [task.status, now, task.id, team.teamId])
    })
    const fingerprint = inspectTaskGraph(readTaskNodes(deps.db, team.teamId)).fingerprint
    const updates = normalized.filter(input => input.task_id).length
    return { text: ids.length ? `Added ${ids.length} task${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}${updates ? `; reviewed ${updates} tasks` : ""}` : `Reviewed ${updates} task${updates === 1 ? "" : "s"}`, fingerprint, oldFingerprint: base.fingerprint, approve: decision.approveTopology }
  })()
  if (result.fingerprint) {
    if (result.fingerprint !== result.oldFingerprint) deps.depthApprovals.invalidate(team.teamId)
    if (result.approve) deps.depthApprovals.accept(team.teamId, result.fingerprint, teamDepthPolicy(deps, team.teamId).depth_limit)
  }
  return result.text
}
