import { engine, Schemas } from '@dcl/sdk/ecs'
import { AUTH_SERVER_PEER_ID } from '@dcl/sdk/network/message-bus-sync'

// ── Sword ──

export enum SwordState {
  AtBase = 'atBase',
  Carried = 'carried',
  Dropped = 'dropped'
}

export const Sword = engine.defineComponent('cg-sword', {
  state: Schemas.EnumString<SwordState>(SwordState, SwordState.AtBase),
  carrierPlayerId: Schemas.String,
  baseX: Schemas.Float,
  baseY: Schemas.Float,
  baseZ: Schemas.Float,
  dropAnchorX: Schemas.Float,
  dropAnchorY: Schemas.Float,
  dropAnchorZ: Schemas.Float
}, {
  state: SwordState.AtBase,
  carrierPlayerId: '',
  baseX: 0, baseY: 0, baseZ: 0,
  dropAnchorX: 0, dropAnchorY: 0, dropAnchorZ: 0
})

Sword.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Infection State (global round state, server-synced) ──

export const InfectionState = engine.defineComponent('cg-infection-state', {
  patientZeroId: Schemas.String,          // userId of the first infected player
  infectedPlayersJson: Schemas.String,    // JSON array of infected player userIds
  humansRemaining: Schemas.Int,           // count of non-infected players
  roundActive: Schemas.Boolean,           // true once Patient Zero is chosen
}, {
  patientZeroId: '',
  infectedPlayersJson: '[]',
  humansRemaining: 0,
  roundActive: false,
})

InfectionState.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Player Infection (per-player, server-synced) ──

export const PlayerInfected = engine.defineComponent('cg-player-infected', {
  playerId: Schemas.String,
  isInfected: Schemas.Boolean,
  infectedAtMs: Schemas.Number,           // Date.now() when infected (0 if human)
  respawnCooldownUntilMs: Schemas.Number, // 0 if alive, timestamp if killed by sword and waiting to respawn
}, {
  playerId: '',
  isInfected: false,
  infectedAtMs: 0,
  respawnCooldownUntilMs: 0,
})

PlayerInfected.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Player Survival Time (replaces PlayerFlagHoldTime) ──

export const PlayerSurvivalTime = engine.defineComponent('cg-player-survival-time', {
  playerId: Schemas.String,
  seconds: Schemas.Float           // how long this player survived as human this round
}, { playerId: '', seconds: 0 })

PlayerSurvivalTime.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

/** Deterministic numeric id for sync entity (same userId => same id on all clients). */
const SURVIVAL_TIME_ENTITY_BASE = 10000

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return h >>> 0
}

export function getSurvivalTimeEntityEnumId(userId: string): number {
  return SURVIVAL_TIME_ENTITY_BASE + (hashString(userId.toLowerCase()) % 100000)
}

/** Deterministic sync ID for PlayerInfected entities. */
const INFECTED_ENTITY_BASE = 200000

export function getInfectedEntityEnumId(userId: string): number {
  return INFECTED_ENTITY_BASE + (hashString(userId.toLowerCase()) % 100000)
}

// ── Infection Constants ──

/** Distance at which a slime infects a human (meters). */
export const INFECTION_RADIUS = 2.0
/** Sword melee attack range (meters). */
export const SWORD_ATTACK_RADIUS = 3.0
/** Seconds a slime is dead after being killed by the sword. */
export const SLIME_RESPAWN_COOLDOWN_SEC = 8
/** Brief immunity after being infected — prevents chain-tag in crowds (ms). */
export const INFECTION_IMMUNITY_MS = 2000

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

// ── Monthly Leaderboard state (synced from server) ──

export const MonthlyLeaderboardState = engine.defineComponent('ctf-monthly-leaderboard-state', {
  json: Schemas.String,
  month: Schemas.String,
}, { json: '[]', month: '' })

MonthlyLeaderboardState.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Shared constants ──

export const SWORD_BASE_POSITION = { x: 230, y: 13, z: 258 }

// ── Sword Spawn Points ──
export const SWORD_SPAWN_POINTS = [
  { x: 228.4, y: 2.6, z: 192.5 },      // Spawn Point 1
  { x: 217, y: 8.25, z: 258 },          // Spawn Point 2
  { x: 211.2, y: 13, z: 305.4 }         // Spawn Point 3
] as const

/**
 * Get a random spawn point for sword respawn.
 * Used at round start / after sword is dropped.
 */
export function getRandomSpawnPoint(): { x: number; y: number; z: number } {
  const index = Math.floor(Math.random() * SWORD_SPAWN_POINTS.length)
  const spawnPoint = { ...SWORD_SPAWN_POINTS[index] }
  console.log(`[SpawnSystem] Sword spawning at point ${index + 1}/3: (${spawnPoint.x}, ${spawnPoint.y}, ${spawnPoint.z})`)
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

// ── Monthly Visitor Analytics (synced from server) ──

export const MonthlyVisitorAnalytics = engine.defineComponent('ctf-monthly-visitor-analytics', {
  month: Schemas.String,
  visitorDataJson: Schemas.String, // JSON array of visitor records
  onlineCount: Schemas.Int,
  totalUniqueVisitors: Schemas.Int
}, { 
  month: '', 
  visitorDataJson: '[]', 
  onlineCount: 0, 
  totalUniqueVisitors: 0 
})

MonthlyVisitorAnalytics.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

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
 * Sync ID pool for traps — fixed pool of reusable IDs.
 * Instead of monotonically increasing (which leaves CRDT tombstones that accumulate
 * and eventually saturate the buffer), we reuse a fixed set of slots.
 * Max concurrent traps: 10 players × 3 each = 30. Pool of 40 gives headroom.
 */
const TRAP_SYNC_ID_BASE = 1000000
const TRAP_POOL_SIZE = 40
const trapIdPool: number[] = []
for (let i = 0; i < TRAP_POOL_SIZE; i++) trapIdPool.push(TRAP_SYNC_ID_BASE + i)
export function getNextTrapSyncId(): number {
  // Recycle from pool; if exhausted, wrap around (oldest trap will be overwritten)
  if (trapIdPool.length > 0) return trapIdPool.shift()!
  return TRAP_SYNC_ID_BASE + (Math.floor(Math.random() * TRAP_POOL_SIZE))
}
export function recycleTrapSyncId(id: number): void {
  if (id >= TRAP_SYNC_ID_BASE && id < TRAP_SYNC_ID_BASE + TRAP_POOL_SIZE) {
    if (!trapIdPool.includes(id)) trapIdPool.push(id)
  }
}

export enum SyncIds {
  SWORD = 1,
  INFECTION_STATE = 2,
  COUNTDOWN = 200,
  LEADERBOARD = 201,
  VISITOR_ANALYTICS = 202,
  ALLTIME_LEADERBOARD = 203,
  MONTHLY_LEADERBOARD = 204,
  MONTHLY_VISITOR_ANALYTICS = 205
}

export function getCurrentMonthString(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

export function getTodayDateString(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
