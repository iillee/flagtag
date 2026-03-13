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
  return HOLD_TIME_ENTITY_BASE + (hashString(userId) % 100000)
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
  
  // Check if we're in the brief "round over" period (server-controlled splash)
  for (const [, timer] of engine.getEntitiesWith(CountdownTimer)) {
    if (timer.roundEndTriggered && now < timer.roundEndDisplayUntilMs) {
      return 0 // Round over splash is showing
    }
    break // Only check the first timer entity
  }
  
  // Pure UTC-based countdown calculation
  // Find the next 5-minute boundary after current time
  const nextBoundary = (Math.floor(now / intervalMs) + 1) * intervalMs
  const secondsToNext = Math.max(0, Math.ceil((nextBoundary - now) / 1000))
  
  // If we get exactly 0, show 300 (5 minutes) to prevent flickering at boundary
  return secondsToNext === 0 ? ROUND_LENGTH_MINUTES * 60 : secondsToNext
}

// ── Leaderboard state (synced from server) ──

export const LeaderboardState = engine.defineComponent('ctf-leaderboard-state', {
  json: Schemas.String,
  date: Schemas.String
}, { json: '[]', date: '' })

LeaderboardState.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

/** Parse the round winner snapshot stored by the server. */
export function getRoundWinners(): { userId: string; name: string }[] {
  for (const [, timer] of engine.getEntitiesWith(CountdownTimer)) {
    if (!timer.roundEndTriggered || !timer.roundWinnerJson) return []
    try {
      return JSON.parse(timer.roundWinnerJson)
    } catch {
      return []
    }
  }
  return []
}

// ── Shared constants ──

export const FLAG_BASE_POSITION = { x: 54, y: 12, z: 122 } // Legacy - kept for compatibility

// ── Red Flag Spawn Points ──
export const FLAG_SPAWN_POINTS = [
  { x: 49, y: 2, z: 74 },      // Spawn Point 1
  { x: 41, y: 7.25, z: 122 },  // Spawn Point 2
  { x: 91, y: 27.25, z: 192.5 } // Spawn Point 3
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

/**
 * Get spawn point by index (for testing or specific selection)
 */
export function getSpawnPointByIndex(index: number): { x: number; y: number; z: number } {
  if (index < 0 || index >= FLAG_SPAWN_POINTS.length) {
    console.log(`[SpawnSystem] Invalid spawn index ${index}, using 0`)
    index = 0
  }
  return { ...FLAG_SPAWN_POINTS[index] }
}

/**
 * Get all spawn points for debugging/visualization
 */
export function getAllSpawnPoints(): ReadonlyArray<{ x: number; y: number; z: number }> {
  return FLAG_SPAWN_POINTS
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

export enum SyncIds {
  FLAG = 1,
  COUNTDOWN = 200,
  LEADERBOARD = 201,
  VISITOR_ANALYTICS = 202
}

export function getTodayDateString(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
