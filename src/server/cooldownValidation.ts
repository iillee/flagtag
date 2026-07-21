export const NAME_CHANGE_COOLDOWN_MS = 10_000
export const FEEDBACK_COOLDOWN_MS = 60_000

export function isRateLimited(lastActionMs: number | undefined, nowMs: number, cooldownMs: number): boolean {
  if (lastActionMs === undefined) return false
  if (![lastActionMs, nowMs, cooldownMs].every(Number.isFinite) || cooldownMs < 0) return true
  return nowMs - lastActionMs < cooldownMs
}

export function pruneExpiredTimestamps(
  timestamps: Map<string, number>,
  nowMs: number,
  cooldownMs: number
): number {
  let removed = 0
  for (const [key, timestamp] of timestamps) {
    if (!isRateLimited(timestamp, nowMs, cooldownMs)) {
      timestamps.delete(key)
      removed++
    }
  }
  return removed
}
