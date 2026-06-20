/**
 * Shared day/night cycle utilities.
 *
 * Client: reads getWorldTime() to get the actual Decentraland auto cycle,
 * then writes SkyboxTime to lock the skybox (prevents manual override).
 *
 * Server: reads SkyboxTime CRDT component (synced from client) so ghost
 * spawning and other night-dependent logic matches the visual cycle exactly.
 *
 * Time scale (0–86400):
 *   0     = midnight (00:00)
 *   21600 = sunrise  (06:00)
 *   43200 = noon     (12:00)
 *   64800 = sunset   (18:00)
 *   86400 = midnight again
 */

import { engine, SkyboxTime } from '@dcl/sdk/ecs'

const SUNSET_TIME = 64800   // 6 PM
const SUNRISE_TIME = 21600  // 6 AM

let cachedWorldSeconds = 43200 // default to noon
let lastFetchTime = 0
const FETCH_INTERVAL_MS = 5000 // refresh every 5 seconds

// Client sets this to getWorldTime after dynamic import
let _getWorldTimeFn: (() => Promise<{ seconds: number }>) | null = null

/** Called by client on startup to provide the getWorldTime function. */
export function setGetWorldTimeFn(fn: () => Promise<{ seconds: number }>): void {
  _getWorldTimeFn = fn
}

/**
 * Call periodically to keep the cached time fresh.
 *
 * Client path: calls getWorldTime() → updates cache → writes SkyboxTime (locks skybox).
 * Server path: reads SkyboxTime CRDT from client → updates cache.
 */
export function updateWorldTime(_dt?: number, _applyToSkybox?: boolean): void {
  const now = Date.now()
  if (now - lastFetchTime < FETCH_INTERVAL_MS) return
  lastFetchTime = now

  if (_getWorldTimeFn) {
    // CLIENT: read actual cycle from runtime, then lock skybox
    _getWorldTimeFn().then((result) => {
      cachedWorldSeconds = result.seconds % 86400
      SkyboxTime.createOrReplace(engine.RootEntity, { fixedTime: cachedWorldSeconds })
    }).catch(() => {})
  } else {
    // SERVER: read SkyboxTime CRDT written by client
    const skybox = SkyboxTime.getOrNull(engine.RootEntity)
    if (skybox) {
      cachedWorldSeconds = skybox.fixedTime % 86400
    }
  }
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
