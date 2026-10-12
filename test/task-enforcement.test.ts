import { beforeEach, afterEach, expect, test } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { executeTeamSpawn, spawnFailures } from "../src/tools/team-spawn"
import { executeTeamClaim } from "../src/tools/team-claim"
import { executeTeamTasksComplete } from "../src/tools/team-tasks-complete"
import { buildLeadSystemPrompt } from "../src/system-prompt"
import { createV2Client } from "../src/v2-client"
import { authorizeDepth, readTaskNodes } from "../src/task-policy"
import { inspectTaskGraph } from "../src/task-graph"

let deps: ReturnType<typeof setupDeps>
beforeEach(() => { deps = setupDeps(); insertTeam(deps.db, "team", "alpha", "lead"); spawnFailures.clear() })
afterEach(() => deps.db.close())
function seed(id: string, parents: string[] | null = [], status = "pending", assignee: string | null = null) {
  deps.db.run("INSERT INTO team_task (id,team_id,content,status,priority,assignee,depends_on,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?,?)", [id, "team", id, status, "medium", assignee, parents === null ? null : JSON.stringify(parents), Date.now(), Date.now()])
}
const spawn = (name: string, claim_task?: string, agent = "build") => executeTeamSpawn(deps, { name, claim_task, agent, prompt: "work", worktree: false }, "lead")
const row = (id: string) => deps.db.query("SELECT status,assignee FROM team_task WHERE id=?").get(id)

test.each([undefined, "", "gone"])("spawn requires a real task (%p) before any external calls", async id => {
  await expect(spawn("worker", id)).rejects.toThrow(/claim_task|not found/)
  expect(deps.client.calls).toEqual([])
  expect(deps.db.query("SELECT COUNT(*) AS count FROM team_member").get()).toEqual({ count: 0 })
})
test.each(["explore", "plan", "build"])("%s agents own a claimed task, including read-only workers", async agent => {
  seed("task")
  await spawn("worker", "task", agent)
  expect(row("task")).toEqual({ status: "in_progress", assignee: "worker" })
})
test.each(["legacy", "ancestor", "blocked", "taken", "foreign"])("%s task cannot start a worker", async scenario => {
  seed("parent", scenario === "ancestor" ? null : [], scenario === "ancestor" ? "completed" : "pending")
  seed("task", scenario === "legacy" ? null : scenario === "ancestor" || scenario === "blocked" ? ["parent"] : [], scenario === "taken" ? "in_progress" : "pending", scenario === "taken" ? "someone" : null)
  if (scenario === "foreign") { insertTeam(deps.db, "other", "other", "other-lead"); deps.db.run("UPDATE team_task SET team_id='other' WHERE id='task'") }
  await expect(spawn("worker", "task")).rejects.toThrow()
  expect(deps.client.calls).toEqual([])
})
test("unrelated legacy declarations do not prevent a valid independent task", async () => {
  seed("legacy", null); seed("root")
  await spawn("worker", "root")
  expect(row("root")).toEqual({ status: "in_progress", assignee: "worker" })
})
test("lead context explains mandatory tracking and both depth resolution modes", () => {
  const user = buildLeadSystemPrompt(deps.db, "team", deps.config)
  expect(user).toContain("depends_on")
  expect(user).toContain("claim_task")
  expect(user).toContain("depth_limit=4")
  expect(user).toContain("depth_approval_token")
  deps.config.depth_limit_overflow_action = "lead_resolve"
  expect(buildLeadSystemPrompt(deps.db, "team", deps.config)).toContain("lead_resolve")
})
test("simultaneous spawns cannot double-own the same task", async () => {
  seed("task")
  const results = await Promise.allSettled([spawn("alice", "task"), spawn("bob", "task")])
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1)
  expect(deps.client.calls.filter(c => c.method === "session.create")).toHaveLength(1)
})
test("simultaneous same-name spawns cannot reserve two tasks", async () => {
  seed("a"); seed("b")
  const results = await Promise.allSettled([spawn("alice", "a"), spawn("alice", "b")])
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1)
  expect(row("b")).toEqual({ status: "pending", assignee: null })
})
test.each(["throw", "missing-id", "member-insert"])("%s failure releases its task reservation", async scenario => {
  seed("task")
  if (scenario === "throw") deps.client.session.create = async () => { throw new Error("offline") }
  if (scenario === "missing-id") deps.client.session.create = async () => ({})
  if (scenario === "member-insert") deps.db.exec("CREATE TRIGGER fail_member BEFORE INSERT ON team_member BEGIN SELECT RAISE(ABORT,'insert failed'); END;")
  await expect(spawn("worker", "task")).rejects.toThrow()
  expect(row("task")).toEqual({ status: "pending", assignee: null })
  if (scenario === "member-insert") expect(deps.client.calls.some(c => c.method === "session.abort")).toBe(true)
})
test("failed asynchronous dispatch releases reservation without undoing completed work", async () => {
  seed("task")
  let rejectPrompt: (reason: Error) => void = () => {}
  deps.client.session.promptAsync = () => new Promise((_, reject) => { rejectPrompt = reject })
  await spawn("worker", "task")
  deps.db.run("UPDATE team_task SET status='completed' WHERE id='task'")
  rejectPrompt(new Error("delivery failed")); await new Promise(resolve => setTimeout(resolve, 5))
  expect(row("task")).toEqual({ status: "completed", assignee: "worker" })
})
test("claims cannot bypass declaration or overflowing graph policy", async () => {
  seed("legacy", null)
  await expect(executeTeamClaim(deps, { task_id: "legacy" }, "lead")).rejects.toThrow("review")
  seed("a"); seed("b", ["a"], "completed"); seed("c", ["b"], "completed"); seed("d", ["c"], "completed"); seed("e", ["d"])
  await expect(executeTeamClaim(deps, { task_id: "e" }, "lead")).rejects.toThrow("lead")
})
test("unclaimed completion is rejected but already-running legacy work may finish", async () => {
  seed("pending")
  await expect(executeTeamTasksComplete(deps, { task_id: "pending" }, "lead")).rejects.toThrow("claim")
  seed("legacy", null, "in_progress", "worker")
  insertMember(deps.db, "team", "worker", "member")
  await executeTeamTasksComplete(deps, { task_id: "legacy" }, "member")
  expect(row("legacy")).toEqual({ status: "completed", assignee: "worker" })
})
test("spawn overflow returns a preview with no session; real approval enables subsequent claims", async () => {
  seed("a", [], "completed"); seed("b", ["a"], "completed"); seed("c", ["b"], "completed"); seed("d", ["c"], "completed"); seed("e", ["d"])
  const request = { name: "worker", claim_task: "e", prompt: "work", worktree: false }
  const preview = await executeTeamSpawn(deps, request, "lead")
  expect(preview).toContain("Depth overflow"); expect(deps.client.calls).toEqual([])
  const q = JSON.parse(preview.slice(preview.indexOf("\n") + 1)) as { token: string; question: string; approvalLabel: string; denialLabel: string }
  await expect(executeTeamSpawn(deps, { ...request, depth_approval_token: q.token }, "lead")).rejects.toThrow("approved")
  deps.depthApprovals.recordQuestionAnswer("lead", `"Depth?"=${JSON.stringify(q.approvalLabel)}.`, { questions: [{ question: q.question, options: [{ label: q.approvalLabel }, { label: q.denialLabel }] }] })
  await executeTeamSpawn(deps, { ...request, depth_approval_token: q.token }, "lead")
  expect(row("e")).toEqual({ status: "in_progress", assignee: "worker" })
})
test("a late session-create result is aborted after timeout instead of becoming an orphan", async () => {
  seed("task")
  const old = process.env.SPAWN_TIMEOUT_MS; process.env.SPAWN_TIMEOUT_MS = "5"
  let finish: (value: { data: { id: string } }) => void = () => {}
  deps.client.session.create = () => new Promise(resolve => { finish = resolve })
  try {
    await expect(spawn("worker", "task")).rejects.toThrow("timed out")
    finish({ data: { id: "late-session" } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(deps.client.calls.filter(c => c.method === "session.abort").map(c => c.args[0])).toContainEqual({ sessionID: "late-session" })
    expect(row("task")).toEqual({ status: "pending", assignee: null })
  } finally { if (old === undefined) delete process.env.SPAWN_TIMEOUT_MS; else process.env.SPAWN_TIMEOUT_MS = old }
})
test("permission setup failure after native V2 session creation is rolled back", async () => {
  seed("task")
  const interrupted: string[] = []
  const client = createV2Client({ session: {
    create: async () => ({ id: "created-session" }), prompt: async () => ({}), synthetic: async () => ({}),
    switchAgent: async () => {}, switchModel: async () => {}, interrupt: async ({ sessionID }) => { interrupted.push(String(sessionID)) },
    get: async () => ({}), context: async () => [], active: async () => ({}),
  }, permission: { rules: async () => { throw new Error("permission failed") } }, worktree: {
    create: async () => ({ directory: "/unused" }), remove: async () => {}, list: async () => [], refresh: async () => {},
  } })
  deps.client.session = client.session
  await expect(spawn("worker", "task")).rejects.toThrow("permission failed")
  expect(interrupted).toEqual(["created-session"])
  expect(row("task")).toEqual({ status: "pending", assignee: null })
})
test("worktree tool instances cannot bypass the lead's stricter canonical depth policy", async () => {
  seed("a", [], "completed"); seed("b", ["a"])
  deps.config.depth_limit = 1; deps.config.depth_limit_overflow_action = "lead_resolve"
  const nodes = readTaskNodes(deps.db, "team"), fingerprint = inspectTaskGraph(nodes).fingerprint
  expect(() => authorizeDepth(deps, "lead", "team", nodes, "check", fingerprint)).toThrow("lead_resolve")
  const worker = setupDeps(deps.db); worker.directory = "/worktrees/worker"
  insertMember(deps.db, "team", "worker", "worker-session")
  await expect(executeTeamClaim(worker, { task_id: "b" }, "worker-session")).rejects.toThrow("depth 2")
  expect(row("b")).toEqual({ status: "pending", assignee: null })
})
test("worktree workers can claim follow-up tasks on the lead's accepted unchanged topology", async () => {
  seed("a", [], "completed"); seed("b", ["a"], "completed"); seed("c", ["b"], "completed"); seed("d", ["c"], "completed"); seed("e", ["d"])
  const nodes = readTaskNodes(deps.db, "team"), fingerprint = inspectTaskGraph(nodes).fingerprint
  deps.depthApprovals.accept("team", fingerprint, 4)
  const worker = setupDeps(deps.db); worker.directory = "/worktrees/worker"
  insertMember(deps.db, "team", "worker", "worker-session")
  await executeTeamClaim(worker, { task_id: "e" }, "worker-session")
  expect(row("e")).toEqual({ status: "in_progress", assignee: "worker" })
})
test.each(["worktree", "workspace"])("late %s creation is removed without affecting the tracked fallback worker", async kind => {
  seed("task")
  const old = process.env.SPAWN_TIMEOUT_MS; process.env.SPAWN_TIMEOUT_MS = "5"
  let finish: () => void = () => {}
  if (kind === "worktree") deps.client.worktree.create = () => new Promise(resolve => { finish = () => resolve({ data: { name: "late", branch: "late-branch", directory: "/late-worktree" } }) })
  else deps.client.workspace.create = () => new Promise(resolve => { finish = () => resolve({ data: { id: "late-workspace", type: "worktree", branch: null, directory: null, projectID: "proj" } }) })
  try {
    await executeTeamSpawn(deps, { name: "worker", claim_task: "task", prompt: "work", worktree: true }, "lead")
    finish()
    const method = `${kind}.remove`, deadline = Date.now() + 1000
    while (!deps.client.calls.some(call => call.method === method) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    expect(deps.client.calls.some(call => call.method === method)).toBe(true)
    expect(row("task")).toEqual({ status: "in_progress", assignee: "worker" })
  } finally { if (old === undefined) delete process.env.SPAWN_TIMEOUT_MS; else process.env.SPAWN_TIMEOUT_MS = old }
})
