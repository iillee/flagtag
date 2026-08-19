/**
 * flagLogic.ts — Flag pickup, drop, steal, gravity, hold-time tracking.
 *
 * Exports systems (flagServerSystem, holdTimeServerSystem, checkProximitySteal),
 * message handler registration (registerFlagHandlers), and helpers needed by
 * other modules (handleDrop, flushHoldTimeAccum, resetGravityState,
 * getOrCreateHoldTimeEntity). handleFlagSteal is exported but module-local in
 * practice — checkProximitySteal is its only caller now that clients no longer
 * request steals.
 */

import { engine, Transform, PlayerIdentityData, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import {
  Flag, FlagState, PlayerFlagHoldTime, CountdownTimer,
  FLAG_BASE_POSITION, getRandomSpawnPoint
} from '../shared/components'
import { room } from '../shared/messages'
import { type StealCandidate, selectClosestCandidate } from './stealCandidate'
import { isRateLimited } from './cooldownValidation'
import { recordRejection } from './rejectionStats'
import { LIGHTNING_RESPAWN_DURATION_SEC } from '../shared/constants'
import {
  flagEntity, setFlagEntity, countdownEntity,
  holdTimeEntities, knownPlayers, playerNames,
  currentScoreRoundId,
  lastStealTime, lightningStruckAt, deathPenaltyCooldowns, rejectionCounts,
  PICKUP_RADIUS, PROXIMITY_STEAL_RADIUS, STEAL_IMMUNITY_MS, HOLD_TIME_SYNC_INTERVAL,
  FLAG_GRAVITY, FLAG_MIN_Y, FLAG_MAX_Y, SCENE_FLOOR_Y, CARRIER_Y_WINDOW_SEC, CARRIER_NO_POSITION_TIMEOUT_MS,
  getPlayerPosition, getActivePlayerAddresses
} from './serverState'
import {
  computeFallY,
  computeLandTimeMs
} from '../shared/flagFall'

// ── Module-local state ──

let flagFalling = false
let flagFallVelocity = 0
let flagGravityTargetY = FLAG_MIN_Y

// Message-driven flag fall (bomb/banana pattern; see src/shared/flagFall.ts).
//
// Instead of writing Flag.dropAnchorY + Transform.position every physics tick
// (~60 CRDT writes/sec during a multi-second fall — historical saturation
// profile per docs/CRDT_SATURATION_REDUCTION.md), the server broadcasts ONE
// `flagFallStart` message per fall and every client runs the same analytic
// gravity locally at 60fps. Server tracks the fall parameters and evaluates
// the analytic Y on demand for pickup validation and water-hit detection.
// One `flagLanded` message + one CRDT write closes the fall.
interface FlagFallInfo {
  active: boolean
  startX: number
  startY: number
  startZ: number
  targetY: number
  dropTimeMs: number
  landTimeMs: number  // absolute wall time (Date.now() ms) when analytic Y hits targetY
}
let flagFallInfo: FlagFallInfo = {
  active: false, startX: 0, startY: 0, startZ: 0, targetY: 0, dropTimeMs: 0, landTimeMs: 0
}
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
export function computeGravityTarget(dropX: number, dropY: number, dropZ: number): void {
  // Called at every drop site — record the immutable baseline for this drop and
  // re-arm the one-shot ground report and the lower-only report budget.
  dropBaselineY = dropY
  groundReportUsed = false
  groundLowerReportsLeft = GROUND_LOWER_REPORT_BUDGET
  // Default: assume the drop happens ON the ground (walking drop). The flag
  // shouldn't fall through the terrain the carrier is standing on — that was
  // the playtest-#9 bug caused by using min(carrierYSamples.y) as the target:
  // a carrier who picked up the flag in a valley (Y=50), climbed a mountain
  // (Y=90) and dropped it there had the flag animate from Y=90 down to Y=50
  // straight through the mountain. Bananas/bombs don't do this because their
  // target is a ground raycast at the DROP location, not carrier history.
  //
  // If the drop is genuinely mid-air (jump, updraft, edge), the client's
  // reportGroundY raycast (below) will lower the target to real ground after
  // ~230ms — retargeting the analytic in-flight without a visible restart.
  carrierYSamples.length = 0
  flagGravityTargetY = Math.max(FLAG_MIN_Y, dropY - 0.5)

  if (dropY > flagGravityTargetY + 0.1) {
    flagFalling = true
    flagFallVelocity = 0
    // Kick off the message-driven analytic fall. Every client's local sim
    // will render this fall smoothly at 60fps without any per-frame CRDT.
    beginFall(dropX, dropY, dropZ, flagGravityTargetY)
  } else {
    flagFalling = false
    // Any previous fall must be finalized — clear the info so pickup logic
    // reads dropAnchor directly and any lingering flagFallStart on a client
    // is superseded by the current CRDT Transform on next tick.
    flagFallInfo.active = false
  }
}

export function resetGravityState(): void {
  flagFalling = false
  flagFallVelocity = 0
  carrierYSamples.length = 0
  // Cancel any active analytic fall too — the flag has been picked up,
  // steal-handed, respawned, or the round reset. Clients ignore stale
  // fall data anyway because the CRDT Flag.state changes.
  flagFallInfo.active = false
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
  if (flag.state === FlagState.AtBase) return Vector3.create(flag.baseX, flag.baseY, flag.baseZ)
  // During an active analytic fall, Flag.dropAnchorY is frozen at startY (we
  // deliberately don't dirty it per-frame anymore). Compute the true Y from
  // the analytic formula so pickup validation stays exact — no throttle
  // staleness like the earlier fall-throttle approach had.
  if (flagFallInfo.active) {
    return Vector3.create(
      flagFallInfo.startX,
      computeFallY(flagFallInfo.startY, flagFallInfo.targetY, flagFallInfo.dropTimeMs, Date.now(), FLAG_GRAVITY),
      flagFallInfo.startZ
    )
  }
  return Vector3.create(flag.dropAnchorX, flag.dropAnchorY, flag.dropAnchorZ)
}

/**
 * Begin a message-driven fall from (startX, startY, startZ) to targetY.
 * Broadcasts `flagFallStart` so every client can start local analytic sim,
 * arms internal fall bookkeeping for pickup validation and landing detection.
 * Called at every drop site (voluntary drop, force-drop, carrier disconnect,
 * stale carrier, lightning) AND when a client `reportGroundY` lowers the
 * target mid-fall (fall restarts from current analytic position with new target).
 */
function beginFall(startX: number, startY: number, startZ: number, targetY: number): void {
  const now = Date.now()
  const landMs = computeLandTimeMs(startY, targetY, FLAG_GRAVITY)
  flagFallInfo = {
    active: true,
    startX, startY, startZ, targetY,
    dropTimeMs: now,
    landTimeMs: now + landMs
  }
  // (No dropAnchor writes here. Client visual runs its own local raycast +
  // Euler gravity from the flagFallStart coords — bomb pattern — and doesn't
  // consult dropAnchor during a fall. Server writes dropAnchor to landY in
  // endFall as before, for post-landing at-rest position.)
  // Every client (and any late-joiner, via the 250ms rebroadcast below) will
  // now compute the same Y for the same `now`. No CRDT writes during the fall.
  room.send('flagFallStart', {
    startX, startY, startZ, targetY, dropTimeMs: now
  })
  console.log('[Server] 🚩⬇️ beginFall startY=', startY.toFixed(1),
    'targetY=', targetY.toFixed(1),
    'estLandInMs=', landMs.toFixed(0))
}

/**
 * Close the active fall. Writes the final rest position to Flag.dropAnchorY
 * and Transform (one CRDT write each — the ONLY per-frame writes normally
 * suppressed by the message-driven pattern), broadcasts `flagLanded`, and
 * clears fall bookkeeping so authoritativeFlagPos falls back to the Flag
 * component's dropAnchor fields again.
 */
function endFall(landX: number, landY: number, landZ: number): void {
  flagFallInfo.active = false
  const fm = Flag.getMutable(flagEntity)
  fm.dropAnchorX = landX
  fm.dropAnchorY = landY
  fm.dropAnchorZ = landZ
  const t = Transform.getMutable(flagEntity)
  t.position = Vector3.create(landX, landY, landZ)
  room.send('flagLanded', { x: landX, y: landY, z: landZ })
  console.log('[Server] 🚩🎯 endFall landedY=', landY.toFixed(1))
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
    recordRejection(rejectionCounts, 'requestPickup:no-flag')
    console.log('[Server] ⚠️ handlePickup REJECT: no flag entity for', playerId.slice(0, 8))
    return
  }
  if (flag.state !== FlagState.AtBase && flag.state !== FlagState.Dropped) {
    // Routine: contested drops race — one pickup wins, the losers' in-flight requests
    // land tens of ms later and refuse here (playtest 2026-08-19 showed 3-player bursts).
    // Counted only, per the rejectionStats doctrine.
    recordRejection(rejectionCounts, 'requestPickup:already-carried')
    return
  }

  // Round-end possession freeze — same gate as checkProximitySteal, or a flag force-dropped
  // in the final seconds gets auto-picked by a player already frozen in the cinematic box.
  if (isRoundEndingSoon(Date.now())) {
    recordRejection(rejectionCounts, 'requestPickup:round-ending')
    return
  }

  const playerPos = getPlayerPosition(playerId)
  if (!playerPos) {
    // No authoritative position yet (avatar Transform not replicated) — reject rather
    // than trust the client, or a hostile client could pick up from anywhere. Legitimate
    // pickups self-heal once the position replicates a moment later.
    recordRejection(rejectionCounts, 'requestPickup:no-position')
    return
  }
  const flagPos = authoritativeFlagPos(flag)
  const dist = Vector3.distance(playerPos, flagPos)
  if (dist > PICKUP_RADIUS) {
    // The pickup-side "movement the server does not accept": the client believed it was
    // at the flag; the server's view disagrees by more than PICKUP_RADIUS. Counted AND
    // logged — the log's payload (both positions) is the position-desync diagnostic the
    // counter can't carry, and volume is bounded by the client's pickup retry cadence.
    recordRejection(rejectionCounts, 'requestPickup:too-far')
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

/**
 * Returns whether the drop actually happened, so the requestDrop message handler can count
 * refusals. Internal callers (force-drop paths, carrier-death drop) ignore the return —
 * for them a refusal is the normal same-frame double-drop case, not a rejected request.
 */
export function handleDrop(playerId: string, forced: boolean = false): boolean {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) return false
  if (flag.state !== FlagState.Carried || flag.carrierPlayerId !== playerId) return false

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
  computeGravityTarget(dropPos.x, dropPos.y, dropPos.z)

  room.send('dropSound', { t: 0 })
  // Fast-path WS message for combat-forced drops so clients don't wait for CRDT.
  // Includes the drop position so the client visual can jump straight to the
  // real spot (previously it lingered at the stale carrier-local offset until
  // the CRDT Transform update propagated — the split-second delay playtesters
  // reported).
  if (forced) {
    room.send('dropForced', { playerId, x: dropPos.x, y: dropPos.y, z: dropPos.z })
  }
  return true
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

/**
 * Exclusion window for a lightning-struck player, deliberately LONGER than the client's freeze.
 *
 * The two clocks start at different moments: the server's when it SENDS `lightningStrike`, the
 * client's when the message ARRIVES and `handleLocalDeath` sets `lightningRespawnDelay`. They are
 * therefore offset by one-way latency, so a window sized exactly to the freeze reopens while the
 * victim is still input-disabled — reintroducing the case this exclusion exists to prevent. The
 * margin covers that offset with slack; the codebase puts RTT at ~100-200ms.
 *
 * A heuristic, not a guarantee: the client counts its freeze down by `dt`, so a client whose
 * frames stall (backgrounded tab) can stay frozen far longer in wall-clock terms. Closing that
 * completely means the server sending an authoritative expiry and the client honouring it — a
 * message-schema change plus reworking the client's dt-based countdown onto wall time. Not done,
 * because the residual is bounded: from 1.5s after the strike the victim sits at the spawn
 * platform, where a carrier has no reason to be.
 */
const LIGHTNING_EXCLUSION_MARGIN_MS = 1500
const LIGHTNING_RESPAWN_MS = LIGHTNING_RESPAWN_DURATION_SEC * 1000 + LIGHTNING_EXCLUSION_MARGIN_MS

/**
 * Exclusion window after a client-reported death (`deathPenalty`), covering water and ghost
 * deaths, which — unlike lightning — the server does not decide itself. The longest client
 * freeze is the water sequence: RESPAWN_DURATION = 10.0s (waterSystem.ts), dt-counted, so it
 * ends no EARLIER than 10s wall clock after the report was sent. The margin covers the
 * one-way latency offset, same reasoning as LIGHTNING_EXCLUSION_MARGIN_MS. (An earlier
 * version used 8.5s — a misread of the freeze — which spent the whole margin and could
 * re-admit a still-frozen player.)
 *
 * Client-reported, so weaker than the lightning signal — but the trust is asymmetric in our
 * favor: reporting a death only EXCLUDES the reporter from stealing (no gain to fake), and
 * withholding it only skips their own coin penalty, which was already true before this read.
 * Playtest 2026-08-19 recorded the gap this closes: a freshly-dead player was handed the flag
 * while input-frozen on the respawn platform.
 */
const DEATH_STEAL_EXCLUSION_MS = 10_000 + LIGHTNING_EXCLUSION_MARGIN_MS

/**
 * No possession changes in the final stretch of a round — gates BOTH checkProximitySteal and
 * handlePickup. Clients start the round-end cinematic on their OWN clock —
 * getCountdownSeconds() floors to 0 for the entire last second, plus skew — and teleport
 * everyone (carrier included) into the shared audience box ~0.6s into the fade, up to ~1s
 * before the server processes round end. Without this gate the server happily hands the flag
 * between cinematic-frozen players piled in that box (playtest 2026-08-19, 15:19:59.8Z: a
 * steal at the audience box 234ms before "Round ended"), and a flag force-dropped in the
 * final seconds gets auto-picked by a frozen player through the pickup path. 2s covers the
 * floor() second plus generous client clock skew; combat hits in the final seconds stay live
 * — only possession changes are frozen, because those are the scoring-relevant nonsense.
 */
const ROUND_END_POSSESSION_FREEZE_MS = 2000

/**
 * True during the last ROUND_END_POSSESSION_FREEZE_MS of a round. Reads the authoritative
 * boundary from the countdown entity rather than recomputing the 5-min boundary, so a
 * drifted/reset timer and this gate can never disagree about when the round ends.
 */
function isRoundEndingSoon(now: number): boolean {
  const timer = CountdownTimer.getOrNull(countdownEntity)
  return timer !== null && timer.roundEndTimeMs - now < ROUND_END_POSSESSION_FREEZE_MS
}

// Deliberately NO position-history lookback here, unlike combat's lag-forgiving hit checks.
// wasWithinRadius compares a candidate's PAST positions against the carrier's CURRENT one,
// which inflates the effective radius whenever the carrier moves onto ground the candidate
// just left: with both running at BASE_RUN (10 m/s), a 150 ms window admits any gap under
// 3.3 m (4.05 m on a mushroom boost) even though the two were never adjacent. This system
// runs every tick, so a one-off position spike only postpones a steal by ~33 ms — there is
// nothing to forgive. (The one-shot requestSteal message did need that forgiveness, which
// is why it existed; that path is gone.)
export function checkProximitySteal(): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag || flag.state !== FlagState.Carried || !flag.carrierPlayerId) return

  // Lowercased at the source, matching every other consequential reader of this field, so the
  // `addr === carrierId` compare below and the immunity map lookup cannot miss on casing.
  const carrierId = flag.carrierPlayerId.toLowerCase()
  const carrierPos = getPlayerPosition(carrierId)
  if (!carrierPos) return

  // Steal immunity, via the shared rate-limit helper (unit-tested in
  // test/cooldownValidation.spec.ts) rather than open-coded arithmetic. It also treats a
  // non-finite timestamp as still-limited, where `now - NaN < ms` would have evaluated false
  // and allowed the steal.
  const now = Date.now()
  if (isRateLimited(lastStealTime.get(carrierId), now, STEAL_IMMUNITY_MS)) return

  // Round-end possession freeze — see ROUND_END_POSSESSION_FREEZE_MS.
  if (isRoundEndingSoon(now)) return

  // Server-authoritative: the closest player inside the radius takes the flag, decided on
  // the server's own position view — the same view handlePickup, trap triggers, projectile
  // hits and ghost touching already act on unconditionally.
  const candidates: StealCandidate[] = []
  for (const addr of getActivePlayerAddresses()) {
    // Skip the carrier here AND pass them to selectClosestCandidate below — two independent
    // layers, deliberately. If the carrier ever reached the candidate list they would sit at
    // distance 0 from themselves and win every tick forever, so this is worth belt and braces:
    // this filter also saves a redundant full-entity-scan lookup, while the parameter below is
    // the unit-tested guarantee and is case-insensitive where this compare is not.
    if (addr === carrierId) continue
    // A lightning-struck player is frozen with input disabled until they respawn — they could
    // neither run from the flag nor drop it, and the flag would ride them to the spawn platform.
    // The deleted client predictor enforced this via !isLightningRespawning(); this is the
    // server-side equivalent, and it is authoritative because the SERVER picks the victim
    // (roundManager sends lightningStrike).
    if (isRateLimited(lightningStruckAt.get(addr), now, LIGHTNING_RESPAWN_MS)) continue
    // Water and ghost deaths have the same frozen-player shape but are only client-reported —
    // the `deathPenalty` message stamps deathPenaltyCooldowns on EVERY death, so use it as the
    // exclusion signal. (An earlier version of this comment claimed those deaths had "no
    // server-visible signal"; that predates the deathPenalty handler.) See
    // DEATH_STEAL_EXCLUSION_MS for the window and why trusting the client here is safe.
    if (isRateLimited(deathPenaltyCooldowns.get(addr), now, DEATH_STEAL_EXCLUSION_MS)) continue
    const pos = getPlayerPosition(addr)
    if (!pos) continue
    candidates.push({ addr, dist: Vector3.distance(carrierPos, pos) })
  }

  const { closestId, closestDist } = selectClosestCandidate(candidates, PROXIMITY_STEAL_RADIUS, carrierId)
  if (!closestId) return

  const stealerPos = getPlayerPosition(closestId)
  console.log('[Server] 🚩 Proximity steal:', closestId.slice(0, 8), '<-', carrierId.slice(0, 8),
    '| carrierPos=', `(${carrierPos.x.toFixed(1)},${carrierPos.y.toFixed(1)},${carrierPos.z.toFixed(1)})`,
    '| stealerPos=', stealerPos ? `(${stealerPos.x.toFixed(1)},${stealerPos.y.toFixed(1)},${stealerPos.z.toFixed(1)})` : 'null',
    '| dist=', closestDist.toFixed(3))
  handleFlagSteal(carrierId, closestId)
}

// The flagHeartbeat broadcast was removed 2026-08-19 — the last heartbeat channel, after
// the position and ghost heartbeats went on 2026-08-03. The CRDT Flag component plus the
// pickupConfirmed/dropForced fast paths are the only flag-state transports now. ACCEPTED
// REGRESSIONS: clients have no corrector for a stalled Flag CRDT, and the live scoreboard
// loses its WS re-anchor for stalled PlayerFlagHoldTime values (the "score resets to 0 on
// steal/drop" report can recur under CRDT saturation).
//
// During an active analytic fall we re-broadcast flagFallStart on a fast
// cadence (250ms) so a client that dropped the initial packet only
// stares at a stuck flag for a quarter second before catching up.
// Idempotent — same dropTimeMs is a no-op on clients already tracking this fall.
// (Not a heartbeat: it re-sends one drop event until the fall lands, then stops.)
const FLAG_FALL_REBROADCAST_INTERVAL_MS = 250
let lastFallRebroadcastMs = 0

// ── Server systems ──

export function flagServerSystem(dt: number): void {
  ensureFlagEntity()
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) return

  // Fast fall-rebroadcast loop.
  // Reason: the initial flagFallStart at drop-time can be lost to packet
  // drops or arrive at a client that hadn't registered its handler yet
  // (fresh join / hot reload). The symptom without it, per playtest:
  // flag stays stuck then teleports.
  // Re-firing every 250ms bounds the worst-case stuck-visual to ~250ms.
  const nowForFallRebroadcast = Date.now()
  if (flagFallInfo.active &&
      nowForFallRebroadcast - lastFallRebroadcastMs >= FLAG_FALL_REBROADCAST_INTERVAL_MS) {
    lastFallRebroadcastMs = nowForFallRebroadcast
    room.send('flagFallStart', {
      startX: flagFallInfo.startX,
      startY: flagFallInfo.startY,
      startZ: flagFallInfo.startZ,
      targetY: flagFallInfo.targetY,
      dropTimeMs: flagFallInfo.dropTimeMs
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
      computeGravityTarget(dropPos.x, dropPos.y, dropPos.z)
      room.send('dropSound', { t: 0 })
    }
  } else {
    resetCarrierTracking()
  }

  // Gravity for dropped flag — message-driven analytic model.
  //
  // No per-frame CRDT writes here. When a drop begins, beginFall() sends one
  // `flagFallStart` and clients render the fall via computeFallY at 60fps.
  // This tick only:
  //   1. Evaluates the analytic Y for internal use (water-hit test below,
  //      currentAnchorY handoff to any downstream at-rest logic).
  //   2. Detects landing via the pre-computed landTimeMs and closes the fall
  //      with a SINGLE CRDT write via endFall().
  //
  // flagFalling/flagFallVelocity are kept in sync with the message-driven
  // state so other code paths (reportGroundY re-arm, roundManager reset)
  // still work the same way.
  let currentAnchorY = flag.dropAnchorY
  if (flagFallInfo.active) {
    const nowMs = Date.now()
    const analyticY = computeFallY(
      flagFallInfo.startY, flagFallInfo.targetY, flagFallInfo.dropTimeMs, nowMs, FLAG_GRAVITY
    )
    currentAnchorY = analyticY
    if (nowMs >= flagFallInfo.landTimeMs) {
      // Land on the same authoritative target the fall was scheduled against —
      // don't use the possibly-slightly-past analytic value.
      endFall(flagFallInfo.startX, flagFallInfo.targetY, flagFallInfo.startZ)
      flagFalling = false
      flagFallVelocity = 0
      currentAnchorY = flagFallInfo.targetY
    }
  }

  // Water respawn (with delay)
  const WATER_RESPAWN_Y = 49.58
  if (flag.state === FlagState.Dropped && currentAnchorY <= WATER_RESPAWN_Y && !waterRespawnActive) {
    waterRespawnActive = true
    waterRespawnTimer = WATER_RESPAWN_DELAY
    // Let the flag sink to the invisible collider floor during the delay.
    // Re-arm a fresh analytic fall from CURRENT analytic Y (not from the last
    // CRDT dropAnchorY, which we deliberately froze at the drop start) so
    // clients pick up the sink from where the visual actually is.
    flagGravityTargetY = SCENE_FLOOR_Y
    flagFalling = true
    beginFall(flag.dropAnchorX, currentAnchorY, flag.dropAnchorZ, SCENE_FLOOR_Y)
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

  // Re-assert the authoritative Transform whenever the flag isn't carried and
  // no analytic fall is active. This drives at-rest position AND overwrites any
  // hostile client Transform write (Transform has no validateBeforeChange).
  // During an active analytic fall we deliberately DON'T write Transform —
  // clients drive the visual locally from `flagFallStart`. The final rest
  // position is written once by endFall(), and non-fall state changes fall
  // through the position-diff guard below.
  if (flag.state !== FlagState.Carried && !flagFallInfo.active) {
    const restX = flag.state === FlagState.AtBase ? flag.baseX : flag.dropAnchorX
    const restY = flag.state === FlagState.AtBase ? flag.baseY : flag.dropAnchorY
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
      computeGravityTarget(dropPos.x, dropPos.y, dropPos.z)
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
      // Routine: a drop can race a steal/force-drop that already took the flag, and the
      // client's drop-fallback path sends on visual state alone. Counted, not logged.
      if (!handleDrop(context.from.toLowerCase())) {
        recordRejection(rejectionCounts, 'requestDrop:not-carrier')
      }
    } catch (err) { console.error('[Server] ❌ requestDrop handler error:', err) }
  })

  // No 'requestSteal' handler: proximity steal is decided entirely by
  // checkProximitySteal on the server's own position view. Clients neither request
  // nor corroborate a steal — see stealCandidate.ts for why the gate was removed.

  room.onMessage('reportGroundY', (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const flag = Flag.getOrNull(flagEntity)
      if (!flag || flag.state !== FlagState.Dropped) {
        // Routine: every observer raycasts on flagFallStart, so late reports land after the flag
        // has already been picked up. Counted, not logged.
        recordRejection(rejectionCounts, 'reportGroundY:not-dropped')
        return
      }
      // NaN/Infinity are rejected outright (before consuming any one-shot/budget).
      if (!Number.isFinite(data.y)) {
        // Anomalous: an honest client never sends this. Log immediately, with the sender.
        console.log('[Server] 🚫 reportGroundY rejected — non-finite y from', from.slice(0, 8), '| y=', String(data.y))
        recordRejection(rejectionCounts, 'reportGroundY:non-finite')
        return
      }

      let newTarget: number
      if (lastDropperId) {
        // Dropper-authoritative path: only the recorded dropper's report is trusted,
        // and only ONCE per drop — the legit flow sends a single raycast result, and
        // repeat reports would otherwise retry the raise cap.
        if (from !== lastDropperId) {
          // Routine and the interesting one in aggregate: N-1 observers are refused per drop, so a
          // count far above the player count means clients are retrying. Its ABSENCE alongside a
          // missing accept is the flag-stranding signature (see docs/KNOWN_BUGS.md).
          recordRejection(rejectionCounts, 'reportGroundY:not-dropper')
          return
        }
        if (groundReportUsed) {
          recordRejection(rejectionCounts, 'reportGroundY:already-used')
          return
        }
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
        if (groundLowerReportsLeft <= 0) {
          // Anomalous: the budget exists to stop report spam, so exhausting it means someone is
          // spamming. Log immediately.
          console.log('[Server] 🚫 reportGroundY rejected — lower-report budget exhausted, from', from.slice(0, 8))
          recordRejection(rejectionCounts, 'reportGroundY:budget-exhausted')
          return
        }
        newTarget = Math.max(FLAG_MIN_Y, data.y + 0.5)
        if (newTarget >= flagGravityTargetY) {
          // Routine: lower-only path, and this report did not improve on the current target.
          recordRejection(rejectionCounts, 'reportGroundY:no-improvement')
          return
        }
        groundLowerReportsLeft--
      }
      flagGravityTargetY = newTarget

      // Read the current analytic Y if a fall is in progress — dropAnchorY is
      // frozen at the fall's startY under the message-driven model.
      const nowMs = Date.now()
      const currentAnchorY = flagFallInfo.active
        ? computeFallY(flagFallInfo.startY, flagFallInfo.targetY, flagFallInfo.dropTimeMs, nowMs, FLAG_GRAVITY)
        : flag.dropAnchorY
      if (currentAnchorY <= newTarget) {
        // Already at/below the new target — snap to it and end any active fall.
        if (flagFallInfo.active) {
          endFall(flag.dropAnchorX, newTarget, flag.dropAnchorZ)
        } else {
          const flagMutable = Flag.getMutable(flagEntity)
          flagMutable.dropAnchorY = newTarget
        }
        flagFalling = false
        flagFallVelocity = 0
      } else {
        // Need to (re)start a fall from the current visual position to the new
        // lower target. If a fall is already in progress, this replaces it —
        // clients receive a fresh flagFallStart and reset their local sim.
        flagFalling = true
        flagFallVelocity = 0
        beginFall(flag.dropAnchorX, currentAnchorY, flag.dropAnchorZ, newTarget)
      }
    } catch (err) { console.error('[Server] ❌ reportGroundY handler error:', err) }
  })
}
