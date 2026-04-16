/**
 * Shared client-side utilities — extracted from projectileSystem and trapSystem
 * to eliminate code duplication.
 */
import { engine, Transform, AudioSource, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { Flag } from '../shared/components'

// ── Error sound (cooldown denial) ──
let errorSoundEntity: Entity | null = null

export function playErrorSound(): void {
  if (!errorSoundEntity) {
    errorSoundEntity = engine.addEntity()
    Transform.create(errorSoundEntity, { position: Vector3.Zero() })
    AudioSource.create(errorSoundEntity, {
      audioClipUrl: 'assets/sounds/error.mp3',
      playing: false,
      loop: false,
      volume: 0.6,
      global: true
    })
  }
  const a = AudioSource.getMutable(errorSoundEntity)
  a.currentTime = 0
  a.playing = true
}

// ── Server connection check ──
export function isServerConnected(): boolean {
  return [...engine.getEntitiesWith(Flag)].length > 0
}
