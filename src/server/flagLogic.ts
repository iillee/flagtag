/**
 * flagLogic.ts — Flag pickup, drop, steal, gravity, hold-time tracking.
 *
 * Exports systems (flagServerSystem, holdTimeServerSystem, checkProximitySteal),
 * message handler registration (registerFlagHandlers), and helpers needed by
 * other modules (handleDrop, flushHoldTimeAccum, resetGravityState,
 * getOrCreateHoldTimeEntity, handleFlagSteal).
 */

import { engine, Transform, PlayerIdentityData, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import {
  Flag, FlagState, PlayerFlagHoldTime,
  FLAG_BASE_POSITION, getRandomSpawnPoint
} from '../shared/components'
import { room } from '../shared/messages'
import {
  type StealIntentStore, type StealCandidate,
  recordStealIntent, hasRecentStealIntent, pruneStaleIntents, selectStealCandidate,
  isStealCorroborated
} from './stealIntent'
import {
  flagEntity, setFlagEntity,
  holdTimeEntities, knownPlayers, playerNames,
  currentScoreRoundId,
  lastStealTime,
  PICKUP_RADIUS, PROXIMITY_STEAL_RADIUS, STEAL_IMMUNITY_MS, HOLD_TIME_SYNC_INTERVAL,
  FLAG_GRAVITY, FLAG_MIN_Y, FLAG_MAX_Y, SCENE_FLOOR_Y, CARRIER_Y_WINDOW_SEC, CARRIER_NO_POSITION_TIMEOUT_MS,
  getPlayerPosition, getActivePlayerAddresses,
  heartbeatPositions
} from './serverState'
import { getFreshHeartbeat } from './positionTrust'

// ── Module-local state ──

let flagFalling = false
let flagFallVelocity = 0
let flagGravityTargetY = FLAG_MIN_Y
const carrierYSamples: { y: number; time: number }[] = []
let lastDropperId = ''  // Who dropped the flag — '' means server-initiated (no trusted dropper)
// Ground-report guards (reset by computeGravityTarget at every drop):
// - dropBaselineY is the anchor Y at the moment of the drop, IMMUTABLE for that
//   drop. The +5m raise cap is computed from it — capping from the live anchor
//   would let repeated reports ratchet the flag up 5m at a time to FLAG_MAX_Y.
// - groundReportUsed makes dropper ground resolution one-shot per drop; its legit
//   purpose (un-burying a flag dropped inside terrain) needs exactly one report.
// - groundLowerReportsLeft bounds the anyone-may-LOWER path used for drops with no
//   trusted dropper (see the reportGroundY handler): honest resolution needs one or
//   two reports, and the budget stops report spam from flooding the ground-report
//   handler. Initialized non-zero so a startup-placed flag (which never goes
//   through computeGravityTarget) gets a budget too.
let dropBaselineY = 0
let groundReportUsed = false
const GROUND_LOWER_REPORT_BUDGET = 8
let groundLowerReportsLeft = GROUND_LOWER_REPORT_BUDGET
let lastKnownCarrierPos: Vector3 | null = null
let lastCarrierPositionMs = 0

let holdTimeAccum = 0
let holdTimeCarrierKey = '' // Track WHO we're accumulating for

// ── Water respawn delay ──
const WATER_RESPAWN_DELAY = 3.0 // seconds before flag respawns after hitting water
let waterRespawnTimer = 0
let waterRespawnActive = false

// ── Gravity helpers ──

function resetCarrierTracking(): void {
  lastCarrierPositionMs = 0
  carrierYSamples.length = 0
  lastKnownCarrierPos = null
}

/**
 * Compute where the flag should land based on the carrier's recent ground-level Y.
 * We track the carrier's Y over the last ~2 seconds. The minimum Y in that window
 * is our best estimate of the terrain they were walking on. If the flag is dropped
 * above that level (e.g. mid-jump), gravity pulls it down to the estimated ground.
 */
export function computeGravityTarget(dropY: number): void {
  // Called at every drop site — record the immutable baseline for this drop and
  // re-arm the one-shot ground report and the lower-only report budget.
  dropBaselineY = dropY
  groundReportUsed = false
  groundLowerReportsLeft = GROUND_LOWER_REPORT_BUDGET
  let minY = Infinity
  for (const s of carrierYSamples) {
    if (s.y < minY) minY = s.y
  }
  const groundEstimate = minY === Infinity ? dropY - 0.5 : minY
  flagGravityTargetY = Math.max(FLAG_MIN_Y, groundEstimate + 0.5)
  carrierYSamples.length = 0

  if (dropY > flagGravityTargetY + 0.1) {
    flagFalling = true
    flagFallVelocity = 0
  } else {
    flagFalling = false
  }
}

export function resetGravityState(): void {
  flagFalling = false
  flagFallVelocity = 0
  carrierYSamples.length = 0
  resetCarrierTracking()
}

/**
 * Mark the current drop as server-initiated: reportGroundY then trusts no client
 * for raises and only accepts LOWER-only reports (see registerFlagHandlers). The
 * force-drop paths inside flagServerSystem clear the dropper inline; this export
 * exists for drops performed outside this module (lightning strike in
 * roundManager) — without it a lightning drop would leave the PREVIOUS dropper
 * armed with a fresh one-shot raise anchored at the strike height.
 */
export function clearLastDropper(): void {
  lastDropperId = ''
}

// ── Hold-time helpers ──

// Shadow copy of each player's hold-time total this round, updated on every write to
// the synced component. The synced entity can be silently wiped by entity-slot
// recycling (getOrCreateHoldTimeEntity recreates it), and recreating at seconds:0
// erased the player's whole round — the round leader would vanish from the round-end
// podium/announcement. Recreated entities are seeded from here instead.
// Cleared at round end by roundManager (via clearHoldTimeTotals).
const holdTimeShadowTotals = new Map<string, number>()

/** Reset the shadow totals for a new round (called from handleRoundEnd). */
export function clearHoldTimeTotals(): void {
  holdTimeShadowTotals.clear()
}

/**
 * Single entry point for creating/retrieving a PlayerFlagHoldTime entity.
 * Prevents the race condition where both playerTrackingSystem and
 * holdTimeServerSystem create duplicate entities for the same player.
 */
export function getOrCreateHoldTimeEntity(userKey: string): Entity {
  const key = userKey.toLowerCase()
  const cached = holdTimeEntities.get(key)

  // Only reuse the cached entity if it STILL carries the component. On a
  // long-running authoritative server the engine recycles entity slots (e.g.
  // when a reconnecting player's avatar slot is version-bumped), which can drop
  // our PlayerFlagHoldTime component while the map still points at the now-dead
  // entity id. Reusing it blindly makes every later getMutable() throw
  // "[mutable] Component ctf-player-flag-hold-time for <id> not found" on every
  // frame (and also breaks handleRoundEnd). Validate, and recreate if stale.
  if (cached !== undefined) {
    const cachedData = PlayerFlagHoldTime.getOrNull(cached)
    if (cachedData !== null) {
      // A failed/emergency round transition can leave a live entity carrying the
      // previous round id. Never accumulate new-round time into that stale value.
      if (cachedData.roundId !== currentScoreRoundId) {
        const mutable = PlayerFlagHoldTime.getMutable(cached)
        mutable.seconds = 0
        mutable.roundId = currentScoreRoundId
        holdTimeShadowTotals.set(key, 0)
      }
      return cached
    }
  }
  if (cached !== undefined) {
    // Drop the stale reference and release the dead entity (best-effort) so its
    // sync-id registration is freed before we re-create with the same enum id.
    holdTimeEntities.delete(key)
    knownPlayers.delete(key)
    try {
      engine.removeEntity(cached)
    } catch {
      // Entity already gone from the engine — nothing left to release.
    }
  }

  const entity = engine.addEntity()
  // Seed from the shadow total — recreating at 0 would erase the player's whole round
  // whenever their entity slot gets recycled mid-round.
  const seededSeconds = holdTimeShadowTotals.get(key) ?? 0
  if (seededSeconds > 0) {
    console.log('[Server] Recreated hold-time entity for', key.slice(0, 8), 'seeded with', seededSeconds.toFixed(1), 's from shadow total')
  }
  PlayerFlagHoldTime.create(entity, { playerId: key, seconds: seededSeconds, roundId: currentScoreRoundId })
  // Let the SDK auto-allocate the network id (no explicit enum id). An enum id
  // makes the network identity (networkId:0, entityId:enumId) — GLOBAL and shared
  // — so a per-address hash id collides (and throws "id already in use") both
  // across two players who hash alike AND when the same player reconnects before
  // their previous entity is cleaned up. Auto-allocation instead uses
  // (networkId:<this server>, entityId:<unique local entity>), which is unique by
  // construction. Player identity lives in the `playerId` field, which is how
  // every reader (client systems + reconcileHoldTimeEntities) already matches.
  syncEntity(entity, [PlayerFlagHoldTime.componentId])
  holdTimeEntities.set(key, entity)
  knownPlayers.add(key)
  console.log('[Server] Created hold-time entity for', key.slice(0, 8))
  return entity
}

/**
 * Flush any accumulated hold time to the specified player.
 * Called when the carrier changes or the flag is dropped so that
 * no accumulated time is lost or credited to the wrong player.
 */
export function flushHoldTimeAccum(): void {
  if (holdTimeAccum > 0 && holdTimeCarrierKey) {
    const entity = getOrCreateHoldTimeEntity(holdTimeCarrierKey)
    // Defensive: getMutableOrNull never throws, so a transient stale entity can
    // only skip one flush instead of crashing the whole system loop.
    const mutable = PlayerFlagHoldTime.getMutableOrNull(entity)
    if (mutable) {
      mutable.seconds += holdTimeAccum
      holdTimeShadowTotals.set(holdTimeCarrierKey, mutable.seconds)
      console.log('[Server] Flushed', holdTimeAccum.toFixed(2), 's hold time to', holdTimeCarrierKey.slice(0, 8), '(total:', mutable.seconds.toFixed(1), 's)')
    }
  }
  holdTimeAccum = 0
  holdTimeCarrierKey = ''
}

/**
 * Read the current hold-time accumulator value for a given carrier key.
 * Used by lightning system to get accurate in-progress hold seconds.
 */
export function getHoldTimeAccumFor(carrierKey: string): number {
  return holdTimeCarrierKey === carrierKey ? holdTimeAccum : 0
}

/**
 * Force-clear the hold-time accumulator (used by handleRoundEnd for defensive reset).
 */
export function clearHoldTimeAccum(): void {
  holdTimeAccum = 0
  holdTimeCarrierKey = ''
}

// ── Flag pickup / drop / steal ──

/**
 * The flag's authoritative world position, read from the validated Flag fields
 * rather than its Transform. The Transform is synced but has no validateBeforeChange
 * (it is the built-in component), so a hostile client can write it — never trust it
 * for server-side distance checks.
 */
function authoritativeFlagPos(flag: { state: FlagState; baseX: number; baseY: number; baseZ: number; dropAnchorX: number; dropAnchorY: number; dropAnchorZ: number }): Vector3 {
  return flag.state === FlagState.AtBase
    ? Vector3.create(flag.baseX, flag.baseY, flag.baseZ)
    : Vector3.create(flag.dropAnchorX, flag.dropAnchorY, flag.dropAnchorZ)
}

/**
 * Watchdog: if the engine has recycled the flag's entity slot and dropped its Flag
 * component (observed for hold-time entities on long-running servers — see
 * getOrCreateHoldTimeEntity), every flag path silently no-ops and the flag appears
 * stuck as Carried on clients forever. Recreate the entity at base so the game recovers.
 * Returns true if it had to recreate.
 */
export function ensureFlagEntity(): boolean {
  if (Flag.getOrNull(flagEntity) !== null) return false
  console.error('[Server] 🚨 Flag component missing — recreating flag entity at base (entity slot recycled?)')
  try { engine.removeEntity(flagEntity) } catch { /* already gone from the engine */ }
  const spawn = getRandomSpawnPoint()
  const e = engine.addEntity()
  Transform.create(e, { position: Vector3.create(spawn.x, spawn.y, spawn.z) })
  Flag.create(e, {
    teamId: 0, state: FlagState.AtBase, carrierPlayerId: '',
    baseX: spawn.x, baseY: spawn.y, baseZ: spawn.z,
    dropAnchorX: spawn.x, dropAnchorY: spawn.y, dropAnchorZ: spawn.z
  })
  // Point everything at the new entity BEFORE syncing so that even if syncEntity throws we
  // don't re-enter this branch and leak a fresh entity every frame.
  setFlagEntity(e)
  resetGravityState()
  // Auto-allocate the network id (NO SyncIds.FLAG): engine.removeEntity intentionally
  // preserves the old entity's NetworkEntity for the rest of the frame, so reusing the enum
  // id here throws "id already in use" (the same hazard getOrCreateHoldTimeEntity documents).
  // Clients find the flag via getEntitiesWith(Flag), not a fixed sync id, so this is fine.
  try {
    syncEntity(e, [Transform.componentId, Flag.componentId])
  } catch (err) {
    console.error('[Server] ❌ Flag re-sync failed (flag will still function locally):', err)
  }
  return true
}

export function handlePickup(playerId: string): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) {
    console.log('[Server] ⚠️ handlePickup REJECT: no flag entity for', playerId.slice(0, 8))
    return
  }
  if (flag.state !== FlagState.AtBase && flag.state !== FlagState.Dropped) {
    console.log('[Server] ⚠️ handlePickup REJECT: flag state is', flag.state, '(not AtBase/Dropped) for', playerId.slice(0, 8), 'carrier=', flag.carrierPlayerId?.slice(0, 8) || 'none')
    return
  }

  const playerPos = getPlayerPosition(playerId)
  if (!playerPos) {
    // No authoritative position yet (avatar Transform not replicated) — reject rather
    // than trust the client, or a hostile client could pick up from anywhere. Legitimate
    // pickups self-heal once the position replicates a moment later.
    console.log('[Server] ⚠️ handlePickup REJECT: no position for', playerId.slice(0, 8))
    return
  }
  const flagPos = authoritativeFlagPos(flag)
  const dist = Vector3.distance(playerPos, flagPos)
  if (dist > PICKUP_RADIUS) {
    console.log('[Server] ⚠️ handlePickup REJECT: distance', dist.toFixed(2), '> PICKUP_RADIUS', PICKUP_RADIUS,
      '| player=(', playerPos.x.toFixed(1), playerPos.y.toFixed(1), playerPos.z.toFixed(1), ')',
      '| flag=(', flagPos.x.toFixed(1), flagPos.y.toFixed(1), flagPos.z.toFixed(1), ')',
      '| for', playerId.slice(0, 8))
    return
  }
  console.log('[Server] ✅ handlePickup ACCEPT for', playerId.slice(0, 8), '| dist=', dist.toFixed(2))

  // Flush any leftover hold time from a previous carrier (safety)
  flushHoldTimeAccum()

  const mutable = Flag.getMutable(flagEntity)
  mutable.state = FlagState.Carried
  mutable.carrierPlayerId = playerId

  resetGravityState()
  lastCarrierPositionMs = Date.now()
  lastStealTime.set(playerId, Date.now())
  room.send('pickupConfirmed', { playerId })
  room.send('flagImmunity', { playerId, durationMs: STEAL_IMMUNITY_MS })
  room.send('pickupSound', { t: 0 })
}

export function handleDrop(playerId: string, forced: boolean = false): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) return
  if (flag.state !== FlagState.Carried || flag.carrierPlayerId !== playerId) return

  // Flush accumulated hold time to the carrier BEFORE dropping
  flushHoldTimeAccum()

  const playerPos = getPlayerPosition(playerId)
  let dropPos: Vector3
  if (playerPos) {
    dropPos = Vector3.add(playerPos, Vector3.create(0, 0.5, 0))
  } else if (lastKnownCarrierPos) {
    dropPos = Vector3.add(lastKnownCarrierPos, Vector3.create(0, 0.5, 0))
    console.log('[Server] ⚠️ handleDrop: no live position for', playerId.slice(0, 8), '— using last known carrier pos')
  } else {
    dropPos = Transform.get(flagEntity).position
  }

  const mutable = Flag.getMutable(flagEntity)
  mutable.state = FlagState.Dropped
  mutable.carrierPlayerId = ''
  mutable.dropAnchorX = dropPos.x
  mutable.dropAnchorY = dropPos.y
  mutable.dropAnchorZ = dropPos.z

  const t = Transform.getMutable(flagEntity)
  t.position = dropPos

  lastDropperId = playerId
  computeGravityTarget(dropPos.y)

  room.send('dropSound', { t: 0 })
  // Fast-path WS message for combat-forced drops so clients don't wait for CRDT
  if (forced) {
    room.send('dropForced', { playerId })
  }
}

export function handleFlagSteal(victimId: string, attackerId: string): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) return
  if (flag.state !== FlagState.Carried || flag.carrierPlayerId !== victimId) return

  // Flush accumulated hold time to the VICTIM before transferring flag
  flushHoldTimeAccum()

  const mutable = Flag.getMutable(flagEntity)
  mutable.state = FlagState.Carried
  mutable.carrierPlayerId = attackerId

  lastStealTime.set(attackerId, Date.now())
  resetGravityState()
  lastCarrierPositionMs = Date.now()
  room.send('pickupConfirmed', { playerId: attackerId })
  room.send('flagImmunity', { playerId: attackerId, durationMs: STEAL_IMMUNITY_MS })
  room.send('pickupSound', { t: 0 })
}

// ── Proximity steal system ──

// Client corroboration for server-initiated steals (see stealIntent.ts): the
// beneficiary's client must have sent requestSteal recently, or the server view
// alone (cross-wire-prone) cannot transfer the flag.
const stealIntents: StealIntentStore = new Map()
// Throttle for the "steal blocked" log — under an active cross-wire the block
// would otherwise fire every tick.
let lastBlockedStealLogMs = 0
const BLOCKED_STEAL_LOG_INTERVAL_MS = 5000

export function checkProximitySteal(): void {
  // Bound the intent store (one entry per address that ever pressed a steal).
  // Runs every tick; the map only ever holds recently-active stealers, so the
  // sweep is a handful of entries.
  pruneStaleIntents(stealIntents, Date.now())

  const flag = Flag.getOrNull(flagEntity)
  if (!flag || flag.state !== FlagState.Carried || !flag.carrierPlayerId) return

  const carrierId = flag.carrierPlayerId
  const carrierPos = getPlayerPosition(carrierId)
  if (!carrierPos) return

  const now = Date.now()
  const carrierStealTime = lastStealTime.get(carrierId) ?? 0
  if (now - carrierStealTime < STEAL_IMMUNITY_MS) return

  // Heartbeat-union roster: a candidate whose PlayerIdentityData entity never
  // replicated can still steal (their client corroborates via requestSteal anyway).
  const candidates: StealCandidate[] = []
  for (const addr of getActivePlayerAddresses()) {
    if (addr === carrierId) continue
    const pos = getPlayerPosition(addr)
    if (!pos) continue
    candidates.push({ addr, dist: Vector3.distance(carrierPos, pos) })
  }

  // Corroboration gate (cross-wire defense): only candidates whose client ALSO
  // believes it is next to the carrier are eligible — that view comes through an
  // independent position channel, so a cross-wired server view can't teleport the
  // flag on its own. Legit steals are unaffected in practice: the client predicts
  // and retries requestSteal every ~500ms while in range, and the requestSteal
  // handler remains the fast path. Two-track selection (see selectStealCandidate):
  // an uncorroborated ghost must not shadow a real corroborated stealer.
  //
  // Heartbeat-dual corroboration (playtest bug "proximity steal sometimes
  // doesn't work"): when BOTH the carrier and the candidate have a fresh
  // posHeartbeat, two independent per-sender WS position streams agree on the
  // proximity. That combination cannot be produced by a CRDT cross-wire (each
  // heartbeat is authenticated to its sender), so it counts as corroboration on
  // its own. Closes the gap where a client whose flag CRDT is fully stalled
  // never sends requestSteal, and the server-side path was previously blocked
  // because there was no client intent to corroborate.
  const carrierHasFreshHb = getFreshHeartbeat(heartbeatPositions, carrierId, now) !== null
  const corroborated = (addr: string): boolean => isStealCorroborated({
    hasClientIntent: hasRecentStealIntent(stealIntents, addr, now),
    carrierHasFreshHeartbeat: carrierHasFreshHb,
    candidateHasFreshHeartbeat: getFreshHeartbeat(heartbeatPositions, addr, now) !== null,
  })
  const { closestId, closestDist, blockedId, blockedDist } = selectStealCandidate(
    candidates,
    corroborated,
    PROXIMITY_STEAL_RADIUS
  )

  if (!closestId) {
    if (blockedId && now - lastBlockedStealLogMs >= BLOCKED_STEAL_LOG_INTERVAL_MS) {
      lastBlockedStealLogMs = now
      console.log('[Server] 🚫 Proximity steal blocked (no client corroboration):', blockedId.slice(0, 8),
        'near', carrierId.slice(0, 8), '| dist=', blockedDist.toFixed(3),
        '— server view says adjacent but the client never predicted a steal (cross-wire signature)')
    }
    return
  }

  {
    // DIAG (BUG_stale-crdt-transform-in-combat.md, Step 1c):
    // Dump the raw positions being compared so we can see WHY the distance was small.
    const cPos = getPlayerPosition(carrierId)
    const vPos = getPlayerPosition(closestId)
    console.log('[Server] 🚩 Proximity steal:', closestId.slice(0, 8), '<-', carrierId.slice(0, 8),
      '| carrierPos=', cPos ? `(${cPos.x.toFixed(1)},${cPos.y.toFixed(1)},${cPos.z.toFixed(1)})` : 'null',
      '| victimPos=', vPos ? `(${vPos.x.toFixed(1)},${vPos.y.toFixed(1)},${vPos.z.toFixed(1)})` : 'null',
      '| dist=', closestDist.toFixed(3),
      '| sameRef=', cPos === vPos)
    // Also dump every player's position in the current iteration so we can spot aliasing.
    for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      const a = identity.address.toLowerCase()
      const t = Transform.get(entity)
      const parent = (t.parent ?? 0) as number
      console.log('[Server]   ⤷ entity', entity as number, 'addr', a.slice(0, 8),
        'pos=(', t.position.x.toFixed(1), ',', t.position.y.toFixed(1), ',', t.position.z.toFixed(1), ')',
        'parent=', parent)
    }
    handleFlagSteal(carrierId, closestId)
  }
}

// ── Flag heartbeat: periodic WS broadcast so clients can self-correct stale CRDT ──
// This is also the live scoreboard's reliable transport when dynamic
// PlayerFlagHoldTime entities stall. Match the displayed score cadence.
const FLAG_HEARTBEAT_INTERVAL_MS = 1000
let lastHeartbeatMs = 0

// ── Server systems ──

export function flagServerSystem(dt: number): void {
  ensureFlagEntity()
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) return

  // Heartbeat: broadcast flag state every second so clients can fix stale visuals
  // and keep every player's live score authoritative.
  const nowForHb = Date.now()
  if (nowForHb - lastHeartbeatMs >= FLAG_HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMs = nowForHb
    // Broadcast the CARRIER's authoritative world position when carried, not the
    // flag entity's Transform — the flag is parented to the carrier, so its
    // Transform.position is a local offset (a few meters near origin), useless
    // to any client trying to do a proximity check. Falls back to the flag
    // Transform for AtBase / Dropped, where it's the real world position.
    // This lets the client's proximity-steal prediction work even when the
    // carrier's PlayerIdentityData CRDT hasn't replicated (root cause of
    // "sometimes running over the carrier doesn't steal the flag").
    let bx: number, by: number, bz: number
    if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
      const cPos = getPlayerPosition(flag.carrierPlayerId)
      if (cPos) { bx = cPos.x; by = cPos.y; bz = cPos.z }
      else { const p = Transform.get(flagEntity).position; bx = p.x; by = p.y; bz = p.z }
    } else {
      const p = Transform.get(flagEntity).position; bx = p.x; by = p.y; bz = p.z
    }
    // Piggyback the carrier's authoritative hold total (synced component + unflushed
    // accumulator). PlayerFlagHoldTime rides the CRDT, which historically stalls under
    // load — this WS copy lets clients re-anchor the live scoreboard even when the
    // CRDT value is frozen (the "score resets to 0 on steal/drop" report).
    let carrierHoldSeconds = 0
    if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
      const carrierKey = flag.carrierPlayerId.toLowerCase()
      const holdEntity = holdTimeEntities.get(carrierKey)
      const syncedSeconds = holdEntity !== undefined
        ? (PlayerFlagHoldTime.getOrNull(holdEntity)?.seconds ?? 0)
        : 0
      carrierHoldSeconds = syncedSeconds + getHoldTimeAccumFor(carrierKey)
    }
    room.send('flagHeartbeat', {
      state: flag.state as string,
      carrierId: flag.carrierPlayerId || '',
      carrierHoldSeconds,
      roundId: currentScoreRoundId,
      x: bx,
      y: by,
      z: bz
    })
  }

  const clampedDt = Math.min(dt, 0.1)

  // Track carrier Y for gravity target estimation + staleness detection
  if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
    const nowMs = Date.now()
    const carrierPos = getPlayerPosition(flag.carrierPlayerId)
    if (carrierPos) {
      lastCarrierPositionMs = nowMs
      lastKnownCarrierPos = Vector3.create(carrierPos.x, carrierPos.y, carrierPos.z)

      const nowSec = nowMs / 1000
      carrierYSamples.push({ y: carrierPos.y, time: nowSec })
      while (carrierYSamples.length > 0 && nowSec - carrierYSamples[0].time > CARRIER_Y_WINDOW_SEC) {
        carrierYSamples.shift()
      }
    }

    // Staleness check: force-drop if carrier position is unavailable for 5s
    if (lastCarrierPositionMs > 0 && (nowMs - lastCarrierPositionMs) > CARRIER_NO_POSITION_TIMEOUT_MS) {
      console.log('[Server] ⚠️ STALE CARRIER DETECTED:', flag.carrierPlayerId.slice(0, 8), '- no position data for', Math.round((nowMs - lastCarrierPositionMs) / 1000) + 's — force-dropping flag')
      flushHoldTimeAccum()
      const dropPos = lastKnownCarrierPos
        ? Vector3.create(lastKnownCarrierPos.x, lastKnownCarrierPos.y + 0.5, lastKnownCarrierPos.z)
        : Transform.get(flagEntity).position
      const mutable = Flag.getMutable(flagEntity)
      mutable.state = FlagState.Dropped
      mutable.carrierPlayerId = ''
      mutable.dropAnchorX = dropPos.x
      mutable.dropAnchorY = dropPos.y
      mutable.dropAnchorZ = dropPos.z
      lastDropperId = ''
      resetCarrierTracking()
      computeGravityTarget(dropPos.y)
      room.send('dropSound', { t: 0 })
    }
  } else {
    resetCarrierTracking()
  }

  // Gravity for dropped flag
  let currentAnchorY = flag.dropAnchorY
  if (flag.state === FlagState.Dropped && flagFalling) {
    flagFallVelocity += FLAG_GRAVITY * clampedDt
    let newY = currentAnchorY - flagFallVelocity * clampedDt
    if (newY <= flagGravityTargetY) {
      newY = flagGravityTargetY
      flagFalling = false
      flagFallVelocity = 0
    }
    currentAnchorY = newY
    const flagMutable = Flag.getMutable(flagEntity)
    flagMutable.dropAnchorY = newY
  }

  // Water respawn (with delay)
  const WATER_RESPAWN_Y = 49.58
  if (flag.state === FlagState.Dropped && currentAnchorY <= WATER_RESPAWN_Y && !waterRespawnActive) {
    waterRespawnActive = true
    waterRespawnTimer = WATER_RESPAWN_DELAY
    // Let the flag sink to the invisible collider floor during the delay
    flagGravityTargetY = SCENE_FLOOR_Y
    flagFalling = true
    console.log('[Server] 🌊 Flag hit water (Y=' + currentAnchorY.toFixed(2) + ') — sinking to Y=0, respawning in ' + WATER_RESPAWN_DELAY + 's')
    room.send('flagSinking', { t: 0 })
  }

  if (waterRespawnActive) {
    if (flag.state !== FlagState.Dropped) {
      // Flag was picked up during delay — cancel
      waterRespawnActive = false
      waterRespawnTimer = 0
      console.log('[Server] 🌊 Water respawn cancelled — flag picked up')
    } else {
      waterRespawnTimer -= clampedDt
      if (waterRespawnTimer <= 0) {
        waterRespawnActive = false
        waterRespawnTimer = 0
        const spawn = getRandomSpawnPoint()
        console.log('[Server] 🌊 Flag respawning at', spawn.x, spawn.y, spawn.z)
        const flagMutable2 = Flag.getMutable(flagEntity)
        flagMutable2.state = FlagState.AtBase
        flagMutable2.carrierPlayerId = ''
        flagMutable2.baseX = spawn.x
        flagMutable2.baseY = spawn.y
        flagMutable2.baseZ = spawn.z
        flagMutable2.dropAnchorX = spawn.x
        flagMutable2.dropAnchorY = spawn.y
        flagMutable2.dropAnchorZ = spawn.z
        const t2 = Transform.getMutable(flagEntity)
        t2.position = Vector3.create(spawn.x, spawn.y, spawn.z)
        flagFalling = false
        flagFallVelocity = 0
      }
    }
  }

  // Re-assert the authoritative Transform whenever the flag isn't carried. This drives
  // gravity visuals AND overwrites any hostile client Transform write (Transform has no
  // validateBeforeChange). Only writes when the value actually changed, to avoid dirtying
  // the synced component every frame while the flag sits still at base.
  if (flag.state !== FlagState.Carried) {
    const restX = flag.state === FlagState.AtBase ? flag.baseX : flag.dropAnchorX
    const restY = flag.state === FlagState.AtBase ? flag.baseY : currentAnchorY
    const restZ = flag.state === FlagState.AtBase ? flag.baseZ : flag.dropAnchorZ
    const t = Transform.getMutable(flagEntity)
    const p = t.position
    if (p.x !== restX || p.y !== restY || p.z !== restZ) {
      t.position = Vector3.create(restX, restY, restZ)
    }
  }

  // Detect carrier disconnect
  if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
    let carrierConnected = false
    const carrierLower = flag.carrierPlayerId.toLowerCase()
    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
      if (identity.address.toLowerCase() === carrierLower) {
        carrierConnected = true
        break
      }
    }
    if (!carrierConnected) {
      console.log('[Server] ⚠️ Carrier', carrierLower.slice(0, 8), 'disconnected (PlayerIdentityData gone) — dropping flag')
      flushHoldTimeAccum()
      const dropPos = lastKnownCarrierPos
        ? Vector3.create(lastKnownCarrierPos.x, lastKnownCarrierPos.y + 0.5, lastKnownCarrierPos.z)
        : Transform.get(flagEntity).position
      const mutable = Flag.getMutable(flagEntity)
      mutable.state = FlagState.Dropped
      mutable.carrierPlayerId = ''
      mutable.dropAnchorX = dropPos.x
      mutable.dropAnchorY = dropPos.y
      mutable.dropAnchorZ = dropPos.z
      lastDropperId = ''
      resetCarrierTracking()
      computeGravityTarget(dropPos.y)
      room.send('dropSound', { t: 0 })
    }
  }
}

export function holdTimeServerSystem(dt: number): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag || flag.state !== FlagState.Carried || !flag.carrierPlayerId) {
    flushHoldTimeAccum()
    return
  }

  const carrierKey = flag.carrierPlayerId.toLowerCase()

  // Carrier changed — flush accumulated time to the PREVIOUS carrier first
  if (carrierKey !== holdTimeCarrierKey) {
    flushHoldTimeAccum()
    holdTimeCarrierKey = carrierKey
  }

  holdTimeAccum += Math.min(dt, 0.1)
  if (holdTimeAccum < HOLD_TIME_SYNC_INTERVAL) return

  const entity = getOrCreateHoldTimeEntity(carrierKey)
  // Defensive: getMutableOrNull never throws, so a transient stale entity can
  // only skip one tick's accumulation instead of erroring on every frame.
  const mutable = PlayerFlagHoldTime.getMutableOrNull(entity)
  if (mutable) {
    mutable.seconds += holdTimeAccum
    holdTimeShadowTotals.set(carrierKey, mutable.seconds)
    holdTimeAccum = 0
  }
}

// ── Message handler registration ──

export function registerFlagHandlers(): void {
  room.onMessage('requestPickup', (_data, context) => {
    try {
      if (!context) return
      handlePickup(context.from.toLowerCase())
    } catch (err) { console.error('[Server] ❌ requestPickup handler error:', err) }
  })

  room.onMessage('requestDrop', (_data, context) => {
    try {
      if (!context) return
      handleDrop(context.from.toLowerCase())
    } catch (err) { console.error('[Server] ❌ requestDrop handler error:', err) }
  })

  room.onMessage('requestSteal', (data, context) => {
    try {
      if (!context) return
      const attackerId = context.from.toLowerCase()
      const victimId = (data.victimId || '').toLowerCase()
      if (!victimId || victimId === attackerId) return

      // Corroboration for checkProximitySteal: the client believes it is within
      // steal range, whatever this handler decides below. Recorded before any
      // validation so a request rejected only for immunity/server-view distance
      // still lets the server-side steal fire once conditions clear.
      recordStealIntent(stealIntents, attackerId, Date.now())

      const flag = Flag.getOrNull(flagEntity)
      if (!flag || flag.state !== FlagState.Carried || flag.carrierPlayerId !== victimId) return

      // Check steal immunity
      const now = Date.now()
      const carrierStealTime = lastStealTime.get(victimId) ?? 0
      if (now - carrierStealTime < STEAL_IMMUNITY_MS) return

      // Validate proximity with generous radius (client has fresher positions).
      const attackerPos = getPlayerPosition(attackerId)
      const carrierPos = getPlayerPosition(victimId)
      if (!attackerPos || !carrierPos) {
        // Missing authoritative position — reject rather than trust the client, or a
        // hostile client could steal from across the map right after connecting. The
        // server-side checkProximitySteal still catches legitimate steals once positions replicate.
        return
      }
      const dist = Vector3.distance(attackerPos, carrierPos)
      // Use 1.5x radius as validation — client already checked at 1x, small slack for lag
      if (dist > PROXIMITY_STEAL_RADIUS * 1.5) {
        console.log('[Server] 🚩 requestSteal rejected: server dist', dist.toFixed(1), 'too far (1.5x radius check)')
        return
      }

      console.log('[Server] 🚩 Client-requested steal:', attackerId.slice(0, 8), '<-', victimId.slice(0, 8))
      handleFlagSteal(victimId, attackerId)
    } catch (err) { console.error('[Server] ❌ requestSteal handler error:', err) }
  })

  room.onMessage('reportGroundY', (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const flag = Flag.getOrNull(flagEntity)
      if (!flag || flag.state !== FlagState.Dropped) return
      // NaN/Infinity are rejected outright (before consuming any one-shot/budget).
      if (!Number.isFinite(data.y)) return

      let newTarget: number
      if (lastDropperId) {
        // Dropper-authoritative path: only the recorded dropper's report is trusted,
        // and only ONCE per drop — the legit flow sends a single raycast result, and
        // repeat reports would otherwise retry the raise cap.
        if (from !== lastDropperId) return
        if (groundReportUsed) return
        groundReportUsed = true
        // Clamp the client-reported ground Y to the valid terrain band. Without an
        // upper bound a hostile client could send y=1e6 and hang the flag in the sky,
        // unreachable until round end. A report may RAISE the flag by at most a few
        // meters (its legit purpose is un-burying a flag dropped inside terrain):
        // FLAG_MAX_Y alone still sits ~60m above the highest walkable ground, so an
        // uncapped raise would let the dropper hang the flag out of PICKUP_RADIUS
        // reach for the rest of the round. The cap is computed from the IMMUTABLE
        // per-drop baseline, never the live anchor a successful report moves.
        // Accepted residual: a mid-air dropper (updraft) can still hang the flag at
        // their drop height +5 until water sink / round end — capping below the drop
        // point would break the legit un-bury case.
        newTarget = Math.min(FLAG_MAX_Y, dropBaselineY + 5, Math.max(FLAG_MIN_Y, data.y + 0.5))
      } else {
        // Server-initiated drop (carrier disconnect, stale carrier, lightning) or a
        // restart-restored dropped flag: no dropper to trust — but these drops also
        // have no carrier ground samples, so the flag can be left hanging at the
        // vanished carrier's mid-air Y. Accept LOWER-only reports from ANY client so
        // an honest raycast can settle it to real ground. Raising is never allowed,
        // so the worst a hostile client gets is sinking the flag to FLAG_MIN_Y —
        // below the water line, i.e. a water respawn back to base. Mild, bounded,
        // and better than a flag hanging unreachable for the rest of the round.
        // Budgeted per drop so spammed ε-lower reports can't flood the handler.
        if (groundLowerReportsLeft <= 0) return
        newTarget = Math.max(FLAG_MIN_Y, data.y + 0.5)
        if (newTarget >= flagGravityTargetY) return
        groundLowerReportsLeft--
      }
      flagGravityTargetY = newTarget

      const currentAnchorY = flag.dropAnchorY
      if (currentAnchorY <= newTarget) {
        const flagMutable = Flag.getMutable(flagEntity)
        flagMutable.dropAnchorY = newTarget
        flagFalling = false
        flagFallVelocity = 0
      } else if (!flagFalling) {
        flagFalling = true
        flagFallVelocity = 0
      }
    } catch (err) { console.error('[Server] ❌ reportGroundY handler error:', err) }
  })
}
