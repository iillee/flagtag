/**
 * Shared day/night cycle utilities.
 *
 * Uses absolute wall-clock time (Date.now()) so server and all clients
 * always agree on what time of day it is — no drift, no sync needed.
 *
 * Full cycle = 30 real-world minutes (1800 seconds).
 * Day = 15 minutes, Night = 15 minutes.
 * Cycle starts at sunrise (06:00) at epoch 0, repeating every 30 min.
 *
 * SkyboxTime uses 0–86400 (seconds in a 24h day).
 *   0     = midnight (00:00)
 *   21600 = sunrise  (06:00)
 *   43200 = noon     (12:00)
 *   64800 = sunset   (18:00)
 *   86400 = midnight again
 */

import { engine, SkyboxTime } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'

const IS_SERVER = isServer()

const SUNSET_TIME = 64800   // 6 PM
const SUNRISE_TIME = 21600  // 6 AM

// Full day/night cycle = 30 real-world minutes = 1800 seconds
const DAY_DURATION_SEC = 60 * 30
// Maps 1800 real seconds to 86400 game seconds
const RATE_FACTOR = 86400 / DAY_DURATION_SEC  // 48

// Update SkyboxTime every N game-seconds (avoids excessive CRDT writes)
const UPDATE_INTERVAL = 10
let lastSkyboxTime = -999

/**
 * Compute the current game time (0–86400) from wall-clock.
 * Cycle starts at sunrise (21600) at Unix epoch, repeating every 30 min.
 */
function computeGameTime(): number {
  const nowSec = Date.now() / 1000
  // Position within the current 30-minute cycle (0 – 1800)
  const cyclePos = nowSec % DAY_DURATION_SEC
  // Convert to game-seconds (0 – 86400) and offset so cycle starts at sunrise
  return (SUNRISE_TIME + cyclePos * RATE_FACTOR) % 86400
}

/**
 * Call every frame to keep the skybox locked to the cycle.
 * On the client, writes SkyboxTime periodically.
 * On the server, just keeps the time fresh for isNightTime() queries.
 */
export function updateWorldTime(_dt?: number, _applyToSkybox?: boolean): void {
  const gameTime = computeGameTime()

  if (!IS_SERVER) {
    // Update SkyboxTime periodically to lock out player overrides
    const delta = Math.abs(gameTime - lastSkyboxTime)
    // Handle wrap-around (e.g. 86399 -> 100)
    const wrappedDelta = Math.min(delta, 86400 - delta)
    if (wrappedDelta >= UPDATE_INTERVAL || lastSkyboxTime < 0) {
      lastSkyboxTime = gameTime
      SkyboxTime.createOrReplace(engine.RootEntity, { fixedTime: gameTime })
    }
  }
}

/** Get the current world time (0–86400). */
export function getCurrentSkyTime(): number {
  return computeGameTime()
}

/**
 * Returns true when it's night: 6 PM – 6 AM.
 */
export function isNightTime(): boolean {
  const t = computeGameTime()
  return t >= SUNSET_TIME || t < SUNRISE_TIME
}
