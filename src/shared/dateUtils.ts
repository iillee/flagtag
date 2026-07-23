import { ROUND_LENGTH_MINUTES } from './constants'

// ── Client→server time offset ──
// Windows NTP slack can leave a client's Date.now() several seconds behind the
// authoritative server, which makes the countdown UI disagree with the server
// (fade-to-black kicks in while the UI still reads 0:05). Anchor this offset
// every time the server crosses a round boundary — the cinematicSystem calls
// setServerTimeOffsetFromRoundEnd() when respawnPlayers arrives, using the
// server's just-updated CountdownTimer.roundEndTimeMs as the reference.
let _serverTimeOffsetMs = 0

export function setServerTimeOffsetMs(ms: number): void { _serverTimeOffsetMs = ms }
export function getServerTimeOffsetMs(): number { return _serverTimeOffsetMs }
function serverNow(): number { return Date.now() + _serverTimeOffsetMs }

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

/** Returns the Unix ms timestamp of the next 5-minute UTC boundary (server-adjusted). */
export function getNextRoundEndTimeMs(): number {
  const now = serverNow()
  const intervalMs = ROUND_LENGTH_MINUTES * 60 * 1000
  return (Math.floor(now / intervalMs) + 1) * intervalMs
}

/** Returns seconds remaining until the next 5-minute UTC boundary (server-adjusted). */
export function getCountdownSeconds(): number {
  const now = serverNow()
  const intervalMs = ROUND_LENGTH_MINUTES * 60 * 1000
  const nextBoundary = (Math.floor(now / intervalMs) + 1) * intervalMs
  return Math.max(0, Math.floor((nextBoundary - now) / 1000))
}
