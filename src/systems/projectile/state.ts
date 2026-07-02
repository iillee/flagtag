/**
 * Shared mutable state for the projectile system.
 * All module-level variables live here so sub-modules can read/write them.
 */
import { type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { PROJECTILE_SPEED, PROJECTILE_MAX_RANGE } from '../../shared/components'

// ── Constants ──
export const CHARGE_TIME_SEC = 1.5
export const CHARGE_MIN_SPEED = PROJECTILE_SPEED   // tap = 30 m/s
export const CHARGE_MAX_SPEED = 60
export const CHARGE_MIN_RANGE = 20
export const RED_RANGE = 40
export const CHARGE_MAX_RANGE = PROJECTILE_MAX_RANGE // full charge = 50m
export const BURNOUT_FLASH_MS = 400
export const PROJECTILE_STAGGER_MS = 800
export const PROJECTILE_SPIN_SPEED = 720 // degrees per second
export const PROJECTILE_CHEST_OFFSET = 0.8
export const PROJECTILE_SCALE = Vector3.create(2.5, 4.5, 2.5)
export const LOCAL_THROW_SAFETY_MS = 4000
export const YELLOW_SECOND_THROW_DELAY_MS = 250
export const ORBIT_VISUAL_RADIUS = 3.0
export const ORBIT_FULL_ROTATIONS = 3
export const ORBIT_DURATION_MS = 3500
export const ORBIT_VISUAL_SPEED = (ORBIT_FULL_ROTATIONS * 360) / (ORBIT_DURATION_MS / 1000)
export const ORBIT_RAMP_MS = 400
export const ORBIT_PARTICLE_COUNT = 6
export const ORBIT_RADIUS = 0.5
export const EMOTE_MOVE_THRESHOLD = 0.1

// ── Charge state ──
export const charge = {
  startMs: 0,
  isCharging: false,
  lastGroundY: 0,
  burnoutFlashUntil: 0,
}

// ── Hand boomerang ──
export const hand = {
  entity: null as Entity | null,
  glowEntity: null as Entity | null,
  leftEntity: null as Entity | null,
  orbitParticles: [] as Entity[],
  orbitAngle: 0,
  emoteActive: false,
  lastPlayerPos: null as Vector3 | null,
}

export const HAND_BOOMERANG_SCALE = Vector3.create(1, 1.5, 1)
export const LEFT_HAND_SCALE = Vector3.create(1, 1.5, 1)

// ── Local throw tracking ──
export const localThrow = {
  active: false,
  sawVisual: false,
  startMs: 0,
}

// ── Green orbit ──
export const orbit = {
  entity: null as Entity | null,
  active: false,
  startMs: 0,
  startAngle: 0,
  endMs: 0,
  wallRayEntity: null as Entity | null,
}

// ── Stagger ──
export const stagger = {
  until: 0,
}

// ── Client-side hit prediction dedup ──
// Track shellIds where we already showed hit VFX locally, so server confirmation doesn't double-play
export const predictedHitShellIds = new Set<number>()

// ── Cooldown ──
export const cooldown = {
  lastFireTime: 0,
  extraCooldown: 0,
}

// ── Yellow double-throw ──
export const yellow = {
  secondThrowAt: 0,
  secondThrowDir: { dirX: 0, dirZ: 0 },
}

// ── Sound entities ──
export const soundEntities = {
  charge: null as Entity | null,
  release: null as Entity | null,
}

// ── Local projectiles (offline mode) ──
export interface LocalProjectile {
  entity: Entity
  firedAtMs: number
  startX: number
  startY: number
  startZ: number
  dirX: number
  dirZ: number
  distanceTraveled: number
  maxDistance: number
  speed: number
  wallRayEntity: Entity | null
  currentY: number
  fallVelocity: number
  groundY: number
  onGround: boolean
  groundRayEntity: Entity | null
  lastGroundRayTime: number
  spinAngle: number
  returning: boolean
  returnDistance: number
}
export const localProjectiles: LocalProjectile[] = []

// ── Message-driven visuals ──
export interface MsgProjectileVisual {
  entity: Entity
  shellId: number
  firedBy: string
  startX: number
  startY: number
  startZ: number
  dirX: number
  dirZ: number
  createdAtMs: number
  distanceTraveled: number
  maxDistance: number
  speed: number
  currentY: number
  fallVelocity: number
  groundY: number
  onGround: boolean
  groundRayEntity: Entity | null
  lastGroundRayTime: number
  spinAngle: number
  returning: boolean
  returnDistance: number
}
export const msgProjectileVisuals: MsgProjectileVisual[] = []

// ── Wall raycasts ──
export interface PendingWallRay {
  entity: Entity
}
export const pendingWallRays: PendingWallRay[] = []
