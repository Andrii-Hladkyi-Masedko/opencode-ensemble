import { createHash } from "node:crypto"

/** A recorded task and its explicit prerequisite declaration. */
export interface TaskNode { id: string; content: string; priority: string; status: string; assignee: string | null; dependsOn: string[] | null }
/** Longest prerequisite chain and a canonical topology fingerprint. */
export interface GraphReport { depth: number; chain: string[]; fingerprint: string }

function required<T>(values: Map<string, T>, id: string): T {
  const value = values.get(id)
  if (value === undefined) throw new Error(`Missing task state for "${id}"`)
  return value
}
/** Validate the recorded topology and report its longest chain. */
export function inspectTaskGraph(tasks: readonly TaskNode[]): GraphReport {
  const ordered = [...tasks].sort((a, b) => a.id.localeCompare(b.id))
  const byId = new Map<string, TaskNode>()
  ordered.forEach(task => {
    if (typeof task.id !== "string" || !task.id.trim()) throw new Error("Task IDs must be nonempty strings")
    if (byId.has(task.id)) throw new Error(`Duplicate task ID "${task.id}"`)
    if (task.dependsOn !== null && (!Array.isArray(task.dependsOn) || task.dependsOn.some(id => typeof id !== "string" || !id.trim()))) {
      throw new Error(`Task "${task.id}" has invalid depends_on; supply an array of real task IDs`)
    }
    byId.set(task.id, task)
  })
  const degree = new Map<string, number>(), children = new Map<string, string[]>()
  const depths = new Map<string, number>(), previous = new Map<string, string>()
  ordered.forEach(task => { degree.set(task.id, 0); children.set(task.id, []); depths.set(task.id, 1) })
  ordered.forEach(task => {
    const deps = [...new Set(task.dependsOn ?? [])].sort()
    deps.forEach(id => {
      if (!byId.has(id)) throw new Error(`Missing prerequisite "${id}" for task "${task.id}"; use task IDs from this team`)
      degree.set(task.id, required(degree, task.id) + 1)
      required(children, id).push(task.id)
    })
  })
  const queue = ordered.filter(task => degree.get(task.id) === 0).map(task => task.id)
  let head = 0, deepest: string | undefined
  while (head < queue.length) {
    const id = queue[head++]
    if (id === undefined) throw new Error("Invalid task traversal")
    if (deepest === undefined || required(depths, id) > required(depths, deepest)) deepest = id
    required(children, id).forEach(child => {
      const depth = required(depths, id) + 1
      if (depth > required(depths, child)) { depths.set(child, depth); previous.set(child, id) }
      degree.set(child, required(degree, child) - 1)
      if (degree.get(child) === 0) queue.push(child)
    })
  }
  if (head !== ordered.length) throw new Error(`Cyclic dependencies among tasks: ${ordered.filter(task => required(degree, task.id) > 0).map(task => task.id).join(", ")}`)
  const chain: string[] = []
  let cursor = deepest
  while (cursor !== undefined) { chain.push(cursor); cursor = previous.get(cursor) }
  const canonical = ordered.map(task => [task.id, task.dependsOn === null ? null : [...new Set(task.dependsOn)].sort()])
  return { depth: deepest === undefined ? 0 : required(depths, deepest), chain: chain.reverse(), fingerprint: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") }
}
/** Require an explicit declaration on the target and its ancestors. */
export function requireDeclaredTask(tasks: readonly TaskNode[], taskId: string): TaskNode {
  inspectTaskGraph(tasks)
  const byId = new Map(tasks.map(task => [task.id, task]))
  const target = byId.get(taskId)
  if (!target) throw new Error(`Task "${taskId}" not found in this team`)
  const queue = [taskId], visited = new Set<string>()
  let head = 0
  while (head < queue.length) {
    const id = queue[head++]
    if (id === undefined) throw new Error("Invalid task traversal")
    if (visited.has(id)) continue
    visited.add(id)
    const task = required(byId, id)
    if (task.dependsOn === null) throw new Error(`Task "${id}" needs lead review: explicitly record depends_on with team_tasks_add (use [] for independent work)`)
    queue.push(...task.dependsOn)
  }
  return target
}
