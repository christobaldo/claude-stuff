// Where a quota window is heading: at the average pace since the window
// began, and at the recent pace, read off the quota readings kept.

import type { QuotaWindow, Reading } from '../types'

export type WindowKind = 'fiveHour' | 'week'

const HOUR = 3_600_000
const LENGTH_MS: Record<WindowKind, number> = { fiveHour: 5 * HOUR, week: 7 * 24 * HOUR }
// The recent pace looks back this far: the quota is read to one decimal, so
// the week needs a day to move enough to measure.
export const LOOKBACK_MS: Record<WindowKind, number> = { fiveHour: HOUR, week: 24 * HOUR }
// The readings must span this much before the recent pace is measured.
export const MEASURED_MS: Record<WindowKind, number> = { fiveHour: 20 * 60_000, week: 4 * HOUR }

// A pace in percent an hour, and where it takes the window: its share at the
// reset, and when it reaches 100% if that comes first.
export type Forecast = { pace: number; atReset: number; outAt: number | null }

export type Outlook = {
  startsAt: number
  resetsAt: number
  // What is left over the time left: the fastest pace that lasts to the reset.
  maxPace: number
  // Null until a tenth of the window has gone.
  average: Forecast | null
  // Null until the readings in this window span MEASURED_MS. Never below
  // what is used: a pace is never negative.
  recent: Forecast | null
}

const forecastOf = (used: number, pace: number, now: number, resetsAt: number): Forecast => {
  const atReset = used + (pace * (resetsAt - now)) / HOUR
  const outAt = atReset >= 100 && pace > 0 ? now + (Math.max(0, 100 - used) / pace) * HOUR : null
  return { pace, atReset, outAt }
}

export const outlookOf = (kind: WindowKind, window: QuotaWindow, readings: readonly Reading[], now: number): Outlook | undefined => {
  const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt)
  if (Number.isNaN(resetsAt) || resetsAt <= now) return undefined
  const startsAt = resetsAt - LENGTH_MS[kind]
  const used = window.percent
  const gone = now - startsAt
  const average = gone >= LENGTH_MS[kind] / 10 ? forecastOf(used, used / (gone / HOUR), now, resetsAt) : null
  // The oldest reading within the lookback and this window.
  const from = Math.max(now - LOOKBACK_MS[kind], startsAt)
  const old = readings.find(one => one.at >= from && one[kind] !== undefined)
  const then = old?.[kind]
  const recent =
    old !== undefined && then !== undefined && now - old.at >= MEASURED_MS[kind] && used >= then
      ? forecastOf(used, (used - then) / ((now - old.at) / HOUR), now, resetsAt)
      : null
  return { startsAt, resetsAt, maxPace: Math.max(0, 100 - used) / ((resetsAt - now) / HOUR), average, recent }
}

// Green under 80% at the reset, amber up to 100%, red when it runs out first.
export const signalOf = (forecast: Forecast) =>
  forecast.outAt !== null ? 'red' : forecast.atReset >= 80 ? 'amber' : 'green'
