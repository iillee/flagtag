import {
  engine, Transform, GltfContainer, Entity, AudioSource,
  Raycast, RaycastResult, RaycastQueryType,
  Tween, EasingFunction
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { room } from '../shared/messages'
import { Flag } from '../shared/components'
import { getPlayer } from '@dcl/sdk/players'
import { showShieldForPlayer, hideShieldForPlayer, hideAllShields, setShieldAlpha } from './shieldSystem'
import { addMushroomSpeedBoost } from './speedBoostSystem'


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
  candidates: { x: number; z: number }[]
  candidateIndex: number
}

// ── Boost sound ──
let boostSoundEntity: Entity | null = null
function playBoostSound(): void {
  if (!boostSoundEntity) {
    boostSoundEntity = engine.addEntity()
    Transform.create(boostSoundEntity, { position: Vector3.create(0, 0, 0) })
    AudioSource.create(boostSoundEntity, {
      audioClipUrl: 'assets/sounds/powerup.mp3',
      playing: false,
      loop: false,
      volume: 0.0625,
      global: true
    })
  }
  AudioSource.createOrReplace(boostSoundEntity, { audioClipUrl: 'assets/sounds/powerup.mp3', playing: true, loop: false, volume: 0.0625, global: true })
}

// ── Shield break sound ──
// playShieldBreakSound + shieldBreakSoundEntity removed — unused

const mushrooms: MushroomVisual[] = []
const pickedUpIds = new Set<number>()  // Prevent sending duplicate pickup requests
let positionsRequested = false
// shieldActive removed — mushrooms no longer block hits



// ── Beacon state ──
// setupMushroomBeacon removed — was never called

// ── Message listeners (registered at module scope for reliable delivery) ──
room.onMessage('mushroomPositions', (data) => {
    const positions: { id: number, candidates: { x: number, z: number }[] }[] = JSON.parse((data as any).mushroomsJson || '[]')
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
    } else {
      // Incremental update — only remove mushrooms whose id matches incoming (replacement)
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

    // Create mushrooms and start raycasting first candidate
    for (const pos of positions) {
      const candidates = pos.candidates
      if (candidates.length === 0) continue
      const first = candidates[0]

      const entity = engine.addEntity()
      // Start hidden underground until raycast finds surface
      Transform.create(entity, {
        position: Vector3.create(first.x, -100, first.z),
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
        position: Vector3.create(first.x, RAY_START_Y, first.z)
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
        candidates,
        candidateIndex: 0
      })
    }
  })

  // Server says a mushroom was picked up
  room.onMessage('mushroomPickedUp', (data) => {
    const mid = (data as any).id as number
    const pid = (data as any).playerId as string
    console.log('[Mushroom] Mushroom', mid, 'picked up by', pid)
    playBoostSound()
    // Speed boost for the local player who picked up the mushroom
    const lp = getPlayer()
    if (lp && pid.toLowerCase() === lp.userId?.toLowerCase()) {
      addMushroomSpeedBoost()
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
    const expired: string[] = []
    for (const [pid, remaining] of flagImmunityTimers) {
      const next = remaining - dt
      if (next <= 0) {
        expired.push(pid)
      } else {
        flagImmunityTimers.set(pid, next)
        // Fade out during the last FADE_DURATION seconds
        if (next < FADE_DURATION) {
          setShieldAlpha(pid, next / FADE_DURATION)
        }
      }
    }
    for (const pid of expired) {
      flagImmunityTimers.delete(pid)
      hideShieldForPlayer(pid)
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

      const currentCandidate = m.candidates[m.candidateIndex]

      // If landed on or below water level, try the next candidate
      if (hitY <= WATER_Y + 0.1) {
        engine.removeEntity(m.rayEntity)
        m.rayEntity = null

        m.candidateIndex++
        if (m.candidateIndex >= m.candidates.length) {
          // All candidates exhausted — place at water level as fallback
          console.log('[Mushroom] Mushroom', m.id, 'all', m.candidates.length, 'candidates on water, placing at water level')
          const t = Transform.getMutable(m.entity)
          t.position = Vector3.create(currentCandidate.x, WATER_Y + 0.2, currentCandidate.z)
          m.placed = true
          continue
        }

        // Try next candidate
        const next = m.candidates[m.candidateIndex]
        console.log('[Mushroom] Mushroom', m.id, 'candidate', m.candidateIndex - 1, 'on water, trying candidate', m.candidateIndex)

        // Move the mushroom entity to new candidate (still hidden)
        const mt = Transform.getMutable(m.entity)
        mt.position = Vector3.create(next.x, -100, next.z)

        // New raycast for next candidate
        const rayEntity = engine.addEntity()
        Transform.create(rayEntity, {
          position: Vector3.create(next.x, RAY_START_Y, next.z)
        })
        Raycast.create(rayEntity, {
          direction: { $case: 'globalDirection', globalDirection: Vector3.create(0, -1, 0) },
          maxDistance: 200,
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          continuous: false
        })
        m.rayEntity = rayEntity
        continue
      }

      const t = Transform.getMutable(m.entity)
      t.position = Vector3.create(currentCandidate.x, hitY + MUSHROOM_Y_OFFSET, currentCandidate.z)
      console.log('[Mushroom] Placed mushroom', m.id, 'at', currentCandidate.x.toFixed(1), hitY.toFixed(1), currentCandidate.z.toFixed(1), hitSurface ? '(raycast hit)' : '(ground fallback)', 'candidate', m.candidateIndex)
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

  // Check proximity for pickup (send to server)
  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position

  for (const m of mushrooms) {
    if (!m.placed) continue
    const mPos = Transform.get(m.entity).position
    const dx = playerPos.x - mPos.x
    const dy = playerPos.y - mPos.y
    const dz = playerPos.z - mPos.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    if (dist < MUSHROOM_PICKUP_RADIUS && dy >= -0.5 && dy <= 2.0 && !pickedUpIds.has(m.id)) {
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
  console.log('[Mushroom] Effects cleared (round end)')
}
