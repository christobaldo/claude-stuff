import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'session-monitor',
  component: 'Pane',
  requestId: 'session-monitor',
  props: {
    title: 'Session Monitor',
    isFocused: false,
    bodyColumns: 160,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const DONE = { durationMs: 0, isAborted: false, reason: 'answer' } as const

type Engine = Parameters<TestBody>[0]

// The engine beneath the plugin: each tool call takes as long as its waits say.
const engine = (
  on: On,
  percents = { fiveHour: 30, week: 60 },
  now = Date.UTC(2026, 10, 2, 9, 0, 0),
  stored: Record<string, unknown> = {},
) => {
  const clock = mock.clock(on, { now })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: percents.fiveHour, resetsAt: '2026-11-02T14:00:00Z' },
        { kind: 'seven_day', percentUsed: percents.week, resetsAt: '2026-11-05T08:00:00Z' },
      ],
    },
  }))
  mock.store(on, stored)
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // Stands for the engine's reply row: it draws the text it is handed.
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.text}</Text>
  })
  return clock
}

// The person typing `/<command> <args>`.
const run = ($: Engine, args: string, command = 'session-monitor') =>
  $.command.run({ command, args } as Parameters<Engine['command']['run']>[0]) as Promise<{ text?: string }>

// A prompt answered at once.
const turn = async ($: Engine, id: string) => {
  await $.turn.start({ text: id, turnId: id })
  await $.turn.complete({ ...DONE, answer: `Answer ${id}.`, turnId: id })
}

// The reply row as the mod draws it.
const reply = async ($: Engine, text: string) => {
  const ui = await $.ui.mount({
    plugin: 'session-monitor', component: 'AssistantMessage', surface: 'desktop',
    props: { text, isFirstOfReply: true },
  })
  const drawn = (await ui.find({ type: 'Text' }))?.text ?? ''
  await ui.unmount()
  return drawn
}

// The pane's Texts in turn: each row's cells, the bars between the column
// groups, then what follows the row.
const pane = async ($: Engine, surface: 'desktop' | 'terminal' = 'desktop') => {
  const ui = await $.ui.mount({ ...PANE, surface })
  const texts = (await ui.findAll({ type: 'Text' })).map(cell => cell.text ?? '')
  const charts = (await ui.findAll({ type: 'Svg' })).length
  await ui.unmount()
  // The line under the Interactions title.
  const figures = texts[texts.indexOf('Interactions') + 1]
  return { texts, joined: texts.join('|'), charts, figures }
}

test('Claude\'s parts add up to its time, misc taking the rest', async ($, on) => {
  const percents = { fiveHour: 30, week: 60 }
  const clock = engine(on, percents)
  // One model request: 1s before the model answers, 3s of thinking, text
  // for 1.5s, then the stop with its usage.
  on('turn.step', async function* (_, e) {
    await clock.sleep(1000)
    yield { kind: 'thinking' as const, index: 0, text: 'hmm' }
    await clock.sleep(3000)
    yield { kind: 'text' as const, index: 1, text: 'ok' }
    await clock.sleep(1500)
    const usage = {
      model: 'opus', input_tokens: 500, output_tokens: 1500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500,
    }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  on('tool.call', async (_, e) => {
    await clock.sleep(e.tool === 'AskUserQuestion' ? 4000 : e.tool === 'Agent' ? 3000 : 2000)
    return { result: {} }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'first', turnId: 't1' })
  await clock.advance(1000)
  await $.turn.complete({ ...DONE, answer: 'First answer.', turnId: 't1' })

  // The person takes 30s, then a turn with a step, a tool, a subagent and a question.
  await clock.advance(30_000)
  await $.turn.start({ text: 'second', turnId: 't2' })
  const step = (async () => {
    for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'opus', messageCount: 3 })) {
      // drained
    }
  })()
  await clock.advance(5500)
  await step
  for (const [tool, ms] of [['Bash', 2000], ['Agent', 3000], ['AskUserQuestion', 4000]] as const) {
    const call = $.tool.call({ tool, command: 'ls', prompt: 'p', description: 'd', questions: [] } as never)
    await clock.advance(ms)
    await call
  }
  await clock.advance(500)
  percents.fiveHour = 30.8
  percents.week = 60.2
  await $.turn.complete({ ...DONE, answer: 'All done here.', turnId: 't2' })

  expect(await reply($, 'All done here.')).toMatch(
    /\n\n\*⏱ #2 · 09:00:31 → 09:00:46 · was idle 30\.0s · user answering 4\.0s · Claude 11\.0s — model wait 1\.0s · thinking 3\.0s · writing 1\.5s · tools 2\.0s \(2 calls\) · subagents 3\.0s · misc 0\.5s \(after last reply 0\.5s\) · 10k in \/ 1\.5k out\* · 🟢 \*\*5h \+0\.8% \(30\.8%\)\*\* · 🟡 \*\*week \+0\.2% \(60\.2%\)\*\*$/,
  )

  const { texts, joined, charts } = await pane($)
  // Each quota window titled with its start, its reset and the fastest pace
  // that lasts to it; then the interactions.
  expect(texts[0]).toBe('5h quota')
  expect(texts[1]).toMatch(/^started \d\d:00 · resets \d\d:00 · max pace left 13\.9%\/h$/)
  expect(texts[2]).toBe('Weekly quota')
  expect(texts[3]).toMatch(/^started Thu 29 Oct \d\d:00 · resets Thu 05 Nov \d\d:00 · max pace left 0\.\d+%\/h$/)
  expect(texts.slice(4, 7)).toEqual([
    'Interactions',
    '1 day · 2 interactions · 2 interactions per day · average Claude 6.0s · efficiency 26% · 90% cached',
    'This session history',
  ])
  // The header on two lines, so a column is no wider than its words.
  expect(joined).toContain(
    '||||Was|User|│||Model||||||│||||5h|Week|│|#|Start||End|idle|answering|│|Claude|wait|Thinking|Writing|Tools|Subagents|Misc|│|Calls|In|Out|quota|quota|│',
  )
  // Today's summary: shares are of Claude's time; efficiency is Claude's 12s
  // over 16s of wall time and 30s idle.
  expect(joined).toContain(
    '|Mon 02 Nov|||30.0s|4.0s|│|12.0s|1.0s (8%)|3.0s (25%)|1.5s (13%)|2.0s (17%)|3.0s (25%)|1.5s (13%)|│|2|10k|1.5k|||│|Mon 02 Nov 2026 · 2 interactions · efficiency 26% · 90% cached',
  )
  expect(joined).toContain(
    '2|09:00:31|→|09:00:46|30.0s|4.0s|│|11.0s|1.0s|3.0s|1.5s|2.0s|3.0s|0.5s|│|2|10k|1.5k|+0.8|+0.2|│|second',
  )
  expect(joined).toContain('1|09:00:00|→|09:00:01|-|-|│|1.0s|-|-|-|-|-|1.0s|│|-|-|-|+0|+0|│|first')
  // Efficiency and Claude's parts, then three gauges for each quota window.
  expect(charts).toBe(8)

  // The terminal has no charts: the quota as words, then the same table.
  const terminal = await pane($, 'terminal')
  expect(terminal.charts).toBe(0)
  expect(terminal.joined).toMatch(/\|5h quota 30\.8% \(resets \d\d:00\)\|Weekly quota\|[^|]*\|Weekly quota 60\.2% \(resets Thu \d\d:00\) · pace so far: out Thu \d\d:09\|Interactions\|[^|]*\|This session history\|/)
  expect(terminal.joined).toContain('|Mon 02 Nov|||30.0s|4.0s|│|12.0s|')
})

test('experiment: misc split into permission, between and after, the rest other', async ($, on) => {
  const clock = engine(on)
  // The permission decision takes 1.5s, the tool 2s.
  on('tool.check', async () => {
    await clock.sleep(1500)
    return { decision: 'allow' as const }
  })
  on('tool.call', async () => {
    await clock.sleep(2000)
    return { result: {} }
  })
  on('turn.step', async function* (_, e) {
    await clock.sleep(1000)
    yield { kind: 'stop' as const, stopReason: 'tool_use' as const, usage: null }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: null }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // The charts' descriptions, drawn mid-turn.
  const alts = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const found = (await ui.findAll({ type: 'Svg' })).map(svg => String(svg.props.alt))
    await ui.unmount()
    return found.join('\n')
  }
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(700)
  // Before the first step, the stretch so far is misc's other.
  expect(await alts()).toContain('Misc: other 0.7s')
  const step = (async () => {
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 })) {
      // drained
    }
  })()
  await clock.advance(1000)
  await step
  await clock.advance(200)
  // The engine decides the call, then runs it.
  const check = $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' } as never)
  await clock.advance(1500)
  await check
  const call = $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(1000)
  // 4.4s in, the charts drawn at 0.7s still stand; 5.8s in, they are drawn again.
  expect(await alts()).toContain("Claude's time 0.7s: Misc: other 0.7s")
  await clock.advance(1000)
  await call
  await clock.advance(400)
  // The tool's stretch so far is its own, not other's.
  expect(await alts()).toMatch(/Tools 2\.0s.*Misc: other 0\.7s/)
  await $.turn.complete({ ...DONE, answer: 'Went.', turnId: 't1' })

  expect(await reply($, 'Went.')).toMatch(
    /· Claude 5\.8s — model wait 1\.0s · tools 2\.0s \(1 calls\) · misc 2\.8s \(permission 1\.5s · between steps 0\.2s · after last reply 0\.4s · other 0\.7s\)\* · 🟢 \*\*5h /,
  )
})

test('a day runs from 05:00: idle across midnight counts, the next morning starts a day', async ($, on) => {
  const clock = engine(on, undefined, new Date(2026, 10, 1, 23, 59, 0).getTime())
  on('tool.call', async () => {
    await clock.sleep(2000)
    return { result: {} }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'late', turnId: 't1' })
  const call = $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(2000)
  await call
  await $.turn.complete({ ...DONE, answer: 'Good night.', turnId: 't1' })

  await clock.advance(31 * 60_000)
  await turn($, 'later')
  expect(await reply($, 'Answer later.')).toMatch(/\*⏱ #2 · 00:30:02 → 00:30:02 · was idle 31m 00s · Claude 0\.0s\* — 🟢 \*\*5h \+0% \(30%\)\*\* · 🟡 \*\*week \+0% \(60%\)\*\*$/)

  await clock.advance((4 * 60 + 40) * 60_000)
  await turn($, 'early')
  expect(await reply($, 'Answer early.')).toMatch(
    /\*⏱ #1 · 05:10:02 → 05:10:02 · Claude 0\.0s\* — 🟢 \*\*5h \+0% \(30%\)\*\* · 🟡 \*\*week \+0% \(60%\)\*\*\n\n\*📅 Sun 01 Nov 2026: 2 interactions · was idle 31m 00s · Claude 2\.0s · efficiency 0% — tools 2\.0s \(100%\) \(1 calls\)\*$/,
  )

  // Today with its interaction, then the day before as one summary line.
  const { joined } = await pane($)
  expect(joined).toMatch(/\|Mon 02 Nov 2026 · 1 interaction\|1\|05:10:02\|→\|05:10:02\|.*\|early\|\|Sun 01 Nov\|\|\|31m 00s\|-\|│\|2\.0s\|.*\|Sun 01 Nov 2026 · 2 interactions · efficiency 0%$/)
  expect(joined).not.toContain('00:30:02|→|00:30:02')
})

test('pause, stopday and startday steer idle and the days', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  await clock.advance(60_000)
  expect((await run($, 'pause')).text).toBe("Paused at 09:01; idle isn't counted until your next prompt.")
  await clock.advance(620_000)
  // A prompt ends the break by itself: the minute before it counts.
  await turn($, 't2')
  expect(await reply($, 'Answer t2.')).toMatch(/\*⏱ #2 · 09:11:20 → 09:11:20 · was idle 1m 00s · /)

  await clock.advance(30_000)
  await run($, 'pause')
  await clock.advance(300_000)
  await turn($, 't3')
  expect(await reply($, 'Answer t3.')).toMatch(/\*⏱ #3 · 09:16:50 → 09:16:50 · was idle 30\.0s · /)

  expect((await run($, 'stopday')).text).toBe(
    "Stopped Mon 02 Nov 2026: 3 interactions, efficiency 0%. Idle isn't counted until startday or 05:00.",
  )
  await clock.advance(3_600_000)
  await turn($, 't4')
  expect(await reply($, 'Answer t4.')).toMatch(/\*⏱ #4 · 10:16:50 → 10:16:50 · Claude 0\.0s/)

  expect((await run($, 'startday')).text).toBe('Started Mon 02 Nov 2026 from 10:16; idle is measured from now.')
  await clock.advance(15_000)
  await turn($, 't5')
  expect(await reply($, 'Answer t5.')).toMatch(/\*⏱ #1 · 10:17:05 → 10:17:05 · was idle 15\.0s · /)

  const { joined } = await pane($)
  expect(joined).toContain('|Mon 02 Nov 2026 from 10:16 · 1 interaction')
  expect(joined).toMatch(/\|Mon 02 Nov 2026 · 4 interactions · efficiency 0% · stopped 09:16$/)
})

test('reset wipes everything; help lists the arguments', async ($, on) => {
  engine(on, undefined, undefined, {
    sessions: [{
      sessionId: 'earlier', startedAt: 0, lastAt: 0, turns: 3, wallMs: 9000, modelWaitMs: 0, thinkingMs: 0, writingMs: 0,
      toolMs: 0, subagentMs: 0, answeringMs: 0, toolCalls: 0, idleMs: 0, permissionMs: 0, betweenMs: 0,
      afterMs: 0, inTokens: 0, outTokens: 0, cachedTokens: 0,
    }],
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  await turn($, 't2')
  expect((await pane($)).joined).toContain('|Earlier sessions|')

  expect((await run($, 'reset')).text).toBe('Cleared 2 interactions and 1 earlier session.')
  const cleared = await pane($)
  expect(cleared.figures).toBe("Nothing logged yet: the charts fill in as each of Claude's answers ends.")
  // The charts show from the start, every slice at 0s, the quota gauges after them.
  expect(cleared.charts).toBe(8)
  expect(cleared.joined).not.toContain('Earlier sessions')
  await turn($, 't3')
  expect(await reply($, 'Answer t3.')).toMatch(/\*⏱ #1 · /)

  const help = (await run($, 'help')).text ?? ''
  for (const word of ['startday:', 'stopday:', 'pause:', 'reset:', 'version:', 'help:']) expect(help).toContain(word)
  expect(help).not.toContain('resume')
  expect((await run($, 'version')).text).toMatch(/^Session Monitor (\d+\.\d+\.\d+|\(version unknown\))$/)
  expect((await run($, 'nonsense')).text).toMatch(/^Unknown argument "nonsense"\./)
})

test('demo adds two made-up earlier days, demo off removes them', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  expect((await run($, 'demo')).text).toBe(
    'Added Sat 31 Oct 2026 (demo) and Sun 01 Nov 2026 (demo); /session-monitor demo off removes them.',
  )
  const shown = await pane($)
  expect(shown.figures).toMatch(/^3 days · 28 interactions · 9\.3 interactions per day · /)
  // Today first, then the made-up days, newest first, one line each.
  expect(shown.joined).toMatch(/Mon 02 Nov 2026 · 1 interaction\|.*\|Sun 01 Nov 2026 \(demo\) · 18 interactions.*\|Sat 31 Oct 2026 \(demo\) · 9 interactions/)
  expect((await run($, 'demo off')).text).toBe('Removed 2 demo days.')
  expect((await pane($)).joined).not.toContain('(demo)')
})

test('a resumed session gets its days back from the store', async ($, on) => {
  const day = {
    id: 1, date: '2026-11-02', startedAt: 1, manual: false, started: 4, firstStart: 1, lastEnd: 2, stoppedAt: null,
    turns: 4, wallMs: 60_000, modelWaitMs: 0, thinkingMs: 0, writingMs: 0, toolMs: 0, subagentMs: 0, answeringMs: 0,
    toolCalls: 0, idleMs: 0, inTokens: 0, outTokens: 0, cachedTokens: 0,
  }
  engine(on, undefined, undefined, {
    'session:session-1': { v: 1, interactions: [], days: [day], clock: { mode: 'active', idleFrom: null, banked: 0 }, lines: [] },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await pane($)).figures).toMatch(/^1 day · 4 interactions · /)
  await turn($, 't5')
  expect(await reply($, 'Answer t5.')).toMatch(/\*⏱ #5 · /)
})

test('the command takes the name the settings give it', { options: { commandName: 'cbo-session-monitor' } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await run($, 'help', 'cbo-session-monitor')).text).toContain('/cbo-session-monitor startday:')
})

test('newest on top, at most 100 interactions', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 105; i++) {
    await $.turn.start({ text: `turn ${i}`, turnId: `t${i}` })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.turn.complete({ ...DONE, answer: '', turnId: `t${i}` })
  }

  const { texts } = await pane($)
  // Seven titles and figures, the header's two rows of 21 and a blank line, today's 22, then
  // 100 rows of 22.
  expect(texts.length).toBe(7 + 42 + 1 + 22 + 100 * 22)
  expect(texts[50 + 21]).toBe('Mon 02 Nov 2026 · 105 interactions')
  expect(texts[72]).toBe('105')
  expect(texts[72 + 21]).toBe('turn 104')
  expect(texts.at(-1)).toBe('turn 5')
})

test('the quota forecast: the average pace since the window began, the recent pace from the readings', async ($, on) => {
  // 12:30, 3h 30m into the 5-hour window that resets at 14:00; the last
  // hour's reading stood at 32%.
  const now = Date.UTC(2026, 10, 2, 12, 30, 0)
  engine(on, { fiveHour: 62, week: 30 }, now, { readings: [{ at: now - 3_600_000, fiveHour: 32, week: 29.5 }] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const alts = (await ui.findAll({ type: 'Svg' })).map(svg => String(svg.props.alt))
  const texts = (await ui.findAll({ type: 'Text' })).map(cell => cell.text ?? '')
  await ui.unmount()
  // 38% left over 1h 30m.
  expect(texts).toContainEqual(expect.stringMatching(/^started \d\d:00 · resets \d\d:00 · max pace left 25\.3%\/h$/))
  expect(alts).toContain('5h quota 62% used')
  // 62% over 3h 30m is 17.7%/h: 89% at the reset, amber.
  expect(alts).toContainEqual(expect.stringMatching(/^5h quota At reset, pace so far: 89% \(17\.7%\/h since \d\d:00\)$/))
  // 30 points in the last hour: 100% within 1h 16m, before the reset.
  expect(alts).toContainEqual(expect.stringMatching(/^5h quota At reset, last hour's pace: out \d\d:46 \(30%\/h over the last hour\)$/))
  // The week has an hour of readings, short of 4: the pace so far stands in.
  expect(alts).toContainEqual(expect.stringMatching(/^Weekly quota At reset, last day's pace: \d+% \(Measuring recent pace\)$/))

  const terminal = await pane($, 'terminal')
  expect(terminal.joined).toMatch(/5h quota 62% \(resets \d\d:00\) · pace so far: 89% at reset · last hour's pace: out \d\d:46/)
})

test('a subagent in the background counts its whole run and tokens, after its interaction ended', async ($, on) => {
  const clock = engine(on)
  on('turn.step', async function* (_, e) {
    const usage = { model: 'haiku', input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'launch it', turnId: 't1' })
  // Launched in the background: it starts, the main turn ends a second later.
  await $.turn.start({ text: 'count', turnId: 's1', agentId: 'a1' } as never)
  await clock.advance(1000)
  await $.turn.complete({ ...DONE, answer: 'Launched.', turnId: 't1' })
  await clock.advance(6000)
  for await (const _ of $.turn.step({ turnId: 's1', index: 0, model: 'haiku', messageCount: 1, agentId: 'a1' } as never)) {
    // drained
  }
  await $.turn.complete({ ...DONE, answer: '21', turnId: 's1', agentId: 'a1' } as never)

  const { joined } = await pane($)
  // 7s of subagent beside 1s of Claude, and the subagent's 1.2k tokens.
  expect(joined).toMatch(/\|1\|\d\d:\d\d:\d\d\|→\|\d\d:\d\d:\d\d\|-\|-\|│\|1\.0s\|-\|-\|-\|-\|7\.0s\|-\|│\|-\|1\.0k\|200\|/)
})
