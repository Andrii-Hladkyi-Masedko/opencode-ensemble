import type { Database } from "../db"
import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { inspectTaskGraph, requireDeclaredTask } from "../task-graph"
import { readTaskNodes, authorizeDepth } from "../task-policy"

/**
 * Atomically claim a pending task for an assignee. Sets status to
 * 'in_progress' and records the assignee. Throws if the task is missing,
 * blocked, already claimed, or no longer pending. Returns the task content
 * on success.
 *
 * Shared by team_claim and team_spawn's claim_task auto-claim so both paths
 * enforce the same atomic claim invariant.
 */
export function claimTask(deps: ToolDeps, teamId: string, taskId: string, assignee: string, forSpawn = false): string {
  const db = deps.db
  return db.transaction(() => {
  if (forSpawn && (db.query("SELECT name FROM team_member WHERE team_id=? AND name=?").get(teamId, assignee) || db.query("SELECT id FROM team_task WHERE team_id=? AND assignee=? AND status='in_progress'").get(teamId, assignee))) throw new Error(`Teammate "${assignee}" already exists or has a reserved task`)
  const nodes = readTaskNodes(db, teamId)
  requireDeclaredTask(nodes, taskId)
  const fingerprint = inspectTaskGraph(nodes).fingerprint
  authorizeDepth(deps, "", teamId, nodes, "claim", fingerprint, undefined, false)
  const task = db.query("SELECT content, status, assignee FROM team_task WHERE id = ? AND team_id = ?")
    .get(taskId, teamId) as { content: string; status: string; assignee: string | null } | null
  if (!task) throw new Error(`Task "${taskId}" not found`)
  if (task.status === "blocked") throw new Error(`Task "${taskId}" is blocked by unresolved dependencies`)
  if (task.status !== "pending") throw new Error(`Task "${taskId}" is not pending (status: ${task.status})`)
  if (task.assignee) throw new Error(`Task "${taskId}" is already claimed by ${task.assignee}`)
  const record = nodes.find(node => node.id === taskId)
  if (record?.dependsOn?.some(id => !["completed", "cancelled"].includes(nodes.find(node => node.id === id)?.status ?? ""))) throw new Error(`Task "${taskId}" is blocked by unresolved dependencies`)

  // Atomic claim: UPDATE only if still pending and unassigned
  const result = db.run(
    "UPDATE team_task SET status = 'in_progress', assignee = ?, time_updated = ? WHERE id = ? AND team_id = ? AND status = 'pending' AND assignee IS NULL",
    [assignee, Date.now(), taskId, teamId]
  )

  if (result.changes === 0) {
    throw new Error(`Task "${taskId}" is already claimed (race condition)`)
  }

  return task.content
  })()
}

/** Release only the reservation still owned by a failed spawn, never completed work. */
export function releaseTaskReservation(db: Database, teamId: string, taskId: string, assignee: string): void {
  db.run("UPDATE team_task SET status='pending',assignee=NULL,time_updated=? WHERE id=? AND team_id=? AND assignee=? AND status='in_progress'", [Date.now(), taskId, teamId, assignee])
}

/**
 * Execute the team_claim tool. Atomically claims a pending task.
 * Rejects if the task is already claimed, blocked, or not pending.
 */
export async function executeTeamClaim(
  deps: ToolDeps,
  args: { task_id: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const claimerName = teamInfo.role === "lead" ? "lead" : (teamInfo.memberName ?? "unknown")
  const content = claimTask(deps, teamInfo.teamId, args.task_id, claimerName)

  return `Claimed task: ${content}`
}
