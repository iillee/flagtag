import {
  engine, Transform, GltfContainer, Entity, AudioSource,
  Raycast, RaycastResult, RaycastQueryType,
  MeshRenderer, Material, MaterialTransparencyMode,
  Tween, EasingFunction
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { room } from '../shared/messages'
import { Flag } from '../shared/components'
import { getPlayer } from '@dcl/sdk/players'
import { showShieldForPlayer, hideShieldForPlayer, hideAllShields, setShieldAlpha } from './shieldSystem'

// ── Constants ──
const MUSHROOM_MODEL = 'assets/models/mushroom_03.glb'

const MUSHROOM_PICKUP_RADIUS = 0.5
// Shield lasts until hit or round end (no time limit)
const MUSHROOM_Y_OFFSET = 0.0   // Raise mushroom above ground so it's not buried

// ── Beacon constants (red, matching flag beacon style) ──
// Mushroom beacon removed — was never called

// Scene bounds (10×15 parcels = 160×240m)




const RAY_START_Y = 100  // Cast from high above
const WATER_Y = 1.577    // Y level of water planes

// ── Helpers ──
function isServerConnected(): boolean {
  return [...engine.getEntitiesWith(Flag)].length > 0
}

// ── State ──
interface MushroomVisual {
  id: number
  entity: Entity
  rayEntity: Entity | null
  placed: boolean  // true once raycast found a surface
  x: number
  z: number
  rerolls?: number
}

// ── Boost sound ──
let boostSoundEntity: Entity | null = null
function playBoostSound(): void {
  if (!boostSoundEntity) {
    boostSoundEntity = engine.addEntity()
    Transform.create(boostSoundEntity, { position: Vector3.create(0, 0, 0) })
    AudioSource.create(boostSoundEntity, {
      audioClipUrl: 'assets/sounds/boost.mp3',
      playing: false,
      loop: false,
      volume: 0.25,
      global: true
    })
  }
  const a = AudioSource.getMutable(boostSoundEntity)
  a.playing = false
  a.currentTime = 0
  a.playing = true
}

// ── Shield break sound ──
// playShieldBreakSound + shieldBreakSoundEntity removed — unused

const mushrooms: MushroomVisual[] = []
const pickedUpIds = new Set<number>()  // Prevent sending duplicate pickup requests
const rerollCounts = new Map<number, number>()  // Track rerolls by mushroom id (persists across entity recreation)
const MAX_CLIENT_REROLLS = 5  // Stop sending reroll requests after this many
let positionsRequested = false
// shieldActive removed — mushrooms no longer block hits

// ── Mushroom trail timer (gold orbs at feet after mushroom pickup) ──
const MUSHROOM_TRAIL_DURATION = 5.0 // seconds of gold trail after picking up a mushroom
let mushroomTrailTimer = 0

// ── Trail pool (gold orbs at feet when shield active) ──
const TRAIL_SPAWN_INTERVAL = 0.08
const TRAIL_LIFETIME_MS = 600
const TRAIL_START_SCALE = 0.18
const TRAIL_POOL_SIZE = 15
const TRAIL_MIN_MOVE_DIST = 0.05
const TRAIL_MATERIAL = {
  albedoColor: Color4.create(1.0, 0.82, 0.2, 0.55),
  emissiveColor: Color4.create(1.0, 0.75, 0.1, 1),
  emissiveIntensity: 2.5,
  roughness: 1.0,
  metallic: 0.0,
  specularIntensity: 0.0,
  transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
}
const trailPool: Entity[] = []
let trailPoolIdx = 0
let trailPoolReady = false
let trailSpawnAccum = 0
let lastShieldPlayerPos: Vector3 | null = null
const activeTrailPuffs: { entity: Entity; expiresAt: number }[] = []
const TRAIL_HIDDEN_POS = Vector3.create(0, -100, 0)

function initTrailPool(): void {
  if (trailPoolReady) return
  trailPoolReady = true
  for (let i = 0; i < TRAIL_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: TRAIL_HIDDEN_POS, scale: Vector3.Zero() })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, TRAIL_MATERIAL)
    trailPool.push(e)
  }
}

function spawnTrailPuff(position: Vector3): void {
  initTrailPool()
  const puff = trailPool[trailPoolIdx % TRAIL_POOL_SIZE]
  trailPoolIdx++
  const jitteredPos = Vector3.create(
    position.x + (Math.random() - 0.5) * 0.25,
    position.y + (Math.random() - 0.5) * 0.15,
    position.z + (Math.random() - 0.5) * 0.25,
  )
  const s = TRAIL_START_SCALE * (0.8 + Math.random() * 0.4)
  const t = Transform.getMutable(puff)
  t.position = jitteredPos
  t.scale = Vector3.create(s, s, s)
  Tween.createOrReplace(puff, {
    mode: Tween.Mode.Scale({ start: Vector3.create(s, s, s), end: Vector3.Zero() }),
    duration: TRAIL_LIFETIME_MS,
    easingFunction: EasingFunction.EF_EASEINQUAD,
  })
  activeTrailPuffs.push({ entity: puff, expiresAt: Date.now() + TRAIL_LIFETIME_MS + 50 })
}

function hideTrailPuff(entity: Entity): void {
  const t = Transform.getMutable(entity)
  t.position = TRAIL_HIDDEN_POS
  t.scale = Vector3.Zero()
  if (Tween.has(entity)) Tween.deleteFrom(entity)
}

function cleanupExpiredTrailPuffs(): void {
  const now = Date.now()
  for (let i = activeTrailPuffs.length - 1; i >= 0; i--) {
    if (now >= activeTrailPuffs[i].expiresAt) {
      hideTrailPuff(activeTrailPuffs[i].entity)
      activeTrailPuffs.splice(i, 1)
    }
  }
}

function hideAllTrailPuffs(): void {
  for (const p of activeTrailPuffs) hideTrailPuff(p.entity)
  activeTrailPuffs.length = 0
  trailSpawnAccum = 0
  lastShieldPlayerPos = null
}

// ── Beacon state ──
// setupMushroomBeacon removed — was never called

// ── Message listeners (registered at module scope for reliable delivery) ──
room.onMessage('mushroomPositions', (data) => {
    const positions: { id: number, x: number, z: number }[] = JSON.parse((data as any).mushroomsJson || '[]')
    const fullReset = (data as any).fullReset === true
    console.log('[Mushroom] Received', positions.length, 'mushroom positions from server', fullReset ? '(full reset)' : '(incremental)')

    if (fullReset) {
      // Full round reset — clear all existing mushrooms
      for (const m of mushrooms) {
        if (m.rayEntity) engine.removeEntity(m.rayEntity)
        engine.removeEntity(m.entity)
      }
      mushrooms.length = 0
      pickedUpIds.clear()
      rerollCounts.clear()
    } else {
      // Incremental update — only remove mushrooms whose id matches incoming (reroll/replacement)
      for (const pos of positions) {
        const existingIdx = mushrooms.findIndex(m => m.id === pos.id)
        if (existingIdx >= 0) {
          const old = mushrooms[existingIdx]
          if (old.rayEntity) engine.removeEntity(old.rayEntity)
          engine.removeEntity(old.entity)
          mushrooms.splice(existingIdx, 1)
          pickedUpIds.delete(pos.id)
        }
      }
    }

    // Create mushrooms and start raycasting to find surfaces
    for (const pos of positions) {
      const entity = engine.addEntity()
      // Start hidden underground until raycast finds surface
      Transform.create(entity, {
        position: Vector3.create(pos.x, -100, pos.z),
        scale: Vector3.create(0.25, 0.25, 0.25),
        rotation: Quaternion.fromEulerDegrees(0, Math.random() * 360, 0)
      })
      GltfContainer.create(entity, {
        src: MUSHROOM_MODEL,
        visibleMeshesCollisionMask: 0,
        invisibleMeshesCollisionMask: 0
      })

      // Create raycast entity to find surface
      const rayEntity = engine.addEntity()
      Transform.create(rayEntity, {
        position: Vector3.create(pos.x, RAY_START_Y, pos.z)
      })
      Raycast.create(rayEntity, {
        direction: { $case: 'globalDirection', globalDirection: Vector3.create(0, -1, 0) },
        maxDistance: 200,
        queryType: RaycastQueryType.RQT_HIT_FIRST,
        continuous: false
      })

      mushrooms.push({
        id: pos.id,
        entity,
        rayEntity,
        placed: false,
        x: pos.x,
        z: pos.z
      })
    }
  })

  // Server says a mushroom was picked up
  room.onMessage('mushroomPickedUp', (data) => {
    const mid = (data as any).id as number
    const pid = (data as any).playerId as string
    console.log('[Mushroom] Mushroom', mid, 'picked up by', pid)
    playBoostSound()
    // Activate gold trail for the local player who picked up the mushroom
    const lp = getPlayer()
    if (lp && pid.toLowerCase() === lp.userId?.toLowerCase()) {
      mushroomTrailTimer = MUSHROOM_TRAIL_DURATION
    }
    // Remove the mushroom visual
    for (let i = mushrooms.length - 1; i >= 0; i--) {
      if (mushrooms[i].id === mid) {
        if (mushrooms[i].rayEntity) engine.removeEntity(mushrooms[i].rayEntity!)
        engine.removeEntity(mushrooms[i].entity)
        mushrooms.splice(i, 1)
        break
      }
    }
  })

  // Legacy shield messages — no-op (mushrooms no longer block hits)
  room.onMessage('mushroomShield', () => {})
  room.onMessage('shieldConsumed', () => {})
  room.onMessage('playerShieldActive', () => {})

  // Flag immunity: show shield for duration on flag pickup/steal, fade out over last 1s
  const FADE_DURATION = 1.0 // seconds
  const flagImmunityTimers = new Map<string, number>()

  room.onMessage('flagImmunity', (data) => {
    const pid = (data as any).playerId as string
    const durationMs = (data as any).durationMs as number
    showShieldForPlayer(pid)
    setShieldAlpha(pid, 1.0)
    flagImmunityTimers.set(pid, durationMs / 1000)
  })

  engine.addSystem((dt: number) => {
    for (const [pid, remaining] of flagImmunityTimers) {
      const next = remaining - dt
      if (next <= 0) {
        flagImmunityTimers.delete(pid)
        hideShieldForPlayer(pid)
      } else {
        flagImmunityTimers.set(pid, next)
        // Fade out during the last FADE_DURATION seconds
        if (next < FADE_DURATION) {
          setShieldAlpha(pid, next / FADE_DURATION)
        }
      }
    }
  })

// ── Process pending raycasts ──
function processMushroomRaycasts(): void {
  for (let i = mushrooms.length - 1; i >= 0; i--) {
    const m = mushrooms[i]
    if (m.placed || !m.rayEntity) continue

    const result = RaycastResult.getOrNull(m.rayEntity)
    if (result) {
      let hitY: number
      let hitSurface = false
      if (result.hits.length > 0) {
        hitY = result.hits[0].position!.y
        hitSurface = true
      } else {
        hitY = WATER_Y
      }

      // If landed on or below water level, request a reroll from the server
      if (hitY <= WATER_Y + 0.1) {
        // Track rerolls by mushroom id (persists across entity recreation)
        const rerolls = (rerollCounts.get(m.id) || 0) + 1
        rerollCounts.set(m.id, rerolls)
        if (rerolls >= MAX_CLIENT_REROLLS) {
          // Max rerolls — just place it at water level
          console.log('[Mushroom] Mushroom', m.id, 'max rerolls reached (' + rerolls + '), placing at water level')
          const t = Transform.getMutable(m.entity)
          t.position = Vector3.create(m.x, WATER_Y + 0.2, m.z)
          engine.removeEntity(m.rayEntity)
          m.rayEntity = null
          m.placed = true
          rerollCounts.delete(m.id)
          continue
        }
        console.log('[Mushroom] Mushroom', m.id, 'landed on water at', m.x.toFixed(1), m.z.toFixed(1), '— requesting reroll (' + rerolls + '/' + MAX_CLIENT_REROLLS + ')')
        engine.removeEntity(m.rayEntity)
        m.rayEntity = null
        // Remove this mushroom; server will send new position via mushroomPositions
        engine.removeEntity(m.entity)
        mushrooms.splice(i, 1)
        room.send('rerollMushroom', { id: m.id })
        continue
      }

      const t = Transform.getMutable(m.entity)
      t.position = Vector3.create(m.x, hitY + MUSHROOM_Y_OFFSET, m.z)
      console.log('[Mushroom] Placed mushroom', m.id, 'at', m.x.toFixed(1), hitY.toFixed(1), m.z.toFixed(1), hitSurface ? '(raycast hit)' : '(ground fallback)')
      // Clean up ray entity
      engine.removeEntity(m.rayEntity)
      m.rayEntity = null
      m.placed = true
    }
  }
}

// ── Beacon positioning ──
// ── Client system (called every frame) ──
export function mushroomClientSystem(dt: number): void {
  // Request mushroom positions from server once
  if (!positionsRequested && isServerConnected()) {
    positionsRequested = true
    room.send('requestMushroomPositions', { t: 0 })
  }

  processMushroomRaycasts()

  // ── Orb trail after mushroom pickup ──
  cleanupExpiredTrailPuffs()
  if (mushroomTrailTimer > 0) mushroomTrailTimer -= dt
  const hasMushroomTrail = mushroomTrailTimer > 0

  if (hasMushroomTrail && Transform.has(engine.PlayerEntity)) {
    const pos = Transform.get(engine.PlayerEntity).position
    if (lastShieldPlayerPos === null) {
      lastShieldPlayerPos = Vector3.create(pos.x, pos.y, pos.z)
    }
    const dx2 = pos.x - lastShieldPlayerPos.x
    const dz2 = pos.z - lastShieldPlayerPos.z
    const moved = Math.sqrt(dx2 * dx2 + dz2 * dz2)
    trailSpawnAccum += dt
    if (trailSpawnAccum >= TRAIL_SPAWN_INTERVAL && moved >= TRAIL_MIN_MOVE_DIST) {
      spawnTrailPuff(Vector3.create(pos.x, pos.y + 0.15, pos.z))
      trailSpawnAccum = 0
      lastShieldPlayerPos = Vector3.create(pos.x, pos.y, pos.z)
    }
  } else {
    if (lastShieldPlayerPos !== null) {
      // Trail just ended — clean up any remaining puffs
      hideAllTrailPuffs()
    }
  }

  // Check proximity for pickup (send to server)
  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position

  for (const m of mushrooms) {
    if (!m.placed) continue
    const mPos = Transform.get(m.entity).position
    const dx = playerPos.x - mPos.x
    const dz = playerPos.z - mPos.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    if (dist < MUSHROOM_PICKUP_RADIUS && !pickedUpIds.has(m.id)) {
      pickedUpIds.add(m.id)
      room.send('pickupMushroom', { id: m.id })
    }
  }
}

/** Returns false — mushrooms no longer block hits. */
export function hasMushroomShield(): boolean {
  return false
}

/** Clear effects on round end */
export function clearMushroomShield(): void {
  hideAllShields()
  hideAllTrailPuffs()
  mushroomTrailTimer = 0
  console.log('[Mushroom] Effects cleared (round end)')
}
