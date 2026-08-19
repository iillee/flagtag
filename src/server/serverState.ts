/**
 * serverState.ts — Shared mutable state, constants, and helpers.
 *
 * This is the foundation module. It imports no other server/ module EXCEPT pure leaf
 * modules that import nothing themselves (positionHistory.ts, identitySweep.ts) — those
 * hold logic extracted for unit testing and cannot form a cycle. Nothing else here may
 * reach sideways into server/.
 */

import { engine, Transform, PlayerIdentityData, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { type PosSample, POS_HISTORY_MAX_MS, pushSample, wasEverWithinRadius, nearestDistanceEver } from './positionHistory'
import { type RejectionCounts } from './rejectionStats'
import {
  type IdentityPosition, type AliasTrackEntry,
  describeEntityId, diffIdentitySweep, trackAliasedPositions, selectNewestPerAddress,
  ALIAS_LAG_EPSILON, ALIAS_MOVE_THRESHOLD, ALIAS_Y_TOLERANCE, ALIAS_LOCKSTEP_TOLERANCE
} from './identitySweep'

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
/**
 * When each player was last struck by lightning (Date.now()). The server picks the victim
 * itself, so this is authoritative — unlike the client-reported `deathPenaltyCooldowns`. Read by
 * checkProximitySteal to keep the flag off a player who is frozen and input-disabled.
 */
export const lightningStruckAt = new Map<string, number>()
export const nameChangeCooldowns = new Map<string, number>()
/** Per-interval counters for rejected client requests; emitted and cleared by the periodic DIAG. */
export const rejectionCounts: RejectionCounts = new Map()
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
  // If duplicate PlayerIdentityData entities exist for the same address (mid-round reconnect
  // leaving a corpse entity behind), scan them all and return the highest entity ID.
  //
  // "Highest" is NOT "newest" — the version lives in the high 16 bits and counts recycles of
  // that slot, not when its occupant was assigned, so an address that moves to a fresher slot
  // can see its raw id drop and this returns the corpse (37 of 103 reallocations in a 3 h log).
  // Kept knowingly: the rule is wrong symmetrically, so this and every client agree, and the
  // duplicate condition needs a lost tombstone that never occurred in that log. The full
  // argument, and what a real fix would have to do, is on `selectNewestPerAddress`.
  //
  // Deliberately does NOT log. This runs on every consequential proximity read — the steal
  // check, ghost targeting, and once per active trap/bomb/projectile/orbit, every tick — so
  // warning here produced 60-240 lines/s for a single duplicated address and buried the very
  // tripwires it was meant to support. sweepDuplicateIdentities reports the same condition ONCE
  // per change (edge-triggered), so grep the log from before the duplicate appeared —
  // once per second with every entity id, which is strictly more useful.
  let bestEntity: Entity | null = null
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address.toLowerCase() === needle) {
      if (bestEntity === null || (entity as number) > (bestEntity as number)) bestEntity = entity
    }
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

/** Last single avatar entity id seen per address — carried across sweeps by diffIdentitySweep. */
const _lastEntityIdByAddr = new Map<string, number>()

/** Per-pair coincidence state — carried across sweeps by trackAliasedPositions. */
const _aliasTracking = new Map<string, AliasTrackEntry>()

/** Separate per-pair state for the lagged tier — the two tiers must not share streaks. */
const _aliasLagTracking = new Map<string, AliasTrackEntry>()

/** Last reported duplicate id-set per address — edge-triggers the `duplicate` event. */
const _lastDuplicateSignature = new Map<string, string>()

/**
 * Diagnostic sweep (~1Hz) for the three observable signatures of the avatar-entity cross-wire
 * (docs/BUG_stale-crdt-transform-in-combat.md): an address with more than one
 * PlayerIdentityData entity, a recycled/reissued avatar entity id (the trigger), and two
 * addresses moving as one (the symptom). All three are edge-triggered.
 *
 * Engine iteration and logging only — the branch selection lives in identitySweep.ts so it
 * can be unit-tested.
 */
let _lastDupSweepMs = 0
export function sweepDuplicateIdentities(): void {
  const now = Date.now()
  if (now - _lastDupSweepMs < 1000) return
  _lastDupSweepMs = now

  const byAddr = new Map<string, number[]>()
  const positions: IdentityPosition[] = []
  for (const [entity, id] of engine.getEntitiesWith(PlayerIdentityData)) {
    const a = id.address.toLowerCase()
    let ids = byAddr.get(a)
    if (!ids) { ids = []; byAddr.set(a, ids) }
    ids.push(entity as number)
    // Transform read separately (getOrNull, not a second query) so adding the aliasing scan
    // cannot change which entities the duplicate detection above considers.
    const t = Transform.getOrNull(entity)
    if (t) positions.push({ addr: a, x: t.position.x, y: t.position.y, z: t.position.z })
  }

  // Cross-wire SYMPTOM: two different addresses tracking one player's position. Requires the
  // pair to MOVE together across sweeps, because this scene parks players on shared fixed
  // points routinely (see trackAliasedPositions). Edge-triggered, so once per occurrence.
  for (const pair of trackAliasedPositions(positions, _aliasTracking)) {
    // dy is the diagnostic half: ~0.85 is the capsule-center anchor fingerprint recorded for
    // this bug, ~0 means the two streams are aligned.
    console.log('[Server] 🔗 position aliasing:', pair.a.slice(0, 8), '≡', pair.b.slice(0, 8),
      '| xzDist=', pair.dist.toFixed(4), '| dy=', pair.dy.toFixed(3),
      '— two addresses moving as one; proximity reads for them are unreliable')
  }

  // Lagged tier: a cross-wired stream that trails its source by a comms snapshot never
  // satisfies the 5cm window above while moving (0.3–1m offset at run speed), which is why
  // the 2026-08-19 playtest showed cross-wire symptoms with a silent 🔗 line. Loose window +
  // movement-vector lockstep instead — see ALIAS_LAG_EPSILON / ALIAS_LOCKSTEP_TOLERANCE for
  // the tuning and the accepted false-positive (a stealer glued to an immune carrier).
  for (const pair of trackAliasedPositions(positions, _aliasLagTracking,
    ALIAS_LAG_EPSILON, ALIAS_MOVE_THRESHOLD, ALIAS_Y_TOLERANCE, ALIAS_LOCKSTEP_TOLERANCE)) {
    console.log('[Server] 🔗≈ position aliasing (lagged):', pair.a.slice(0, 8), '≈', pair.b.slice(0, 8),
      '| xzDist=', pair.dist.toFixed(4), '| dy=', pair.dy.toFixed(3),
      '— two addresses moving in lockstep at offset; possible lagged cross-wire (or a glued chase)')
  }

  for (const event of diffIdentitySweep(byAddr, _lastEntityIdByAddr, _lastDuplicateSignature)) {
    switch (event.kind) {
      case 'duplicate':
        console.log('[Server] 👥 duplicate PlayerIdentityData:', event.addr.slice(0, 8),
          '×', event.ids.length, '|', event.ids.map(describeEntityId).join(' , '))
        break
      case 'recycled':
        console.log('[Server] ♻️ avatar entity is a RECYCLED slot:', event.addr.slice(0, 8),
          '|', describeEntityId(event.id), '— cross-wire risk, positions for this address may be wrong')
        break
      case 'reissued':
        console.log('[Server] ♻️ avatar entity REISSUED:', event.addr.slice(0, 8),
          '|', describeEntityId(event.prevId), '->', describeEntityId(event.id), '— cross-wire risk')
        break
    }
  }
}

// ── Player position history (rolling time-windowed samples for lag-forgiving hit checks) ──
// Keeps ~500ms of positions per player. Used by combat to reconcile shooter/victim
// position lag: a projectile that would have hit the victim ~300ms ago still counts.
// The per-sample logic lives in positionHistory.ts (pure, unit-tested).

const positionHistory = new Map<string, PosSample[]>()

/** Called each server tick — snapshot every connected player's position. */
export function recordPlayerPositions(): void {
  const now = Date.now()
  const cutoff = now - POS_HISTORY_MAX_MS
  // Resolve duplicates to ONE entity per address before sampling, using the same newest-wins
  // rule as getPlayerPosition. Sampling per entity instead put a stale corpse entity's positions
  // into the live player's history, and wasWithinRadius accepts if ANY sample matches — so the
  // corpse could keep authorizing projectile hits and client action positions for that player.
  const entries: { addr: string; id: Entity }[] = []
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    entries.push({ addr: identity.address.toLowerCase(), id: entity })
  }
  const newest = selectNewestPerAddress(entries)
  for (const [addr, entity] of newest) {
    const p = Transform.get(entity).position
    let arr = positionHistory.get(addr)
    if (!arr) { arr = []; positionHistory.set(addr, arr) }
    pushSample(arr, { t: now, x: p.x, y: p.y, z: p.z }, cutoff)
  }
  // Clean up disconnected players
  for (const addr of positionHistory.keys()) {
    if (!newest.has(addr)) positionHistory.delete(addr)
  }
}

/**
 * True if the player was within `radius` of `target` at any point in the last `lookbackMs`.
 * Used for lag-forgiving projectile hit checks: the shooter's client already saw the
 * hit against a slightly-lagged victim position; the server accepts if the victim
 * *was* recently there. If no history exists, falls back to current position.
 *
 * `lookbackMs` beyond POS_HISTORY_MAX_MS gains nothing — older samples are already trimmed.
 */
export function wasWithinRadius(address: string, target: Vector3, radius: number, lookbackMs: number): boolean {
  const addr = address.toLowerCase()
  // Adapter only — the history/live-position branch selection is unit-tested in
  // positionHistory.ts. getPlayerPosition is passed lazily because it scans every entity.
  return wasEverWithinRadius(
    positionHistory.get(addr),
    target.x, target.y, target.z,
    radius,
    Date.now() - lookbackMs,
    () => getPlayerPosition(addr)
  )
}

/**
 * Smallest distance between `target` and the player's position over the last `lookbackMs`
 * (falling back to their live position when no history exists), or Infinity if unknown.
 *
 * The distance-returning form of wasWithinRadius, for callers that must pick the NEAREST of
 * several lag-forgiven candidates rather than merely ask whether one qualifies. Same
 * retention caveat: a `lookbackMs` beyond POS_HISTORY_MAX_MS gains nothing.
 */
export function distanceWithinLookback(address: string, target: Vector3, lookbackMs: number): number {
  const addr = address.toLowerCase()
  return nearestDistanceEver(
    positionHistory.get(addr),
    target.x, target.y, target.z,
    Date.now() - lookbackMs,
    () => getPlayerPosition(addr)
  )
}

export function clearPositionHistory(address: string): void {
  positionHistory.delete(address.toLowerCase())
}
