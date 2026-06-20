/**
 * Shared day/night cycle utilities.
 *
 * Uses Decentraland's default 24-minute day/night cycle (auto skybox).
 * We just read getWorldTime() periodically to know if it's night
 * (for ghost spawning, proximity lights, UI icons, etc.)
 *
 * Default cycle: 1 minute per second, full cycle = 24 real minutes.
 * getWorldTime() returns 0–86400 (seconds in a 24h day).
 *   0     = midnight (00:00)
 *   21600 = sunrise  (06:00)
 *   43200 = noon     (12:00)
 *   64800 = sunset   (18:00)
 *   86400 = midnight again
 */

import { getWorldTime } from '~system/Runtime'

const SUNSET_TIME = 64800   // 6 PM
const SUNRISE_TIME = 21600  // 6 AM

let cachedWorldSeconds = 43200 // default to noon
let lastFetchTime = 0
const FETCH_INTERVAL_MS = 5000 // refresh every 5 seconds

/**
 * Call periodically to keep the cached time fresh.
 * No longer writes SkyboxTime — the platform handles the skybox.
 */
export function updateWorldTime(_dt?: number, _applyToSkybox?: boolean): void {
  const now = Date.now()
  if (now - lastFetchTime < FETCH_INTERVAL_MS) return
  lastFetchTime = now
  getWorldTime({}).then((result) => {
    cachedWorldSeconds = result.seconds % 86400
  }).catch(() => {})
}

/** Get the current world time (0–86400). */
export function getCurrentSkyTime(): number {
  return cachedWorldSeconds
}

/**
 * Returns true when it's night: 6 PM – 6 AM.
 */
export function isNightTime(): boolean {
  return cachedWorldSeconds >= SUNSET_TIME || cachedWorldSeconds < SUNRISE_TIME
}
