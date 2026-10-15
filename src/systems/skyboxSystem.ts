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
import { getSkyboxSecondsAt } from '../shared/dayNight'

const WRITE_INTERVAL_S = 0.1

let installed = false
let writeClock = 0

function writeSkybox(): void {
  SkyboxTime.createOrReplace(engine.RootEntity, {
    fixedTime: Math.floor(getSkyboxSecondsAt(Date.now())),
    transitionMode: TransitionMode.TM_FORWARD
  })
}

export function setupSkybox(): void {
  if (installed) return
  installed = true
  writeSkybox()
  engine.addSystem((dt: number) => {
    writeClock += dt
    if (writeClock < WRITE_INTERVAL_S) return
    writeClock = 0
    writeSkybox()
  })
  console.log('[Skybox] Locked to round-aligned day/night cycle (5 min day / 5 min night)')
}