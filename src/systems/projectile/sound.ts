/**
 * Projectile sound effects — charge, release, in-flight loop.
 */
import { engine, Transform, AudioSource, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { soundEntities } from './state'

// ── Release sound pool ──
// Pre-create a fixed pool of entities for positional release sounds.
// Rotate through them instead of addEntity/removeEntity per throw.
const RELEASE_SOUND_POOL_SIZE = 6
const releaseSoundPool: Entity[] = []
let releaseSoundPoolIdx = 0
let releaseSoundPoolReady = false

function initReleaseSoundPool(): void {
  if (releaseSoundPoolReady) return
  releaseSoundPoolReady = true
  for (let i = 0; i < RELEASE_SOUND_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: Vector3.create(0, -200, 0) })
    AudioSource.create(e, {
      audioClipUrl: RELEASE_SOUND_SRC,
      playing: false, loop: false, volume: 0, global: false, pitch: 1.0
    })
    releaseSoundPool.push(e)
  }
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
  initReleaseSoundPool()
  const e = releaseSoundPool[releaseSoundPoolIdx % RELEASE_SOUND_POOL_SIZE]
  releaseSoundPoolIdx++
  Transform.getMutable(e).position = pos
  AudioSource.createOrReplace(e, {
    audioClipUrl: RELEASE_SOUND_SRC,
    playing: true, loop: false, volume: 0.35, global: false, pitch: 1.0
  })
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
