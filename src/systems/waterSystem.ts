import { engine, Transform, InputModifier, AudioSource } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { movePlayerTo, triggerEmote } from '~system/RestrictedActions'
import { room } from '../shared/messages'
import { isSpectatorMode } from './spectatorSystem'

// Water surface Y level
const WATER_SURFACE_Y = 1.58

// Drowning config
const DROWN_TIME = 5.0 // seconds in water before death
const RECHARGE_TIME = 5.0 // seconds to fully recharge on land (2x faster)
const SPAWN_POSITION = Vector3.create(263, 48, 298)
// Scene bounds
const SCENE_MIN_X = 0
const SCENE_MAX_X = 512
const SCENE_MIN_Z = 0
const SCENE_MAX_Z = 512

function isInWaterZone(px: number, pz: number): boolean {
  return px >= SCENE_MIN_X && px <= SCENE_MAX_X && pz >= SCENE_MIN_Z && pz <= SCENE_MAX_Z
}

let wasInWater = false
let waterSoundEntity: ReturnType<typeof engine.addEntity> | null = null
let lastPlayerPos = Vector3.Zero()

// Drowning state (exported for UI)
let airRemaining = DROWN_TIME
let drownBarVisible = false
let drownCooldown = 0
let drownSoundEntity: ReturnType<typeof engine.addEntity> | null = null
let respawnDelay = 0
const RESPAWN_DURATION = 10.0 // total respawn time
const DROWN_FADE_IN = 1.5 // seconds to fade to black
const DROWN_FADE_OUT = 1.5 // seconds to fade back at end
let outOfWaterTimer = 3.0 // time spent out of water (start fully charged so no delay at scene load)
const RECHARGE_DELAY = 5.0 // seconds out of water before recharge begins

/** Returns 0..1 fraction of air remaining */
export function getDrownFraction(): number {
  return Math.max(0, Math.min(1, airRemaining / DROWN_TIME))
}

/** Returns true if the drown meter should be displayed */
export function isDrownBarVisible(): boolean {
  return drownBarVisible
}

/** Returns seconds remaining until respawn, or 0 if not drowning */
export function getRespawnCountdown(): number {
  return respawnDelay
}

/** Returns 0..1 opacity for the drown fade overlay */
export function getDrownFadeOpacity(): number {
  if (respawnDelay <= 0) return 0
  const elapsed = RESPAWN_DURATION - respawnDelay
  // Fade in during first DROWN_FADE_IN seconds
  if (elapsed < DROWN_FADE_IN) return elapsed / DROWN_FADE_IN
  // Fade out during last DROWN_FADE_OUT seconds
  if (respawnDelay < DROWN_FADE_OUT) return respawnDelay / DROWN_FADE_OUT
  // Fully black in between
  return 1
}

/** Returns true if player is in drown respawn period */
export function isDrownRespawning(): boolean {
  return respawnDelay > 0
}

/** Returns true if drown text should be visible (before fade-in starts through hold, hidden during fade-out) */
export function isDrownTextVisible(): boolean {
  if (respawnDelay <= 0) return false
  return respawnDelay >= DROWN_FADE_OUT
}

function ensureDrownBar() {
  if (drownSoundEntity) return
  drownSoundEntity = engine.addEntity()
  Transform.create(drownSoundEntity, { position: Vector3.create(0, 0, 0) })
  AudioSource.create(drownSoundEntity, {
    audioClipUrl: 'assets/sounds/gameover.wav',
    playing: false,
    loop: false,
    volume: 1.0,
    global: true
  })
}

function setBarVisible(show: boolean) {
  drownBarVisible = show
}

export function waterSystem(dt: number) {
  if (!Transform.has(engine.PlayerEntity)) return
  if (isSpectatorMode()) return

  ensureDrownBar()

  const playerPos = Transform.get(engine.PlayerEntity).position
  const inWater = playerPos.y <= WATER_SURFACE_Y && isInWaterZone(playerPos.x, playerPos.z)

  // Respawn delay — fade to black, teleport, fade back
  if (respawnDelay > 0) {
    const prevDelay = respawnDelay
    respawnDelay -= dt

    // Teleport once screen is fully black (after fade-in completes)
    const teleportAt = RESPAWN_DURATION - DROWN_FADE_IN
    if (prevDelay > teleportAt && respawnDelay <= teleportAt) {
      void movePlayerTo({ newRelativePosition: SPAWN_POSITION })
    }

    // Stop emote 1 second before respawn
    if (prevDelay > 1.0 && respawnDelay <= 1.0) {
      void triggerEmote({ predefinedEmote: 'wave' })
    }

    if (respawnDelay <= 0) {
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({ disableAll: false })
      })
      drownCooldown = 2.0
      airRemaining = DROWN_TIME
      setBarVisible(false)
    }
    wasInWater = inWater
    lastPlayerPos = playerPos
    return
  }

  // Drown cooldown after respawn
  if (drownCooldown > 0) {
    drownCooldown -= dt
    if (drownCooldown > 0) {
      wasInWater = inWater
      lastPlayerPos = playerPos
      return
    }
  }

  // Create water sound entity once
  if (!waterSoundEntity) {
    waterSoundEntity = engine.addEntity()
    Transform.create(waterSoundEntity, { position: Vector3.create(0, 0, 0) })
    AudioSource.create(waterSoundEntity, {
      audioClipUrl: 'assets/sounds/water.mp3',
      playing: false,
      loop: true,
      volume: 0.5,
      global: true
    })
  }

  // Toggle run disable on water enter/exit
  if (inWater && !wasInWater) {
    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: InputModifier.Mode.Standard({ disableRun: true })
    })
  } else if (!inWater && wasInWater) {
    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: InputModifier.Mode.Standard({ disableRun: false })
    })
  }

  // Drowning / recharge logic
  if (inWater) {
    // Reset out-of-water timer
    outOfWaterTimer = 0

    // Drain air
    airRemaining -= dt
    if (airRemaining < 0) airRemaining = 0

    setBarVisible(true)

    // Death
    if (airRemaining <= 0 && respawnDelay <= 0) {
      console.log('[Water] Player drowned!')
      setBarVisible(false)

      if (drownSoundEntity) {
        const a = AudioSource.getMutable(drownSoundEntity)
        a.currentTime = 0
        a.playing = true
      }

      room.send('requestDrop', { t: 0 })

      if (waterSoundEntity) {
        const a = AudioSource.getMutable(waterSoundEntity)
        a.playing = false
      }

      void triggerEmote({ predefinedEmote: 'urn:decentraland:matic:collections-v2:0x7bdc37ff3e8dca2d69f01a3dc34f3ad82e2e1870:0' })
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({ disableAll: true })
      })

      respawnDelay = RESPAWN_DURATION
    }
  } else {
    // Track time out of water
    outOfWaterTimer += dt

    // Recharge air on land only after 3 seconds out of water
    if (airRemaining < DROWN_TIME) {
      if (outOfWaterTimer >= RECHARGE_DELAY) {
        airRemaining += (DROWN_TIME / RECHARGE_TIME) * dt
        if (airRemaining >= DROWN_TIME) {
          airRemaining = DROWN_TIME
          setBarVisible(false)
        } else {
          setBarVisible(true)
        }
      } else {
        setBarVisible(true) // still show bar during delay
      }
    }
  }

  // Water sound — play when moving in water (but not during respawn)
  if (inWater && waterSoundEntity && respawnDelay <= 0) {
    const dx = playerPos.x - lastPlayerPos.x
    const dz = playerPos.z - lastPlayerPos.z
    const isMoving = (dx * dx + dz * dz) > 0.0001

    const audio = AudioSource.getMutable(waterSoundEntity)
    if (isMoving && !audio.playing) {
      audio.playing = true
    } else if (!isMoving && audio.playing) {
      audio.playing = false
    }
  } else if (!inWater && waterSoundEntity) {
    const audio = AudioSource.getMutable(waterSoundEntity)
    if (audio.playing) {
      audio.playing = false
    }
  }

  wasInWater = inWater
  lastPlayerPos = playerPos
}
