import { readFileSync } from "node:fs"
import path from "node:path"

/** Plugin configuration shape. All fields optional — defaults applied. */
export interface EnsembleConfig {
  /** Maximum recorded prerequisite-chain depth; roots count as one. */
  depth_limit?: number
  /** Resolve overflow through user approval or lead replanning. */
  depth_limit_overflow_action?: "user_resolve" | "lead_resolve"
  /** Auto-merge worktree branches on cleanup (default: true) */
  mergeOnCleanup?: boolean
  /** Stall detection threshold in ms (default: 180000 = 3 min, 0 to disable) */
  stallThresholdMs?: number
  /** Min steps before token-based stall check (default: 3) */
  stallMinSteps?: number
  /** Output token threshold for stall detection (default: 500) */
  stallTokenThreshold?: number
  /** Hard timeout for busy members in ms (default: 1800000 = 30 min, 0 to disable) */
  timeoutMs?: number
  /** Rate limit capacity (default: 10, 0 to disable) */
  rateLimitCapacity?: number
  /** Dashboard server port (default: 4747, 0 to disable) */
  dashboardPort?: number
  /** Max peer messages per agent per window before nudge (default: 5, 0 to disable) */
  peerMessageLimit?: number
  /** Time window for peer message rate limiting in ms (default: 300000 = 5 min) */
  peerMessageWindowMs?: number
  /** Default model for all agents (e.g. "opencode/zen-sonnet-4-6") */
  defaultModel?: string
  /** Pool of models for rotation/random assignment */
  modelPool?: string[]
  /** Map agent type to specific model e.g. {"build": "anthropic/claude-opus-4-6"} */
  modelsByAgent?: Record<string, string>
  /** How to assign models: "default" | "rotate" | "random" (default: "default") */
  modelAssignment?: "default" | "rotate" | "random"
  /** Lead asks user about model preferences before spawning (default: false) */
  promptForModels?: boolean
}

/** Default configuration values. */
export const DEFAULT_CONFIG: Required<EnsembleConfig> = {
  depth_limit: 4,
  depth_limit_overflow_action: "user_resolve",
  mergeOnCleanup: true,
  stallThresholdMs: 300_000,
  stallMinSteps: 5,
  stallTokenThreshold: 200,
  timeoutMs: 30 * 60 * 1000,
  rateLimitCapacity: 10,
  dashboardPort: 4747,
  peerMessageLimit: 5,
  peerMessageWindowMs: 300_000,
  defaultModel: "",
  modelPool: [],
  modelsByAgent: {},
  modelAssignment: "default",
  promptForModels: false,
}

class DepthConfigError extends Error {}

/** Read a JSON config file, returning an empty object on missing/invalid JSON. */
function readConfigFile(filePath: string): Partial<EnsembleConfig> {
  try {
    const text = readFileSync(filePath, "utf-8")
    const raw = JSON.parse(text) as Record<string, unknown>
    // Validate types — only accept numbers for numeric fields, booleans for boolean fields
    const result: Partial<EnsembleConfig> = {}
    if (Object.hasOwn(raw, "depth_limit")) {
      if (typeof raw.depth_limit !== "number" || !Number.isSafeInteger(raw.depth_limit) || raw.depth_limit < 1) {
        throw new DepthConfigError(`Invalid depth_limit in ${filePath}: expected a positive safe integer`)
      }
      result.depth_limit = raw.depth_limit
    }
    if (Object.hasOwn(raw, "depth_limit_overflow_action")) {
      if (raw.depth_limit_overflow_action !== "user_resolve" && raw.depth_limit_overflow_action !== "lead_resolve") {
        throw new DepthConfigError(`Invalid depth_limit_overflow_action in ${filePath}: expected user_resolve or lead_resolve`)
      }
      result.depth_limit_overflow_action = raw.depth_limit_overflow_action
    }
    if (typeof raw.mergeOnCleanup === "boolean") result.mergeOnCleanup = raw.mergeOnCleanup
    if (typeof raw.stallThresholdMs === "number") result.stallThresholdMs = raw.stallThresholdMs
    if (typeof raw.stallMinSteps === "number") result.stallMinSteps = raw.stallMinSteps
    if (typeof raw.stallTokenThreshold === "number") result.stallTokenThreshold = raw.stallTokenThreshold
    if (typeof raw.timeoutMs === "number") result.timeoutMs = raw.timeoutMs
    if (typeof raw.rateLimitCapacity === "number") result.rateLimitCapacity = raw.rateLimitCapacity
    if (typeof raw.dashboardPort === "number") result.dashboardPort = raw.dashboardPort
    if (typeof raw.peerMessageLimit === "number") result.peerMessageLimit = raw.peerMessageLimit
    if (typeof raw.peerMessageWindowMs === "number") result.peerMessageWindowMs = raw.peerMessageWindowMs
    if (typeof raw.defaultModel === "string") result.defaultModel = raw.defaultModel
    if (Array.isArray(raw.modelPool) && raw.modelPool.every((m: unknown) => typeof m === "string")) result.modelPool = raw.modelPool as string[]
    if (typeof raw.modelsByAgent === "object" && raw.modelsByAgent !== null && !Array.isArray(raw.modelsByAgent)) {
      const valid = Object.entries(raw.modelsByAgent as Record<string, unknown>).every(([, v]) => typeof v === "string")
      if (valid) result.modelsByAgent = raw.modelsByAgent as Record<string, string>
    }
    if (typeof raw.modelAssignment === "string" && ["default", "rotate", "random"].includes(raw.modelAssignment)) result.modelAssignment = raw.modelAssignment as "default" | "rotate" | "random"
    if (typeof raw.promptForModels === "boolean") result.promptForModels = raw.promptForModels
    return result
  } catch (err) {
    if (err instanceof DepthConfigError) throw err
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return {}
    console.warn(`[ensemble] Invalid config at ${filePath}, using defaults`)
    return {}
  }
}

/**
 * Load plugin configuration. Merges global → project → env vars.
 * Missing files are silently skipped. Invalid JSON logs a warning.
 */
export function loadConfig(projectDir: string): Required<EnsembleConfig> {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ""
  const globalPath = path.join(homeDir, ".config", "opencode", "ensemble.json")
  const projectPath = path.join(projectDir, ".opencode", "ensemble.json")

  const global = readConfigFile(globalPath)
  const project = readConfigFile(projectPath)
  const merged = { ...DEFAULT_CONFIG, ...global, ...project }

  // Env vars override everything
  const timeout = process.env.OPENCODE_ENSEMBLE_TIMEOUT
  if (timeout !== undefined) merged.timeoutMs = timeout === "0" ? 0 : (parseInt(timeout, 10) || merged.timeoutMs)

  const rateLimit = process.env.OPENCODE_ENSEMBLE_RATE_LIMIT
  if (rateLimit !== undefined) merged.rateLimitCapacity = rateLimit === "0" ? 0 : (parseInt(rateLimit, 10) || merged.rateLimitCapacity)

  const stall = process.env.STALL_THRESHOLD_MS
  if (stall !== undefined) merged.stallThresholdMs = stall === "0" ? 0 : (parseInt(stall, 10) || merged.stallThresholdMs)

  return merged
}
