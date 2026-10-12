import { beforeEach, afterEach, expect, test } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { executeTeamTasksAdd } from "../src/tools/team-tasks-add"
import { readTaskNodes, authorizeDepth } from "../src/task-policy"
import { inspectTaskGraph } from "../src/task-graph"

let deps: ReturnType<typeof setupDeps>
beforeEach(() => { deps = setupDeps(); insertTeam(deps.db, "team", "alpha", "lead"); insertMember(deps.db, "team", "worker", "member") })
afterEach(() => deps.db.close())
const create = (content: string, depends_on: string[] = []) => executeTeamTasksAdd(deps, { tasks: [{ content, depends_on, priority: "medium" }] }, "lead")
const row = (id: string) => readTaskNodes(deps.db, "team").find(t => t.id === id)!
const add = async (content: string, parents: string[] = []) => { await create(content, parents); return readTaskNodes(deps.db, "team").find(t => t.content === content)!.id }

test("independent tasks persist an explicit empty declaration", async () => {
  await create("a")
  expect(readTaskNodes(deps.db, "team")[0]?.dependsOn).toEqual([])
  expect(deps.db.query("SELECT depends_on FROM team_task").get()).toEqual({ depends_on: "[]" })
})
test("missing and malformed declarations are rejected with zero writes", async () => {
  await expect(executeTeamTasksAdd(deps, { tasks: [{ content: "a" }] }, "lead")).rejects.toThrow("depends_on")
  await expect(executeTeamTasksAdd(deps, { tasks: [{ content: "a", depends_on: [42] as unknown as string[] }] }, "lead")).rejects.toThrow("depends_on")
  expect(readTaskNodes(deps.db, "team")).toEqual([])
})
test("invalid IDs abort entire mixed batches", async () => {
  const a = await add("a")
  await expect(executeTeamTasksAdd(deps, { tasks: [{ task_id: a, content: "changed", depends_on: [] }, { content: "bad", depends_on: ["gone"] }] }, "lead")).rejects.toThrow("gone")
  expect(row(a).content).toBe("a"); expect(readTaskNodes(deps.db, "team")).toHaveLength(1)
})
test("tasks from another team cannot be prerequisite IDs", async () => {
  insertTeam(deps.db, "other", "other", "other-lead")
  await executeTeamTasksAdd(deps, { tasks: [{ content: "foreign", depends_on: [] }] }, "other-lead")
  const foreign = readTaskNodes(deps.db, "other")[0]!.id
  await expect(create("bad", [foreign])).rejects.toThrow("Missing prerequisite")
})
test("duplicate edit entries cannot overwrite each other", async () => {
  const a = await add("a")
  await expect(executeTeamTasksAdd(deps, { tasks: [{ task_id: a, depends_on: [] }, { task_id: a, depends_on: [] }] }, "lead")).rejects.toThrow("Duplicate")
})
test("lead-only dependency updates preserve omitted metadata and recompute status", async () => {
  const a = await add("a"), b = await add("b")
  deps.db.run("UPDATE team_task SET priority='high' WHERE id=?", [b])
  await expect(executeTeamTasksAdd(deps, { tasks: [{ task_id: b, depends_on: [a] }] }, "member")).rejects.toThrow("lead")
  await executeTeamTasksAdd(deps, { tasks: [{ task_id: b, depends_on: [a, a] }] }, "lead")
  expect(row(b)).toMatchObject({ content: "b", priority: "high", status: "blocked", dependsOn: [a] })
  await executeTeamTasksAdd(deps, { tasks: [{ task_id: b, depends_on: [] }] }, "lead")
  expect(row(b).status).toBe("pending")
})
test("cycles and self-dependencies never write", async () => {
  const a = await add("a"), b = await add("b", [a])
  await expect(executeTeamTasksAdd(deps, { tasks: [{ task_id: a, depends_on: [b] }] }, "lead")).rejects.toThrow("Cyclic")
  await expect(executeTeamTasksAdd(deps, { tasks: [{ task_id: a, depends_on: [a] }] }, "lead")).rejects.toThrow("Cyclic")
  expect(row(a).dependsOn).toEqual([])
})
test("legacy ancestry requires review, but unrelated legacy tasks do not block roots", async () => {
  const a = await add("a"); deps.db.run("UPDATE team_task SET depends_on=NULL WHERE id=?", [a])
  await expect(create("b", [a])).rejects.toThrow("review")
  await create("root")
  await executeTeamTasksAdd(deps, { tasks: [{ task_id: a, depends_on: [] }] }, "lead")
  await create("b", [a])
  expect(readTaskNodes(deps.db, "team")).toHaveLength(3)
})
test("terminal task edits preserve status and active tasks cannot gain blockers", async () => {
  const a = await add("a"), b = await add("b")
  deps.db.run("UPDATE team_task SET status='in_progress',assignee='worker' WHERE id=?", [b])
  await expect(executeTeamTasksAdd(deps, { tasks: [{ task_id: b, depends_on: [a] }] }, "lead")).rejects.toThrow("in_progress")
  deps.db.run("UPDATE team_task SET status='completed' WHERE id=?", [b])
  await executeTeamTasksAdd(deps, { tasks: [{ task_id: b, depends_on: [a] }] }, "lead")
  expect(row(b).status).toBe("completed")
})
test("lead_resolve accepts depth four and rejects five without token bypass", async () => {
  deps.config.depth_limit_overflow_action = "lead_resolve"
  let parent = await add("a")
  for (const content of ["b", "c", "d"]) parent = await add(content, [parent])
  expect(inspectTaskGraph(readTaskNodes(deps.db, "team")).depth).toBe(4)
  await expect(create("e", [parent])).rejects.toThrow("depth 5")
  await expect(executeTeamTasksAdd(deps, { tasks: [{ content: "e", depends_on: [parent] }], depth_approval_token: "fake" }, "lead")).rejects.toThrow("lead_resolve")
  expect(readTaskNodes(deps.db, "team")).toHaveLength(4)
})
test("user overflow requires a genuine answer and then accepts the resulting real-ID graph", async () => {
  let parent = await add("a")
  for (const content of ["b", "c", "d"]) parent = await add(content, [parent])
  const request = { tasks: [{ content: "e", depends_on: [parent] }] }
  const preview = await executeTeamTasksAdd(deps, request, "lead")
  expect(preview).toContain("Depth overflow"); expect(readTaskNodes(deps.db, "team")).toHaveLength(4)
  const challenge = JSON.parse(preview.slice(preview.indexOf("\n") + 1)) as { token: string; question: string; approvalLabel: string; denialLabel: string }
  await expect(executeTeamTasksAdd(deps, { ...request, depth_approval_token: challenge.token }, "lead")).rejects.toThrow("approved")
  deps.depthApprovals.recordQuestionAnswer("lead", `"Depth?"=${JSON.stringify(challenge.approvalLabel)}.`, { questions: [{ question: challenge.question, options: [{ label: challenge.approvalLabel }, { label: challenge.denialLabel }] }] })
  await executeTeamTasksAdd(deps, { ...request, depth_approval_token: challenge.token }, "lead")
  const nodes = readTaskNodes(deps.db, "team")
  expect(nodes).toHaveLength(5)
  expect(deps.depthApprovals.isAccepted("team", inspectTaskGraph(nodes).fingerprint, 4)).toBe(true)
  expect(() => authorizeDepth(deps, "lead", "team", nodes, "spawn:e", inspectTaskGraph(nodes).fingerprint)).not.toThrow()
  await expect(executeTeamTasksAdd(deps, { ...request, depth_approval_token: challenge.token }, "lead")).rejects.toThrow("invalid")
})
test("approved tokens reject changed payload and changed graph snapshots", async () => {
  deps.config.depth_limit = 1
  const a = await add("a"), request = { tasks: [{ content: "b", depends_on: [a] }] }
  const preview = await executeTeamTasksAdd(deps, request, "lead")
  const q = JSON.parse(preview.slice(preview.indexOf("\n") + 1)) as { token: string; question: string; approvalLabel: string; denialLabel: string }
  deps.depthApprovals.recordQuestionAnswer("lead", `"Depth?"=${JSON.stringify(q.approvalLabel)}.`, { questions: [{ question: q.question, options: [{ label: q.approvalLabel }, { label: q.denialLabel }] }] })
  await expect(executeTeamTasksAdd(deps, { tasks: [{ content: "different", depends_on: [a] }], depth_approval_token: q.token }, "lead")).rejects.toThrow("invalid")
  await add("independent")
  await expect(executeTeamTasksAdd(deps, { ...request, depth_approval_token: q.token }, "lead")).rejects.toThrow("invalid")
  expect(readTaskNodes(deps.db, "team")).toHaveLength(2)
})
