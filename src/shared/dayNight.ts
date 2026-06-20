/**
 * Shared day/night cycle utilities.
 *
 * Derives time from wall clock (Date.now) so it works identically on
 * both client and authoritative server. All instances share the same
 * epoch so day/night is consistent across players.
 *
 * Decentraland's default cycle: 1 real second = 60 in-world seconds.
 * Full cycle = 1440 real seconds (24 minutes).
 *
 * Time scale (0–86400):
 *   0     = midnight (00:00)
 *   21600 = sunrise  (06:00)
 *   43200 = noon     (12:00)
 *   64800 = sunset   (18:00)
 *   86400 = midnight again
 *
 * Also writes SkyboxTime to lock the visual skybox, preventing
 * players from overriding to manual mode.
 */

import { engine, SkyboxTime } from '@dcl/sdk/ecs'

const SUNSET_TIME = 64800   // 6 PM
const SUNRISE_TIME = 21600  // 6 AM

let cachedWorldSeconds = 43200 // default to noon
let lastFetchTime = 0
const FETCH_INTERVAL_MS = 5000 // refresh every 5 seconds

/**
 * Derive world time from wall clock.
 * Decentraland's auto cycle: 1 real second = 60 in-world seconds.
 * Full cycle = 1440 real seconds (24 minutes).
 * All instances share the same epoch so day/night is consistent.
 */
function getWallClockWorldTime(): number {
  const CYCLE_REAL_SECONDS = 1440 // 24 real minutes
  const nowSec = Date.now() / 1000
  const cyclePosition = (nowSec % CYCLE_REAL_SECONDS) / CYCLE_REAL_SECONDS
  return cyclePosition * 86400
}

/**
 * Call periodically to keep the cached time fresh.
 * Uses wall-clock-derived time (works on both client and server).
 * Writes SkyboxTime on clients to lock the skybox to the auto cycle,
 * preventing players from overriding via the manual UI toggle.
 */
export function updateWorldTime(_dt?: number, _applyToSkybox?: boolean): void {
  const now = Date.now()
  if (now - lastFetchTime < FETCH_INTERVAL_MS) return
  lastFetchTime = now
  cachedWorldSeconds = getWallClockWorldTime()
  SkyboxTime.createOrReplace(engine.RootEntity, { fixedTime: cachedWorldSeconds })
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
