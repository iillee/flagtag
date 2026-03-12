import { engine, Transform, GltfContainer, MeshCollider, PlayerIdentityData, type Entity } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import { Storage } from '@dcl/sdk/server'
import {
  Flag, FlagState, PlayerFlagHoldTime, CountdownTimer, LeaderboardState,
  getHoldTimeEntityEnumId, getNextRoundEndTimeMs,
  FLAG_BASE_POSITION, SyncIds
} from '../shared/components'
import { room } from '../shared/messages'

// ── Constants ──
const PICKUP_RADIUS = 3
const HIT_RADIUS = 2.5
const HIT_COOLDOWN_MS = 450
const DROP_BEHIND_DISTANCE = 1.4
const HOLD_TIME_SYNC_INTERVAL = 0.2
const IDLE_BOB_AMPLITUDE = 0.15
const IDLE_BOB_SPEED = 2
const IDLE_ROT_SPEED_DEG_PER_SEC = 25
const SPLASH_DURATION_MS = 3000
const FLAG_GRAVITY = 15          // m/s² (slightly faster than real gravity for snappy game feel)
const FLAG_MIN_Y = 0.5           // absolute minimum Y (ground plane)
const CARRIER_Y_WINDOW_SEC = 2.0 // seconds of carrier Y history to estimate ground level
const BANNER_SRC = 'assets/asset-packs/small_red_banner/Banner_Red_02/Banner_Red_02.glb'

// ── Server state ──
let flagEntity: Entity
let countdownEntity: Entity
let leaderboardEntity: Entity
let idleTime = 0
let holdTimeAccum = 0
const lastAttackTime = new Map<string, number>()
const holdTimeEntities = new Map<string, Entity>()
const knownPlayers = new Set<string>()
const playerNames = new Map<string, string>()

// Gravity state for dropped flag
let flagFalling = false
let flagFallVelocity = 0
let flagGravityTargetY = FLAG_MIN_Y
const carrierYSamples: { y: number; time: number }[] = []

// ── Persistence helpers ──
async function persistFlagState(): Promise<void> {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) return
  const pos = Transform.get(flagEntity).position
  await Storage.set('flagState', JSON.stringify({
    state: flag.state,
    x: pos.x, y: pos.y, z: pos.z,
    carrierPlayerId: flag.carrierPlayerId,
    dropAnchorX: flag.dropAnchorX,
    dropAnchorY: flag.dropAnchorY,
    dropAnchorZ: flag.dropAnchorZ
  }))
}

async function persistLeaderboard(json: string): Promise<void> {
  await Storage.set('leaderboard', json)
}

// ── Setup ──
export async function setupServer(): Promise<void> {
  console.log('[Server] Starting Flag Tag server...')

  // Load persisted flag state
  const savedFlag = await Storage.get<string>('flagState')
  let flagStartState = FlagState.AtBase
  let flagStartPos = Vector3.create(FLAG_BASE_POSITION.x, FLAG_BASE_POSITION.y, FLAG_BASE_POSITION.z)
  let dropAnchor = { x: 0, y: 0, z: 0 }

  if (savedFlag) {
    try {
      const data = JSON.parse(savedFlag)
      if (data.state === FlagState.Dropped) {
        flagStartState = FlagState.Dropped
        flagStartPos = Vector3.create(data.x, data.y, data.z)
        dropAnchor = { x: data.dropAnchorX || data.x, y: data.dropAnchorY || data.y, z: data.dropAnchorZ || data.z }
      }
      // If carried when server stopped, reset to dropped at last position
      if (data.state === FlagState.Carried) {
        flagStartState = FlagState.Dropped
        flagStartPos = Vector3.create(data.x, data.y, data.z)
        dropAnchor = { x: data.x, y: data.y, z: data.z }
      }
    } catch { /* invalid data, use defaults */ }
  }

  // Create flag entity
  flagEntity = engine.addEntity()
  Transform.create(flagEntity, {
    position: flagStartPos,
    rotation: Quaternion.fromEulerDegrees(0, 0, 0),
    scale: Vector3.create(1, 1, 1)
  })
  GltfContainer.create(flagEntity, { src: BANNER_SRC })
  MeshCollider.setBox(flagEntity)
  Flag.create(flagEntity, {
    teamId: 0,
    state: flagStartState,
    carrierPlayerId: '',
    baseX: FLAG_BASE_POSITION.x, baseY: FLAG_BASE_POSITION.y, baseZ: FLAG_BASE_POSITION.z,
    dropAnchorX: dropAnchor.x, dropAnchorY: dropAnchor.y, dropAnchorZ: dropAnchor.z
  })
  syncEntity(flagEntity, [Transform.componentId, Flag.componentId, GltfContainer.componentId], SyncIds.FLAG)

  // Create countdown timer
  const roundEndTimeMs = getNextRoundEndTimeMs()
  countdownEntity = engine.addEntity()
  CountdownTimer.create(countdownEntity, {
    roundEndTimeMs,
    roundEndTriggered: false,
    roundEndDisplayUntilMs: 0
  })
  syncEntity(countdownEntity, [CountdownTimer.componentId], SyncIds.COUNTDOWN)

  // Load persisted leaderboard (all-time, survives redeployments)
  const savedLeaderboard = await Storage.get<string>('leaderboard')
  const leaderboardJson = savedLeaderboard || '[]'
  leaderboardEntity = engine.addEntity()
  LeaderboardState.create(leaderboardEntity, { json: leaderboardJson, date: '' })
  syncEntity(leaderboardEntity, [LeaderboardState.componentId], SyncIds.LEADERBOARD)

  // Register message handlers (added in next step)
  registerHandlers()

  // Register systems (added in next step)
  engine.addSystem(flagServerSystem)
  engine.addSystem(holdTimeServerSystem)
  engine.addSystem(playerTrackingSystem)
  engine.addSystem(countdownServerSystem)

  console.log('[Server] Flag Tag server ready')
}

// ── Helper: find player position by wallet address ──
function getPlayerPosition(address: string): Vector3 | null {
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address === address) return Transform.get(entity).position
  }
  return null
}

function getPlayerRotation(address: string): Quaternion | null {
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address === address) return Transform.get(entity).rotation
  }
  return null
}

// ── Gravity helpers ──

/**
 * Compute where the flag should land based on the carrier's recent ground-level Y.
 * We track the carrier's Y over the last ~2 seconds. The minimum Y in that window
 * is our best estimate of the terrain they were walking on. If the flag is dropped
 * above that level (e.g. mid-jump), gravity pulls it down to the estimated ground.
 */
function computeGravityTarget(dropY: number): void {
  let minY = Infinity
  for (const s of carrierYSamples) {
    if (s.y < minY) minY = s.y
  }
  // If we have history, use the lowest recent Y + small offset; otherwise assume near drop point
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

function resetGravityState(): void {
  flagFalling = false
  flagFallVelocity = 0
  carrierYSamples.length = 0
}

// ── Message handlers ──
function registerHandlers(): void {
  room.onMessage('registerName', (data, context) => {
    if (!context || !data.name) return
    playerNames.set(context.from, data.name)
    // Update existing leaderboard entries with the real display name
    const lb = LeaderboardState.getOrNull(leaderboardEntity)
    if (lb && lb.json) {
      try {
        const entries: { userId: string; name: string; roundsWon: number }[] = JSON.parse(lb.json)
        let changed = false
        for (const entry of entries) {
          if (entry.userId === context.from && entry.name !== data.name) {
            entry.name = data.name
            changed = true
          }
        }
        if (changed) {
          const json = JSON.stringify(entries)
          const mutable = LeaderboardState.getMutable(leaderboardEntity)
          mutable.json = json
          persistLeaderboard(json)
        }
      } catch { /* ignore parse errors */ }
    }
  })
  room.onMessage('requestPickup', (_data, context) => {
    if (!context) return
    handlePickup(context.from)
  })
  room.onMessage('requestDrop', (_data, context) => {
    if (!context) return
    handleDrop(context.from)
  })
  room.onMessage('requestAttack', (_data, context) => {
    if (!context) return
    handleAttack(context.from)
  })
  room.onMessage('reportGroundY', (data, context) => {
    if (!context) return
    const flag = Flag.getOrNull(flagEntity)
    if (!flag || flag.state !== FlagState.Dropped) return

    const newTarget = Math.max(FLAG_MIN_Y, data.y + 0.5)
    flagGravityTargetY = newTarget

    const currentAnchorY = flag.dropAnchorY
    if (currentAnchorY <= newTarget) {
      // Already at or below target — snap and stop
      const flagMutable = Flag.getMutable(flagEntity)
      flagMutable.dropAnchorY = newTarget
      flagFalling = false
      flagFallVelocity = 0
      persistFlagState()
    } else if (!flagFalling) {
      // Target is below current position but gravity stopped — restart it
      flagFalling = true
      flagFallVelocity = 0
    }
    // If already falling, gravity will naturally reach the new target
  })
}

function handlePickup(playerId: string): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) { console.log('[Server] handlePickup: no flag component'); return }
  if (flag.state !== FlagState.AtBase && flag.state !== FlagState.Dropped) {
    console.log('[Server] handlePickup: flag state is', flag.state, '— not pickupable')
    return
  }

  const playerPos = getPlayerPosition(playerId)
  if (!playerPos) { console.log('[Server] handlePickup: player position not found for', playerId); return }

  const flagPos = Transform.get(flagEntity).position
  const dist = Vector3.distance(playerPos, flagPos)
  if (dist > PICKUP_RADIUS) {
    console.log('[Server] handlePickup: too far — dist:', dist.toFixed(2), 'player:', JSON.stringify(playerPos), 'flag:', JSON.stringify(flagPos))
    return
  }
  console.log('[Server] handlePickup: SUCCESS for', playerId)

  const mutable = Flag.getMutable(flagEntity)
  mutable.state = FlagState.Carried
  mutable.carrierPlayerId = playerId

  if (MeshCollider.has(flagEntity)) MeshCollider.deleteFrom(flagEntity)

  resetGravityState()
  room.send('pickupSound', { t: 0 })
  persistFlagState()
}

function handleDrop(playerId: string): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) return
  if (flag.state !== FlagState.Carried || flag.carrierPlayerId !== playerId) return

  const playerPos = getPlayerPosition(playerId)
  const playerRot = getPlayerRotation(playerId)

  let dropPos: Vector3
  if (playerPos && playerRot) {
    const behind = Vector3.rotate(Vector3.Backward(), playerRot)
    const offsetBehind = Vector3.scale(behind, DROP_BEHIND_DISTANCE)
    dropPos = Vector3.add(Vector3.add(playerPos, Vector3.create(0, 0.5, 0)), offsetBehind)
  } else if (playerPos) {
    dropPos = Vector3.add(playerPos, Vector3.create(0, 0.5, 0))
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

  if (!MeshCollider.has(flagEntity)) MeshCollider.setBox(flagEntity)

  // Start gravity — estimate ground from carrier's recent Y history
  computeGravityTarget(dropPos.y)

  room.send('dropSound', { t: 0 })
  persistFlagState()
}

function handleAttack(attackerId: string): void {
  const now = Date.now()
  const lastAttack = lastAttackTime.get(attackerId) ?? 0
  if (now - lastAttack < HIT_COOLDOWN_MS) return
  lastAttackTime.set(attackerId, now)

  const attackerPos = getPlayerPosition(attackerId)
  if (!attackerPos) return

  // Find closest victim
  let closestId: string | null = null
  let closestPos: Vector3 | null = null
  let closestDist = HIT_RADIUS

  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address === attackerId) continue
    const pos = getPlayerPosition(identity.address)
    if (!pos) continue
    const dist = Vector3.distance(attackerPos, pos)
    if (dist < closestDist) {
      closestDist = dist
      closestId = identity.address
      closestPos = pos
    }
  }

  if (closestId && closestPos) {
    // Hit confirmed
    room.send('hitVfx', { x: closestPos.x, y: closestPos.y, z: closestPos.z })
    room.send('stagger', { victimId: closestId })

    // Drop flag if victim was carrying
    const flag = Flag.getOrNull(flagEntity)
    if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === closestId) {
      handleDrop(closestId)
    }
  } else {
    // Miss — send attacker position, client computes forward offset locally
    room.send('missVfx', { x: attackerPos.x, y: attackerPos.y, z: attackerPos.z })
  }
}

// ── Server Systems ──

function flagServerSystem(dt: number): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) return

  const clampedDt = Math.min(dt, 0.1)
  idleTime += clampedDt

  // Track carrier Y for gravity target estimation (rolling window of recent positions)
  if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
    const carrierPos = getPlayerPosition(flag.carrierPlayerId)
    if (carrierPos) {
      const now = Date.now() / 1000
      carrierYSamples.push({ y: carrierPos.y, time: now })
      while (carrierYSamples.length > 0 && now - carrierYSamples[0].time > CARRIER_Y_WINDOW_SEC) {
        carrierYSamples.shift()
      }
    }
  }

  // Gravity for dropped flag — accelerate downward until reaching ground estimate
  let currentAnchorY = flag.dropAnchorY
  if (flag.state === FlagState.Dropped && flagFalling) {
    flagFallVelocity += FLAG_GRAVITY * clampedDt
    let newY = currentAnchorY - flagFallVelocity * clampedDt
    if (newY <= flagGravityTargetY) {
      newY = flagGravityTargetY
      flagFalling = false
      flagFallVelocity = 0
      persistFlagState()
    }
    currentAnchorY = newY
    const flagMutable = Flag.getMutable(flagEntity)
    flagMutable.dropAnchorY = newY
  }

  // Idle bob animation (server is sole writer for non-carried states)
  // Disable bob while falling so the flag drops smoothly
  if (flag.state !== FlagState.Carried) {
    const restX = flag.state === FlagState.AtBase ? flag.baseX : flag.dropAnchorX
    const restY = flag.state === FlagState.AtBase ? flag.baseY : currentAnchorY
    const restZ = flag.state === FlagState.AtBase ? flag.baseZ : flag.dropAnchorZ
    const bobY = flagFalling ? 0 : IDLE_BOB_AMPLITUDE * Math.sin(idleTime * IDLE_BOB_SPEED)
    const angleDeg = (idleTime * IDLE_ROT_SPEED_DEG_PER_SEC) % 360
    const t = Transform.getMutable(flagEntity)
    t.position = Vector3.create(restX, restY + bobY, restZ)
    t.rotation = Quaternion.fromEulerDegrees(0, angleDeg, 0)
  }

  // Detect carrier disconnect
  if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
    let carrierConnected = false
    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
      if (identity.address === flag.carrierPlayerId) {
        carrierConnected = true
        break
      }
    }
    if (!carrierConnected) {
      const flagPos = Transform.get(flagEntity).position
      const mutable = Flag.getMutable(flagEntity)
      mutable.state = FlagState.Dropped
      mutable.carrierPlayerId = ''
      mutable.dropAnchorX = flagPos.x
      mutable.dropAnchorY = flagPos.y
      mutable.dropAnchorZ = flagPos.z

      // Start gravity on disconnect drop
      computeGravityTarget(flagPos.y)

      if (!MeshCollider.has(flagEntity)) MeshCollider.setBox(flagEntity)
      room.send('dropSound', { t: 0 })
      persistFlagState()
    }
  }
}

function holdTimeServerSystem(dt: number): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag || flag.state !== FlagState.Carried || !flag.carrierPlayerId) {
    holdTimeAccum = 0
    return
  }

  holdTimeAccum += Math.min(dt, 0.1)
  if (holdTimeAccum < HOLD_TIME_SYNC_INTERVAL) return

  const entity = holdTimeEntities.get(flag.carrierPlayerId)
  if (entity) {
    const mutable = PlayerFlagHoldTime.getMutable(entity)
    mutable.seconds += holdTimeAccum
  }
  holdTimeAccum = 0
}

function playerTrackingSystem(): void {
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    const userId = identity.address
    if (knownPlayers.has(userId)) continue
    knownPlayers.add(userId)

    // Create synced hold time entity for this player
    const entity = engine.addEntity()
    PlayerFlagHoldTime.create(entity, { playerId: userId, seconds: 0 })
    syncEntity(entity, [PlayerFlagHoldTime.componentId], getHoldTimeEntityEnumId(userId))
    holdTimeEntities.set(userId, entity)
  }
}

function countdownServerSystem(): void {
  const now = Date.now()
  const timer = CountdownTimer.getOrNull(countdownEntity)
  if (!timer) return

  // Round end: trigger immediately when time is up
  if (!timer.roundEndTriggered && now >= timer.roundEndTimeMs) {
    handleRoundEnd()
  }

  // Splash finished — just clear the flag (game already restarted)
  if (timer.roundEndTriggered && now >= timer.roundEndDisplayUntilMs) {
    const mutable = CountdownTimer.getMutable(countdownEntity)
    mutable.roundEndTriggered = false
  }
}

function handleRoundEnd(): void {
  const now = Date.now()

  // ── 1. Determine winner(s) ──
  let maxSeconds = 0
  const players: { userId: string; seconds: number }[] = []

  for (const [, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    if (data.seconds > 0) {
      players.push({ userId: data.playerId, seconds: data.seconds })
      if (data.seconds > maxSeconds) maxSeconds = data.seconds
    }
  }

  // ── 2. Save winner snapshot for splash display ──
  const winners = maxSeconds > 0 ? players.filter(p => p.seconds >= maxSeconds) : []
  const winnerSnapshot = winners.map(p => ({
    userId: p.userId,
    name: playerNames.get(p.userId) || p.userId.slice(0, 8)
  }))

  // ── 3. Set timer: splash + next round time IMMEDIATELY ──
  const timerMutable = CountdownTimer.getMutable(countdownEntity)
  timerMutable.roundEndTriggered = true
  timerMutable.roundEndDisplayUntilMs = now + SPLASH_DURATION_MS
  timerMutable.roundEndTimeMs = getNextRoundEndTimeMs()
  timerMutable.roundWinnerJson = JSON.stringify(winnerSnapshot)

  // ── 4. Update leaderboard ──
  if (maxSeconds > 0) {
    const lb = LeaderboardState.getOrNull(leaderboardEntity)
    let entries: { userId: string; name: string; roundsWon: number }[] = []

    if (lb && lb.json) {
      try { entries = JSON.parse(lb.json) } catch { entries = [] }
    }

    for (const p of players) {
      if (p.seconds < maxSeconds) continue
      const existing = entries.find((e) => e.userId === p.userId)
      if (existing) {
        existing.roundsWon += 1
        const displayName = playerNames.get(p.userId)
        if (displayName) existing.name = displayName
      } else {
        const displayName = playerNames.get(p.userId) || p.userId.slice(0, 8)
        entries.push({ userId: p.userId, name: displayName, roundsWon: 1 })
      }
    }

    const json = JSON.stringify(entries)
    const mutable = LeaderboardState.getMutable(leaderboardEntity)
    mutable.json = json
    persistLeaderboard(json)
  }

  // ── 5. Reset flag to base ──
  resetGravityState()
  const flagMutable = Flag.getMutable(flagEntity)
  flagMutable.state = FlagState.AtBase
  flagMutable.carrierPlayerId = ''
  const t = Transform.getMutable(flagEntity)
  t.position = Vector3.create(FLAG_BASE_POSITION.x, FLAG_BASE_POSITION.y, FLAG_BASE_POSITION.z)
  if (!MeshCollider.has(flagEntity)) MeshCollider.setBox(flagEntity)
  persistFlagState()

  // ── 6. Reset all hold times (splash reads from snapshot, not live data) ──
  for (const [entity] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    PlayerFlagHoldTime.getMutable(entity).seconds = 0
  }
}
