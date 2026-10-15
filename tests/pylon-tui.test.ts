import { describe, expect, mock, test } from 'claude-code/testing'

import {
  countChange,
  formatDuration,
  groupSummary,
  labelFor,
  matchTurn,
  noticeFor,
  patchText,
  relativePath,
  spinnerLabel,
  turnParts,
  limitLevel,
  mergeSlices,
  usageParts,
  withLabel,
} from '../hooks/text'

const PLUGIN = 'pylon-tui'
const PANE = 'pylon-tui-session'

const EDIT_RESULT = {
  filePath: '/repo/src/routes/upload.ts',
  oldString: 'handleUpload)',
  newString: 'rateLimit, handleUpload)',
  originalFile: null,
  structuredPatch: [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 3,
      lines: [' import { Router } from "express";', '+import { rateLimit } from "../middleware/rateLimit";', '-router.post("/upload", handleUpload);', '+router.post("/upload", rateLimit, handleUpload);'],
    },
  ],
  userModified: false,
  replaceAll: false,
}

const PANE_PROPS = {
  title: 'Session',
  isFocused: false,
  bodyColumns: 44,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

describe('text helpers', () => {
  test('counts added and removed lines of a patch', () => {
    expect(countChange(EDIT_RESULT)).toEqual({ added: 2, removed: 1 })
  })

  test('counts every line of a new file as added', () => {
    const created = { filePath: '/repo/a.ts', type: 'create' as const, content: 'one\ntwo\n', structuredPatch: [] }
    expect(countChange(created)).toEqual({ added: 2, removed: 0 })
    expect(patchText(created)).toBe('@@ -0,0 +1,2 @@\n+one\n+two')
  })

  test('makes paths relative to the session folder on any platform', () => {
    expect(relativePath('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    expect(relativePath('C:\\Code\\Repo\\src\\a.ts', 'c:\\code\\repo')).toBe('src/a.ts')
    expect(relativePath('/other/a.ts', '/repo')).toBe('/other/a.ts')
  })

  test('formats durations', () => {
    expect(formatDuration(41_200)).toBe('41s')
    expect(formatDuration(72_000)).toBe('1m 12s')
    expect(formatDuration(120_000)).toBe('2m')
    expect(formatDuration(3_900_000)).toBe('1h 5m')
  })

  test('shows cost and rate-limit usage together', () => {
    const limits = [{ kind: 'five_hour', percentUsed: 80 }, { kind: 'seven_day', percentUsed: 12.5 }]
    expect(usageParts(0.42, limits)).toEqual([
      { text: '$0.42', level: 'ok' },
      { text: '5h 80%', level: 'low' },
      { text: '7d 12.5%', level: 'ok' },
    ])
    expect(usageParts(null, [])).toEqual([])
  })

  test('combines the MCP context slices into one', () => {
    const slices = [
      { name: 'MCP tools', tokens: 3000, color: 'cyan' },
      { name: 'Messages', tokens: 9000, color: 'purple' },
      { name: 'MCP server instructions', tokens: 500, color: 'blue' },
    ]
    expect(mergeSlices(slices)).toEqual([
      { name: 'MCP', tokens: 3500, color: 'cyan' },
      { name: 'Messages', tokens: 9000, color: 'purple' },
    ])
  })

  test('warns as a usage limit runs out', () => {
    expect(limitLevel(75)).toBe('ok')
    expect(limitLevel(75.1)).toBe('low')
    expect(limitLevel(90)).toBe('low')
    expect(limitLevel(90.1)).toBe('critical')
  })

  test('describes a turn', () => {
    const finishedAt = new Date(2026, 9, 15, 9, 5).getTime()
    const summary = { finishedAt, durationMs: 72_000, changed: 3, added: 40, removed: 2, isAborted: false }
    expect(turnParts(summary)).toEqual(['09:05', 'Worked for 1m 12s', '3 file changes'])
    expect(turnParts({ ...summary, changed: 0 })[2]).toBe('no changes')
  })

  test('matches a turn row by its duration', () => {
    const list = [
      { finishedAt: 0, durationMs: 41_000, changed: 0, added: 0, removed: 0, isAborted: false },
      { finishedAt: 0, durationMs: 72_000, changed: 3, added: 9, removed: 1, isAborted: false },
    ]
    expect(matchTurn(list, 72_300)?.changed).toBe(3)
    expect(matchTurn(list, 10_000)).toBeUndefined()
  })

  test('summarises a group by its latest distinct tools', () => {
    const calls = ['Read', 'Grep', 'Read', 'Bash', 'mcp__github__search_code', 'Bash'].map(tool => ({ tool }))
    expect(groupSummary(calls)).toEqual({ title: '6 commands', detail: 'read · search_code · bash +1' })
    expect(groupSummary(['Glob', 'Read', 'Grep', 'Bash', 'Read'].map(tool => ({ tool }))).detail).toBe('grep · bash · read +1')
    expect(groupSummary([{ tool: 'Read' }])).toEqual({ title: '1 command', detail: 'read' })
  })

  test('labels the spinner by loop', () => {
    const label = spinnerLabel('Bash', { command: 'npm test -- rateLimit' }, '/repo')
    expect(label).toBe('Running npm test -- rateLimit')
    let state = withLabel({ labels: {}, agentIds: [] }, 'main', label)
    state = withLabel(state, 'agent-1', null)
    expect(labelFor(state, 'main')).toBe(label)
    expect(labelFor(state, 'agent-1')).toBeUndefined()
    expect(labelFor(withLabel(state, 'main', null), 'main')).toBeUndefined()
  })

  test('adds context to commands that use changed files', () => {
    const list = [{ path: 'test/rateLimit.test.ts', isNew: true, added: 52, removed: 0, patch: '' }]
    expect(noticeFor('npm test -- rateLimit.test.ts', list)).toBe('Uses test/rateLimit.test.ts, which Claude created this session.')
    expect(noticeFor('ls', list)).toBeNull()
  })
})

describe('session pane', () => {
  test('lists an edited file and shows its diff on press', async ($, on) => {
    on('tool.call', { tool: 'Edit' }, () => ({ result: EDIT_RESULT }))
    await $.tool.call({ tool: 'Edit', file_path: EDIT_RESULT.filePath, old_string: 'a', new_string: 'b' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: PANE_PROPS })
      const key = `file:${EDIT_RESULT.filePath}`
      expect(await ui.find({ type: 'Button', key })).toBeDefined()
      expect(await ui.find({ type: 'Code' })).toBeUndefined()
      await ui.press({ key })
      expect(await ui.find({ type: 'Code' })).toBeDefined()
      await ui.press({ key })
    }
  })
})

describe('transcript rows', () => {
  test('folds an edit row to one line with its counts', async $ => {
    const props = {
      tool_use_id: 'toolu_1',
      tool: 'Edit',
      input: { file_path: EDIT_RESULT.filePath },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: EDIT_RESULT,
    }
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'ToolUse', requestId: 'toolu_1', props })
      const head = await ui.find({ type: 'Button', key: 'fold' })
      expect(head?.text).toMatch(/Edited \/repo\/src\/routes\/upload\.ts/)
      expect(head?.text).toMatch(/\+2/)
    }
  })

  test('folds a group of reads to one line', async $ => {
    const props = {
      calls: [
        { tool_use_id: 'toolu_2', tool: 'Read', input: { file_path: '/repo/a.ts' }, isRunning: false, isErrored: false, isInterrupted: false },
        { tool_use_id: 'toolu_3', tool: 'Grep', input: { pattern: 'x' }, isRunning: false, isErrored: false, isInterrupted: false },
      ],
      isActive: false,
      isExpanded: false,
    }
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'ToolGroup', props })
      expect((await ui.find({ type: 'Button', key: 'fold' }))?.text).toMatch(/2 commands +read · grep/)
    }
  })

  test('replaces the turn duration line with a summary', async ($, on) => {
    mock.clock(on, { now: new Date(2026, 9, 15, 14, 30).getTime() })
    on('turn.complete', () => ({ text: '' }))
    await $.turn.complete({ answer: 'done', durationMs: 41_000, isAborted: false, turnId: 'turn-1', reason: 'answer' })

    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs: 41_000 } })
    expect(await ui.find({ type: 'Text', text: '14:30' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Worked for 41s' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'no changes' })).toBeDefined()
  })
})
