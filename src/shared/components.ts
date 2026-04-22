import { engine, Schemas } from '@dcl/sdk/ecs'
import { AUTH_SERVER_PEER_ID } from '@dcl/sdk/network/message-bus-sync'

// ── Flag ──

export enum FlagState {
  AtBase = 'atBase',
  Carried = 'carried',
  Dropped = 'dropped'
}

export const Flag = engine.defineComponent('ctf-flag', {
  teamId: Schemas.Int,
  state: Schemas.EnumString<FlagState>(FlagState, FlagState.AtBase),
  carrierPlayerId: Schemas.String,
  baseX: Schemas.Float,
  baseY: Schemas.Float,
  baseZ: Schemas.Float,
  dropAnchorX: Schemas.Float,
  dropAnchorY: Schemas.Float,
  dropAnchorZ: Schemas.Float
}, {
  teamId: 0,
  state: FlagState.AtBase,
  carrierPlayerId: '',
  baseX: 0, baseY: 0, baseZ: 0,
  dropAnchorX: 0, dropAnchorY: 0, dropAnchorZ: 0
})

Flag.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Player hold time ──

export const PlayerFlagHoldTime = engine.defineComponent('ctf-player-flag-hold-time', {
  playerId: Schemas.String,
  seconds: Schemas.Float
}, { playerId: '', seconds: 0 })

PlayerFlagHoldTime.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

/** Deterministic numeric id for sync entity (same userId => same id on all clients). */
const HOLD_TIME_ENTITY_BASE = 10000

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return h >>> 0
}

export function getHoldTimeEntityEnumId(userId: string): number {
  return HOLD_TIME_ENTITY_BASE + (hashString(userId.toLowerCase()) % 100000)
}

// ── Countdown timer ──

export const CountdownTimer = engine.defineComponent('ctf-countdown-timer', {
  roundEndTimeMs: Schemas.Number,
  roundEndTriggered: Schemas.Boolean,
  roundEndDisplayUntilMs: Schemas.Number,
  roundWinnerJson: Schemas.String
}, {
  roundEndTimeMs: 0,
  roundEndTriggered: false,
  roundEndDisplayUntilMs: 0,
  roundWinnerJson: ''
})

CountdownTimer.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

/** Round length in minutes; aligned to 5-minute UTC boundaries. */
const ROUND_LENGTH_MINUTES = 5

export function getNextRoundEndTimeMs(): number {
  const now = Date.now()
  const intervalMs = ROUND_LENGTH_MINUTES * 60 * 1000
  // Next boundary strictly after now
  return (Math.floor(now / intervalMs) + 1) * intervalMs
}

export function getCountdownSeconds(): number {
  const now = Date.now()
  const intervalMs = ROUND_LENGTH_MINUTES * 60 * 1000
  
  // Pure UTC-based countdown — never pauses, never overridden
  const nextBoundary = (Math.floor(now / intervalMs) + 1) * intervalMs
  return Math.max(0, Math.floor((nextBoundary - now) / 1000))
}

// ── Leaderboard state (synced from server) ──

export const LeaderboardState = engine.defineComponent('ctf-leaderboard-state', {
  json: Schemas.String,
  date: Schemas.String
}, { json: '[]', date: '' })

LeaderboardState.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── All-Time Leaderboard state (synced from server) ──

export const AllTimeLeaderboardState = engine.defineComponent('ctf-alltime-leaderboard-state', {
  json: Schemas.String,
}, { json: '[]' })

AllTimeLeaderboardState.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Shared constants ──

export const FLAG_BASE_POSITION = { x: 230, y: 13, z: 258 }

// ── Red Flag Spawn Points ──
export const FLAG_SPAWN_POINTS = [
  { x: 228.4, y: 2.6, z: 192.5 },      // Spawn Point 1
  { x: 217, y: 8.25, z: 258 },   // Spawn Point 2
  { x: 211.2, y: 13, z: 305.4 } // Spawn Point 3
] as const

/**
 * Three spawn locations for the red flag.
 * Flag will randomly spawn at one of these three locations when a round ends.
 */

/**
 * Get a random spawn point for flag respawn.
 * Used at round end to prevent spawn camping.
 */
export function getRandomSpawnPoint(): { x: number; y: number; z: number } {
  const index = Math.floor(Math.random() * FLAG_SPAWN_POINTS.length)
  const spawnPoint = { ...FLAG_SPAWN_POINTS[index] }
  console.log(`[SpawnSystem] Flag spawning at point ${index + 1}/3: (${spawnPoint.x}, ${spawnPoint.y}, ${spawnPoint.z})`)
  return spawnPoint
}

// ── Visitor Analytics (server-synced) ──

export const VisitorAnalytics = engine.defineComponent('ctf-visitor-analytics', {
  date: Schemas.String,
  visitorDataJson: Schemas.String, // JSON array of visitor records
  onlineCount: Schemas.Int,
  totalUniqueVisitors: Schemas.Int
}, { 
  date: '', 
  visitorDataJson: '[]', 
  onlineCount: 0, 
  totalUniqueVisitors: 0 
})

VisitorAnalytics.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Trap (powerup) ──

export const Trap = engine.defineComponent('ctf-banana', {
  droppedByPlayerId: Schemas.String,
  droppedAtMs: Schemas.Number,       // Date.now() when dropped — used for expiry (server-side only)
}, {
  droppedByPlayerId: '',
  droppedAtMs: 0,
})

Trap.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

/** How long a trap stays on the ground before despawning (seconds). */
export const TRAP_LIFETIME_SEC = 15
/** Cooldown between trap drops (seconds). */
export const TRAP_COOLDOWN_SEC = 5
/** Max traps one player can have on the ground at once. */
export const TRAP_MAX_ACTIVE = 3
/** Radius for trap trigger (meters). */
export const TRAP_TRIGGER_RADIUS = 2.0

/**
 * Sync ID range for traps — monotonically increasing, never recycled.
 * Each new trap gets a unique sync ID for the lifetime of the server process.
 * The entityEnumId space is a 32-bit integer, so we have billions of IDs available.
 * Base starts at 1000000 to avoid collisions with hold-time entities (10000–109999).
 */
const TRAP_SYNC_ID_BASE = 1000000
let trapIdCounter = 0
export function getNextTrapSyncId(): number {
  return TRAP_SYNC_ID_BASE + (trapIdCounter++)
}

// ── Projectile (powerup) ──

export const Projectile = engine.defineComponent('ctf-shell', {
  firedByPlayerId: Schemas.String,
  firedAtMs: Schemas.Number,
  startX: Schemas.Float,          // spawn position — client uses these for local movement prediction
  startY: Schemas.Float,
  startZ: Schemas.Float,
  dirX: Schemas.Float,           // normalized forward direction (XZ plane)
  dirZ: Schemas.Float,
  distanceTraveled: Schemas.Float,
  maxDistance: Schemas.Float,     // wall distance reported by client, or default cap
  active: Schemas.Boolean,       // false once it hits something or expires
}, {
  firedByPlayerId: '',
  firedAtMs: 0,
  startX: 0,
  startY: 0,
  startZ: 0,
  dirX: 0,
  dirZ: 0,
  distanceTraveled: 0,
  maxDistance: 50,
  active: true,
})

Projectile.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

/** Cooldown between projectile fires (seconds). */
export const PROJECTILE_COOLDOWN_SEC = 0.45
/** Max projectiles one player can have in flight at once. */
export const PROJECTILE_MAX_ACTIVE = 1
/** Speed of projectile (meters per second). */
export const PROJECTILE_SPEED = 30
/** Max range if no wall is detected (meters). */
export const PROJECTILE_MAX_RANGE = 50
/** Radius for projectile hitting a player (meters). */
export const PROJECTILE_HIT_RADIUS = 2.0
/** Max time a projectile can exist (seconds) — safety net. */
export const PROJECTILE_LIFETIME_SEC = 8

/**
 * Sync ID range for projectiles — monotonically increasing, never recycled.
 * Each new projectile gets a unique sync ID for the lifetime of the server process.
 * The entityEnumId space is a 32-bit integer, so we have billions of IDs available.
 * Base starts at 2000000 to guarantee no overlap with traps or hold-time entities.
 */
const PROJECTILE_SYNC_ID_BASE = 2000000
let projectileIdCounter = 0
export function getNextProjectileSyncId(): number {
  return PROJECTILE_SYNC_ID_BASE + (projectileIdCounter++)
}

export enum SyncIds {
  FLAG = 1,
  COUNTDOWN = 200,
  LEADERBOARD = 201,
  VISITOR_ANALYTICS = 202,
  ALLTIME_LEADERBOARD = 203
}

export function getTodayDateString(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
