/**
 * plantGrowthSystem.ts — "Grow" solo minigame.
 *
 * Plants in/around the castle bloom when the flag carrier walks nearby.
 * After the flag moves away, plants slowly decay and wilt.
 * At round end, the player earns bonus coins based on how many plants
 * are alive (percentage of total).
 *
 * Architecture:
 *   - Scans scene for known plant GLB models on first tick
 *   - Tracks bloom state per plant (dead → growing → bloomed → decaying → dead)
 *   - Uses Transform scale to animate growth/decay
 *   - Only the local flag carrier can grow plants (solo challenge)
 *   - Reports bloom percentage to server at round end for coin rewards
 */

import {
  engine, Transform, GltfContainer, AudioSource, Entity
} from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { Flag, FlagState } from '../shared/components'
import { room } from '../shared/messages'
import { registerSystem } from './systemManager'

// ── Configuration ──
const BLOOM_RADIUS = 10          // meters — flag carrier must be this close to activate
const DECAY_TIME = 120           // seconds — plant stays bloomed after flag leaves
const GROW_SPEED = 0.5           // scale factor per second (0→1 in 2s)
const DECAY_SPEED = 0.25         // scale factor per second (1→0 in 4s)
const MIN_SCALE = 0.01           // "dead" scale
const BLOOM_THRESHOLD = 0.95     // considered "bloomed" at this growth factor

// ── Plant models to detect ──
const PLANT_MODELS = [
  'assets/models/Plant_02/Plant_02.glb',
  'assets/models/Plant_03/Plant_03.glb',
  'assets/models/whiteflowers.glb',
]

// ── State ──

export enum PlantState {
  Dead = 0,
  Growing = 1,
  Bloomed = 2,
  Decaying = 3,
}

interface PlantData {
  entity: Entity
  position: Vector3
  originalScale: Vector3
  state: PlantState
  growthFactor: number    // 0 = dead, 1 = fully bloomed
  decayTimer: number      // seconds remaining before decay begins
  model: string
}

const plants: PlantData[] = []
let scanComplete = false

// ── Public API for UI ──

/** Returns how many plants are bloomed vs total */
export function getPlantProgress(): { bloomed: number; total: number } {
  let bloomed = 0
  for (const p of plants) {
    if (p.growthFactor >= BLOOM_THRESHOLD) bloomed++
  }
  return { bloomed, total: plants.length }
}

/** Returns bloom percentage 0-100 (average growth of all plants) */
export function getBloomPercentage(): number {
  if (plants.length === 0) return 0
  let sum = 0
  for (const p of plants) {
    sum += p.growthFactor
  }
  return Math.round((sum / plants.length) * 100)
}

/** Check if ALL plants are fully bloomed right now */
export function isAllBloomed(): boolean {
  if (plants.length === 0) return false
  return plants.every(p => p.growthFactor >= BLOOM_THRESHOLD)
}

/** Reset all plants to dead (called on round end) */
export function resetAllPlants(): void {
  for (const plant of plants) {
    plant.state = PlantState.Dead
    plant.growthFactor = 0
    plant.decayTimer = 0
    // Scale to minimum
    const t = Transform.getMutable(plant.entity)
    t.scale = Vector3.create(
      plant.originalScale.x * MIN_SCALE,
      plant.originalScale.y * MIN_SCALE,
      plant.originalScale.z * MIN_SCALE
    )
  }
}

// ── Sound ──
let bloomSoundEntity: Entity | null = null

function playBloomSound(position: Vector3): void {
  if (!bloomSoundEntity) {
    bloomSoundEntity = engine.addEntity()
    Transform.create(bloomSoundEntity, { position })
    AudioSource.create(bloomSoundEntity, {
      audioClipUrl: 'assets/sounds/powerup.mp3',
      playing: false, loop: false, volume: 0.15, global: false
    })
  }
  Transform.getMutable(bloomSoundEntity).position = position
  AudioSource.createOrReplace(bloomSoundEntity, {
    audioClipUrl: 'assets/sounds/powerup.mp3',
    playing: true, loop: false, volume: 0.15, global: false
  })
}

// ── Scan for plant entities ──
function scanForPlants(): void {
  for (const [entity] of engine.getEntitiesWith(GltfContainer, Transform)) {
    const gltf = GltfContainer.get(entity)
    if (!PLANT_MODELS.includes(gltf.src)) continue

    const transform = Transform.get(entity)
    const pos = Vector3.create(transform.position.x, transform.position.y, transform.position.z)
    const scale = Vector3.create(transform.scale.x, transform.scale.y, transform.scale.z)

    plants.push({
      entity,
      position: pos,
      originalScale: scale,
      state: PlantState.Dead,
      growthFactor: 0,
      decayTimer: 0,
      model: gltf.src,
    })

    // Start dead (scaled to minimum)
    const t = Transform.getMutable(entity)
    t.scale = Vector3.create(
      scale.x * MIN_SCALE,
      scale.y * MIN_SCALE,
      scale.z * MIN_SCALE
    )
  }

  scanComplete = true
  console.log(`[PlantGrowth] 🌱 Found ${plants.length} plants to track`)
  for (const p of plants) {
    console.log(`  - ${p.model} at (${p.position.x.toFixed(1)}, ${p.position.y.toFixed(1)}, ${p.position.z.toFixed(1)})`)
  }
}

// ── Check if local player is carrying the flag ──
function isLocalPlayerCarrying(): boolean {
  const player = getPlayer()
  if (!player) return false
  const userId = player.userId.toLowerCase()

  for (const [entity] of engine.getEntitiesWith(Flag)) {
    const flag = Flag.get(entity)
    if (flag.state === FlagState.Carried && flag.carrierPlayerId.toLowerCase() === userId) {
      return true
    }
  }
  return false
}

// ── Main system ──
function plantGrowthSystem(dt: number): void {
  // Wait for scene to load before scanning
  if (!scanComplete) {
    const hasEntities = [...engine.getEntitiesWith(GltfContainer)].length > 0
    if (hasEntities) scanForPlants()
    return
  }

  if (plants.length === 0) return

  const clampedDt = Math.min(dt, 0.1)

  // Only grow plants when the LOCAL player carries the flag
  const carrying = isLocalPlayerCarrying()
  let playerPos: Vector3 | null = null
  if (carrying) {
    playerPos = Transform.get(engine.PlayerEntity).position
  }

  for (const plant of plants) {
    const prevFactor = plant.growthFactor

    // Check if flag carrier is in range
    const inRange = carrying && playerPos
      ? Vector3.distance(playerPos, plant.position) <= BLOOM_RADIUS
      : false

    // State machine
    switch (plant.state) {
      case PlantState.Dead:
        if (inRange) {
          plant.state = PlantState.Growing
          plant.decayTimer = DECAY_TIME
        }
        break

      case PlantState.Growing:
        if (inRange) {
          plant.decayTimer = DECAY_TIME
        }
        plant.growthFactor += GROW_SPEED * clampedDt
        if (plant.growthFactor >= 1) {
          plant.growthFactor = 1
          plant.state = PlantState.Bloomed
          if (prevFactor < BLOOM_THRESHOLD) {
            playBloomSound(plant.position)
          }
        }
        if (!inRange && plant.growthFactor < BLOOM_THRESHOLD) {
          plant.state = PlantState.Decaying
        }
        break

      case PlantState.Bloomed:
        if (inRange) {
          plant.decayTimer = DECAY_TIME
        } else {
          plant.decayTimer -= clampedDt
          if (plant.decayTimer <= 0) {
            plant.state = PlantState.Decaying
          }
        }
        break

      case PlantState.Decaying:
        if (inRange) {
          plant.state = PlantState.Growing
          plant.decayTimer = DECAY_TIME
        } else {
          plant.growthFactor -= DECAY_SPEED * clampedDt
          if (plant.growthFactor <= 0) {
            plant.growthFactor = 0
            plant.state = PlantState.Dead
          }
        }
        break
    }

    // Apply scale
    const scaleFactor = MIN_SCALE + (1 - MIN_SCALE) * plant.growthFactor
    const t = Transform.getMutable(plant.entity)
    t.scale = Vector3.create(
      plant.originalScale.x * scaleFactor,
      plant.originalScale.y * scaleFactor,
      plant.originalScale.z * scaleFactor
    )
  }
}

// ── Round-end reporting ──
function setupRoundEndReporting(): void {
  // When the round ends (respawnPlayers message), report bloom percentage to server
  room.onMessage('respawnPlayers', () => {
    const pct = getBloomPercentage()
    if (pct > 0) {
      const player = getPlayer()
      if (player) {
        console.log(`[PlantGrowth] 🌸 Round ended — bloom percentage: ${pct}%`)
        room.send('reportBloomPercentage', { percentage: pct })
      }
    }
    // Reset plants for next round
    resetAllPlants()
  })
}

// ── Setup ──
export function setupPlantGrowth(): void {
  registerSystem(plantGrowthSystem)
  setupRoundEndReporting()
  console.log('[PlantGrowth] 🌱 Plant growth system registered')
}
