/**
 * Shared day/night cycle utilities.
 *
 * Enforces a 5-minute day/night cycle via SkyboxTime so that
 * players cannot override the skybox with their UI slider.
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

// Day duration in real-world seconds (5 minutes = 300 seconds)
const DAY_DURATION = 60 * 15
// How fast game time advances relative to real time
const RATE_FACTOR = (60 * 60 * 24) / DAY_DURATION
// Update SkyboxTime every game-hour (avoids excessive writes)
const UPDATE_INTERVAL = 10

// Start at midday
let time = 60 * 60 * 8
let setTime = 0

/**
 * Call every frame to advance the day/night cycle.
 * On the client, also writes SkyboxTime to lock out player overrides.
 */
export function updateWorldTime(dt?: number, _applyToSkybox?: boolean): void {
  if (!dt || dt <= 0) return

  time += dt * RATE_FACTOR
  if (time > 86400) time = time % 86400

  if (time - setTime > UPDATE_INTERVAL || setTime === 0) {
    setTime = time
    if (!IS_SERVER) {
      SkyboxTime.createOrReplace(engine.RootEntity, { fixedTime: setTime })
    }
  }
}

/** Get the current world time (0–86400). */
export function getCurrentSkyTime(): number {
  return time
}

/**
 * Returns true when it's night: 6 PM – 6 AM.
 */
export function isNightTime(): boolean {
  return time >= SUNSET_TIME || time < SUNRISE_TIME
}
