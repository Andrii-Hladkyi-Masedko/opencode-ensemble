import { beforeEach, afterEach, expect, test } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { executeTeamSpawn, spawnFailures } from "../src/tools/team-spawn"
import { executeTeamClaim } from "../src/tools/team-claim"
import { executeTeamTasksComplete } from "../src/tools/team-tasks-complete"
import { buildLeadSystemPrompt } from "../src/system-prompt"

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
