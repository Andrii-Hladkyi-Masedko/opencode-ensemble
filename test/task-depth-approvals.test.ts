import { describe, expect, test } from "bun:test"
import { PendingTaskDepthApprovals, observeDepthQuestionAnswer, type DepthScope, type DepthChallenge } from "../src/task-depth-approvals"

const scope: DepthScope = { sessionId: "lead", teamId: "team", operationKey: "add:a", baseFingerprint: "base", proposedFingerprint: "new", depthLimit: 4, action: "user_resolve" }
const args = (q: DepthChallenge) => ({ questions: [{ question: q.question, options: [{ label: q.approvalLabel }, { label: q.denialLabel }] }] })
const answer = (label: string) => `User has answered your questions: "Depth?"=${JSON.stringify(label)}.`
function fixture() {
  let clock = 1000, count = 0
  const registry = new PendingTaskDepthApprovals(600_000, () => clock, () => `token-${++count}-abcdef`)
  const challenge = registry.create(scope, "Limit 4; depth 5; a → b → c → d → e")
  return { registry, challenge, advance: () => { clock += 600_001 } }
}

describe("task depth human approvals", () => {
  test("an echoed token is not human approval", () => {
    const { registry, challenge } = fixture()
    expect(() => registry.consume(scope, challenge.token)).toThrow("approved")
  })
  test("an actual successful question answer authorizes the exact operation once", () => {
    const { registry, challenge } = fixture()
    observeDepthQuestionAnswer(registry, "lead", answer(challenge.approvalLabel), args(challenge), true)
    expect(() => registry.consume(scope, challenge.token)).not.toThrow()
    expect(() => registry.consume(scope, challenge.token)).toThrow("invalid")
    expect(challenge.question).toContain("Limit 4; depth 5")
  })
  test.each(["denied", "failed", "wrong-session", "missing-option", "forged-answer", "wrong-question"])("%s does not authorize", scenario => {
    const { registry, challenge } = fixture()
    const input = args(challenge)
    if (scenario === "missing-option") input.questions[0]!.options.pop()
    if (scenario === "wrong-question") input.questions[0]!.question = "Approve something unrelated?"
    observeDepthQuestionAnswer(registry, scenario === "wrong-session" ? "worker" : "lead",
      answer(scenario === "denied" ? challenge.denialLabel : scenario === "forged-answer" ? `${challenge.approvalLabel} extra` : challenge.approvalLabel), input, scenario !== "failed")
    expect(() => registry.consume(scope, challenge.token)).toThrow("approved")
  })
  test("denial clears an earlier approval", () => {
    const { registry, challenge } = fixture()
    registry.recordQuestionAnswer("lead", answer(challenge.approvalLabel), args(challenge))
    registry.recordQuestionAnswer("lead", answer(challenge.denialLabel), args(challenge))
    expect(() => registry.consume(scope, challenge.token)).toThrow("approved")
  })
  test.each(["sessionId", "teamId", "operationKey", "baseFingerprint", "proposedFingerprint", "action"] as const)("changed %s invalidates a token", key => {
    const { registry, challenge } = fixture()
    registry.recordQuestionAnswer("lead", answer(challenge.approvalLabel), args(challenge))
    expect(() => registry.consume({ ...scope, [key]: key === "action" ? "lead_resolve" : "changed" } as DepthScope, challenge.token)).toThrow("invalid")
  })
  test("changed limit and expired challenges are rejected", () => {
    const { registry, challenge, advance } = fixture()
    registry.recordQuestionAnswer("lead", answer(challenge.approvalLabel), args(challenge))
    expect(() => registry.consume({ ...scope, depthLimit: 5 }, challenge.token)).toThrow("invalid")
    advance()
    expect(() => registry.consume(scope, challenge.token)).toThrow("invalid")
  })
  test("accepted topology is scoped to team, fingerprint and limit, and resets on restart", () => {
    const { registry } = fixture()
    registry.accept("team", "new", 4)
    expect(registry.isAccepted("team", "new", 4)).toBe(true)
    expect(registry.isAccepted("other", "new", 4)).toBe(false)
    expect(registry.isAccepted("team", "different", 4)).toBe(false)
    expect(registry.isAccepted("team", "new", 5)).toBe(false)
    expect(registry.isAccepted("team", "new", 4)).toBe(false)
    expect(new PendingTaskDepthApprovals().isAccepted("team", "new", 4)).toBe(false)
  })
  test("successful topology changes can invalidate exceptions even if later restored", () => {
    const { registry } = fixture()
    registry.accept("team", "new", 4); registry.invalidate("team")
    expect(registry.isAccepted("team", "new", 4)).toBe(false)
  })
  test("lead_resolve cannot create a human-approval bypass", () => {
    const { registry } = fixture()
    expect(() => registry.create({ ...scope, action: "lead_resolve" }, "depth 5")).toThrow("lead_resolve")
  })
})
