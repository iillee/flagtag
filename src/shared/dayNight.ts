/**
 * Shared day/night cycle utilities.
 * Uses getWorldTime() from ~system/Runtime — same source as proximity lights.
 * getWorldTime() returns seconds in a 0–86400 range (one full DCL day).
 *
 * Night window matches proximityLights.ts:
 *   SUNSET  = 64800 (6 PM)
 *   SUNRISE =  7200 (6 AM)
 */

import { getWorldTime } from '~system/Runtime'

const SUNSET_TIME = 64800   // 6 PM
const SUNRISE_TIME = 7200   // 6 AM

let cachedWorldSeconds = 36000 // default to noon
let lastFetchTime = 0
const FETCH_INTERVAL_MS = 10000 // refresh every 10 seconds

/** Call periodically (e.g. from a system) to keep the cached time fresh. */
export function updateWorldTime(): void {
  const now = Date.now()
  if (now - lastFetchTime < FETCH_INTERVAL_MS) return
  lastFetchTime = now
  getWorldTime({}).then((result) => {
    cachedWorldSeconds = result.seconds % 86400
  }).catch(() => {})
}

/** Get the current sky time (0–72000) for SkyboxTime compatibility. */
export function getCurrentSkyTime(): number {
  return (cachedWorldSeconds / 86400) * 72000
}

/** Returns true when it's night (ghost spawning window): 6 PM – 6 AM. */
export function isNightTime(): boolean {
  return cachedWorldSeconds >= SUNSET_TIME || cachedWorldSeconds < SUNRISE_TIME
}
