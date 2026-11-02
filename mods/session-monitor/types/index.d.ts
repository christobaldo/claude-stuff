// The account's rate-limit windows as one reading has them, in percent used.
export type QuotaWindow = { percent: number; resetsAt?: string }

export type Quota = { fiveHour?: QuotaWindow; week?: QuotaWindow }

// One quota reading, kept to measure the recent pace.
export type Reading = { at: number; fiveHour?: number; week?: number }

// What the model requests used, summed: `inTokens` holds every input token,
// cache reads and writes included; `cachedTokens` the cache reads alone.
export type Tokens = { inTokens: number; outTokens: number; cachedTokens: number }

// What an interaction's spans and requests add up to. Its wall time is
// measured on the main loop as one timeline, each moment given to one part:
// the person answering, else a tool running, else a subagent running, else
// the model waiting, thinking or writing. Claude's time is the wall time less
// the person's answering; what no part covers of it is Claude's misc.
export type Sums = Tokens & {
  modelWaitMs: number
  thinkingMs: number
  writingMs: number
  toolMs: number
  subagentMs: number
  answeringMs: number
  // Every tool call, subagents' included.
  toolCalls: number
  // Before the interaction: the gap since the previous one ended or a day's
  // start, less a pause; none on a day's first or while the day is stopped.
  idleMs: number
  // Experiment: what Claude's misc holds. The permission decision before a
  // tool runs (the auto-mode classifier, or a dialog the person answers), and
  // the stretches nothing ran in between steps and after the last reply; the
  // one before the first model request is left in misc's other.
  permissionMs: number
  betweenMs: number
  afterMs: number
}

// The parts a stretch of the main loop's timeline can go to.
export type StretchKey =
  | 'answeringMs' | 'toolMs' | 'subagentMs' | 'permissionMs' | 'thinkingMs' | 'writingMs' | 'modelWaitMs'
  | 'betweenMs' | 'afterMs'

// One interaction: a main-loop turn, from the prompt to the answer.
export type Interaction = Sums & {
  id: string
  // The day it belongs to, and its number in that day, from 1.
  dayId: number
  n: number
  label: string
  start: number
  end: number | null
  // The quota read as the turn began and as it ended.
  quotaStart: Quota
  quotaEnd: Quota | null
  // While it runs: the stretch since the timeline's last change, and the
  // part it goes to.
  // null: a stretch no part takes, left in misc's other.
  stretch?: { since: number; key: StretchKey | null }
}

// What finished interactions add up to.
export type Tally = Sums & { turns: number; wallMs: number }

// One day of this session: begun by its first interaction after 05:00 or by
// `startday`, closed by the next or by `stopday`.
export type Day = Tally & {
  id: number
  // The date it is named by, `2026-11-02`.
  date: string
  startedAt: number
  // Begun by `startday` rather than by the first interaction after 05:00.
  manual: boolean
  // The numbers given so far, running interactions included.
  started: number
  firstStart: number | null
  lastEnd: number | null
  stoppedAt: number | null
  // Made up by `demo`, to show several days without waiting for them.
  demo?: boolean
}

// What the person's commands set: whether idle counts, and from when.
export type Clock = {
  mode: 'active' | 'paused' | 'stopped'
  // Idle runs from here; `banked` holds idle counted before a pause.
  idleFrom: number | null
  banked: number
}

// What a session added up to, kept across sessions.
export type SessionSummary = Tally & { sessionId: string; startedAt: number; lastAt: number }

// The timing line of one main-loop turn, matched to the reply's last block by
// the end of its text, with the finished day's line on the first turn after it.
export type TimedLine = { tail: string; line: string; day?: string }

declare module 'claude-code' {
  interface PluginState {
    'session-monitor': {
      interactions: Shaped<Interaction[]>
      days: Shaped<Day[]>
      clock: Shaped<Clock>
      history: SessionSummary[]
      lines: Shaped<TimedLine[]>
      quota: Quota
      readings: Reading[]
    }
  }
}
