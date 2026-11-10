/**
 * lavaAmbience.ts - Halloween lava ambience (SFX, independent of the music mute).
 *
 * One looping, non-spatial sound on a child of the camera (follows the
 * listener, so `global` playback never fades with distance). Volume rises
 * as the player's Y approaches the live lava surface (getWaterSurfaceY, so
 * the lever rise is included):
 *   target = lerp(MIN, MAX, 1 - clamp((playerY - lavaY) / RANGE_M, 0, 1))
 * smoothed exponentially and written at UPDATE_HZ.
 */
import { engine, Entity, Transform, AudioSource } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { registerThrottled } from './systemManager'
import { getWaterSurfaceY } from './waterSystem'

/** Swap this to drop in a different lava loop. */
export const LAVA_AMBIENCE_SRC = 'assets/sounds/lava.mp3'
export const LAVA_AMBIENCE_MIN_VOLUME = 0.08
export const LAVA_AMBIENCE_MAX_VOLUME = 0.8
/** Height above the lava at which the volume bottoms out at MIN. */
export const LAVA_AMBIENCE_RANGE_M = 40
/** Seconds for the volume to close ~63% of the gap to the target. */
export const LAVA_AMBIENCE_SMOOTH_SEC = 0.5
const UPDATE_INTERVAL_S = 0.1 // ~10 Hz
const VOLUME_EPSILON = 0.005

let ambience: Entity | null = null
let volume = LAVA_AMBIENCE_MIN_VOLUME

/** Pure volume curve (exported for tuning/tests). */
export function lavaAmbienceTarget(playerY: number, lavaY: number): number {
  const d = (playerY - lavaY) / LAVA_AMBIENCE_RANGE_M
  const near = 1 - Math.min(1, Math.max(0, d))
  return LAVA_AMBIENCE_MIN_VOLUME + (LAVA_AMBIENCE_MAX_VOLUME - LAVA_AMBIENCE_MIN_VOLUME) * near
}

function update(dt: number): void {
  if (!ambience || !Transform.has(engine.PlayerEntity)) return
  const target = lavaAmbienceTarget(Transform.get(engine.PlayerEntity).position.y, getWaterSurfaceY())
  const k = 1 - Math.exp(-dt / LAVA_AMBIENCE_SMOOTH_SEC)
  const next = volume + (target - volume) * k
  if (Math.abs(next - volume) < VOLUME_EPSILON) return
  volume = next
  AudioSource.getMutable(ambience).volume = volume
}

export function setupLavaAmbience(): void {
  if (ambience) return
  ambience = engine.addEntity()
  Transform.create(ambience, { parent: engine.CameraEntity, position: Vector3.Zero() })
  AudioSource.create(ambience, {
    audioClipUrl: LAVA_AMBIENCE_SRC,
    playing: true,
    loop: true,
    volume,
    global: true,
  })
  registerThrottled(update, UPDATE_INTERVAL_S)
  console.log('[LavaAmbience] Playing ' + LAVA_AMBIENCE_SRC)
}