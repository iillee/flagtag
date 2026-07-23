import { ROUND_LENGTH_MINUTES } from './constants'

// ── Snap-to-zero flag ──
// Server clock and client clock can drift by several seconds (Windows NTP
// slack). When the server-authoritative respawnPlayers arrives we know the
// server has crossed the boundary, but the client's local Date.now() may
// still put us a few seconds short of it — so the UI would still read
// something like 0:05 for one frame before the fade begins. Setting this
// flag forces getCountdownSeconds() to return 0 so the UI shows 0:00 at
// the exact moment the cinematic starts.
let _snapCountdownToZero = false

export function snapCountdownToZero(): void { _snapCountdownToZero = true }
export function releaseCountdownSnap(): void { _snapCountdownToZero = false }

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
  if (_snapCountdownToZero) return 0
  const now = Date.now()
  const intervalMs = ROUND_LENGTH_MINUTES * 60 * 1000
  const nextBoundary = (Math.floor(now / intervalMs) + 1) * intervalMs
  return Math.max(0, Math.floor((nextBoundary - now) / 1000))
}
