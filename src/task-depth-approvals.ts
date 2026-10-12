import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { Database } from "./db"
import { loadConfig } from "./config"

/** Scope binding a human answer to one exact graph operation and policy. */
export interface DepthScope { sessionId: string; teamId: string; operationKey: string; baseFingerprint: string; proposedFingerprint: string; depthLimit: number; action: "user_resolve" | "lead_resolve" }
/** Human-facing challenge returned before an overflowing operation is applied. */
export interface DepthChallenge { token: string; question: string; approvalLabel: string; denialLabel: string }
/** Canonical project policy, shared by all tool instances serving a team's database. */
export interface DepthPolicy { depth_limit: number; depth_limit_overflow_action: "user_resolve" | "lead_resolve" }
interface Pending { scopeKey: string; sessionId: string; challenge: DepthChallenge; approved: boolean; created: number }

function scopeKey(scope: DepthScope): string {
  return JSON.stringify([scope.sessionId, scope.teamId, scope.operationKey, scope.baseFingerprint, scope.proposedFingerprint, scope.depthLimit, scope.action])
}

function selected(output: string, label: string): boolean {
  const escaped = JSON.stringify(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`=(?:${escaped}|\\[${escaped}\\])(?=\\.|,|\\s|$)`).test(output)
}

function hasChallenge(args: unknown, challenge: DepthChallenge): boolean {
  if (!args || typeof args !== "object" || !("questions" in args) || !Array.isArray(args.questions)) return false
  return args.questions.some((question: unknown) => {
    if (!question || typeof question !== "object") return false
    const q = question as { question?: unknown; options?: unknown }
    if (q.question !== challenge.question || !Array.isArray(q.options)) return false
    const labels = q.options.map((option: unknown) => option && typeof option === "object" && "label" in option ? option.label : undefined)
    return labels.includes(challenge.approvalLabel) && labels.includes(challenge.denialLabel)
  })
}
/** Runtime-scoped human approvals for dependency-depth exceptions. */
export class PendingTaskDepthApprovals {
  private pending = new Map<string, Pending>()
  private accepted = new Map<string, { fingerprint: string; limit: number }>()
  private policySources = new Map<string, () => DepthPolicy>()
  private seenPolicies = new Map<string, string>()
  constructor(private readonly ttlMs = 600_000, private readonly now: () => number = Date.now, private readonly createToken: () => string = randomUUID) {}
  /** Stage an operation for a real human answer. */
  create(scope: DepthScope, preview: string): DepthChallenge {
    if (scope.action !== "user_resolve") throw new Error("Depth approval is unavailable in lead_resolve mode")
    this.prune()
    const token = this.createToken()
    const suffix = token.slice(0, 8)
    const challenge = { token, question: `${preview}\nApprove this specific deeper task graph?`, approvalLabel: `Approve depth ${suffix}`, denialLabel: `Deny depth ${suffix}` }
    this.pending.set(token, { scopeKey: scopeKey(scope), sessionId: scope.sessionId, challenge, approved: false, created: this.now() })
    return challenge
  }
  /** Observe an actual native question answer. */
  recordQuestionAnswer(sessionId: string, output: string, args: unknown): void {
    this.prune()
    this.pending.forEach(pending => {
      if (pending.sessionId !== sessionId || !hasChallenge(args, pending.challenge)) return
      if (selected(output, pending.challenge.denialLabel)) pending.approved = false
      else if (selected(output, pending.challenge.approvalLabel)) pending.approved = true
    })
  }
  /** Consume an authorized challenge exactly once. */
  consume(scope: DepthScope, token: string): void {
    this.prune()
    const pending = this.pending.get(token)
    if (!pending || pending.scopeKey !== scopeKey(scope) || scope.action !== "user_resolve") throw new Error("Depth approval token is invalid, stale, or expired")
    if (!pending.approved) throw new Error("Depth overflow was not approved by the user; ask the exact preview question before retrying")
    this.pending.delete(token)
  }
  /** Remember one accepted topology under a depth limit. */
  accept(teamId: string, fingerprint: string, depthLimit: number): void { this.accepted.set(teamId, { fingerprint, limit: depthLimit }) }
  /** Check whether a topology is currently accepted. */
  isAccepted(teamId: string, fingerprint: string, depthLimit: number): boolean {
    const approved = this.accepted.get(teamId)
    if (approved && approved.limit !== depthLimit) { this.accepted.delete(teamId); return false }
    return approved?.fingerprint === fingerprint
  }
  /** Expire an exception after a successful topology change. */
  invalidate(teamId: string): void { this.accepted.delete(teamId) }
  /** Register the canonical location's live policy loader, never a worker's local override. */
  setPolicySource(directory: string, source: () => DepthPolicy): void { this.policySources.set(directory, source) }
  /** Resolve policy from the original team's location rather than the current worktree. */
  policyForProject(directory: string): DepthPolicy | undefined { return this.policySources.get(directory)?.() }
  /** Expire approval when a team observes an actual policy change. */
  observePolicy(teamId: string, policy: DepthPolicy): void {
    const key = JSON.stringify([policy.depth_limit, policy.depth_limit_overflow_action]), prior = this.seenPolicies.get(teamId)
    if (prior !== undefined && prior !== key) this.invalidate(teamId)
    this.seenPolicies.set(teamId, key)
  }
  /** A canonical-location reload clears its challenges and exceptions across workers. */
  clearTeam(teamId: string): void {
    this.invalidate(teamId); this.seenPolicies.delete(teamId)
    this.pending.forEach((pending, token) => { if (JSON.parse(pending.scopeKey)[1] === teamId) this.pending.delete(token) })
  }
  private prune(): void { this.pending.forEach((pending, token) => { if (this.now() - pending.created > this.ttlMs) this.pending.delete(token) }) }
}

const byDatabase = new WeakMap<Database, PendingTaskDepthApprovals>()
const byPath = new Map<string, PendingTaskDepthApprovals>()
/** Share runtime authority across connections to one SQLite file; isolated memory DBs stay isolated. */
export function getTaskDepthApprovals(db: Database, databasePath?: string): PendingTaskDepthApprovals {
  const key = databasePath && databasePath !== ":memory:" ? resolve(databasePath) : undefined
  const existing = byDatabase.get(db) ?? (key ? byPath.get(key) : undefined)
  const registry = existing ?? new PendingTaskDepthApprovals()
  byDatabase.set(db, registry); if (key) byPath.set(key, registry)
  return registry
}

/** Bind policy to its canonical location and expire that location's exceptions on reload. */
export function configureDepthLocation(db: Database, registry: PendingTaskDepthApprovals, directory: string): void {
  registry.setPolicySource(directory, () => loadConfig(directory))
  const teams = db.query("SELECT id FROM team WHERE project_id=?").all(directory) as Array<{ id: string }>
  teams.forEach(team => { registry.clearTeam(team.id) })
}
/** Feed only successful native question answers into the depth registry. */
export function observeDepthQuestionAnswer(registry: PendingTaskDepthApprovals, sessionId: string, output: string, args: unknown, successful: boolean): void {
  if (successful) registry.recordQuestionAnswer(sessionId, output, args)
}
