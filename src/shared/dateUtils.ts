import { ROUND_LENGTH_MINUTES } from './constants'

/** Returns today's date as 'YYYY-MM-DD' in UTC. */
export function getTodayDateString(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Returns the current month as 'YYYY-MM' in UTC. */
export function getCurrentMonthString(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

/** Returns the Unix ms timestamp of the next 5-minute UTC boundary. */
export function getNextRoundEndTimeMs(): number {
  const now = Date.now()
  const intervalMs = ROUND_LENGTH_MINUTES * 60 * 1000
  return (Math.floor(now / intervalMs) + 1) * intervalMs
}

/** Returns seconds remaining until the next 5-minute UTC boundary. */
export function getCountdownSeconds(): number {
  const now = Date.now()
  const intervalMs = ROUND_LENGTH_MINUTES * 60 * 1000
  const nextBoundary = (Math.floor(now / intervalMs) + 1) * intervalMs
  return Math.max(0, Math.floor((nextBoundary - now) / 1000))
}
