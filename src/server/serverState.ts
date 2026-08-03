/**
 * serverState.ts — Shared mutable state, constants, and helpers.
 * This is the foundation module: no imports from other server/ modules.
 */

import { engine, Transform, PlayerIdentityData, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

// ── Entity references (set during setupServer) ──

export let flagEntity: Entity
export function setFlagEntity(e: Entity) { flagEntity = e }

export let countdownEntity: Entity
export function setCountdownEntity(e: Entity) { countdownEntity = e }

/** Identifier shared by every hold-time value in the current round. */
export let scoreRoundSessionId = ''
export function setScoreRoundSessionId(id: string) { scoreRoundSessionId = id }
export let currentScoreRoundId = ''
export function setCurrentScoreRoundId(id: string) { currentScoreRoundId = id }

export let leaderboardEntity: Entity
export function setLeaderboardEntity(e: Entity) { leaderboardEntity = e }

export let allTimeLeaderboardEntity: Entity
export function setAllTimeLeaderboardEntity(e: Entity) { allTimeLeaderboardEntity = e }



export let coinStateEntity: Entity
export function setCoinStateEntity(e: Entity) { coinStateEntity = e }

// ── Per-player maps ──

export const holdTimeEntities = new Map<string, Entity>()
export const knownPlayers = new Set<string>()
export const playerNames = new Map<string, string>()

export const playerLifetimeHoldTimeCache = new Map<string, number>()

export const playerBoomerangColors = new Map<string, string>() // playerId -> color ('r','y','b','g')
export const playerCoinBalances = new Map<string, number>()
export const playerUpgradeData = new Map<string, import('../shared/upgrades').UpgradeData>()
export const playerLifetimeWinsCache = new Map<string, number>()

export const deathPenaltyCooldowns = new Map<string, number>()
export const lastStealTime = new Map<string, number>()
export const nameChangeCooldowns = new Map<string, number>()
export const feedbackCooldowns = new Map<string, number>()

// ── Per-session analytics counters ──
export const sessionDeaths = new Map<string, number>()
export const sessionBananasDropped = new Map<string, number>()
export const sessionBoomerangsFired = new Map<string, number>()

// ── Visitor tracking ──

export const visitorSessions = new Map<string, { name: string; sessionStartMs: number; totalSecondsToday: number }>()
export const monthlyVisitorSessions = new Map<string, { name: string; sessionStartMs: number; totalSecondsMonth: number }>()
export const currentlyConnected = new Set<string>()
/** Everyone connected at any point during the current round, including later disconnects. */
export const roundParticipants = new Set<string>()

// ── Constants ──

export const PICKUP_RADIUS = 4.5
export { PROXIMITY_STEAL_RADIUS, STEAL_IMMUNITY_MS } from '../shared/constants'
export const HOLD_TIME_SYNC_INTERVAL = 2.0 // seconds between CRDT hold-time writes (was 0.5)
export const SPLASH_DURATION_MS = 3000
// Re-export so existing server code that imports from serverState keeps
// working; canonical definition now lives in shared/flagFall so client and
// server share the same value for the message-driven analytic fall.
export { FLAG_GRAVITY } from '../shared/flagFall'
export const FLAG_MIN_Y = 49.5
// Upper bound for any client-reported flag ground Y. The playable terrain sits
// around Y=48–80 after the +48 scene lift; anything above this is a spoofed report.
export const FLAG_MAX_Y = 120
// Y of the invisible collider plane below the lifted scene (players can walk on it).
// Flag sinks to this Y when it lands in water, instead of falling to Y=0.
export { SCENE_FLOOR_Y } from '../shared/constants'
export const CARRIER_Y_WINDOW_SEC = 2.0
export const CARRIER_NO_POSITION_TIMEOUT_MS = 5000

// ── Mushroom constants ──

// Center of the mushroom spawn disc. Aligned with the playable boundary
// (see boundaryWalls.ts: BOUNDARY_CX=372.75, BOUNDARY_CZ=349.5, RADIUS=128).
// The previous values (250.75, 255.5) predated commit b65794c which moved the
// scene to the center of the 50x50 world — they left the mushroom spawn disc
// mostly OUTSIDE the terrain, so ~all raycast candidates hit water/nothing and
// the mushroom was silently rejected every spawn.
export const MUSHROOM_CX = 372.75
export const MUSHROOM_CZ = 349.5
// Slightly smaller than the boundary radius so candidates stay well inside the
// playable area (avoids landing right against the wall or on the boundary rim).
export const MUSHROOM_RADIUS = 100
export const MUSHROOM_CANDIDATES = 10

// ── Leaderboard reset tracking ──

export let lastLeaderboardResetDay = ''
export function setLastLeaderboardResetDay(d: string) { lastLeaderboardResetDay = d }

// ── Visitor reset tracking ──

export let lastVisitorResetDay = ''
export function setLastVisitorResetDay(d: string) { lastVisitorResetDay = d }

export let lastMonthlyVisitorResetMonth = ''
export function setLastMonthlyVisitorResetMonth(m: string) { lastMonthlyVisitorResetMonth = m }

// ── Concurrent user tracking (hourly peaks) ──

export let hourlyPeakConcurrent: number[] = new Array(24).fill(0)
export function setHourlyPeakConcurrent(arr: number[]) { hourlyPeakConcurrent = arr }

export let peakConcurrent = 0
export function setPeakConcurrent(n: number) { peakConcurrent = n }

export let peakConcurrentTime = '' // HH:MM UTC when peak occurred
export function setPeakConcurrentTime(t: string) { peakConcurrentTime = t }

// ── Ghost shared state ──
// Shared here so both combat.ts (ghost-trap collision) and ghostSystem.ts can access without circular imports.

export interface ActiveGhost {
  entity: Entity
  syncId: number
  hp: number
  posX: number
  posY: number
  posZ: number
  spawnedAtMs: number
  lastStaggerTime: Map<string, number>
  lastHitMs: number
  lastCrdtSyncTime: number
}

export const activeGhosts: ActiveGhost[] = []
export let ghostRespawnCooldown = 0
export function setGhostRespawnCooldown(v: number) { ghostRespawnCooldown = v }
export const GHOST_RESPAWN_COOLDOWN = 30

// ── Shared helpers ──

export function isRealName(name: string): boolean {
  return name.length > 0 && !name.startsWith('0x')
}

/**
 * Authoritative player position, read from the CRDT-synced Transform. Every
 * consequential proximity decision goes through here rather than reading the
 * player entity's Transform directly, so the lookup (including the duplicate-entity
 * handling below) stays in one place.
 */
export function getPlayerPosition(address: string): Vector3 | null {
  const needle = address.toLowerCase()
  // DIAGNOSTIC (BUG_stale-crdt-transform-in-combat.md, Step 1a):
  // If duplicate PlayerIdentityData entities exist for the same address (mid-round
  // reconnect leaving a corpse entity behind), scan them all and return the newest
  // (highest entity ID). Warn once per lookup so we can confirm the hypothesis.
  let bestEntity: Entity | null = null
  let matches = 0
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address.toLowerCase() === needle) {
      matches++
      if (bestEntity === null || (entity as number) > (bestEntity as number)) bestEntity = entity
    }
  }
  if (matches > 1) {
    console.log('[Server] ⚠️ getPlayerPosition: address', needle.slice(0, 8), 'has', matches, 'entities — using newest')
  }
  if (bestEntity === null) return null
  return Transform.get(bestEntity).position
}

/**
 * Every address that should be considered a live victim candidate. Combat and
 * steal loops iterate this instead of getEntitiesWith(PlayerIdentityData, ...)
 * directly so duplicate entities per address can't double-iterate a victim.
 */
export function getActivePlayerAddresses(): Set<string> {
  const addresses = new Set<string>()
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    addresses.add(identity.address.toLowerCase())
  }
  return addresses
}

/** Diagnostic sweep: log any address with >1 PlayerIdentityData entity. Called ~1Hz. */
let _lastDupSweepMs = 0
export function sweepDuplicateIdentities(): void {
  const now = Date.now()
  if (now - _lastDupSweepMs < 1000) return
  _lastDupSweepMs = now
  const counts = new Map<string, number>()
  for (const [, id] of engine.getEntitiesWith(PlayerIdentityData)) {
    const a = id.address.toLowerCase()
    counts.set(a, (counts.get(a) ?? 0) + 1)
  }
  for (const [addr, n] of counts) {
    if (n > 1) console.log('[Server] 👥 duplicate PlayerIdentityData:', addr.slice(0, 8), '×', n)
  }
}

// ── Player position history (rolling ring buffer for lag-forgiving hit checks) ──
// Keeps ~500ms of positions per player. Used by combat to reconcile shooter/victim
// position lag: a projectile that would have hit the victim ~300ms ago still counts.

interface PosSample { t: number; x: number; y: number; z: number }
const POS_HISTORY_MAX_MS = 500
const positionHistory = new Map<string, PosSample[]>()

/** Called each server tick — snapshot every connected player's position. */
export function recordPlayerPositions(): void {
  const now = Date.now()
  const cutoff = now - POS_HISTORY_MAX_MS
  const seen = new Set<string>()
  const push = (addr: string, x: number, y: number, z: number) => {
    let arr = positionHistory.get(addr)
    if (!arr) { arr = []; positionHistory.set(addr, arr) }
    arr.push({ t: now, x, y, z })
    // Drop stale samples from front
    while (arr.length > 0 && arr[0].t < cutoff) arr.shift()
  }
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    const addr = identity.address.toLowerCase()
    seen.add(addr)
    const p = Transform.get(entity).position
    push(addr, p.x, p.y, p.z)
  }
  // Clean up disconnected players
  for (const addr of positionHistory.keys()) {
    if (!seen.has(addr)) positionHistory.delete(addr)
  }
}

/**
 * True if the player was within `radius` of `target` at any point in the last `lookbackMs`.
 * Used for lag-forgiving projectile hit checks: the shooter's client already saw the
 * hit against a slightly-lagged victim position; the server accepts if the victim
 * *was* recently there. If no history exists, falls back to current position.
 */
export function wasWithinRadius(address: string, target: Vector3, radius: number, lookbackMs: number): boolean {
  const addr = address.toLowerCase()
  const arr = positionHistory.get(addr)
  const now = Date.now()
  const cutoff = now - lookbackMs
  if (arr && arr.length > 0) {
    const r2 = radius * radius
    for (let i = arr.length - 1; i >= 0; i--) {
      const s = arr[i]
      if (s.t < cutoff) break
      const dx = s.x - target.x, dy = s.y - target.y, dz = s.z - target.z
      if (dx * dx + dy * dy + dz * dz < r2) return true
    }
    return false
  }
  // Fallback: no history — use current position
  const cur = getPlayerPosition(addr)
  if (!cur) return false
  return Vector3.distance(cur, target) < radius
}

export function clearPositionHistory(address: string): void {
  positionHistory.delete(address.toLowerCase())
}
