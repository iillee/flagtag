/**
 * Spatial audio helper — manually attenuates volume by distance from the player.
 * Only applies on mobile, where `global: false` doesn't attenuate with distance.
 * On desktop, plays normally without any distance check.
 */
import { engine, Transform, AudioSource, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

let mobile = false
export function setSpatialAudioMobile(val: boolean): void { mobile = val }

const MAX_HEAR_DIST = 64
const FULL_VOL_DIST = 8

function getDistanceVolume(soundPos: Vector3): number {
  if (!mobile) return 1
  if (!Transform.has(engine.PlayerEntity)) return 1
  const playerPos = Transform.get(engine.PlayerEntity).position
  const dist = Vector3.distance(playerPos, soundPos)
  if (dist <= FULL_VOL_DIST) return 1
  if (dist >= MAX_HEAR_DIST) return 0
  return 1 - (dist - FULL_VOL_DIST) / (MAX_HEAR_DIST - FULL_VOL_DIST)
}

/**
 * Play a positional sound with mobile distance attenuation workaround.
 * On desktop, behaves identically to a normal AudioSource play.
 */
export function playSpatialSound(
  entity: Entity,
  clipUrl: string,
  position: Vector3,
  baseVolume: number,
  opts?: { loop?: boolean; pitch?: number }
): boolean {
  const volMult = getDistanceVolume(position)
  if (volMult <= 0) {
    if (AudioSource.has(entity)) {
      const a = AudioSource.getMutable(entity)
      a.playing = false
      a.volume = 0
    }
    return false
  }
  if (Transform.has(entity)) {
    Transform.getMutable(entity).position = position
  }
  AudioSource.createOrReplace(entity, {
    audioClipUrl: clipUrl,
    playing: true,
    loop: opts?.loop ?? false,
    volume: baseVolume * volMult,
    global: false,
    pitch: opts?.pitch ?? 1.0
  })
  return true
}
