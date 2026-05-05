/**
 * Shared day/night cycle utilities.
 * SkyboxTime range: 0–72000 (maps to 24 hours).
 *   0     = midnight
 *   18000 = 6 AM (sunrise)
 *   36000 = noon
 *   54000 = 6 PM (sunset)
 *   72000 = midnight
 *
 * 10-minute real-time cycle (600 seconds).
 */

export const DAY_NIGHT_CYCLE_DURATION_SEC = 600
export const DAY_NIGHT_SPEED = 72000 / DAY_NIGHT_CYCLE_DURATION_SEC // 120 units/sec

/** Night window: 4 minutes centered on midnight (0/72000).
 *  4 min = 240s out of 600s cycle = 40% = 28800 units.
 *  Half before midnight: 72000 - 14400 = 57600. Half after: 14400. */
const NIGHT_START = 57600  // 2 min before midnight
const NIGHT_END   = 14400  // 2 min after midnight

/** Get the current sky time (0–72000) synced to wall-clock. */
export function getCurrentSkyTime(): number {
  const nowSec = Date.now() / 1000
  return (nowSec * DAY_NIGHT_SPEED) % 72000
}

/** Returns true when it's fully night (ghost spawning window). */
export function isNightTime(): boolean {
  const t = getCurrentSkyTime()
  // Night wraps around midnight: t >= NIGHT_START OR t < NIGHT_END
  return t >= NIGHT_START || t < NIGHT_END
}
