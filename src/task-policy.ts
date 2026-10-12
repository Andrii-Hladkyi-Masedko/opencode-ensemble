import type { Database } from "./db"
import type { ToolDeps } from "./types"
import { inspectTaskGraph, type TaskNode } from "./task-graph"
/** Read canonical, team-scoped task topology. */
export function readTaskNodes(db: Database, teamId: string): TaskNode[] {
  const rows = db.query("SELECT id,content,priority,status,assignee,depends_on FROM team_task WHERE team_id=? ORDER BY time_created,id").all(teamId) as Array<{ id: string; content: string; priority: string; status: string; assignee: string | null; depends_on: string | null }>
  return rows.map(({ depends_on, ...row }) => {
    let parsed: unknown = null
    try { parsed = depends_on === null ? null : JSON.parse(depends_on) } catch { throw new Error(`Task "${row.id}" has malformed depends_on; the lead must repair its declaration`) }
    if (parsed !== null && (!Array.isArray(parsed) || parsed.some(id => typeof id !== "string" || !id.trim()))) throw new Error(`Task "${row.id}" has malformed depends_on`)
    return { ...row, dependsOn: parsed as string[] | null }
  })
}
/** Result of a depth-policy check; previews perform no mutation. */
export type DepthDecision = { allowed: true; approveTopology: boolean } | { allowed: false; preview: string }
/** Authorize one operation against the current or proposed topology. */
export function authorizeDepth(deps: ToolDeps, sessionId: string, teamId: string, tasks: readonly TaskNode[], operationKey: string, baseFingerprint: string, token?: string, allowChallenge = true): DepthDecision {
  const report = inspectTaskGraph(tasks), limit = deps.config.depth_limit, action = deps.config.depth_limit_overflow_action
  const summary = `Depth overflow: depth ${report.depth} exceeds depth_limit ${limit}. Chain: ${report.chain.map(id => `${tasks.find(t => t.id === id)?.content ?? id} (${id})`).join(" → ")}`
  if (action === "lead_resolve" && token) throw new Error("depth_approval_token cannot bypass lead_resolve; restructure genuine dependencies")
  if (token) {
    deps.depthApprovals.consume({ sessionId, teamId, operationKey, baseFingerprint, proposedFingerprint: report.fingerprint, depthLimit: limit, action }, token)
    return { allowed: true, approveTopology: true }
  }
  if (report.depth <= limit) return { allowed: true, approveTopology: false }
  if (action === "lead_resolve") throw new Error(`${summary}. lead_resolve: revise the plan without discarding real prerequisites or changing policy to bypass the guard.`)
  if (deps.depthApprovals.isAccepted(teamId, report.fingerprint, limit)) return { allowed: true, approveTopology: false }
  if (!allowChallenge) throw new Error(`${summary}. Ask the lead to review the graph with team_tasks_add and resolve depth overflow before claiming.`)
  const lead = deps.db.query("SELECT lead_session_id FROM team WHERE id=?").get(teamId) as { lead_session_id: string } | null
  if (lead?.lead_session_id !== sessionId) throw new Error(`${summary}. Ask the lead to obtain user approval.`)
  const challenge = deps.depthApprovals.create({ sessionId, teamId, operationKey, baseFingerprint, proposedFingerprint: report.fingerprint, depthLimit: limit, action }, summary)
  return { allowed: false, preview: `Depth overflow — no changes applied. Ask the user with the exact question/options below, then retry the same tool input with depth_approval_token.\n${JSON.stringify(challenge)}` }
}
