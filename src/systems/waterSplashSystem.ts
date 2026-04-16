/**
 * Water Splash System
 * 
 * Spawns small splash billboard planes at the player's feet while walking in water.
 * Each splash pops up briefly and fades out.
 */
import {
  engine, Transform, MeshRenderer, Material, MaterialTransparencyMode,
  Billboard, BillboardMode, Entity
} from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { isSpectatorMode } from './spectatorSystem'

// Must match waterSystem.ts
const WATER_SURFACE_Y = 1.58

// Water plane now covers the entire scene (160m × 240m)
function isInWaterZone(px: number, pz: number): boolean {
  return px >= 0 && px <= 512 && pz >= 0 && pz <= 512
}

// ── Splash config ──
const POOL_SIZE = 12
const SPLASH_LIFETIME = 0.5       // seconds — quick pop
const SPLASH_MAX_HEIGHT = 0.6     // how high splashes rise
const SPLASH_SIZE = 0.25          // billboard size
const SPLASH_SPAWN_INTERVAL = 0.15 // seconds between splashes while moving
const SPLASH_SCATTER = 0.4        // random XZ spread around feet
const HIDDEN_POS = Vector3.create(0, -200, 0)

// ── Pool ──
interface Splash {
  entity: Entity
  spawnTime: number
  active: boolean
  startX: number
  startZ: number
  waterY: number
  velX: number
  velZ: number
  velY: number
  lastAlpha: number  // last alpha written to material — skip update if unchanged
}

const splashPool: Splash[] = []
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
    MeshRenderer.setPlane(e)
    Billboard.create(e, { billboardMode: BillboardMode.BM_ALL })
    Material.setPbrMaterial(e, {
      albedoColor: Color4.create(0.85, 0.92, 1, 0.7),
      emissiveColor: Color4.create(0.7, 0.85, 1, 1),
      emissiveIntensity: 0.5,
      roughness: 1,
      metallic: 0,
      specularIntensity: 0,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
      castShadows: false,
    })
    splashPool.push({
      entity: e,
      spawnTime: 0,
      active: false,
      startX: 0, startZ: 0, waterY: 0,
      velX: 0, velZ: 0, velY: 0,
      lastAlpha: 0,
    })
  }
}

function spawnSplash(x: number, z: number, waterY: number) {
  const splash = splashPool[poolIdx % POOL_SIZE]
  poolIdx++

  // Random scatter and upward velocity
  const ox = (Math.random() - 0.5) * SPLASH_SCATTER
  const oz = (Math.random() - 0.5) * SPLASH_SCATTER

  splash.active = true
  splash.spawnTime = Date.now()
  splash.startX = x + ox
  splash.startZ = z + oz
  splash.waterY = waterY
  splash.velX = (Math.random() - 0.5) * 0.5
  splash.velZ = (Math.random() - 0.5) * 0.5
  splash.velY = SPLASH_MAX_HEIGHT / SPLASH_LIFETIME * (1.5 + Math.random() * 0.5)
  splash.lastAlpha = 0.7

  const t = Transform.getMutable(splash.entity)
  t.position = Vector3.create(splash.startX, waterY + 0.1, splash.startZ)
  const s = SPLASH_SIZE * (0.6 + Math.random() * 0.8)
  t.scale = Vector3.create(s, s, s)
}

export function waterSplashSystem(dt: number) {
  if (!initialized) {
    initPool()
    initialized = true
  }

  const now = Date.now()

  // Animate active splashes
  for (const splash of splashPool) {
    if (!splash.active) continue

    const age = (now - splash.spawnTime) / 1000
    const progress = age / SPLASH_LIFETIME

    if (progress >= 1) {
      splash.active = false
      const t = Transform.getMutable(splash.entity)
      t.position = HIDDEN_POS
      t.scale = Vector3.Zero()
      continue
    }

    // Arc upward then fall back (parabolic)
    const yOffset = splash.velY * age - 4 * age * age
    const x = splash.startX + splash.velX * age
    const z = splash.startZ + splash.velZ * age

    const t = Transform.getMutable(splash.entity)
    t.position = Vector3.create(x, splash.waterY + 0.1 + Math.max(0, yOffset), z)

    // Shrink and fade toward end
    const fadeProgress = progress > 0.5 ? (progress - 0.5) / 0.5 : 0
    const scaleMult = 1 - fadeProgress * 0.7
    const baseScale = SPLASH_SIZE * scaleMult
    t.scale = Vector3.create(baseScale, baseScale, baseScale)

    // Only update material when alpha changed meaningfully (saves many setPbrMaterial calls/sec)
    const alpha = 0.7 * (1 - fadeProgress)
    if (Math.abs(alpha - splash.lastAlpha) >= 0.08) {
      splash.lastAlpha = alpha
      Material.setPbrMaterial(splash.entity, {
        albedoColor: Color4.create(0.85, 0.92, 1, alpha),
        emissiveColor: Color4.create(0.7, 0.85, 1, 1),
        emissiveIntensity: 0.5,
        roughness: 1,
        metallic: 0,
        specularIntensity: 0,
        transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
        castShadows: false,
      })
    }
  }

  // Spawn splashes while player moves in water
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
      if (spawnTimer >= SPLASH_SPAWN_INTERVAL) {
        spawnTimer = 0
        // Spawn 2-3 droplets per step
        const count = 2 + Math.floor(Math.random() * 2)
        for (let i = 0; i < count; i++) {
          spawnSplash(playerPos.x, playerPos.z, WATER_SURFACE_Y)
        }
      }
    } else {
      spawnTimer = SPLASH_SPAWN_INTERVAL * 0.8
    }
  } else {
    spawnTimer = 0
  }

  lastPlayerPos = playerPos
}
