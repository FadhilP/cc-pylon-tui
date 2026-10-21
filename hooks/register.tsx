import { atom, derive, memberOf, read, update } from 'claude-code'
import type { AgentInfo, ProcessRunResult, Register, SessionUsage } from 'claude-code'

import type { AgentRow, EditRun, PlanStatus, SessionFacts } from '../types'
import {
  MAIN_LOOP,
  afterAppend,
  applyTaskUpdate,
  baseName,
  bashEditCount,
  bashEditTitle,
  bashEdits,
  countChange,
  countInRun,
  fitLabel,
  groupSummary,
  isFileToolResult,
  isNewFile,
  joinRun,
  labelFor,
  matchTurn,
  mergeChange,
  mergeSlices,
  noticeFor,
  patchText,
  planFromTodos,
  relativePath,
  runOf,
  spinnerLabel,
  withLabel,
} from './text'
import type { FileToolResult, TaskUpdate } from './text'
import { changeDetail, foldHead, paneView, turnView } from './views'
import type { PaneModel } from './views'

const PANE = 'pylon-tui-session'
const PANE_TITLE = 'Session'
const REFRESH_MS = 15_000
const MAX_TURNS = 100
const ACTIVE_AGENT_STATUS = new Set(['pending', 'running', 'waiting'])
const FILE_TOOLS = new Set(['Edit', 'Write'])

const plan = atom({ plugin: 'pylon-tui', key: 'plan' } as const, [])
const changes = atom({ plugin: 'pylon-tui', key: 'changes' } as const, [])
const turns = atom({ plugin: 'pylon-tui', key: 'turns' } as const, [])
const agents = atom({ plugin: 'pylon-tui', key: 'agents' } as const, [])
const running = atom({ plugin: 'pylon-tui', key: 'running' } as const, { labels: {}, agentIds: [] })
const editRuns = atom({ plugin: 'pylon-tui', key: 'editRuns' } as const, { path: null, runs: [] })
const isPaneOpen = atom({ plugin: 'pylon-tui', key: 'isPaneOpen' } as const, false)
const selectedFile = atom({ plugin: 'pylon-tui', key: 'selectedFile' } as const, null)
const isOpen = atom({ plugin: 'pylon-tui', key: 'isOpen' } as const, false)
const facts = atom({ plugin: 'pylon-tui', key: 'facts' } as const, {
  cwd: '',
  project: '',
  branch: null,
  costUsd: null,
  contextTokens: null,
  contextWindow: null,
  breakdownMax: null,
  slices: [],
})

const paneData = derive(
  [facts, plan, changes, agents, selectedFile],
  (factsValue, planValue, changesValue, agentsValue, selected): PaneModel => ({
    facts: factsValue,
    plan: planValue,
    changes: changesValue,
    agents: agentsValue,
    selectedFile: selected,
  }),
)

type Turn = { changed: Set<string>; added: number; removed: number }

function newTurn(): Turn {
  return { changed: new Set(), added: 0, removed: 0 }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function branchFrom(run: ProcessRunResult | undefined, current: string | null): string | null {
  if (run === undefined) return current
  if (run.exitCode !== 0) return null
  return run.stdout.trim() || 'detached HEAD'
}

function mergeFacts(
  current: SessionFacts,
  usage: SessionUsage | undefined,
  branch: string | null,
  model: string | undefined,
): SessionFacts {
  const breakdown = usage?.context.breakdown
  const compactAt = breakdown?.autoCompactThreshold
  const slices = mergeSlices(
    (breakdown?.categories ?? [])
      .filter(category => category.kind === 'used' && category.tokens > 0)
      .map(category => ({ name: category.name, tokens: category.tokens, color: category.color })),
  )
  return {
    ...current,
    branch,
    model: model ?? current.model ?? null,
    costUsd: usage?.cost?.usd ?? current.costUsd,
    rateLimits: usage?.rateLimits.map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed })) ?? current.rateLimits ?? [],
    // After a compaction `tokens` stays at the last reply's count until the next one; the breakdown is current.
    contextTokens: breakdown?.totalTokens ?? usage?.context.tokens ?? current.contextTokens,
    contextWindow: compactAt ?? usage?.context.window ?? current.contextWindow,
    breakdownMax: compactAt ?? breakdown?.rawMaxTokens ?? current.breakdownMax,
    slices: breakdown === undefined ? current.slices : slices,
  }
}

// The main screen prints rows to scrollback and cannot redraw them, so runs fold only in fullscreen.
async function foldedRun(
  $: Parameters<typeof read>[0],
  e: { viewport?: { isFullscreen?: boolean }; props: { tool_use_id: string } },
): Promise<EditRun | undefined> {
  if (e.viewport?.isFullscreen !== true) return undefined
  const run = runOf(await read($, editRuns), e.props.tool_use_id)
  return run !== undefined && run.ids.length > 1 ? run : undefined
}

function activeAgents(list: readonly AgentInfo[]): AgentRow[] {
  return list
    .filter(agent => ACTIVE_AGENT_STATUS.has(agent.status))
    .map(agent => ({ id: agent.id, description: agent.description, type: agent.type }))
}

export const register: Register = on => {
  let refreshNow: (() => void) | undefined
  let turn = newTurn()

  function addToTurn(path: string, result: FileToolResult): void {
    const { added, removed } = countChange(result)
    turn.changed.add(path)
    turn.added += added
    turn.removed += removed
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dock', description: 'Show or hide the session pane' })
    await update($, facts, current => ({ ...current, cwd: e.cwd, project: baseName(e.cwd) }))

    const refreshAll = async (): Promise<void> => {
      const [usage, model, branchRun, agentList, panes] = await Promise.all([
        $.session.usage({ breakdown: 'summary' }).catch(() => undefined),
        $.session.model().catch(() => undefined),
        $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 3000 }).catch(() => undefined),
        $.agent.list().catch(() => undefined),
        $.ui.panes().catch(() => undefined),
      ])

      const current = await read($, facts)
      const nextFacts = mergeFacts(current, usage, branchFrom(branchRun, current.branch), model)
      if (!sameValue(current, nextFacts)) await update($, facts, () => nextFacts)

      const rows = agentList === undefined ? undefined : activeAgents(agentList)
      if (rows !== undefined && !sameValue(rows, await read($, agents))) await update($, agents, () => rows)

      const isPlaced = panes?.some(pane => pane.id === PANE && pane.isPlaced)
      if (isPlaced !== undefined && isPlaced !== (await read($, isPaneOpen))) await update($, isPaneOpen, () => isPlaced)
    }

    refreshNow = () => void refreshAll().catch(() => undefined)
    refreshNow()
    $.clock.every(REFRESH_MS, refreshNow)
    // The engine holds an unasked pane undrawn until the terminal is wide enough.
    void $.ui.open({ id: PANE, title: PANE_TITLE }).then(() => refreshNow?.(), () => undefined)
    return next(e)
  })

  const withTitle = (title: string | undefined) => (current: SessionFacts) => ({ ...current, title: title ?? current.title })

  on('classic.SessionStart', async ($, e, next) => {
    await update($, facts, withTitle(e.session_title))
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await update($, facts, withTitle(e.session_title))
    return next(e)
  })

  on('command.run', { command: 'dock' }, async $ => {
    if (await read($, isPaneOpen)) {
      await $.ui.close({ id: PANE })
      return { text: 'Closed the session pane.' }
    }
    const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
    await update($, isPaneOpen, () => opened.isPlaced)
    return { text: opened.isPlaced ? 'Opened the session pane.' : 'The session pane opens when the terminal is wider.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isPaneOpen, () => false)
    return closed
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) turn = newTurn()
    else refreshNow?.()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      refreshNow?.()
      return next(e)
    }
    const summary = {
      finishedAt: await $.clock.now(),
      durationMs: e.durationMs,
      changed: turn.changed.size,
      added: turn.added,
      removed: turn.removed,
      isAborted: e.isAborted,
    }
    await update($, turns, list => [...list, summary].slice(-MAX_TURNS))
    refreshNow?.()
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const loop = e.agentId ?? MAIN_LOOP
    const isMainLoop = e.agentId === undefined
    const { cwd } = await read($, facts)

    const command = typeof input.command === 'string' ? input.command : null
    const notice = command === null ? null : noticeFor(command, await read($, changes))
    if (notice !== null) $.ui.notice(e.tool_use_id, notice)

    await update($, running, state => withLabel(state, loop, spinnerLabel(tool, input, cwd)))
    const editPath = typeof input.file_path === 'string' ? relativePath(input.file_path, cwd) : null
    if (isMainLoop && FILE_TOOLS.has(tool) && editPath !== null) {
      await update($, editRuns, state => joinRun(state, e.tool_use_id, editPath))
    }
    try {
      const ran = await next(e)
      const result = ran.isError === true ? undefined : ran.result

      if (FILE_TOOLS.has(tool) && isFileToolResult(result)) {
        const path = relativePath(result.filePath, cwd)
        await update($, changes, list => mergeChange(list, path, result))
        if (isMainLoop) addToTurn(path, result)
        if (isMainLoop) await update($, editRuns, state => countInRun(state, e.tool_use_id, countChange(result)))
      }
      if (isMainLoop && tool === 'TodoWrite' && Array.isArray(input.todos)) {
        const todos = input.todos as { content: string; status: PlanStatus }[]
        await update($, plan, () => planFromTodos(todos))
      }
      const created = (result as { task?: { id: string; subject: string } } | undefined)?.task
      if (isMainLoop && tool === 'TaskCreate' && created !== undefined) {
        await update($, plan, list => [...list, { id: created.id, text: created.subject, status: 'pending' as const }])
      }
      if (isMainLoop && tool === 'TaskUpdate' && typeof input.taskId === 'string') {
        await update($, plan, list => applyTaskUpdate(list, input as unknown as TaskUpdate))
      }
      return ran
    } finally {
      await update($, running, state => withLabel(state, loop, null))
    }
  })

  on('session.append', async ($, e, next) => {
    if (e.agentId === undefined) await update($, editRuns, state => afterAppend(state, e.message.content, FILE_TOOLS))
    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const label = labelFor(await read($, running), e.requestId)
    if (label === undefined) return next(e)
    return next({ ...e, props: { ...e.props, message: fitLabel(label, e.viewport?.columns) } })
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const summary = matchTurn(await read($, turns), e.props.durationMs)
    // Rows saved by the previous version have no finishedAt.
    if (typeof summary?.finishedAt !== 'number') return next(e)
    return turnView($.ui.resolve(e), summary)
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const member = memberOf(isOpen, e)
    const isShown = await read($, member)
    const { title, detail } = groupSummary(e.props.calls)
    const head = foldHead(els, isShown, title, <Text dimColor>{detail}</Text>, () => void update($, member, value => !value))
    if (!isShown) return head
    const rows = await next({ ...e, props: { ...e.props, isExpanded: true } })
    return (
      <Box flexDirection="column">
        {head}
        <Box paddingLeft={2}>{rows}</Box>
      </Box>
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const props = e.props
    // A parallel call's row keeps isRunning after its result lands; a stored output means it resolved.
    const isSettled = !props.isErrored && !props.isInterrupted
    const result = props.output
    if (!FILE_TOOLS.has(props.tool) || !isSettled || !isFileToolResult(result)) return next(e)
    const els = $.ui.resolve(e)
    const run = await foldedRun($, e)
    if (run !== undefined && run.ids[0] !== props.tool_use_id) return <els.Box />
    const member = memberOf(isOpen, e)
    const { cwd } = await read($, facts)
    const { added, removed } = run ?? countChange(result)
    const verb = isNewFile(result) ? 'Created' : 'Edited'
    const times = run === undefined ? '' : ` ×${run.ids.length}`
    const title = `${verb} ${relativePath(result.filePath, cwd)}${times}`
    return foldHead(els, await read($, member), title, changeDetail(els, added, removed), () => void update($, member, value => !value))
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const result = e.props.output
    if (!FILE_TOOLS.has(e.props.tool) || e.props.isErrored || !isFileToolResult(result)) return next(e)
    const { Box, Code, Text } = $.ui.resolve(e)
    const head = (await foldedRun($, e))?.ids[0] ?? e.requestId
    if (!(await read($, memberOf(isOpen, { requestId: head })))) return <Box />
    const patch = patchText(result)
    if (patch === '') return <Text dimColor>No changes</Text>
    return (
      <Box paddingLeft={2}>
        <Code format="diff" source={patch} path={result.filePath} />
      </Box>
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const props = e.props
    const isSettled = !props.isErrored && !props.isInterrupted
    const edits = props.tool === 'Bash' && isSettled ? bashEdits(props.output) : null
    if (edits === null) return next(e)
    const els = $.ui.resolve(e)
    const member = memberOf(isOpen, e)
    const isShown = await read($, member)
    const { cwd } = await read($, facts)
    const { added, removed } = bashEditCount(edits)
    const title = bashEditTitle(edits, cwd)
    const head = foldHead(els, isShown, title, changeDetail(els, added, removed), () => void update($, member, value => !value))
    if (!isShown) return head
    const { Box } = els
    return (
      <Box flexDirection="column">
        {head}
        {await next(e)}
      </Box>
    )
  })

  // The engine's own Bash result draws the diff, so an open fold shows it unchanged.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const isBashEdit = e.props.tool === 'Bash' && !e.props.isErrored && bashEdits(e.props.output) !== null
    if (!isBashEdit || (await read($, memberOf(isOpen, e)))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const model = { ...(await read($, paneData)), viewedAgent: e.props.view.agentId }
    const onView = (agentId: string | undefined) => void $.ui.view(agentId === undefined ? {} : { agentId })
    return paneView($.ui.resolve(e), model, e.props.bodyColumns, path => void update($, selectedFile, () => path), onView)
  })
}
