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
  getHoldTimeEntityEnumId, FLAG_BASE_POSITION, getRandomSpawnPoint, SyncIds
} from '../shared/components'
import { room } from '../shared/messages'
import { persistFlagState } from './persistence'
import {
  flagEntity,
  holdTimeEntities, knownPlayers, playerNames,
  lastStealTime,
  PICKUP_RADIUS, PROXIMITY_STEAL_RADIUS, STEAL_IMMUNITY_MS, HOLD_TIME_SYNC_INTERVAL,
  FLAG_GRAVITY, FLAG_MIN_Y, CARRIER_Y_WINDOW_SEC, CARRIER_NO_POSITION_TIMEOUT_MS,
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
  let entity = holdTimeEntities.get(key)
  if (entity) return entity

  entity = engine.addEntity()
  PlayerFlagHoldTime.create(entity, { playerId: key, seconds: 0 })
  syncEntity(entity, [PlayerFlagHoldTime.componentId], getHoldTimeEntityEnumId(key))
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
    const mutable = PlayerFlagHoldTime.getMutable(entity)
    mutable.seconds += holdTimeAccum
    console.log('[Server] Flushed', holdTimeAccum.toFixed(2), 's hold time to', holdTimeCarrierKey.slice(0, 8), '(total:', mutable.seconds.toFixed(1), 's)')
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

export function handlePickup(playerId: string): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) return
  if (flag.state !== FlagState.AtBase && flag.state !== FlagState.Dropped) return

  const playerPos = getPlayerPosition(playerId)
  if (playerPos) {
    const flagPos = Transform.get(flagEntity).position
    const dist = Vector3.distance(playerPos, flagPos)
    if (dist > PICKUP_RADIUS) return
  } else {
    console.log('[Server] ⚠️ handlePickup: no position for', playerId.slice(0, 8), '— trusting client proximity')
  }

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

export function handleDrop(playerId: string): void {
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
  const WATER_RESPAWN_Y = 1.58
  if (flag.state === FlagState.Dropped && currentAnchorY <= WATER_RESPAWN_Y && !waterRespawnActive) {
    waterRespawnActive = true
    waterRespawnTimer = WATER_RESPAWN_DELAY
    // Let the flag sink all the way to Y=0 during the delay
    flagGravityTargetY = 0
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

  // Server only writes Transform when the flag is falling (gravity updates)
  if (flag.state !== FlagState.Carried && flagFalling) {
    const restX = flag.state === FlagState.AtBase ? flag.baseX : flag.dropAnchorX
    const restY = flag.state === FlagState.AtBase ? flag.baseY : currentAnchorY
    const restZ = flag.state === FlagState.AtBase ? flag.baseZ : flag.dropAnchorZ
    const t = Transform.getMutable(flagEntity)
    t.position = Vector3.create(restX, restY, restZ)
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
  const mutable = PlayerFlagHoldTime.getMutable(entity)
  mutable.seconds += holdTimeAccum
  holdTimeAccum = 0
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

      // Validate proximity with generous radius (client has fresher positions)
      const attackerPos = getPlayerPosition(attackerId)
      const carrierPos = getPlayerPosition(victimId)
      if (attackerPos && carrierPos) {
        const dist = Vector3.distance(attackerPos, carrierPos)
        // Use 2x radius as validation — client already checked at 1x
        if (dist > PROXIMITY_STEAL_RADIUS * 2) {
          console.log('[Server] 🚩 requestSteal rejected: server dist', dist.toFixed(1), 'too far (2x radius check)')
          return
        }
      }
      // If either position is missing, trust the client report

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

      const newTarget = Math.max(FLAG_MIN_Y, data.y + 0.5)
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
