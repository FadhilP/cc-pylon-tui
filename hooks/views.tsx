import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { AgentRow, FileChange, PlanItem, SessionFacts, TurnSummary } from '../types'
import { contextCells, formatTokens, plural, turnParts, usageParts } from './text'

export type Els = Pick<Elements[RenderSurface], 'Box' | 'Text' | 'Button' | 'Code'>

export type PaneModel = {
  facts: SessionFacts
  plan: PlanItem[]
  changes: FileChange[]
  agents: AgentRow[]
  selectedFile: string | null
  viewedAgent?: string
}

type Press = () => void

type ViewAgent = (agentId: string | undefined) => void

const PANE_PADDING = 2

const PLAN_GLYPH = { completed: '✓', in_progress: '◐', pending: '○' } as const
const PLAN_COLOR = { completed: 'success', in_progress: 'claude', pending: 'inactive' } as const
const LEVEL_COLOR = { low: 'warning', critical: 'error' } as const

function heading(els: Els, title: string, aside: string): RenderElement {
  const { Box, Text } = els
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text weight="semibold">{title}</Text>
      <Text dimColor>{aside}</Text>
    </Box>
  )
}

function usageValue(els: Els, facts: SessionFacts): RenderElement | string {
  const { Text } = els
  const parts = usageParts(facts.costUsd, facts.rateLimits ?? [])
  if (parts.length === 0) return 'unknown'
  return (
    <Text>
      {parts.map((part, index) => {
        const text = index === 0 ? part.text : `  ${part.text}`
        return part.level === 'ok' ? text : <Text color={LEVEL_COLOR[part.level]}>{text}</Text>
      })}
    </Text>
  )
}

function factRow(els: Els, label: string, value: RenderElement | string): RenderElement {
  const { Box, Text } = els
  return (
    <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
      <Box flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate-start">{value}</Text>
      </Box>
    </Box>
  )
}

function sessionSection(els: Els, facts: SessionFacts): RenderElement {
  const { Box } = els
  return (
    <Box flexDirection="column">
      {heading(els, 'Session', facts.project)}
      {factRow(els, 'Directory', facts.cwd)}
      {factRow(els, 'Branch', facts.branch ?? 'no git repository')}
      {factRow(els, 'Cost/Usage', usageValue(els, facts))}
      {factRow(els, 'Model', facts.model ?? 'unknown')}
    </Box>
  )
}

function contextSection(els: Els, facts: SessionFacts, width: number): RenderElement {
  const { Box, Text } = els
  const hasTotals = facts.contextTokens !== null && facts.contextWindow !== null
  const aside = hasTotals ? `${formatTokens(facts.contextTokens ?? 0)} of ${formatTokens(facts.contextWindow ?? 0)}` : ''
  if (facts.breakdownMax === null || facts.slices.length === 0) {
    return (
      <Box flexDirection="column">
        {heading(els, 'Context', aside)}
        <Text dimColor>Shows after Claude's first reply</Text>
      </Box>
    )
  }
  const cells = contextCells(facts.slices, facts.breakdownMax, width)
  const free = Math.max(0, width - cells.reduce((sum, cell) => sum + cell.count, 0))
  return (
    <Box flexDirection="column">
      {heading(els, 'Context', aside)}
      <Text>
        {cells.map(cell => <Text color={cell.color}>{'█'.repeat(cell.count)}</Text>)}
        <Text dimColor>{'░'.repeat(free)}</Text>
      </Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {facts.slices.map(slice => (
          <Text>
            <Text color={slice.color}>■</Text> <Text dimColor>{slice.name.toLowerCase()} {formatTokens(slice.tokens)}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  )
}

function planSection(els: Els, plan: PlanItem[]): RenderElement {
  const { Box, Text } = els
  const done = plan.filter(item => item.status === 'completed').length
  return (
    <Box flexDirection="column">
      {heading(els, 'Plan', plan.length > 0 ? `${done} of ${plan.length}` : '')}
      {plan.length === 0 && <Text dimColor>No plan yet</Text>}
      {plan.map(item => (
        <Box flexDirection="row" gap={1}>
          <Text color={PLAN_COLOR[item.status]}>{PLAN_GLYPH[item.status]}</Text>
          <Text dimColor={item.status === 'completed'} wrap="truncate-end">{item.text}</Text>
        </Box>
      ))}
    </Box>
  )
}

function changeButton(els: Els, change: FileChange, isSelected: boolean, onSelect: (path: string | null) => void): RenderElement {
  const { Button, Text } = els
  return (
    <Button key={`file:${change.path}`} plain onPress={() => onSelect(isSelected ? null : change.path)}>
      <Text color={change.isNew ? 'success' : 'suggestion'}>{change.isNew ? 'A' : 'M'}</Text> {change.path}{' '}
      <Text color="success">+{change.added}</Text>
      {change.removed > 0 ? <Text color="error"> −{change.removed}</Text> : ''}
    </Button>
  )
}

function changesSection(els: Els, list: FileChange[], selected: string | null, onSelect: (path: string | null) => void): RenderElement {
  const { Box, Text, Code } = els
  const shown = list.find(change => change.path === selected)
  return (
    <Box flexDirection="column">
      {heading(els, 'Changes', list.length > 0 ? plural(list.length, 'file') : '')}
      {list.length === 0 && <Text dimColor>No files changed yet</Text>}
      {list.map(change => changeButton(els, change, change.path === selected, onSelect))}
      {list.length > 0 && shown === undefined && <Text dimColor>Select a file to see its last change</Text>}
      {shown !== undefined && shown.patch !== '' && <Code format="diff" source={shown.patch} path={shown.path} wrap="truncate-end" />}
    </Box>
  )
}

function viewButton(els: Els, key: string, isViewed: boolean, onPress: Press, label: RenderElement | string): RenderElement {
  const { Button, Text } = els
  return (
    <Button key={key} plain onPress={onPress}>
      <Text color={isViewed ? 'claude' : 'permission'}>{isViewed ? '▸' : '◆'}</Text> {label}
    </Button>
  )
}

function backgroundSection(els: Els, list: AgentRow[], viewed: string | undefined, onView: ViewAgent): RenderElement {
  const { Box, Text } = els
  const hasNav = list.length > 0 || viewed !== undefined
  return (
    <Box flexDirection="column">
      {heading(els, 'Background', list.length > 0 ? `${list.length} running` : '')}
      {list.length === 0 && <Text dimColor>Nothing running</Text>}
      {hasNav && viewButton(els, 'agent:main', viewed === undefined, () => onView(undefined), 'Main conversation')}
      {list.map(agent =>
        viewButton(
          els,
          `agent:${agent.id}`,
          agent.id === viewed,
          () => onView(agent.id),
          <Text wrap="truncate-end">
            {agent.description} <Text dimColor>{agent.type}</Text>
          </Text>,
        ),
      )}
    </Box>
  )
}

export function paneView(els: Els, model: PaneModel, width: number, onSelect: (path: string | null) => void, onView: ViewAgent): RenderElement {
  const { Box } = els
  const bodyWidth = Math.max(1, width - PANE_PADDING)
  return (
    <Box flexDirection="column" gap={1} width={width} paddingLeft={PANE_PADDING}>
      {sessionSection(els, model.facts)}
      {contextSection(els, model.facts, bodyWidth)}
      {planSection(els, model.plan)}
      {changesSection(els, model.changes, model.selectedFile, onSelect)}
      {backgroundSection(els, model.agents, model.viewedAgent, onView)}
    </Box>
  )
}

export function foldHead(els: Els, isOpen: boolean, title: string, detail: RenderElement | string, onPress: Press): RenderElement {
  const { Button, Text } = els
  return (
    <Button key="fold" plain onPress={onPress}>
      <Text dimColor>{isOpen ? '▾' : '▸'}</Text> {title} {detail}
    </Button>
  )
}

export function changeDetail(els: Els, added: number, removed: number): RenderElement {
  const { Text } = els
  return (
    <Text>
      <Text color="success">+{added}</Text>
      {removed > 0 ? <Text color="error"> −{removed}</Text> : ''}
    </Text>
  )
}

export function turnView(els: Els, summary: TurnSummary): RenderElement {
  const { Box, Text } = els
  const [clock, ...rest] = turnParts(summary)
  return (
    <Box flexDirection="row" columnGap={2} marginTop={1}>
      <Text>
        <Text color={summary.isAborted ? 'warning' : 'success'}>●</Text> <Text dimColor>{clock}</Text>
      </Text>
      {rest.map(part => <Text dimColor>{part}</Text>)}
      {summary.changed > 0 && changeDetail(els, summary.added, summary.removed)}
    </Box>
  )
}
