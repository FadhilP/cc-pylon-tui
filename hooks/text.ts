import type { ContextSlice, FileChange, PlanItem, PlanStatus, RateLimit, RunningState, TurnSummary } from '../types'

export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export type FileToolResult = {
  filePath: string
  type?: 'create' | 'update'
  content?: string
  structuredPatch: Hunk[]
}

export type GroupCall = { tool: string; input: unknown; isErrored: boolean }

export type TaskUpdate = { taskId: string; subject?: string; status?: PlanStatus | 'deleted' }

export const MAIN_LOOP = 'main'

const MAX_FILES = 50
const MAX_PATCH_LINES = 400
const LABEL_MAX = 60
const SHOWN_FILES = 3
// TurnDuration props carry no turn id, so a row is matched to its summary by duration.
const TURN_MATCH_MS = 1500

const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'ToolSearch', 'WebSearch', 'WebFetch'])
const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'limit' }

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

export function baseName(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

export function relativePath(path: string, cwd: string): string {
  const file = path.replaceAll('\\', '/')
  if (cwd === '') return file
  const root = `${cwd.replaceAll('\\', '/').replace(/\/+$/, '')}/`
  const isInside = file.toLowerCase().startsWith(root.toLowerCase())
  return isInside ? file.slice(root.length) : file
}

export function isFileToolResult(value: unknown): value is FileToolResult {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.filePath === 'string' && Array.isArray(record.structuredPatch)
}

export function isNewFile(result: FileToolResult): boolean {
  return result.type === 'create'
}

function newFileLines(result: FileToolResult): string[] {
  const lines = (result.content ?? '').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

export function countChange(result: FileToolResult): { added: number; removed: number } {
  if (isNewFile(result)) return { added: newFileLines(result).length, removed: 0 }
  let added = 0
  let removed = 0
  for (const hunk of result.structuredPatch) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1
      if (line.startsWith('-')) removed += 1
    }
  }
  return { added, removed }
}

export function patchText(result: FileToolResult): string {
  if (isNewFile(result)) {
    const lines = newFileLines(result).slice(0, MAX_PATCH_LINES)
    if (lines.length === 0) return ''
    return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`)].join('\n')
  }
  return result.structuredPatch
    .map(hunk => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines].join('\n'))
    .join('\n')
}

export function mergeChange(list: FileChange[], path: string, result: FileToolResult): FileChange[] {
  const { added, removed } = countChange(result)
  const patch = patchText(result)
  const existing = list.find(change => change.path === path)
  if (existing === undefined) {
    return [...list, { path, isNew: isNewFile(result), added, removed, patch }].slice(-MAX_FILES)
  }
  const merged = { ...existing, added: existing.added + added, removed: existing.removed + removed, patch }
  return list.map(change => (change.path === path ? merged : change))
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
  }
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

export function formatClock(epochMs: number): string {
  const time = new Date(epochMs)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(time.getHours())}:${pad(time.getMinutes())}`
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

export type UsageLevel = 'ok' | 'low' | 'critical'

export function limitLevel(percentUsed: number): UsageLevel {
  const left = 100 - percentUsed
  if (left < 10) return 'critical'
  if (left < 25) return 'low'
  return 'ok'
}

export function usageParts(costUsd: number | null, limits: readonly RateLimit[]): { text: string; level: UsageLevel }[] {
  const parts = limits.map(limit => ({
    text: `${LIMIT_NAMES[limit.kind] ?? limit.kind} ${limit.percentUsed}%`,
    level: limitLevel(limit.percentUsed),
  }))
  if (costUsd !== null) parts.unshift({ text: `$${costUsd.toFixed(2)}`, level: 'ok' })
  return parts
}

export function turnParts(summary: TurnSummary): string[] {
  const time = formatDuration(summary.durationMs)
  return [
    formatClock(summary.finishedAt),
    summary.isAborted ? `Stopped after ${time}` : `Worked for ${time}`,
    summary.changed > 0 ? plural(summary.changed, 'file change') : 'no changes',
  ]
}

export function matchTurn(list: TurnSummary[], durationMs: number): TurnSummary | undefined {
  let best: TurnSummary | undefined
  let bestGap = TURN_MATCH_MS
  for (const summary of list) {
    const gap = Math.abs(summary.durationMs - durationMs)
    if (gap > bestGap) continue
    best = summary
    bestGap = gap
  }
  return best
}

type CallKind = 'read' | 'search' | 'command' | 'other'

function kindOf(tool: string): CallKind {
  if (tool === 'Read') return 'read'
  if (SEARCH_TOOLS.has(tool)) return 'search'
  if (tool === 'Bash' || tool === 'PowerShell') return 'command'
  return 'other'
}

function readPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const path = (input as Record<string, unknown>).file_path
  return typeof path === 'string' ? path : null
}

export function groupSummary(calls: readonly GroupCall[], isActive: boolean): { title: string; detail: string } {
  const files: string[] = []
  const counts: Record<CallKind, number> = { read: 0, search: 0, command: 0, other: 0 }
  let failed = 0
  for (const call of calls) {
    const kind = kindOf(call.tool)
    counts[kind] += 1
    if (call.isErrored) failed += 1
    const path = kind === 'read' ? readPath(call.input) : null
    if (path !== null && !files.includes(baseName(path))) files.push(baseName(path))
  }

  const verb = isActive ? 'Exploring' : 'Explored'
  const title = files.length > 0 ? `${verb} ${plural(files.length, 'file')}` : verb
  const hidden = files.length - SHOWN_FILES
  const detail = [
    ...files.slice(0, SHOWN_FILES),
    hidden > 0 ? `+${hidden}` : null,
    counts.search > 0 ? plural(counts.search, 'search', 'searches') : null,
    counts.command > 0 ? plural(counts.command, 'command') : null,
    counts.other > 0 ? plural(counts.other, 'other call') : null,
    failed > 0 ? `${failed} failed` : null,
  ].filter(part => part !== null)
  return { title, detail: detail.join(', ') }
}

function firstLine(text: unknown): string | null {
  if (typeof text !== 'string') return null
  return text.split('\n')[0]?.trim() || null
}

function labelText(tool: string, input: Record<string, unknown>, cwd: string): string | null {
  const path = readPath(input)
  const file = path === null ? null : relativePath(path, cwd)
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = firstLine(input.command)
    return command === null ? null : `Running ${command}`
  }
  if (file !== null && tool === 'Edit') return `Editing ${file}`
  if (file !== null && tool === 'Write') return `Writing ${file}`
  if (file !== null && tool === 'Read') return `Reading ${file}`
  if (SEARCH_TOOLS.has(tool)) return 'Searching'
  if (tool === 'Agent') {
    const task = firstLine(input.description)
    return task === null ? 'Running an agent' : `Running agent: ${task}`
  }
  return null
}

export function spinnerLabel(tool: string, input: Record<string, unknown>, cwd: string): string | null {
  const text = labelText(tool, input, cwd)
  if (text === null || text.length <= LABEL_MAX) return text
  return `${text.slice(0, LABEL_MAX - 1)}…`
}

export function labelFor(state: RunningState, requestId: string): string | undefined {
  const own = state.labels[requestId]
  if (own !== undefined) return own
  const isSubagent = state.agentIds.includes(requestId)
  return isSubagent ? undefined : state.labels[MAIN_LOOP]
}

export function withLabel(state: RunningState, loop: string, label: string | null): RunningState {
  const labels = { ...state.labels }
  if (label === null) delete labels[loop]
  else labels[loop] = label
  const isNewAgent = loop !== MAIN_LOOP && !state.agentIds.includes(loop)
  const agentIds = isNewAgent ? [...state.agentIds, loop].slice(-50) : state.agentIds
  return { labels, agentIds }
}

export function noticeFor(command: string, list: FileChange[]): string | null {
  const used = list.filter(change => command.includes(change.path) || command.includes(baseName(change.path)))
  if (used.length === 0) return null
  const names = used.slice(0, 2).map(change => change.path).join(', ')
  const more = used.length > 2 ? ` and ${plural(used.length - 2, 'more file')}` : ''
  const verb = used.every(change => change.isNew) ? 'created' : 'changed'
  return `Uses ${names}${more}, which Claude ${verb} this session.`
}

export function planFromTodos(todos: readonly { content: string; status: PlanStatus }[]): PlanItem[] {
  return todos.map((todo, index) => ({ id: String(index), text: todo.content, status: todo.status }))
}

export function applyTaskUpdate(list: PlanItem[], change: TaskUpdate): PlanItem[] {
  if (change.status === 'deleted') return list.filter(item => item.id !== change.taskId)
  const status = change.status
  return list.map(item => {
    if (item.id !== change.taskId) return item
    return { ...item, text: change.subject ?? item.text, status: status ?? item.status }
  })
}

export function contextCells(slices: ContextSlice[], max: number, width: number): { color: string; count: number }[] {
  if (max <= 0 || width <= 0) return []
  const cells: { color: string; count: number }[] = []
  let used = 0
  for (const slice of slices) {
    const count = Math.min(width - used, Math.round((slice.tokens / max) * width))
    if (count <= 0) continue
    cells.push({ color: slice.color, count })
    used += count
  }
  return cells
}

export function usedPercent(tokens: number | null, window: number | null): number | null {
  if (tokens === null || window === null || window <= 0) return null
  return Math.round((tokens / window) * 100)
}
