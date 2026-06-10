/**
 * Shared day/night cycle utilities.
 *
 * Accelerated cycle synced across all players via Date.now():
 *   30 minutes real time = 1 full day/night cycle
 *   15 minutes day (sunrise → sunset)
 *   15 minutes night (sunset → sunrise)
 *
 * Skybox time range: 0–72000
 *   0     = midnight
 *   18000 = sunrise  (6 AM)
 *   36000 = noon
 *   54000 = sunset   (6 PM)
 *   72000 = midnight again
 */

import { engine, SkyboxTime } from '@dcl/sdk/ecs'
import { isCinematicActive } from '../gameState/cinematicState'

// Cycle config
const CYCLE_DURATION_SECONDS = 30 * 60  // 30 real-world minutes = 1 full cycle (15 day, 15 night)
const SKYBOX_MAX = 72000

// Night window in skybox time: sunset (54000) → sunrise (18000)
const SUNSET_SKY = 54000   // 6 PM skybox time
const SUNRISE_SKY = 18000  // 6 AM skybox time

let currentSkyTime = 36000  // cached value

let lastAppliedSkyTime = -1

/**
 * Call periodically (e.g. from a system) to update the skybox.
 * Uses Date.now() so all players compute the same time regardless of join time.
 * Set applyToSkybox=false on the server side (no rendering needed).
 *
 * During cinematics (black screen), we still compute the time but skip
 * applying to the skybox. When the cinematic ends, the skybox jumps
 * to the correct time — hidden behind the black fade.
 */
export function updateWorldTime(applyToSkybox: boolean = true): void {
  const nowSeconds = Date.now() / 1000
  const cycleProgress = (nowSeconds % CYCLE_DURATION_SECONDS) / CYCLE_DURATION_SECONDS
  currentSkyTime = Math.floor(cycleProgress * SKYBOX_MAX) % SKYBOX_MAX

  // Apply to skybox — skip during cinematic so the jump is hidden
  if (applyToSkybox && !isCinematicActive()) {
    lastAppliedSkyTime = currentSkyTime
    SkyboxTime.createOrReplace(engine.RootEntity, { fixedTime: currentSkyTime })
  }
}

/** Get the current sky time (0–72000). */
export function getCurrentSkyTime(): number {
  return currentSkyTime
}

/**
 * Returns true when it's night: sunset (54000) → midnight → sunrise (18000).
 * Night = skyTime >= 54000 OR skyTime < 18000
 */
export function isNightTime(): boolean {
  return currentSkyTime >= SUNSET_SKY || currentSkyTime < SUNRISE_SKY
}
