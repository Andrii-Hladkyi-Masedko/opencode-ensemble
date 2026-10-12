import { describe, expect, test } from "bun:test"
import { inspectTaskGraph, requireDeclaredTask, type TaskNode } from "../src/task-graph"

const task = (id: string, dependsOn: string[] | null = []): TaskNode => ({ id, content: id, priority: "medium", status: "pending", assignee: null, dependsOn })

describe("task dependency validation", () => {
  test("roots count as one and longest chains include terminal tasks", () => {
    const nodes = [task("d", ["c"]), task("b", ["a"]), task("a"), { ...task("c", ["b"]), status: "completed" }]
    expect(inspectTaskGraph(nodes).depth).toBe(4)
    expect(inspectTaskGraph(nodes).chain).toEqual(["a", "b", "c", "d"])
    expect(inspectTaskGraph([task("root")]).depth).toBe(1)
    expect(inspectTaskGraph([]).depth).toBe(0)
  })
  test("diamond depth is the longest path, not the number of dependencies", () => {
    const nodes = [task("a"), task("b", ["a"]), task("c", ["a"]), task("d", ["b", "c"])]
    expect(inspectTaskGraph(nodes).depth).toBe(3)
  })
  test("missing or cross-team IDs are rejected", () => {
    expect(() => inspectTaskGraph([task("a", ["missing"])])).toThrow("missing")
  })
  test.each([
    { nodes: [task("a", ["a"])] },
    { nodes: [task("a", ["b"]), task("b", ["a"])] },
  ])("cycles are rejected rather than assigned an arbitrary depth", ({ nodes }) => {
    expect(() => inspectTaskGraph(nodes)).toThrow("Cyclic")
  })
  test("duplicate edges and ordering do not change topology fingerprints", () => {
    const a = [task("a"), task("b", ["a", "a"])]
    const b = [{ ...task("b", ["a"]), status: "completed", content: "Changed", assignee: "worker", priority: "high" }, task("a")]
    expect(inspectTaskGraph(a).fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(inspectTaskGraph(a).fingerprint).toBe(inspectTaskGraph(b).fingerprint)
    expect(inspectTaskGraph(a).fingerprint).not.toBe(inspectTaskGraph([task("a"), task("b")]).fingerprint)
    expect(inspectTaskGraph([task("a", null)]).fingerprint).not.toBe(inspectTaskGraph([task("a")]).fingerprint)
  })
  test("target and ancestors must explicitly declare depends_on", () => {
    expect(() => requireDeclaredTask([task("legacy", null)], "legacy")).toThrow("depends_on")
    expect(() => requireDeclaredTask([task("a", null), task("b", ["a"])], "b")).toThrow("a")
    expect(requireDeclaredTask([task("legacy", null), task("root")], "root").id).toBe("root")
    expect(() => requireDeclaredTask([task("root")], "gone")).toThrow("gone")
  })
  test("malformed declarations and duplicate node IDs fail closed", () => {
    expect(() => inspectTaskGraph([{ ...task("a"), dependsOn: [42] as unknown as string[] }])).toThrow("depends_on")
    expect(() => inspectTaskGraph([task("a"), task("a")])).toThrow("Duplicate")
  })
  test("a thousand-node chain traverses iteratively and supports prototype-like IDs", () => {
    const nodes = Array.from({ length: 1000 }, (_, i) => task(String(i), i ? [String(i - 1)] : []))
    expect(inspectTaskGraph(nodes).depth).toBe(1000)
    expect(requireDeclaredTask(nodes, "999").id).toBe("999")
    expect(inspectTaskGraph([task("__proto__"), task("constructor", ["__proto__"])]).depth).toBe(2)
  })
})
