import { describe, expect, mock, test } from 'claude-code/testing'

import {
  afterAppend,
  bashEditTitle,
  bashEdits,
  countChange,
  countInRun,
  fitLabel,
  formatDuration,
  groupSummary,
  joinRun,
  labelFor,
  matchTurn,
  noticeFor,
  patchText,
  relativePath,
  runOf,
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

const BASH_OUTPUT = {
  stdout: '',
  stderr: '',
  interrupted: false,
  bashEditDiff: {
    files: [
      { filePath: '/repo/x.txt', hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-b', '+B'] }] },
      { filePath: '/repo/n.txt', created: true as const, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] }] },
    ],
    moreFiles: 0,
  },
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

  test('fits the spinner label to the window width', () => {
    const label = `Running ${'x'.repeat(200)}`
    expect(fitLabel(label, 120)).toHaveLength(70)
    expect(fitLabel(label, 120).endsWith('…')).toBe(true)
    expect(fitLabel(label, 30)).toHaveLength(20)
    expect(fitLabel('Running ls', 120)).toBe('Running ls')
    expect(fitLabel(label, undefined)).toBe(label)
  })

  test('runs consecutive edits of one file until another row draws', () => {
    const files = new Set(['Edit', 'Write'])
    let state = joinRun({ path: null, runs: [] }, 'a', 'src/x.ts')
    state = countInRun(state, 'a', { added: 2, removed: 1 })
    state = afterAppend(state, [{ type: 'tool_result', tool_use_id: 'a' }], files)
    state = afterAppend(state, [{ type: 'thinking' }, { type: 'tool_use', name: 'Edit' }], files)
    state = countInRun(joinRun(state, 'b', 'src/x.ts'), 'b', { added: 3, removed: 0 })
    expect(runOf(state, 'b')).toEqual({ ids: ['a', 'b'], added: 5, removed: 1 })

    expect(runOf(joinRun(state, 'c', 'src/y.ts'), 'c')?.ids).toEqual(['c'])
    const afterText = afterAppend(state, [{ type: 'text', text: 'Next.' }], files)
    expect(runOf(joinRun(afterText, 'c', 'src/x.ts'), 'c')?.ids).toEqual(['c'])
    const afterError = afterAppend(joinRun(state, 'c', 'src/x.ts'), [{ type: 'tool_result', tool_use_id: 'c', is_error: true }], files)
    expect(runOf(afterError, 'c')).toBeUndefined()
    expect(afterError.path).toBeNull()
  })

  test('titles a shell command by the files it changed', () => {
    const files = BASH_OUTPUT.bashEditDiff.files
    expect(bashEditTitle({ files, moreFiles: 0 }, '/repo')).toBe('Edited 2 files')
    expect(bashEditTitle({ files: files.slice(1), moreFiles: 0 }, '/repo')).toBe('Created n.txt')
    expect(bashEditTitle({ files: files.slice(1), moreFiles: 3 }, '/repo')).toBe('Edited 4 files')
  })

  test('reads a shell edit the engine lists by path alone', () => {
    const edits = bashEdits({ bashEditDiff: { files: [], moreFiles: 1, changedFiles: ['/repo/src/cli.ts'] } })
    expect(edits === null ? null : bashEditTitle(edits, '/repo')).toBe('Edited src/cli.ts')
    expect(bashEdits({ bashEditDiff: { files: [], moreFiles: 0, changedFiles: [] } })).toBeNull()
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

  test('heads the session section with the session title', async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    await $.classic.UserPromptSubmit({ prompt: 'hi', session_title: 'Fix the pane title' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'Fix the pane title' })).toBeDefined()
  })
})

describe('agent navigation', () => {
  test('switches the main view to a background agent and back', async ($, on) => {
    const agent = { id: 'agent-1', description: 'Scout the hooks', type: 'Explore', status: 'running' as const }
    const clock = mock.clock(on, { now: 0 })
    on('command.register', () => ({ value: { command: 'dock' } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    for (const name of ['session.usage', 'session.model', 'process.run', 'ui.panes', 'ui.open'] as const) on(name, () => ({ deny: 'not in this test' }))
    on('agent.list', () => ({ value: [agent] }))
    const views: unknown[] = []
    on('ui.view', ($, e) => {
      views.push({ ...e })
      return { value: {} }
    })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()

    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    await ui.press({ key: 'agent:agent-1' })
    await ui.press({ key: 'agent:main' })
    expect(views).toEqual([{ agentId: 'agent-1' }, {}])
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

  test('folds consecutive edits of one file into the first row in fullscreen', async ($, on) => {
    on('tool.call', { tool: 'Edit' }, () => ({ result: EDIT_RESULT }))
    for (const id of ['toolu_a', 'toolu_b']) {
      await $.tool.call({ tool: 'Edit', tool_use_id: id, file_path: EDIT_RESULT.filePath, old_string: 'a', new_string: 'b' })
    }
    const rowProps = (id: string) => ({
      tool_use_id: id,
      tool: 'Edit',
      input: { file_path: EDIT_RESULT.filePath },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: EDIT_RESULT,
    })
    const mount = (id: string, isFullscreen: boolean) =>
      $.ui.mount({
        plugin: PLUGIN,
        surface: 'terminal',
        component: 'ToolUse',
        requestId: id,
        viewport: { columns: 120, rows: 40, isFullscreen },
        props: rowProps(id),
      })

    const head = await (await mount('toolu_a', true)).find({ type: 'Button', key: 'fold' })
    expect(head?.text).toMatch(/×2/)
    expect(head?.text).toMatch(/\+4/)
    const hidden = await mount('toolu_b', true)
    expect(await hidden.find({ type: 'Button', key: 'fold' })).toBeUndefined()
    await hidden.unmount()
    expect((await (await mount('toolu_b', false)).find({ type: 'Button', key: 'fold' }))?.text).not.toMatch(/×/)
  })

  test('folds a shell command that edited files', async $ => {
    const props = {
      tool_use_id: 'toolu_9',
      tool: 'Bash',
      input: { command: "sed -i 's/b/B/' x.txt" },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: BASH_OUTPUT,
    }
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'ToolUse', requestId: 'toolu_9', props })
    const head = await ui.find({ type: 'Button', key: 'fold' })
    expect(head?.text).toMatch(/Edited 2 files/)
    expect(head?.text).toMatch(/\+2/)
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
