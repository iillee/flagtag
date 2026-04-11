import { engine, Transform, InputModifier, AudioSource, MeshRenderer, Material, MaterialTransparencyMode, Billboard, BillboardMode, VisibilityComponent } from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { movePlayerTo, triggerEmote } from '~system/RestrictedActions'
import { room } from '../shared/messages'
import { isSpectatorMode } from './spectatorSystem'

// Water surface Y level
const WATER_SURFACE_Y = 1.58

// Drowning config
const DROWN_TIME = 10.0 // seconds in water before death
const RECHARGE_TIME = 5.0 // seconds to fully recharge on land
const SPAWN_POSITION = Vector3.create(263, 48, 298)
const BAR_WIDTH = 0.6
const BAR_HEIGHT = 0.08
const BAR_OFFSET_Y = 2.8

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

// Drowning state
let airRemaining = DROWN_TIME // current air in seconds
let drownBarBg: ReturnType<typeof engine.addEntity> | null = null
let drownBarFill: ReturnType<typeof engine.addEntity> | null = null
let drownBarVisible = false
let drownCooldown = 0
let drownSoundEntity: ReturnType<typeof engine.addEntity> | null = null
let respawnDelay = 0

function ensureDrownBar() {
  if (drownBarBg) return

  // Background bar — parented to PlayerEntity
  drownBarBg = engine.addEntity()
  Transform.create(drownBarBg, {
    parent: engine.PlayerEntity,
    position: Vector3.create(0, BAR_OFFSET_Y, 0),
    scale: Vector3.create(BAR_WIDTH, BAR_HEIGHT, 0.01)
  })
  MeshRenderer.setPlane(drownBarBg)
  Material.setPbrMaterial(drownBarBg, {
    albedoColor: Color4.create(0.0, 0.0, 0.1, 0.7),
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    castShadows: false
  })
  Billboard.create(drownBarBg, { billboardMode: BillboardMode.BM_Y })
  VisibilityComponent.create(drownBarBg, { visible: false })

  // Fill bar — child of background
  drownBarFill = engine.addEntity()
  Transform.create(drownBarFill, {
    parent: drownBarBg,
    position: Vector3.create(0, 0, 0.05),
    scale: Vector3.create(1, 1, 1)
  })
  MeshRenderer.setPlane(drownBarFill)
  Material.setPbrMaterial(drownBarFill, {
    albedoColor: Color4.create(0.2, 0.5, 1.0, 0.95),
    emissiveColor: { r: 0.1, g: 0.3, b: 0.8 },
    emissiveIntensity: 2.0,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    castShadows: false
  })
  VisibilityComponent.create(drownBarFill, { visible: false })

  // Death sound
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
  if (show === drownBarVisible) return
  drownBarVisible = show
  if (drownBarBg) {
    const v = VisibilityComponent.getMutable(drownBarBg)
    v.visible = show
  }
  if (drownBarFill) {
    const v = VisibilityComponent.getMutable(drownBarFill)
    v.visible = show
  }
}

function updateDrownBar(fraction: number) {
  if (!drownBarFill) return
  const clamped = Math.max(0, Math.min(1, fraction))
  const fillT = Transform.getMutable(drownBarFill)
  fillT.scale = Vector3.create(clamped, 1, 1)
  fillT.position = Vector3.create(-(1 - clamped) / 2, 0, 0.05)
}

export function waterSystem(dt: number) {
  if (!Transform.has(engine.PlayerEntity)) return
  if (isSpectatorMode()) return

  ensureDrownBar()

  const playerPos = Transform.get(engine.PlayerEntity).position
  const inWater = playerPos.y <= WATER_SURFACE_Y && isInWaterZone(playerPos.x, playerPos.z)

  // Respawn delay — waiting for death emote to play
  if (respawnDelay > 0) {
    respawnDelay -= dt
    if (respawnDelay <= 0) {
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({ disableAll: false })
      })
      drownCooldown = 2.0
      airRemaining = DROWN_TIME
      setBarVisible(false)
      void movePlayerTo({ newRelativePosition: SPAWN_POSITION })
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
    // Drain air
    airRemaining -= dt
    if (airRemaining < 0) airRemaining = 0

    setBarVisible(true)
    updateDrownBar(airRemaining / DROWN_TIME)

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

      void triggerEmote({ predefinedEmote: 'urn:decentraland:matic:collections-v2:0x7bdc37ff3e8dca2d69f01a3dc34f3ad82e2e1870:0' })
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({ disableAll: true })
      })

      respawnDelay = 2.0
    }
  } else {
    // Recharge air on land
    if (airRemaining < DROWN_TIME) {
      airRemaining += (DROWN_TIME / RECHARGE_TIME) * dt
      if (airRemaining >= DROWN_TIME) {
        airRemaining = DROWN_TIME
        setBarVisible(false) // fully recharged — hide bar
      } else {
        setBarVisible(true)
        updateDrownBar(airRemaining / DROWN_TIME)
      }
    }
  }

  // Water sound — play when moving in water
  if (inWater && waterSoundEntity) {
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
