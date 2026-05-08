/**
 * Boost Trail System
 * 
 * Spawns colored orb trails at the player's feet during speed boosts.
 * Gold orbs for mushroom boost, light blue/white orbs for coin boost.
 * Driven by the speedBoostSystem's active state.
 */
import {
  engine, Transform, Entity, MeshRenderer, Material, MaterialTransparencyMode,
  Tween, EasingFunction
} from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { isSpeedBoosted, getBoostTier } from './speedBoostSystem'

// ── Config ──
const TRAIL_SPAWN_INTERVAL = 0.08
const TRAIL_LIFETIME_MS = 600
const TRAIL_START_SCALE = 0.18
const TRAIL_POOL_SIZE = 20
const TRAIL_MIN_MOVE_DIST = 0.05
const TRAIL_HIDDEN_POS = Vector3.create(0, -100, 0)

// ── Materials ──
const MUSHROOM_MATERIAL = {
  albedoColor: Color4.create(1.0, 0.2, 0.15, 0.55),
  emissiveColor: Color4.create(1.0, 0.1, 0.05, 1),
  emissiveIntensity: 2.5,
  roughness: 1.0,
  metallic: 0.0,
  specularIntensity: 0.0,
  transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
}

const COIN_MATERIAL = {
  albedoColor: Color4.create(1.0, 0.82, 0.2, 0.55),
  emissiveColor: Color4.create(1.0, 0.75, 0.1, 1),
  emissiveIntensity: 2.5,
  roughness: 1.0,
  metallic: 0.0,
  specularIntensity: 0.0,
  transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
}

// ── State ──
const trailPool: Entity[] = []
let trailPoolIdx = 0
let trailPoolReady = false
let trailSpawnAccum = 0
let lastPlayerPos: Vector3 | null = null
let lastTier: string = 'none'
const activePuffs: { entity: Entity; expiresAt: number }[] = []

function initTrailPool(): void {
  if (trailPoolReady) return
  trailPoolReady = true
  for (let i = 0; i < TRAIL_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: TRAIL_HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, COIN_MATERIAL) // default, will be overridden per-spawn
    trailPool.push(e)
  }
}

function spawnPuff(position: Vector3, tier: string): void {
  initTrailPool()
  const puff = trailPool[trailPoolIdx % TRAIL_POOL_SIZE]
  trailPoolIdx++

  const jittered = Vector3.create(
    position.x + (Math.random() - 0.5) * 0.25,
    position.y + (Math.random() - 0.5) * 0.15,
    position.z + (Math.random() - 0.5) * 0.25,
  )
  const s = TRAIL_START_SCALE * (0.8 + Math.random() * 0.4)

  const t = Transform.getMutable(puff)
  t.position = jittered
  t.scale = Vector3.create(s, s, s)

  // Set color based on tier
  Material.setPbrMaterial(puff, tier === 'mushroom' ? MUSHROOM_MATERIAL : COIN_MATERIAL)

  Tween.createOrReplace(puff, {
    mode: Tween.Mode.Scale({ start: Vector3.create(s, s, s), end: Vector3.Zero() }),
    duration: TRAIL_LIFETIME_MS,
    easingFunction: EasingFunction.EF_EASEINQUAD,
  })

  activePuffs.push({ entity: puff, expiresAt: Date.now() + TRAIL_LIFETIME_MS + 50 })
}

function hidePuff(entity: Entity): void {
  const t = Transform.getMutable(entity)
  t.position = TRAIL_HIDDEN_POS
  t.scale = Vector3.Zero()
  if (Tween.has(entity)) Tween.deleteFrom(entity)
}

function cleanupExpired(): void {
  const now = Date.now()
  for (let i = activePuffs.length - 1; i >= 0; i--) {
    if (now >= activePuffs[i].expiresAt) {
      hidePuff(activePuffs[i].entity)
      activePuffs.splice(i, 1)
    }
  }
}

function hideAll(): void {
  for (const p of activePuffs) hidePuff(p.entity)
  activePuffs.length = 0
  trailSpawnAccum = 0
  lastPlayerPos = null
}

/** Per-frame system */
export function boostTrailSystem(dt: number): void {
  cleanupExpired()

  const boosted = isSpeedBoosted()
  const tier = getBoostTier()

  if (!boosted) {
    if (lastTier !== 'none') {
      hideAll()
      lastTier = 'none'
    }
    return
  }

  lastTier = tier

  if (!Transform.has(engine.PlayerEntity)) return
  const pos = Transform.get(engine.PlayerEntity).position

  if (lastPlayerPos === null) {
    lastPlayerPos = Vector3.create(pos.x, pos.y, pos.z)
  }

  const dx = pos.x - lastPlayerPos.x
  const dz = pos.z - lastPlayerPos.z
  const moved = Math.sqrt(dx * dx + dz * dz)

  trailSpawnAccum += dt
  if (trailSpawnAccum >= TRAIL_SPAWN_INTERVAL && moved >= TRAIL_MIN_MOVE_DIST) {
    spawnPuff(Vector3.create(pos.x, pos.y + 0.15, pos.z), tier)
    trailSpawnAccum = 0
    lastPlayerPos = Vector3.create(pos.x, pos.y, pos.z)
  }
}
