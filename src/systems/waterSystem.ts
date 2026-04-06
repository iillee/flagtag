import { engine, Transform, InputModifier, AudioSource, inputSystem, InputAction } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { isSpectatorMode } from './spectatorSystem'

// Water surface Y level (both water planes are at y ≈ 0.58)
const WATER_SURFACE_Y = 0.58

let wasInWater = false
let waterSoundEntity: ReturnType<typeof engine.addEntity> | null = null
let lastPlayerPos = Vector3.Zero()

export function waterSystem() {
  if (!Transform.has(engine.PlayerEntity)) return
  if (isSpectatorMode()) return

  const playerPos = Transform.get(engine.PlayerEntity).position
  const inWater = playerPos.y <= WATER_SURFACE_Y

  // Create water sound entity once
  if (!waterSoundEntity) {
    waterSoundEntity = engine.addEntity()
    Transform.create(waterSoundEntity, { position: Vector3.create(0, 0, 0) })
    AudioSource.create(waterSoundEntity, {
      audioClipUrl: 'assets/sounds/water.mp3',
      playing: false,
      loop: true,
      volume: 1.0,
      global: true
    })
  }

  if (inWater && !wasInWater) {
    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: InputModifier.Mode.Standard({
        disableRun: true
      })
    })
  } else if (!inWater && wasInWater) {
    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: InputModifier.Mode.Standard({
        disableRun: false
      })
    })
  }

  // Play water sound when moving in water, stop when still or out of water
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
