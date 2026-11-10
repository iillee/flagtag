/**
 * skyboxSystem.ts - drives the sky from the fixed round-locked cycle in
 * shared/dayNight.ts.
 *
 * Writing SkyboxTime on engine.RootEntity also locks the player's own
 * time-of-day setting while they are in the scene, so nobody can override
 * the cycle locally. Written at 10 Hz with TM_FORWARD (the cycle only ever
 * moves forward), so the renderer's interpolator is not reset every frame.
 * Pattern adapted from dcl-snowdrift/src/client/skybox.ts.
 */
import { engine, SkyboxTime, TransitionMode } from '@dcl/sdk/ecs'
import { getSkyboxSecondsAt, isSkyMovingBackwardAt, skyStepIsBackward } from '../shared/dayNight'

const WRITE_INTERVAL_S = 0.1

let installed = false
let writeClock = 0

let lastWritten = -1
/** Client join time: Halloween sky starts at sunset going forward from here. */
let anchorMs = 0
let lastBackward = false

function writeSkybox(): void {
  const now = Date.now()
  const fixedTime = Math.floor(getSkyboxSecondsAt(now, anchorMs))
  // Skip identical writes (common at the slow cosine turnarounds) so the
  // renderer's interpolator isn't reset with a zero-length step.
  if (fixedTime === lastWritten) return
  // Direction from the actual step since the last write (not the clock
  // phase), so a turnaround can never be declared the wrong way round.
  lastBackward = lastWritten < 0 ? isSkyMovingBackwardAt(now, anchorMs) : skyStepIsBackward(lastWritten, fixedTime, lastBackward)
  lastWritten = fixedTime
  SkyboxTime.createOrReplace(engine.RootEntity, {
    fixedTime,
    transitionMode: lastBackward ? TransitionMode.TM_BACKWARD : TransitionMode.TM_FORWARD
  })
}

export function setupSkybox(): void {
  if (installed) return
  installed = true
  anchorMs = Date.now()
  writeSkybox() // first write immediately at setup, before any other client init
  engine.addSystem((dt: number) => {
    writeClock += dt
    if (writeClock < WRITE_INTERVAL_S) return
    writeClock = 0
    writeSkybox()
  })
  console.log('[Skybox] Locked to round-aligned day/night cycle (5 min day / 5 min night)')
}