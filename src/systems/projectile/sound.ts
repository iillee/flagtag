/**
 * Projectile sound effects — charge, release, in-flight loop.
 */
import { engine, Transform, AudioSource, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { soundEntities } from './state'
import { registerSystem } from '../systemManager'

// Pooled sound cleanup — single system handles all pending cleanups
const pendingCleanups: { entity: Entity; expireAt: number }[] = []
let _cleanupRegistered = false
function ensureCleanupSystem() {
  if (_cleanupRegistered) return
  _cleanupRegistered = true
  registerSystem((_dt: number) => {
    const now = Date.now()
    for (let i = pendingCleanups.length - 1; i >= 0; i--) {
      if (now >= pendingCleanups[i].expireAt) {
        engine.removeEntity(pendingCleanups[i].entity)
        pendingCleanups.splice(i, 1)
      }
    }
  })
}

const CHARGE_SOUND_SRC = 'assets/sounds/charge.mp3'
const RELEASE_SOUND_SRC = 'assets/sounds/release.mp3'
const PROJECTILE_SOUND_SRC = 'assets/sounds/boomerang2.mp3'

export function playChargeSound(): void {
  if (!soundEntities.charge) {
    soundEntities.charge = engine.addEntity()
    Transform.create(soundEntities.charge, {})
  }
  AudioSource.createOrReplace(soundEntities.charge, {
    audioClipUrl: CHARGE_SOUND_SRC,
    playing: true, loop: false, volume: 0.25, global: true, pitch: 0.6
  })
}

export function stopChargeSound(): void {
  if (soundEntities.charge && AudioSource.has(soundEntities.charge)) {
    AudioSource.createOrReplace(soundEntities.charge, {
      audioClipUrl: CHARGE_SOUND_SRC, playing: false, loop: false, volume: 0, global: true, pitch: 0.6
    })
  }
}

export function playReleaseSound(): void {
  if (!soundEntities.release) {
    soundEntities.release = engine.addEntity()
    Transform.create(soundEntities.release, {})
  }
  AudioSource.createOrReplace(soundEntities.release, {
    audioClipUrl: RELEASE_SOUND_SRC,
    playing: true, loop: false, volume: 0.175, global: true, pitch: 1.0
  })
}

export function playReleaseSoundAt(pos: Vector3): void {
  const e = engine.addEntity()
  Transform.create(e, { position: pos })
  AudioSource.create(e, {
    audioClipUrl: RELEASE_SOUND_SRC,
    playing: true, loop: false, volume: 0.35, global: false, pitch: 1.0
  })
  ensureCleanupSystem()
  pendingCleanups.push({ entity: e, expireAt: Date.now() + 2000 })
}

export function attachProjectileSound(entity: Entity): void {
  AudioSource.createOrReplace(entity, {
    audioClipUrl: PROJECTILE_SOUND_SRC,
    playing: true, loop: true, volume: 1.0, global: false, pitch: 1.3
  })
}

export function stopProjectileSound(entity: Entity): void {
  if (AudioSource.has(entity)) {
    const a = AudioSource.getMutable(entity)
    a.playing = false
    a.volume = 0
    a.loop = false
  }
}
