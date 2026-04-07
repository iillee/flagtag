import { engine, Transform, InputModifier, AudioSource, inputSystem, InputAction } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { isSpectatorMode } from './spectatorSystem'

// Water surface Y level (both water planes are at y ≈ 0.58)
const WATER_SURFACE_Y = 0.58

// Pre-computed world-space corners of each water plane
// (from model corners [0,0],[8,0],[8,-8],[0,-8] × scale × rotation + position)
type Polygon = [number, number][]

const WATER_POLYGONS: Polygon[] = [
  // Water 1 (large rectangle)
  [[40, 113.9], [40, 168.5], [72.4, 168.5], [72.4, 114.2]],
  // Water 2 (rotated diamond)
  [[47.4, 88], [60.6, 65.5], [98, 87.6], [84.9, 110]],
]

// Standard ray-casting point-in-polygon test
function pointInPolygon(px: number, pz: number, poly: Polygon): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1]
    const xj = poly[j][0], zj = poly[j][1]
    if ((zi > pz) !== (zj > pz) &&
        px < (xj - xi) * (pz - zi) / (zj - zi) + xi) {
      inside = !inside
    }
  }
  return inside
}

function isInWaterZone(px: number, pz: number): boolean {
  for (const poly of WATER_POLYGONS) {
    if (pointInPolygon(px, pz, poly)) return true
  }
  return false
}

let wasInWater = false
let waterSoundEntity: ReturnType<typeof engine.addEntity> | null = null
let lastPlayerPos = Vector3.Zero()

export function waterSystem() {
  if (!Transform.has(engine.PlayerEntity)) return
  if (isSpectatorMode()) return

  const playerPos = Transform.get(engine.PlayerEntity).position
  const inWater = playerPos.y <= WATER_SURFACE_Y && isInWaterZone(playerPos.x, playerPos.z)

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
