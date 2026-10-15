/**
 * sceneLightGate.ts - turns always-on scene lights (portal glow, teleport orb
 * glows) on only inside the evening/night window from shared/dayNight.ts.
 *
 * Proximity lights gate themselves in proximityLights.ts (they keep their
 * nearest-N behaviour inside the window). Lightning flash is a gameplay VFX
 * and is deliberately NOT gated. No fade: LightSource is toggled via `active`,
 * same as the existing proximity code.
 */
import { engine, LightSource, type Entity } from '@dcl/sdk/ecs'
import { lightsEnabledAt } from '../shared/dayNight'

const gated: Entity[] = []
let lastEnabled: boolean | null = null

/** Register a LightSource entity whose `active` should follow the light window. */
export function registerGatedLight(entity: Entity): void {
  gated.push(entity)
  const enabled = lightsEnabledAt(Date.now())
  if (LightSource.has(entity)) LightSource.getMutable(entity).active = enabled
}

/** Call from a throttled system (0.25 s is plenty). */
export function sceneLightGateSystem(): void {
  const enabled = lightsEnabledAt(Date.now())
  if (enabled === lastEnabled) return
  lastEnabled = enabled
  for (const e of gated) {
    if (LightSource.has(e)) LightSource.getMutable(e).active = enabled
  }
  console.log(`[Lights] Scene lights ${enabled ? 'enabled (evening/night)' : 'disabled (daytime)'}`)
}