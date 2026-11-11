import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type {
  Clock,
  Day,
  Interaction,
  Quota,
  QuotaWindow,
  Reading,
  SessionSummary,
  Sums,
  StretchKey,
  Tally,
  TimedLine,
  Tokens,
} from '../types'

import { COLORS, donutOf, gaugeOf, MISC_SHADES, SIGNALS } from './charts'
import { outlookOf, signalOf } from './forecast'
import type { Forecast, WindowKind } from './forecast'

const PANE = 'session-monitor'
const DEFAULT_COMMAND = 'session-monitor'
const KEEP_INTERACTIONS = 100
const KEEP_SESSIONS = 50
const KEEP_LINES = 200
// While an interaction runs, the charts are drawn again at most this often:
// each new drawing reloads a chart's frame, which blanks it for a moment.
const CHARTS_EVERY_MS = 5000
const TAIL = 120
// A day runs from 05:00 to 05:00 local: a late night belongs to the day
// before.
const DAY_STARTS_HOUR = 5
// Tools whose call is the person answering, and tools that run a subagent.
const ASKS_THE_PERSON = new Set(['AskUserQuestion', 'ExitPlanMode'])
const RUNS_A_SUBAGENT = new Set(['Agent', 'Task'])
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// Dates are shown as `Mon 02 Nov`: no reader takes it for the 11th of February.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const NO_TOKENS: Tokens = { inTokens: 0, outTokens: 0, cachedTokens: 0 }

const NO_SUMS: Sums = {
  modelWaitMs: 0,
  thinkingMs: 0,
  writingMs: 0,
  toolMs: 0,
  subagentMs: 0,
  answeringMs: 0,
  toolCalls: 0,
  idleMs: 0,
  permissionMs: 0,
  betweenMs: 0,
  afterMs: 0,
  ...NO_TOKENS,
}

const NO_TALLY: Tally = { turns: 0, wallMs: 0, ...NO_SUMS }

const NO_CLOCK: Clock = { mode: 'active', idleFrom: null, banked: 0 }

// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const interactions = atom({ plugin: 'session-monitor', key: 'interactions' } as const, [], { shape: 'interactions-1' })
const days = atom({ plugin: 'session-monitor', key: 'days' } as const, [], { shape: 'days-1' })
const clock = atom({ plugin: 'session-monitor', key: 'clock' } as const, NO_CLOCK, { shape: 'clock-1' })
const history = atom({ plugin: 'session-monitor', key: 'history' } as const, [])
const lines = atom({ plugin: 'session-monitor', key: 'lines' } as const, [], { shape: 'lines-2' })
// Whether the lines are drawn under replies; kept across sessions.
const chat = atom({ plugin: 'session-monitor', key: 'chat' } as const, true)
const quota = atom({ plugin: 'session-monitor', key: 'quota' } as const, {})
// The account's quota readings of the last 25 hours, at most one a minute,
// kept in the store too: every session reads the same account.
const readings = atom({ plugin: 'session-monitor', key: 'readings' } as const, [])
const KEEP_READINGS_MS = 25 * 3_600_000

// Claude's parts, in the order they are shown; misc is what they leave.
const PARTS = [
  { key: 'modelWaitMs', column: 'modelWait', name: 'model wait' },
  { key: 'thinkingMs', column: 'thinking', name: 'thinking' },
  { key: 'writingMs', column: 'writing', name: 'writing' },
  { key: 'toolMs', column: 'tools', name: 'tools' },
  { key: 'subagentMs', column: 'subagents', name: 'subagents' },
] as const

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const tailOf = (text: string) => text.trim().slice(-TAIL)

const pad = (n: number) => String(n).padStart(2, '0')

const clockOf = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const minuteOf = (ms: number) => clockOf(ms).slice(0, 5)

const calendarOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// The day a moment belongs to, `2026-11-02`, which 02:30 on the 3rd still is.
// Read on the local clock, so the night clocks change still turns at 05:00.
const dayOf = (ms: number) => {
  const d = new Date(ms)
  return d.getHours() >= DAY_STARTS_HOUR
    ? calendarOf(ms)
    : calendarOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12).getTime())
}

const weekdayOf = (date: string) => WEEKDAYS[new Date(`${date}T12:00:00`).getDay()] ?? ''

// Seconds are the smallest unit: 0.2s, 0.0s, then `1m 05s`, `1h 05m`.
const durationOf = (ms: number) => {
  if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`
}

const tokensOf = (n: number) => {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

const percentOf = (n: number) => `${Math.round(n * 10) / 10}%`

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

// `17:00` for the 5-hour window, `Thu 09:00` for the week.
const momentOf = (ms: number, withDay: boolean) => {
  const d = new Date(ms)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return withDay ? `${WEEKDAYS[d.getDay()]} ${time}` : time
}

// `Thu 29 Oct 21:20`: a week's start and reset share the weekday.
const datedOf = (ms: number) => {
  const d = new Date(ms)
  return `${WEEKDAYS[d.getDay()]} ${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const resetAtOf = (window: QuotaWindow, withDay: boolean) => {
  const ms = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt)
  return Number.isNaN(ms) ? '' : momentOf(ms, withDay)
}

// `17.7%/h`, `0.42%/h` below a tenth.
const paceOf = (pace: number) => `${pace < 0.1 ? pace.toFixed(2) : Math.round(pace * 10) / 10}%/h`

const quotaOf = (limits: readonly SessionRateLimit[]): Quota => {
  const windowOf = (kind: string): QuotaWindow | undefined => {
    const limit = limits.find(one => one.kind === kind)
    return limit === undefined ? undefined : { percent: limit.percentUsed, resetsAt: limit.resetsAt }
  }
  return { fiveHour: windowOf('five_hour'), week: windowOf('seven_day') }
}

// Holds a quota reading: as the one shown, and among those the recent pace is
// measured on, one a minute (a later one within the minute replaces it).
const holdQuota = async ($: EngineInterface, held: Quota) => {
  await update($, quota, () => held)
  if (held.fiveHour === undefined && held.week === undefined) return
  const now = await $.clock.now()
  const reading: Reading = { at: now, fiveHour: held.fiveHour?.percent, week: held.week?.percent }
  const kept = (await read($, readings)).filter(one => now - one.at <= KEEP_READINGS_MS)
  const last = kept.at(-1)
  const next = last !== undefined && now - last.at < 60_000 ? [...kept.slice(0, -1), { ...reading, at: last.at }] : [...kept, reading]
  await update($, readings, () => next)
  await $.store.set('readings', next)
}

const readQuota = async ($: EngineInterface) => {
  const now = quotaOf((await $.session.usage()).rateLimits)
  await holdQuota($, now)
  return now
}

// What one interaction moved a window, and where it stands; a window reset
// during the turn has no move, only where it stands.
const movedOf = (start?: QuotaWindow, end?: QuotaWindow) => {
  if (end === undefined) return undefined
  const moved = start === undefined || end.percent < start.percent ? null : end.percent - start.percent
  return { moved, at: end.percent }
}

const plus = <T extends Sums>(one: T, more: Sums): T => ({
  ...one,
  modelWaitMs: one.modelWaitMs + more.modelWaitMs,
  thinkingMs: one.thinkingMs + more.thinkingMs,
  writingMs: one.writingMs + more.writingMs,
  toolMs: one.toolMs + more.toolMs,
  subagentMs: one.subagentMs + more.subagentMs,
  answeringMs: one.answeringMs + more.answeringMs,
  toolCalls: one.toolCalls + more.toolCalls,
  idleMs: one.idleMs + more.idleMs,
  permissionMs: one.permissionMs + more.permissionMs,
  betweenMs: one.betweenMs + more.betweenMs,
  afterMs: one.afterMs + more.afterMs,
  inTokens: one.inTokens + more.inTokens,
  outTokens: one.outTokens + more.outTokens,
  cachedTokens: one.cachedTokens + more.cachedTokens,
})

const tallyPlus = <T extends Tally>(one: T, more: Tally): T => ({
  ...plus(one, more),
  turns: one.turns + more.turns,
  wallMs: one.wallMs + more.wallMs,
})

// Claude's time: the wall time less the person's answering.
const claudeOf = (sums: Sums, wallMs: number) => Math.max(0, wallMs - sums.answeringMs)

const miscOf = (sums: Sums, wallMs: number) =>
  Math.max(0, claudeOf(sums, wallMs) - PARTS.reduce((ms, part) => ms + sums[part.key], 0))

// Claude's time over the person's whole time: Claude's, answering and idle.
const efficiencyOf = (tally: Tally) =>
  tally.wallMs + tally.idleMs > 0
    ? Math.round((claudeOf(tally, tally.wallMs) / (tally.wallMs + tally.idleMs)) * 100)
    : null

const shareOf = (ms: number, of: number) => (ms > 0 && of > 0 ? ` (${Math.round((ms / of) * 100)}%)` : '')

const cachedOf = (tokens: Tokens) =>
  tokens.inTokens > 0 ? `${Math.round((tokens.cachedTokens / tokens.inTokens) * 100)}% cached` : ''

// Experiment: what misc holds, as measured; `other` is what is left of it.
const MISC_PARTS = [
  { key: 'permissionMs', name: 'permission' },
  { key: 'betweenMs', name: 'between steps' },
  { key: 'afterMs', name: 'after last reply' },
] as const

const miscPartsOf = (sums: Sums, wallMs: number) => {
  const misc = miscOf(sums, wallMs)
  const parts: { name: string; ms: number }[] = MISC_PARTS.map(part => ({ name: part.name, ms: sums[part.key] }))
  parts.push({ name: 'other', ms: Math.max(0, misc - parts.reduce((ms, part) => ms + part.ms, 0)) })
  return parts.filter(part => part.ms >= 50)
}

// The chat's words for Claude's parts: `model wait 1.0s · … · misc 0.5s`,
// each with its share of Claude's time where `withShares`.
const partsOf = (sums: Sums, wallMs: number, withShares = false) => {
  const claude = claudeOf(sums, wallMs)
  const share = (ms: number) => (withShares ? shareOf(ms, claude) : '')
  const parts: string[] = []
  for (const part of PARTS) {
    const ms = sums[part.key]
    if (ms <= 0 && !(part.key === 'toolMs' && sums.toolCalls > 0)) continue
    parts.push(`${part.name} ${durationOf(ms)}${share(ms)}${part.key === 'toolMs' ? ` (${sums.toolCalls} calls)` : ''}`)
  }
  const misc = miscOf(sums, wallMs)
  if (misc >= 50) {
    const inside = miscPartsOf(sums, wallMs).map(part => `${part.name} ${durationOf(part.ms)}`)
    parts.push(`misc ${durationOf(misc)}${share(misc)}${inside.length === 0 ? '' : ` (${inside.join(' · ')})`}`)
  }
  if (sums.inTokens + sums.outTokens > 0) parts.push(`${tokensOf(sums.inTokens)} in / ${tokensOf(sums.outTokens)} out`)
  return parts.join(' · ')
}

// The person's time, then Claude's: `was idle 30.0s · user answering 4.0s · Claude 8.0s`.
const personAndClaudeOf = (sums: Sums, wallMs: number) =>
  [
    sums.idleMs > 0 ? `was idle ${durationOf(sums.idleMs)}` : '',
    sums.answeringMs > 0 ? `user answering ${durationOf(sums.answeringMs)}` : '',
    `Claude ${durationOf(claudeOf(sums, wallMs))}`,
  ]
    .filter(part => part !== '')
    .join(' · ')

// The line under a reply, in Markdown, each quota in bold after a dot in its gauge's colour:
// `*⏱ #3 · 09:00:31 → 09:00:43 · was idle 30.0s · … · Claude 8.0s — model wait 1.0s · …* · 🟢 **5h +0.8% (30.8%)** · …`.
const lineOf = (one: Interaction, end: number) => {
  const wall = end - one.start
  const parts = partsOf(one, wall)
  const quotas: string[] = []
  for (const [name, window] of [
    ['5h', movedOf(one.quotaStart.fiveHour, one.quotaEnd?.fiveHour)],
    ['week', movedOf(one.quotaStart.week, one.quotaEnd?.week)],
  ] as const) {
    if (window === undefined) continue
    // A dot in the gauge's colour: Markdown has bold, but no colour.
    const dot = window.at < 50 ? '🟢' : window.at < 80 ? '🟡' : '🔴'
    const text = window.moved === null ? `${name} ${percentOf(window.at)}` : `${name} +${percentOf(window.moved)} (${percentOf(window.at)})`
    quotas.push(`${dot} **${text}**`)
  }
  const lead = `⏱ #${one.n} · ${clockOf(one.start)} → ${clockOf(end)} · ${personAndClaudeOf(one, wall)}`
  const text = `*${parts === '' ? lead : `${lead} — ${parts}`}*`
  return quotas.length === 0 ? text : `${text}${parts === '' ? ' — ' : ' · '}${quotas.join(' · ')}`
}

// `Sun 01 Nov`, for a summary row's Start, from `2026-11-01`.
const shortDateOf = (date: string) => `${weekdayOf(date)} ${date.slice(8, 10)} ${MONTHS[Number(date.slice(5, 7)) - 1] ?? ''}`

// `Sun 01 Nov 2026`.
const longDateOf = (date: string) => `${shortDateOf(date)} ${date.slice(0, 4)}`

const dayNameOf = (day: Day) =>
  `${longDateOf(day.date)}${day.manual ? ` from ${minuteOf(day.startedAt)}` : ''}${day.demo === true ? ' (demo)' : ''}`

// The finished day's line, in Markdown, under the first reply after it.
const dayLineOf = (day: Day) => {
  const efficiency = efficiencyOf(day)
  const parts = partsOf(day, day.wallMs, true)
  return (
    `*📅 ${dayNameOf(day)}: ${plural(day.turns, 'interaction')} · ${personAndClaudeOf(day, day.wallMs)}` +
    `${efficiency === null ? '' : ` · efficiency ${efficiency}%`}${parts === '' ? '' : ` — ${parts}`}*`
  )
}

// The table: the interaction and the person's time; Claude's time and its
// parts; then counts and quota.
type Column =
  | 'n' | 'start' | 'arrow' | 'end' | 'idle' | 'answering'
  | 'claude' | 'modelWait' | 'thinking' | 'writing' | 'tools' | 'subagents' | 'misc'
  | 'calls' | 'in' | 'out' | 'fiveHour' | 'week'
type Row = Partial<Record<Column, string>>
// Each header on two lines, so a column is no wider than its words.
const COLUMNS: Record<Column, [string, string]> = {
  n: ['', '#'],
  start: ['', 'Start'],
  arrow: ['', ''],
  end: ['', 'End'],
  idle: ['Was', 'idle'],
  answering: ['User', 'answering'],
  claude: ['', 'Claude'],
  modelWait: ['Model', 'wait'],
  thinking: ['', 'Thinking'],
  writing: ['', 'Writing'],
  tools: ['', 'Tools'],
  subagents: ['', 'Subagents'],
  misc: ['', 'Misc'],
  calls: ['', 'Calls'],
  in: ['', 'In'],
  out: ['', 'Out'],
  fiveHour: ['5h', 'quota'],
  week: ['Week', 'quota'],
}
const GROUPS: Column[][] = [
  ['n', 'start', 'arrow', 'end', 'idle', 'answering'],
  ['claude', 'modelWait', 'thinking', 'writing', 'tools', 'subagents', 'misc'],
  ['calls', 'in', 'out', 'fiveHour', 'week'],
]
// Each column's theme color: the person's time grey and red, Claude's orange.
const COLUMN_COLORS: Partial<Record<Column, string>> = { idle: 'inactive', answering: 'error' }
const GROUP_COLORS = [undefined, 'claude', undefined]

const timeOf = (ms: number) => (ms > 0 ? durationOf(ms) : '-')
const countOf = (n: number, of: (n: number) => string) => (n > 0 ? of(n) : '-')

const cellsOf = (sums: Sums, wallMs: number, withShares = false): Row => {
  const claude = claudeOf(sums, wallMs)
  const cell = (ms: number) => `${timeOf(ms)}${withShares ? shareOf(ms, claude) : ''}`
  const row: Row = {
    idle: timeOf(sums.idleMs),
    answering: timeOf(sums.answeringMs),
    claude: timeOf(claude),
    misc: cell(miscOf(sums, wallMs)),
    calls: countOf(sums.toolCalls, String),
    in: countOf(sums.inTokens, tokensOf),
    out: countOf(sums.outTokens, tokensOf),
  }
  for (const part of PARTS) row[part.column] = cell(sums[part.key])
  return row
}

// What the interaction moved a window; the gauges show where it stands.
const quotaCellOf = (window?: { moved: number | null; at: number }) =>
  window === undefined ? undefined : window.moved === null ? `${percentOf(window.at)}` : `+${percentOf(window.moved).slice(0, -1)}`

const rowOf = (one: Interaction, now: number): Row => {
  const end = one.end ?? now
  return {
    ...cellsOf(soFarOf(one, now), end - one.start),
    n: String(one.n),
    start: clockOf(one.start),
    arrow: '→',
    end: one.end === null ? 'running' : clockOf(end),
    fiveHour: quotaCellOf(movedOf(one.quotaStart.fiveHour, one.quotaEnd?.fiveHour)),
    week: quotaCellOf(movedOf(one.quotaStart.week, one.quotaEnd?.week)),
  }
}

// Adds a span's time or a request's tokens to the running interaction.
const add = async ($: EngineInterface, sums: Partial<Sums>) => {
  const more = { ...NO_SUMS, ...sums }
  await update($, interactions, list => {
    const at = list.findLastIndex(one => one.end === null)
    return at === -1 ? list : list.map((one, i) => (i === at ? plus(one, more) : one))
  })
}

// Subagents running, each with the interaction that launched it and when it
// began: one launched in the background outlives its Agent call, and often
// the interaction too.
const agents = new Map<string, { home: string; start: number }>()

// Adds to the interaction a subagent belongs to, finished or not, and to its
// day once it has finished.
const addTo = async ($: EngineInterface, agentId: string, sums: Partial<Sums>) => {
  const home = agents.get(agentId)?.home
  if (home === undefined) return add($, sums)
  const more = { ...NO_SUMS, ...sums }
  const one = (await read($, interactions)).find(each => each.id === home)
  if (one === undefined) return
  await update($, interactions, list => list.map(each => (each.id === home ? plus(each, more) : each)))
  if (one.end !== null) {
    await update($, days, all => all.map(day => (day.id === one.dayId ? plus(day, more) : day)))
    await saveSummary($)
  }
}

// The main loop's timeline: what is going on now. Each moment goes to one
// part, the first that holds: the person answering, a tool running, a
// subagent running, else the step's state. The counts are kept in the module;
// the stretch since the last change is kept in the running interaction, so
// that a drawing reads its parts and its stretch as one.
type Activity = 'answering' | 'tools' | 'subagents' | 'permission' | 'thinking' | 'writing' | 'modelWait'
type StepState = 'modelWait' | 'thinking' | 'writing' | null
const ACTIVITY_KEYS = {
  answering: 'answeringMs',
  tools: 'toolMs',
  subagents: 'subagentMs',
  permission: 'permissionMs',
  thinking: 'thinkingMs',
  writing: 'writingMs',
  modelWait: 'modelWaitMs',
} as const
const live = {
  step: null as StepState,
  tools: 0,
  agents: 0,
  asks: 0,
  // Experiment: tool calls being decided, and the steps begun this turn.
  checks: new Set<string>(),
  steps: 0,
}
const idleLive = () => ({ step: null, tools: 0, agents: 0, asks: 0, checks: new Set<string>(), steps: 0 })

const activityOf = (): Activity | null =>
  live.asks > 0
    ? 'answering'
    : live.tools > 0
      ? 'tools'
      : live.agents > 0
        ? 'subagents'
        : live.checks.size > 0
          ? 'permission'
          : live.step

// Where the stretch beginning now goes: to what is going on; a stretch nothing
// runs in goes, as an experiment, to between steps, or before the first step
// to none of them.
const stretchKeyOf = (): StretchKey | null => {
  const activity = activityOf()
  return activity !== null ? ACTIVITY_KEYS[activity] : live.steps === 0 ? null : 'betweenMs'
}

// Applies a change to the timeline: the running interaction's stretch goes to
// its part and a new one begins, in one write. At the turn's end a stretch
// between steps is the one after the last reply.
const change = async ($: EngineInterface, apply: () => void, atEnd = false) => {
  const now = await $.clock.now()
  apply()
  const key = stretchKeyOf()
  await update($, interactions, list => {
    const at = list.findLastIndex(one => one.end === null)
    return at === -1 ? list : list.map((one, i) => (i === at ? closeStretch(one, now, atEnd, key) : one))
  })
}

const closeStretch = (one: Interaction, now: number, atEnd: boolean, key: StretchKey | null): Interaction => {
  const ran = one.stretch === undefined ? one : soFarOf(one, now, atEnd)
  return { ...ran, stretch: { since: now, key } }
}

// A running interaction so far, its stretch given to its part: a drawing
// mid-turn adds up the way the finished turn will.
const soFarOf = (one: Interaction, now: number, atEnd = false): Interaction => {
  if (one.end !== null || one.stretch === undefined || one.stretch.key === null || now <= one.stretch.since) return one
  const key = atEnd && one.stretch.key === 'betweenMs' ? 'afterMs' : one.stretch.key
  return plus(one, { ...NO_SUMS, [key]: now - one.stretch.since })
}

// Every day's finished interactions plus the running one so far.
const grandOf = (list: readonly Interaction[], kept: readonly Day[], now: number): Tally => {
  let sum = kept.reduce((all, day) => tallyPlus(all, day), NO_TALLY)
  for (const one of list.filter(each => each.end === null)) {
    sum = tallyPlus(sum, { ...plus(NO_TALLY, soFarOf(one, now)), turns: 1, wallMs: now - one.start })
  }
  return sum
}

// A summary as a tally: what it holds less the session's own fields.
const tallyOf = ({ sessionId: _id, startedAt: _start, lastAt: _last, ...tally }: SessionSummary): Tally => tally

// The session's days live in the host's state, which ends with the process:
// a snapshot in the store, under the session's id, brings them back when the
// session is resumed after a restart.
const SNAPSHOT = 'session:'
type Snapshot = { v: 1; interactions: Interaction[]; days: Day[]; clock: Clock; lines: TimedLine[] }

const saveSnapshot = async ($: EngineInterface) => {
  const snapshot: Snapshot = {
    v: 1,
    interactions: [...(await read($, interactions))],
    days: [...(await read($, days))],
    clock: await read($, clock),
    lines: [...(await read($, lines))],
  }
  await $.store.set(`${SNAPSHOT}${await $.session.id()}`, snapshot)
}

const restoreSnapshot = async ($: EngineInterface) => {
  if ((await read($, days)).length > 0) return
  const stored = (await $.store.get(`${SNAPSHOT}${await $.session.id()}`)) as Snapshot | undefined
  if (stored === undefined || stored.v !== 1) return
  // A turn the restart cut short is left out.
  await update($, interactions, () => stored.interactions.filter(one => one.end !== null))
  await update($, days, () => stored.days)
  await update($, clock, () => stored.clock)
  await update($, lines, () => stored.lines)
}

// Two made-up days before the real ones, to show the multi-day view.
const demoDaysOf = (now: number): Day[] =>
  [
    { back: 2, turns: 9, wallMs: 21 * 60_000, idleMs: 95 * 60_000, answeringMs: 2 * 60_000 },
    { back: 1, turns: 18, wallMs: 42 * 60_000, idleMs: 70 * 60_000, answeringMs: 4 * 60_000 },
  ].map(({ back, turns, wallMs, idleMs, answeringMs }) => {
    const startedAt = now - back * 86_400_000
    const claude = wallMs - answeringMs
    return {
      ...newDay(startedAt, dayOf(startedAt), false),
      demo: true,
      turns,
      started: turns,
      wallMs,
      idleMs,
      answeringMs,
      modelWaitMs: Math.round(claude * 0.3),
      thinkingMs: Math.round(claude * 0.15),
      writingMs: Math.round(claude * 0.2),
      toolMs: Math.round(claude * 0.2),
      subagentMs: Math.round(claude * 0.05),
      // Misc, the 10% left, as the experiment splits it; the rest is other.
      betweenMs: Math.round(claude * 0.05),
      afterMs: Math.round(claude * 0.02),
      toolCalls: turns * 6,
      inTokens: turns * 250_000,
      outTokens: turns * 3_000,
      cachedTokens: turns * 235_000,
      firstStart: startedAt,
      lastEnd: startedAt + wallMs + idleMs,
    }
  })

const saveSummary = async ($: EngineInterface) => {
  const sessionId = await $.session.id()
  const now = await $.clock.now()
  const kept = await read($, days)
  const grand = grandOf(await read($, interactions), kept, now)
  const summary: SessionSummary = { sessionId, startedAt: kept[0]?.startedAt ?? now, lastAt: now, ...grand }
  const stored = await read($, history)
  const next = [summary, ...stored.filter(one => one.sessionId !== sessionId)].slice(0, KEEP_SESSIONS)
  await update($, history, () => next)
  await $.store.set('sessions', next)
  const known = new Set(next.map(one => `${SNAPSHOT}${one.sessionId}`))
  for (const key of await $.store.keys()) {
    if (key.startsWith(SNAPSHOT) && !known.has(key)) await $.store.delete(key)
  }
  await saveSnapshot($)
}

const newDay = (now: number, date: string, manual: boolean): Day => ({
  ...NO_TALLY,
  id: now,
  date,
  startedAt: now,
  manual,
  started: 0,
  firstStart: null,
  lastEnd: null,
  stoppedAt: null,
})

type Chart = { source: string; alt: string; width: number; height: number }

// The charts last drawn, and when.
let drawnCharts: { at: number; running: boolean; charts: Chart[] } = { at: 0, running: false, charts: [] }

export const register: Register = (on, options) => {
  const asked = typeof options.commandName === 'string' ? options.commandName.trim().replace(/^\//, '') : ''
  const command = /^[A-Za-z0-9_-]{1,64}$/.test(asked) ? asked : DEFAULT_COMMAND
  const help = [
    `/${command}: open the Session Monitor.`,
    `/${command} startday: start a new day now; idle is measured from now and numbering starts again at #1.`,
    `/${command} stopday: close the day; idle isn't counted until startday or the first prompt after 05:00.`,
    `/${command} pause: a break; idle isn't counted until your next prompt.`,
    `/${command} reset: wipe everything: all days and the earlier sessions' history.`,
    `/${command} demo: add two made-up earlier days, to see the multi-day view; demo off removes them.`,
    `/${command} chatoff: no line under replies (the pane and the footer stay); chaton brings it back.`,
    `/${command} version: the installed version.`,
    `/${command} help: this list.`,
  ].join('\n')

  on('session.start', async ($, e, next) => {
    drawnCharts = { at: 0, running: false, charts: [] }
    if ((await $.store.get('chat')) === false) await update($, chat, () => false)
    const stored = await $.store.get('sessions')
    if (Array.isArray(stored)) {
      await update($, history, () => stored as SessionSummary[])
    }
    const read = await $.store.get('readings')
    if (Array.isArray(read)) {
      await update($, readings, () => read as Reading[])
    }
    await restoreSnapshot($)
    await $.command.register({
      name: command,
      description: 'Session Monitor: each interaction with Claude\'s time and its parts, your idle and answering time, efficiency, tokens and quota',
      argumentHint: '[startday | stopday | pause | reset | demo | version | help]',
    })

    return next(e)
  })

  on('command.run', { command }, async ($, e) => {
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(word => word !== '').join(' ')
    const now = await $.clock.now()
    const held = await read($, clock)
    const today = (await read($, days)).at(-1)

    switch (words) {
      case '':
        await $.ui.open({ id: PANE, title: 'Session Monitor' })
        return { text: 'Session Monitor opened.' }
      case 'startday': {
        const day = newDay(now, dayOf(now), true)
        await update($, days, all => [...all, day])
        await update($, clock, (): Clock => ({ mode: 'active', idleFrom: now, banked: 0 }))
        await saveSnapshot($)
        return { text: `Started ${dayNameOf(day)}; idle is measured from now.` }
      }
      case 'stopday': {
        if (today === undefined) return { text: 'No day to stop yet.' }
        await update($, days, all => all.map(day => (day.id === today.id ? { ...day, stoppedAt: now } : day)))
        await update($, clock, (): Clock => ({ mode: 'stopped', idleFrom: null, banked: 0 }))
        await saveSnapshot($)
        const efficiency = efficiencyOf(today)
        return {
          text: `Stopped ${dayNameOf(today)}: ${plural(today.turns, 'interaction')}${efficiency === null ? '' : `, efficiency ${efficiency}%`}. Idle isn't counted until startday or 05:00.`,
        }
      }
      case 'pause': {
        if (held.mode === 'stopped') return { text: 'The day is stopped: startday begins a new one.' }
        if (held.mode === 'paused') return { text: 'Already paused.' }
        const banked = held.banked + (held.idleFrom === null ? 0 : Math.max(0, now - held.idleFrom))
        await update($, clock, (): Clock => ({ mode: 'paused', idleFrom: null, banked }))
        await saveSnapshot($)
        return { text: `Paused at ${minuteOf(now)}; idle isn't counted until your next prompt.` }
      }
      case 'reset': {
        const turns = (await read($, days)).reduce((n, day) => n + day.turns, 0)
        const sessionId = await $.session.id()
        const earlier = (await read($, history)).filter(one => one.sessionId !== sessionId).length
        await update($, interactions, () => [])
        await update($, days, () => [])
        await update($, clock, () => NO_CLOCK)
        await update($, lines, () => [])
        await update($, history, () => [])
        await $.store.set('sessions', [])
        await update($, readings, () => [])
        await $.store.set('readings', [])
        for (const key of await $.store.keys()) {
          if (key.startsWith(SNAPSHOT)) await $.store.delete(key)
        }
        Object.assign(live, idleLive())
        agents.clear()
        return { text: `Cleared ${plural(turns, 'interaction')} and ${plural(earlier, 'earlier session')}.` }
      }
      case 'demo': {
        const made = demoDaysOf(now)
        await update($, days, all => [...made, ...all.filter(day => day.demo !== true)])
        await saveSnapshot($)
        return { text: `Added ${made.map(dayNameOf).join(' and ')}; /${command} demo off removes them.` }
      }
      case 'demo off': {
        const count = (await read($, days)).filter(day => day.demo === true).length
        await update($, days, all => all.filter(day => day.demo !== true))
        await saveSnapshot($)
        return { text: `Removed ${plural(count, 'demo day')}.` }
      }
      case 'version': {
        // The manifest's version, so there is one place to bump it.
        const manifest = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => '{}')
        const version = (JSON.parse(manifest) as { version?: unknown }).version
        return { text: `Session Monitor ${typeof version === 'string' ? version : '(version unknown)'}` }
      }
      case 'chaton':
      case 'chatoff': {
        const shown = words === 'chaton'
        await update($, chat, () => shown)
        await $.store.set('chat', shown)
        return { text: shown ? 'The line under replies is back.' : 'No line under replies; /' + command + ' chaton brings it back.' }
      }
      case 'help':
        return { text: help }
      default:
        return { text: `Unknown argument "${words}".\n${help}` }
    }
  })

  // The quota as the engine pushes it: after each turn and when a window moves.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await holdQuota($, quotaOf(e.rateLimits))
    }

    return next(e)
  })

  // Only the main loop opens an interaction; a subagent's tokens and tool
  // calls are added to the one it runs in, its time is its tool's.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const list = await read($, interactions)
      const home = (list.findLast(one => one.end === null) ?? list.at(-1))?.id
      if (home !== undefined) agents.set(e.agentId, { home, start: await $.clock.now() })
      return next(e)
    }
    const start = await $.clock.now()
    const held = await read($, clock)
    let day = (await read($, days)).at(-1)
    // The first prompt of a new day, 05:00 to 05:00, opens it, with no idle.
    const opens = day === undefined || dayOf(start) > day.date
    if (opens || day === undefined) {
      day = newDay(start, dayOf(start), false)
      const opened = day
      await update($, days, all => [...all, opened])
    }
    const gap =
      opens || held.mode === 'stopped'
        ? 0
        : held.banked + (held.mode === 'active' && held.idleFrom !== null ? Math.max(0, start - held.idleFrom) : 0)
    const dayId = day.id
    const n = day.started + 1
    await update($, days, all => all.map(each => (each.id === dayId ? { ...each, started: n } : each)))
    await update($, clock, (now): Clock => ({ mode: opens ? 'active' : now.mode === 'stopped' ? 'stopped' : 'active', idleFrom: null, banked: 0 }))
    const interaction: Interaction = {
      ...NO_SUMS,
      id: e.turnId,
      dayId,
      n,
      label: e.text.replace(/\s+/g, ' ').slice(0, 60) || '(continuation)',
      start,
      end: null,
      idleMs: gap,
      quotaStart: await readQuota($),
      quotaEnd: null,
      stretch: { since: start, key: null },
    }
    await update($, interactions, all => [...all, interaction].slice(-KEEP_INTERACTIONS))
    Object.assign(live, idleLive())

    return next(e)
  })

  // A step waits for the model until its first thinking or output; then each
  // stretch goes to thinking or writing by what last streamed, until the stop.
  on('turn.step', async function* ($, e, next) {
    const main = e.agentId === undefined
    const enter = async (state: StepState) => {
      if (main && live.step !== state) await change($, () => (live.step = state))
    }
    if (main) {
      // A call refused at its check never runs: its decision ends here.
      await change($, () => {
        live.checks.clear()
        live.step = 'modelWait'
      })
      live.steps++
    }

    try {
      for await (const chunk of next(e)) {
        if (chunk.kind === 'thinking') {
          await enter('thinking')
        } else if (chunk.kind === 'text' || chunk.kind === 'tool' || chunk.kind === 'input') {
          await enter('writing')
        } else if (chunk.kind === 'stop') {
          await enter(null)
          if (chunk.usage !== null) {
            const used = chunk.usage
            const tokens = {
              inTokens: used.input_tokens + used.cache_read_input_tokens + used.cache_creation_input_tokens,
              outTokens: used.output_tokens,
              cachedTokens: used.cache_read_input_tokens,
            }
            await (main ? add($, tokens) : addTo($, e.agentId, tokens))
          }
        }
        yield chunk
      }
    } finally {
      await enter(null)
    }
  })

  // Experiment: a main-loop call's permission decision runs from its check
  // until the tool starts.
  on('tool.check', async ($, e, next) => {
    const id = e.tool_use_id
    if (e.agentId === undefined && id !== undefined) {
      await change($, () => live.checks.add(id))
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const main = e.agentId === undefined
    const kind = ASKS_THE_PERSON.has(e.tool) ? 'asks' : RUNS_A_SUBAGENT.has(e.tool) ? 'agents' : 'tools'
    if (main) {
      await change($, () => {
        // Its own decision ends; failing an id to match, the oldest one.
        const id = e.tool_use_id !== undefined && live.checks.has(e.tool_use_id) ? e.tool_use_id : [...live.checks][0]
        if (id !== undefined) live.checks.delete(id)
        live[kind]++
      })
    }
    try {
      return await next(e)
    } finally {
      if (main) {
        await change($, () => (live[kind] = Math.max(0, live[kind] - 1)))
      }
      if (kind !== 'asks') await (main ? add($, { toolCalls: 1 }) : addTo($, e.agentId, { toolCalls: 1 }))
    }
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) {
      // A subagent waited on by its Agent call is already in the timeline;
      // one in the background adds its whole run, alongside the main loop.
      const agent = agents.get(e.agentId)
      if (agent !== undefined && live.agents === 0) {
        await addTo($, e.agentId, { subagentMs: (await $.clock.now()) - agent.start })
      }
      agents.delete(e.agentId)
      return ran
    }

    await change($, () => Object.assign(live, { step: null, tools: 0, agents: 0, asks: 0, checks: new Set<string>() }), true)
    const end = await $.clock.now()
    const list = await read($, interactions)
    const at = list.findIndex(one => one.id === e.turnId && one.end === null)
    const found = list[at]
    if (found === undefined) {
      return ran
    }
    const { stretch: _done, ...ended } = found
    const turn: Interaction = { ...ended, end, quotaEnd: await readQuota($) }
    await update($, interactions, all => all.map(one => (one.id === turn.id ? turn : one)))
    await update($, days, all =>
      all.map(day =>
        day.id === turn.dayId
          ? {
              ...tallyPlus(day, { ...plus(NO_TALLY, turn), turns: 1, wallMs: end - turn.start }),
              firstStart: day.firstStart ?? turn.start,
              lastEnd: end,
            }
          : day,
      ),
    )
    await update($, clock, held => (held.mode === 'stopped' ? held : { mode: held.mode, idleFrom: end, banked: 0 }))

    // The first turn of a new day closes the day before with its line.
    const before = list[at - 1]
    const closed =
      before === undefined || before.dayId === turn.dayId
        ? undefined
        : (await read($, days)).find(day => day.id === before.dayId)

    const tail = tailOf(e.answer)
    if (tail !== '') {
      const timed: TimedLine = { tail, line: lineOf(turn, end), day: closed && dayLineOf(closed) }
      await update($, lines, all => [...all, timed].slice(-KEEP_LINES))
    }
    // Saved after the line, so a restart still draws it.
    await saveSummary($)

    return ran
  })

  // The timing line closes the reply: drawn under its last block, on every
  // surface; the transcript itself is left as it was.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!(await read($, chat))) {
      return next(e)
    }
    const text = e.props.text.trim()
    const timed = (await read($, lines)).findLast(one => text.endsWith(one.tail))
    if (timed === undefined) {
      return next(e)
    }
    const added = [timed.line, timed.day].filter(line => line !== undefined)
    // The reply drawn by the engine, untouched, and the line beneath it: a
    // surface that marks rewritten replies (VS Code boxes them and stops their
    // links) sees the engine's own row.
    const own = await next(e)
    const { Box, Markdown } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {own}
        <Markdown text={added.join('\n\n')} />
      </Box>
    )
  })

  // A label in the prompt footer: the running interaction, else the last one,
  // today's total, and the quota.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const list = await read($, interactions)
    const last = list.at(-1)
    if (last === undefined) {
      return next(e)
    }
    const today = (await read($, days)).at(-1)
    const held = await read($, quota)
    const mode = (await read($, clock)).mode
    const parts = [
      last.end === null ? `⏱ since ${clockOf(last.start)}` : `⏱ last ${durationOf(last.end - last.start)}`,
    ]
    if (today !== undefined) parts.push(`today ${durationOf(today.wallMs)}`)
    if (mode !== 'active') parts.push(mode)
    if (held.fiveHour !== undefined) parts.push(`5h ${percentOf(held.fiveHour.percent)}`)
    if (held.week !== undefined) parts.push(`wk ${percentOf(held.week.percent)}`)

    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, parts.join(' · ')] } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    // The terminal has no Svg: it shows the figures as text.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const list = await read($, interactions)
    const kept = await read($, days)
    const past = await read($, history)
    const held = await read($, quota)
    const mode = (await read($, clock)).mode
    const sessionId = await $.session.id()
    const now = await $.clock.now()
    const grand = grandOf(list, kept, now)
    const grandClaude = claudeOf(grand, grand.wallMs)
    const efficiency = efficiencyOf(grand)
    const earlier = past.filter(one => one.sessionId !== sessionId)

    // Interactions: the figures, then the efficiency and Claude's parts.
    const daysCount = Math.max(1, kept.length)
    const figures =
      grand.turns === 0
        ? "Nothing logged yet: the charts fill in as each of Claude's answers ends."
        : [
            plural(kept.length, 'day'),
            plural(grand.turns, 'interaction'),
            `${Math.round((grand.turns / daysCount) * 10) / 10} interactions per day`,
            `average Claude ${durationOf(grandClaude / grand.turns)}`,
            efficiency === null ? '' : `efficiency ${efficiency}%`,
            cachedOf(grand),
          ]
            .filter(part => part !== '')
            .join(' · ')
    const fresh: Chart[] = []
    // Drawn from the start: with nothing logged yet, every slice at 0s shows
    // what the charts will measure.
    const empty = grand.wallMs === 0
    {
      const slices = [
        { name: 'Claude', ms: grandClaude, label: durationOf(grandClaude), color: COLORS.claude },
        { name: 'User answering', ms: grand.answeringMs, label: durationOf(grand.answeringMs), color: COLORS.answering },
        { name: 'Was idle', ms: grand.idleMs, label: durationOf(grand.idleMs), color: COLORS.idle },
      ].filter(slice => empty || slice.ms > 0)
      fresh.push({
        ...donutOf({ center: empty ? '–' : `${efficiency ?? 0}%`, caption: 'Operator efficiency', slices }),
        alt: `Operator efficiency ${efficiency ?? 0}%: ${slices.map(slice => `${slice.name} ${slice.label}`).join(', ')}`,
      })
      const parts = [
        ...PARTS.map(part => ({
          name: capital(part.name),
          ms: grand[part.key],
          label: durationOf(grand[part.key]),
          color: COLORS[part.column],
        })),
        // Experiment: misc as the parts it was measured in.
        ...miscPartsOf(grand, grand.wallMs).map((part, i) => ({
          name: `Misc: ${part.name}`,
          ms: part.ms,
          label: durationOf(part.ms),
          color: MISC_SHADES[i % MISC_SHADES.length] ?? COLORS.misc,
          aside: true,
        })),
      ]
        .filter(slice => empty || slice.ms > 0)
        // Largest share first.
        .sort((one, other) => other.ms - one.ms)
      fresh.push({
        ...donutOf({ center: durationOf(grandClaude), caption: "Claude's time", slices: parts }),
        alt: `Claude's time ${durationOf(grandClaude)}: ${parts.map(slice => `${slice.name} ${slice.label}`).join(', ')}`,
      })
    }
    // Mid-turn, the charts drawn last stand for up to CHARTS_EVERY_MS; the
    // turn's end draws them at once.
    const running = list.some(one => one.end === null)
    const keep = running && drawnCharts.running && now - drawnCharts.at < CHARTS_EVERY_MS
    if (!keep) drawnCharts = { at: now, running, charts: fresh }
    const charts = drawnCharts.charts
    // Each window: what is used, then where the pace so far and the last
    // hour's (the last day's for the week) take it by the reset.
    const heldReadings = await read($, readings)
    type QuotaRow = { title: string; about: string; gauges: Chart[]; words: string }
    const quotaRows: QuotaRow[] = []
    for (const [kind, title, withDay, recentPace, lookback] of [
      ['fiveHour', '5h quota', false, "last hour's", 'the last hour'],
      ['week', 'Weekly quota', true, "last day's", 'the last day'],
    ] as const satisfies readonly (readonly [WindowKind, string, boolean, string, string])[]) {
      const window = held[kind]
      if (window === undefined) continue
      const resets = resetAtOf(window, withDay)
      const outlook = outlookOf(kind, window, heldReadings, now)
      const about = (
        outlook === undefined
          ? [resets === '' ? '' : `resets ${resets}`]
          : [
              `started ${withDay ? datedOf(outlook.startsAt) : momentOf(outlook.startsAt, false)}`,
              `resets ${withDay ? datedOf(outlook.resetsAt) : momentOf(outlook.resetsAt, false)}`,
              `max pace left ${paceOf(outlook.maxPace)}`,
            ]
      )
        .filter(part => part !== '')
        .join(' · ')
      const shownOf = (forecast: Forecast) =>
        forecast.outAt !== null ? `out ${momentOf(forecast.outAt, withDay)}` : `${Math.round(forecast.atReset)}%`
      const aheadOf = (caption: string, forecast: Forecast | null | undefined, note: string): Chart => {
        if (forecast === null || forecast === undefined) {
          return { ...gaugeOf({ percent: 0, caption, note, center: '–' }), alt: `${title} ${caption}: ${note}` }
        }
        const shown = shownOf(forecast)
        return {
          ...gaugeOf({ percent: forecast.atReset, caption, note, color: SIGNALS[signalOf(forecast)], center: shown }),
          alt: `${title} ${caption}: ${shown} (${note})`,
        }
      }
      const average = outlook?.average
      const recent = outlook?.recent
      const soFar = average && outlook ? `${paceOf(average.pace)} since ${momentOf(outlook.startsAt, withDay)}` : ''
      const missing = outlook === undefined ? 'no reset time' : ''
      quotaRows.push({
        title,
        about,
        gauges: [
          { ...gaugeOf({ percent: window.percent, caption: 'Used now', note: '' }), alt: `${title} ${percentOf(window.percent)} used` },
          aheadOf('At reset, pace so far', average, average ? soFar : missing || 'too early in the window'),
          // Until the readings span enough, the pace so far stands in.
          recent
            ? aheadOf(`At reset, ${recentPace} pace`, recent, `${paceOf(recent.pace)} over ${lookback}`)
            : aheadOf(`At reset, ${recentPace} pace`, average, missing || 'Measuring recent pace'),
        ],
        words: [
          `${title} ${percentOf(window.percent)}${resets === '' ? '' : ` (resets ${resets})`}`,
          average ? `pace so far: ${shownOf(average)}${average.outAt === null ? ' at reset' : ''}` : '',
          recent ? `${recentPace} pace: ${shownOf(recent)}${recent.outAt === null ? ' at reset' : ''}` : '',
        ]
          .filter(part => part !== '')
          .join(' · '),
      })
    }

    // This session's days, newest first: today's summary and its
    // interactions, then each earlier day's summary alone.
    type Line = { row: Row; after: string; dim?: boolean; bold?: boolean }
    const dayLine = (day: Day, current: boolean): Line => {
      const dayEfficiency = efficiencyOf(day)
      const state = day.stoppedAt !== null ? `stopped ${minuteOf(day.stoppedAt)}` : current && mode === 'paused' ? 'paused' : ''
      return {
        row: {
          ...cellsOf(day, day.wallMs, true),
          start: shortDateOf(day.date),
        },
        after: [
          dayNameOf(day),
          plural(day.turns, 'interaction'),
          dayEfficiency === null ? '' : `efficiency ${dayEfficiency}%`,
          cachedOf(day),
          state,
        ]
          .filter(part => part !== '')
          .join(' · '),
        bold: true,
        dim: !current,
      }
    }
    const table: Line[] = []
    const current = kept.at(-1)
    if (current !== undefined) {
      table.push(dayLine(current, true))
      for (const one of list.filter(each => each.dayId === current.id).reverse()) {
        table.push({ row: rowOf(one, now), after: one.label, dim: one.end !== null })
      }
      for (const day of kept.slice(0, -1).reverse()) table.push(dayLine(day, false))
    }
    const before: Line[] = earlier.slice(0, 5).map(one => {
      const tally = tallyOf(one)
      const sessionEfficiency = efficiencyOf(tally)
      return {
        row: { ...cellsOf(tally, tally.wallMs), start: shortDateOf(calendarOf(one.startedAt)) },
        after: [
          longDateOf(calendarOf(one.startedAt)),
          plural(one.turns, 'interaction'),
          sessionEfficiency === null ? '' : `efficiency ${sessionEfficiency}%`,
        ]
          .filter(part => part !== '')
          .join(' · '),
        dim: true,
      }
    })
    const widthOf = (column: Column) =>
      Math.max(...COLUMNS[column].map(word => word.length), ...[...table, ...before].map(line => (line.row[column] ?? '').length))
    const bar = <Text color="subtle">│</Text>
    // A blank line between the headers and the rows: a drawn rule can't line
    // up with cells in a proportional font.
    const spacer = <Text> </Text>
    // Each row is cut at the pane's right edge rather than wrapped: a wider
    // pane shows more of it, with no redraw.
    const draw = (line: Line | 'header' | 'header-top') => (
      <Box flexDirection="row" flexWrap="nowrap" columnGap={1} width="100%" overflow="hidden">
        {GROUPS.map((group, g) => (
          <Box flexDirection="row" flexWrap="nowrap" columnGap={1} flexShrink={0}>
            {g > 0 && bar}
            {group.map(column => (
              <Box width={widthOf(column)} flexShrink={0} justifyContent="flex-end">
                <Text
                  bold={typeof line === 'string' || line.bold || column === 'claude'}
                  dimColor={typeof line !== 'string' && line.dim}
                  color={COLUMN_COLORS[column] ?? GROUP_COLORS[g]}
                >
                  {line === 'header-top' ? COLUMNS[column][0] : line === 'header' ? COLUMNS[column][1] : (line.row[column] ?? '')}
                </Text>
              </Box>
            ))}
          </Box>
        ))}
        {bar}
        {typeof line !== 'string' && line.after !== '' && (
          <Text dimColor={line.dim} bold={line.bold} wrap="truncate-end">
            {line.after}
          </Text>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {quotaRows.map(row => (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={2}>
              <Text bold>{row.title}</Text>
              <Text dimColor>{row.about}</Text>
            </Box>
            {Svg === undefined ? (
              <Text dimColor>{row.words}</Text>
            ) : (
              <Box flexDirection="row" columnGap={2} flexWrap="wrap">
                {row.gauges.map(gauge => (
                  <Svg source={gauge.source} alt={gauge.alt} width={gauge.width} height={gauge.height} />
                ))}
              </Box>
            )}
          </Box>
        ))}
        <Box flexDirection="column">
          <Text bold>Interactions</Text>
          <Text dimColor>{figures}</Text>
        </Box>
        {Svg !== undefined && charts.length > 0 && (
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            {charts.map(chart => (
              <Svg source={chart.source} alt={chart.alt} width={chart.width} height={chart.height} isInteractive />
            ))}
          </Box>
        )}
        <Box flexDirection="column">
          <Text bold>This session history</Text>
          {draw('header-top')}
          {draw('header')}
          {spacer}
          {table.map(draw)}
        </Box>
        {before.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Earlier sessions</Text>
            {before.map(draw)}
          </Box>
        )}
      </Box>
    )
  })
}
