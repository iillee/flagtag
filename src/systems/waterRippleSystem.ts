/**
 * Water Ripple System
 * 
 * Spawns expanding, fading ring ripples at the player's feet while walking in water.
 * Uses a pool of flat cylinder entities with alpha-blended materials.
 */
import {
  engine, Transform, MeshRenderer, Material, MaterialTransparencyMode, Entity
} from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { isSpectatorMode } from './spectatorSystem'

// Must match waterSystem.ts
const WATER_SURFACE_Y = 0.58

// Reuse water zone polygons from waterSystem
type Polygon = [number, number][]
const WATER_POLYGONS: Polygon[] = [
  [[40, 113.9], [40, 168.5], [72.4, 168.5], [72.4, 114.2]],
  [[47.4, 88], [60.6, 65.5], [98, 87.6], [84.9, 110]],
]

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

// ── Ripple config ──
const POOL_SIZE = 8
const RIPPLE_LIFETIME = 1.2      // seconds
const RIPPLE_START_SCALE = 0.3   // initial ring diameter
const RIPPLE_END_SCALE = 3.0     // final ring diameter
const RIPPLE_SPAWN_INTERVAL = 0.25 // seconds between ripples while moving
const RIPPLE_Y_OFFSET = 0.1      // above water bob range (±0.06) to stay visible
const HIDDEN_POS = Vector3.create(0, -200, 0)

// ── Ripple pool ──
interface Ripple {
  entity: Entity
  spawnTime: number
  active: boolean
  x: number
  z: number
  waterY: number
}

const ripplePool: Ripple[] = []
let poolIdx = 0
let spawnTimer = 0
let lastPlayerPos = Vector3.Zero()
let initialized = false

function initPool() {
  for (let i = 0; i < POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, {
      position: HIDDEN_POS,
      scale: Vector3.Zero(),
    })
    MeshRenderer.setCylinder(e, 0.5, 0.5)
    Material.setPbrMaterial(e, {
      albedoColor: Color4.create(1, 1, 1, 0.35),
      emissiveColor: Color4.create(0.8, 0.9, 1, 1),
      emissiveIntensity: 0.3,
      roughness: 1,
      metallic: 0,
      specularIntensity: 0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
      castShadows: false,
    })
    ripplePool.push({
      entity: e,
      spawnTime: 0,
      active: false,
      x: 0, z: 0, waterY: 0
    })
  }
}

function spawnRipple(x: number, z: number, waterY: number) {
  const ripple = ripplePool[poolIdx % POOL_SIZE]
  poolIdx++

  ripple.active = true
  ripple.spawnTime = Date.now()
  ripple.x = x
  ripple.z = z
  ripple.waterY = waterY

  const t = Transform.getMutable(ripple.entity)
  t.position = Vector3.create(x, waterY + RIPPLE_Y_OFFSET, z)
  const s = RIPPLE_START_SCALE
  t.scale = Vector3.create(s, 0.01, s)
}

export function waterRippleSystem(dt: number) {
  if (!initialized) {
    initPool()
    initialized = true
  }

  // Animate active ripples
  const now = Date.now()
  for (const ripple of ripplePool) {
    if (!ripple.active) continue

    const age = (now - ripple.spawnTime) / 1000
    const progress = age / RIPPLE_LIFETIME

    if (progress >= 1) {
      ripple.active = false
      const t = Transform.getMutable(ripple.entity)
      t.position = HIDDEN_POS
      t.scale = Vector3.Zero()
      continue
    }

    // Scale expands
    const scale = RIPPLE_START_SCALE + (RIPPLE_END_SCALE - RIPPLE_START_SCALE) * progress
    const t = Transform.getMutable(ripple.entity)
    t.position = Vector3.create(ripple.x, ripple.waterY + RIPPLE_Y_OFFSET, ripple.z)
    t.scale = Vector3.create(scale, 0.01, scale)

    // Fade out alpha
    const alpha = 0.35 * (1 - progress * progress)
    Material.setPbrMaterial(ripple.entity, {
      albedoColor: Color4.create(1, 1, 1, alpha),
      emissiveColor: Color4.create(0.8, 0.9, 1, 1),
      emissiveIntensity: 0.3,
      roughness: 1,
      metallic: 0,
      specularIntensity: 0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
      castShadows: false,
    })
  }

  // Spawn new ripples while player moves in water
  if (!Transform.has(engine.PlayerEntity)) return
  if (isSpectatorMode()) return

  const playerPos = Transform.get(engine.PlayerEntity).position
  const inWater = playerPos.y <= WATER_SURFACE_Y && isInWaterZone(playerPos.x, playerPos.z)

  if (inWater) {
    const dx = playerPos.x - lastPlayerPos.x
    const dz = playerPos.z - lastPlayerPos.z
    const isMoving = (dx * dx + dz * dz) > 0.0001

    if (isMoving) {
      spawnTimer += dt
      if (spawnTimer >= RIPPLE_SPAWN_INTERVAL) {
        spawnTimer = 0
        spawnRipple(playerPos.x, playerPos.z, WATER_SURFACE_Y)
      }
    } else {
      spawnTimer = RIPPLE_SPAWN_INTERVAL * 0.8 // nearly ready to spawn when moving again
    }
  } else {
    spawnTimer = 0
  }

  lastPlayerPos = playerPos
}
