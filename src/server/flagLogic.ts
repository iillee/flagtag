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
import { persistFlagState } from './persistence'
import {
  flagEntity, setFlagEntity,
  holdTimeEntities, knownPlayers, playerNames,
  lastStealTime,
  PICKUP_RADIUS, PROXIMITY_STEAL_RADIUS, STEAL_IMMUNITY_MS, HOLD_TIME_SYNC_INTERVAL,
  FLAG_GRAVITY, FLAG_MIN_Y, FLAG_MAX_Y, SCENE_FLOOR_Y, CARRIER_Y_WINDOW_SEC, CARRIER_NO_POSITION_TIMEOUT_MS,
  getPlayerPosition
} from './serverState'

// ── Module-local state ──

let flagFalling = false
let flagFallVelocity = 0
let flagGravityTargetY = FLAG_MIN_Y
const carrierYSamples: { y: number; time: number }[] = []
let lastDropperId = ''  // Who dropped the flag — only accept reportGroundY from them
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

// ── Hold-time helpers ──

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
  if (cached !== undefined && PlayerFlagHoldTime.getOrNull(cached) !== null) {
    return cached
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
  PlayerFlagHoldTime.create(entity, { playerId: key, seconds: 0 })
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
  if (!flag) return
  if (flag.state !== FlagState.AtBase && flag.state !== FlagState.Dropped) return

  const playerPos = getPlayerPosition(playerId)
  if (!playerPos) {
    // No authoritative position yet (avatar Transform not replicated) — reject rather
    // than trust the client, or a hostile client could pick up from anywhere. Legitimate
    // pickups self-heal once the position replicates a moment later.
    console.log('[Server] ⚠️ handlePickup: no position for', playerId.slice(0, 8), '— rejecting')
    return
  }
  const dist = Vector3.distance(playerPos, authoritativeFlagPos(flag))
  if (dist > PICKUP_RADIUS) return

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
  persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
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
  persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
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
  persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
}

// ── Proximity steal system ──

export function checkProximitySteal(): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag || flag.state !== FlagState.Carried || !flag.carrierPlayerId) return

  const carrierId = flag.carrierPlayerId
  const carrierPos = getPlayerPosition(carrierId)
  if (!carrierPos) return

  const now = Date.now()
  const carrierStealTime = lastStealTime.get(carrierId) ?? 0
  if (now - carrierStealTime < STEAL_IMMUNITY_MS) return

  let closestId: string | null = null
  let closestDist = PROXIMITY_STEAL_RADIUS

  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    const addr = identity.address.toLowerCase()
    if (addr === carrierId) continue

    const pos = getPlayerPosition(addr)
    if (!pos) continue
    const dist = Vector3.distance(carrierPos, pos)
    if (dist < closestDist) {
      closestDist = dist
      closestId = addr
    }
  }

  if (closestId) {
    console.log('[Server] 🚩 Proximity steal:', closestId.slice(0, 8), '<-', carrierId.slice(0, 8))
    handleFlagSteal(carrierId, closestId)
  }
}

// ── Flag heartbeat: periodic WS broadcast so clients can self-correct stale CRDT ──
const FLAG_HEARTBEAT_INTERVAL_MS = 5000
let lastHeartbeatMs = 0

// ── Server systems ──

export function flagServerSystem(dt: number): void {
  ensureFlagEntity()
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) return

  // Heartbeat: broadcast flag state every 5s so clients can fix stale visuals
  const nowForHb = Date.now()
  if (nowForHb - lastHeartbeatMs >= FLAG_HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMs = nowForHb
    const pos = Transform.get(flagEntity).position
    room.send('flagHeartbeat', {
      state: flag.state as string,
      carrierId: flag.carrierPlayerId || '',
      x: pos.x,
      y: pos.y,
      z: pos.z
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
      persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
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
      persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
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
        persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
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
      persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
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

  room.onMessage('requestReloadRespawn', (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const flag = Flag.getOrNull(flagEntity)
      if (!flag || flag.state !== FlagState.Carried || flag.carrierPlayerId !== from) return
      const spawn = getRandomSpawnPoint()
      const mutable = Flag.getMutable(flagEntity)
      mutable.state = FlagState.AtBase
      mutable.carrierPlayerId = ''
      mutable.baseX = spawn.x
      mutable.baseY = spawn.y
      mutable.baseZ = spawn.z
      const t = Transform.getMutable(flagEntity)
      t.position = Vector3.create(spawn.x, spawn.y, spawn.z)
      persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
    } catch (err) { console.error('[Server] ❌ requestReloadRespawn handler error:', err) }
  })

  room.onMessage('requestSteal', (data, context) => {
    try {
      if (!context) return
      const attackerId = context.from.toLowerCase()
      const victimId = (data.victimId || '').toLowerCase()
      if (!victimId || victimId === attackerId) return

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
      if (lastDropperId && from !== lastDropperId) return
      const flag = Flag.getOrNull(flagEntity)
      if (!flag || flag.state !== FlagState.Dropped) return

      // Clamp the client-reported ground Y to the valid terrain band. Without an upper
      // bound a hostile client could send y=1e6 and hang the flag in the sky, unreachable
      // until round end. NaN/Infinity are rejected outright.
      if (!Number.isFinite(data.y)) return
      const newTarget = Math.min(FLAG_MAX_Y, Math.max(FLAG_MIN_Y, data.y + 0.5))
      flagGravityTargetY = newTarget

      const currentAnchorY = flag.dropAnchorY
      if (currentAnchorY <= newTarget) {
        const flagMutable = Flag.getMutable(flagEntity)
        flagMutable.dropAnchorY = newTarget
        flagFalling = false
        flagFallVelocity = 0
        persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
      } else if (!flagFalling) {
        flagFalling = true
        flagFallVelocity = 0
      }
    } catch (err) { console.error('[Server] ❌ reportGroundY handler error:', err) }
  })
}
