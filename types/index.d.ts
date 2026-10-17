export type PlanStatus = 'pending' | 'in_progress' | 'completed'

export type PlanItem = { id: string; text: string; status: PlanStatus }

export type FileChange = {
  path: string
  isNew: boolean
  added: number
  removed: number
  patch: string
}

export type TurnSummary = {
  finishedAt: number
  durationMs: number
  changed: number
  added: number
  removed: number
  isAborted: boolean
}

export type ContextSlice = { name: string; tokens: number; color: string }

export type RateLimit = { kind: string; percentUsed: number }

export type SessionFacts = {
  cwd: string
  project: string
  title?: string | null
  branch: string | null
  model?: string | null
  costUsd: number | null
  rateLimits?: RateLimit[]
  contextTokens: number | null
  contextWindow: number | null
  breakdownMax: number | null
  slices: ContextSlice[]
}

export type AgentRow = { id: string; description: string; type: string }

export type EditRun = { ids: string[]; added: number; removed: number }

export type EditRuns = { path: string | null; runs: EditRun[] }

export type RunningState = {
  labels: Record<string, string>
  agentIds: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'pylon-tui': {
      plan: PlanItem[]
      changes: FileChange[]
      turns: TurnSummary[]
      facts: SessionFacts
      agents: AgentRow[]
      running: RunningState
      editRuns: EditRuns
      isPaneOpen: boolean
      selectedFile: string | null
      isOpen: StateFamily<boolean>
    }
  }
}
