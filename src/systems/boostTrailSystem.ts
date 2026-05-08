/**
 * Boost Trail System
 * 
 * Spawns colored orb trails at players' feet during speed boosts.
 * Gold orbs for coin boost, gold orbs for mushroom boost.
 * Local player trail driven by speedBoostSystem state.
 * Remote player trails driven by 'boostStarted' messages (within 32m).
 */
import {
  engine, Transform, Entity, MeshRenderer, Material, MaterialTransparencyMode,
  Tween, EasingFunction, PlayerIdentityData
} from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { isSpeedBoosted, getBoostTier } from './speedBoostSystem'
import { room } from '../shared/messages'

// ── Config ──
const TRAIL_SPAWN_INTERVAL = 0.08
const TRAIL_LIFETIME_MS = 600
const TRAIL_START_SCALE = 0.18
const TRAIL_POOL_SIZE = 40 // increased for remote players
const TRAIL_MIN_MOVE_DIST = 0.05
const TRAIL_HIDDEN_POS = Vector3.create(0, -100, 0)
const REMOTE_PROXIMITY = 32 // meters — only show trails for players within this range

// ── Materials ──
const MUSHROOM_MATERIAL = {
  albedoColor: Color4.create(1.0, 0.85, 0.1, 0.55),
  emissiveColor: Color4.create(1.0, 0.75, 0.0, 1),
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

// ── Pool ──
const trailPool: Entity[] = []
let trailPoolIdx = 0
let trailPoolReady = false
const activePuffs: { entity: Entity; expiresAt: number }[] = []

function initTrailPool(): void {
  if (trailPoolReady) return
  trailPoolReady = true
  for (let i = 0; i < TRAIL_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: TRAIL_HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, COIN_MATERIAL)
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

// ── Local player state ──
let localSpawnAccum = 0
let localLastPos: Vector3 | null = null
let localLastTier: string = 'none'

// ── Remote player boost tracking ──
interface RemoteBoost {
  tier: string
  timer: number
  lastPos: Vector3 | null
  spawnAccum: number
}
const remoteBoosts: Map<string, RemoteBoost> = new Map()

/** Set up message listener for remote boost broadcasts */
export function setupBoostTrailMessages(): void {
  room.onMessage('playerBoosted', (data) => {
    const playerId = data.playerId
    if (!playerId) return
    // Skip our own messages
    const local = getPlayer()
    if (local && playerId === local.userId.toLowerCase()) return

    const existing = remoteBoosts.get(playerId)
    if (existing) {
      existing.tier = data.tier
      existing.timer = data.duration
    } else {
      remoteBoosts.set(playerId, {
        tier: data.tier,
        timer: data.duration,
        lastPos: null,
        spawnAccum: 0,
      })
    }
  })
}

/** Find a remote player's world position via PlayerIdentityData */
function getRemotePlayerPos(playerId: string): Vector3 | null {
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address.toLowerCase() === playerId) {
      return Transform.get(entity).position
    }
  }
  return null
}

/** Per-frame system */
export function boostTrailSystem(dt: number): void {
  cleanupExpired()

  const localPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : null

  // ── Local player trail ──
  const boosted = isSpeedBoosted()
  const tier = getBoostTier()

  if (!boosted) {
    if (localLastTier !== 'none') {
      localSpawnAccum = 0
      localLastPos = null
      localLastTier = 'none'
    }
  } else {
    localLastTier = tier
    if (localPos) {
      if (localLastPos === null) {
        localLastPos = Vector3.create(localPos.x, localPos.y, localPos.z)
      }
      const dx = localPos.x - localLastPos.x
      const dz = localPos.z - localLastPos.z
      const moved = Math.sqrt(dx * dx + dz * dz)

      localSpawnAccum += dt
      if (localSpawnAccum >= TRAIL_SPAWN_INTERVAL && moved >= TRAIL_MIN_MOVE_DIST) {
        spawnPuff(Vector3.create(localPos.x, localPos.y + 0.15, localPos.z), tier)
        localSpawnAccum = 0
        localLastPos = Vector3.create(localPos.x, localPos.y, localPos.z)
      }
    }
  }

  // ── Remote player trails ──
  for (const [playerId, boost] of remoteBoosts) {
    boost.timer -= dt
    if (boost.timer <= 0) {
      remoteBoosts.delete(playerId)
      continue
    }

    // Find remote player position
    const remotePos = getRemotePlayerPos(playerId)
    if (!remotePos) continue

    // Proximity check — only spawn if within range
    if (localPos) {
      const dx = localPos.x - remotePos.x
      const dy = localPos.y - remotePos.y
      const dz = localPos.z - remotePos.z
      if (dx * dx + dy * dy + dz * dz > REMOTE_PROXIMITY * REMOTE_PROXIMITY) continue
    }

    if (boost.lastPos === null) {
      boost.lastPos = Vector3.create(remotePos.x, remotePos.y, remotePos.z)
    }

    const dx = remotePos.x - boost.lastPos.x
    const dz = remotePos.z - boost.lastPos.z
    const moved = Math.sqrt(dx * dx + dz * dz)

    boost.spawnAccum += dt
    if (boost.spawnAccum >= TRAIL_SPAWN_INTERVAL && moved >= TRAIL_MIN_MOVE_DIST) {
      spawnPuff(Vector3.create(remotePos.x, remotePos.y + 0.15, remotePos.z), boost.tier)
      boost.spawnAccum = 0
      boost.lastPos = Vector3.create(remotePos.x, remotePos.y, remotePos.z)
    }
  }
}
