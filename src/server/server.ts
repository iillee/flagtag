import { engine, Transform, GltfContainer, PlayerIdentityData, type Entity } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import { Storage } from '@dcl/sdk/server'
import {
  Flag, FlagState, PlayerFlagHoldTime, CountdownTimer, LeaderboardState, VisitorAnalytics,
  getHoldTimeEntityEnumId, getNextRoundEndTimeMs,
  FLAG_BASE_POSITION, FLAG_SPAWN_POINTS, getRandomSpawnPoint, SyncIds, getTodayDateString
} from '../shared/components'
import { room } from '../shared/messages'

// ── Constants ──
const PICKUP_RADIUS = 3
const HIT_RADIUS = 2.5
const HIT_COOLDOWN_MS = 450       // Attacker cooldown (how soon they can attack again)
const VICTIM_IMMUNITY_MS = 3000   // Victim immunity after being hit/stolen from (prevents tag-backs)
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
let visitorAnalyticsEntity: Entity
let idleTime = 0
let holdTimeAccum = 0
const lastAttackTime = new Map<string, number>()
const lastHitTime = new Map<string, number>()  // Track when players were last hit (for immunity)
const holdTimeEntities = new Map<string, Entity>()
const knownPlayers = new Set<string>()
const playerNames = new Map<string, string>()
let lastLeaderboardResetDay = ''

// ── Visitor tracking ──
const visitorSessions = new Map<string, { name: string; sessionStartMs: number; totalMinutesToday: number }>()
let lastVisitorResetDay = ''

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

async function persistVisitorData(visitorDataJson: string): Promise<void> {
  await Storage.set('visitorData', visitorDataJson)
  await Storage.set('lastVisitorResetDay', lastVisitorResetDay)
}

async function loadVisitorData(): Promise<void> {
  const savedData = await Storage.get<string>('visitorData')
  const savedResetDay = await Storage.get<string>('lastVisitorResetDay')
  
  if (savedData && savedResetDay) {
    try {
      const visitorRecords = JSON.parse(savedData)
      lastVisitorResetDay = savedResetDay
      
      // Restore visitor data if it's from today
      const currentDay = getTodayDateString()
      if (lastVisitorResetDay === currentDay) {
        for (const record of visitorRecords) {
          visitorSessions.set(record.userId, {
            name: record.name,
            sessionStartMs: 0, // Not currently online after server restart
            totalMinutesToday: record.totalMinutes
          })
          playerNames.set(record.userId, record.name)
        }
        console.log('[Server] Restored visitor data for', currentDay, '- loaded', visitorRecords.length, 'visitors')
      } else {
        console.log('[Server] Visitor data was from', lastVisitorResetDay, 'but today is', currentDay, '- starting fresh')
        lastVisitorResetDay = currentDay
      }
    } catch (e) {
      console.error('[Server] Failed to load visitor data:', e)
      lastVisitorResetDay = getTodayDateString()
    }
  } else {
    lastVisitorResetDay = getTodayDateString()
    console.log('[Server] No visitor data found, starting fresh for', lastVisitorResetDay)
  }
}

// Check and perform daily leaderboard reset at 12:00 AM UTC (midnight)
async function checkLeaderboardDailyReset(): Promise<boolean> {
  const now = new Date()
  const currentDay = now.toISOString().slice(0, 10) // YYYY-MM-DD format
  
  // Load last reset day from storage if not set
  if (lastLeaderboardResetDay === '') {
    const savedResetDay = await Storage.get<string>('lastLeaderboardResetDay')
    lastLeaderboardResetDay = savedResetDay || currentDay
  }
  
  // Reset at midnight UTC (00:00) - check if new day and we haven't reset today
  if (lastLeaderboardResetDay !== currentDay) {
    console.log('[Server] Daily leaderboard reset at midnight UTC for new day:', currentDay)
    lastLeaderboardResetDay = currentDay
    
    // Clear the leaderboard
    const mutable = LeaderboardState.getMutable(leaderboardEntity)
    mutable.json = '[]'
    await persistLeaderboard('[]')
    
    // Persist the reset day
    await Storage.set('lastLeaderboardResetDay', currentDay)
    
    console.log('[Server] Leaderboard reset completed')
    return true
  }
  
  return false
}

// Check and perform daily visitor reset at 12:00 AM UTC (midnight)
async function checkVisitorDailyReset(): Promise<boolean> {
  const currentDay = getTodayDateString()
  
  if (lastVisitorResetDay !== currentDay) {
    console.log('[Server] Daily visitor reset at midnight UTC for new day:', currentDay)
    lastVisitorResetDay = currentDay
    
    // Clear visitor data for new day
    visitorSessions.clear()
    
    // Sync empty visitor data
    await syncVisitorAnalytics()
    
    console.log('[Server] Visitor data reset completed')
    return true
  }
  
  return false
}

async function syncVisitorAnalytics(): Promise<void> {
  const currentDay = getTodayDateString()
  const onlineCount = Array.from(visitorSessions.values()).filter(v => v.sessionStartMs > 0).length
  
  // Build visitor data array
  const visitorData = Array.from(visitorSessions.entries()).map(([userId, data]) => {
    const isOnline = data.sessionStartMs > 0
    let totalMinutes = data.totalMinutesToday
    
    // Add current session time if online
    if (isOnline) {
      const sessionMs = Date.now() - data.sessionStartMs
      const sessionMinutes = Math.floor(sessionMs / (1000 * 60))
      totalMinutes += sessionMinutes
    }
    
    return {
      userId,
      name: data.name,
      isOnline,
      totalMinutes
    }
  }).filter(v => v.totalMinutes > 0 || v.isOnline) // Only include visitors with time or currently online
  
  const visitorDataJson = JSON.stringify(visitorData)
  
  // Update synced component
  const mutable = VisitorAnalytics.getMutable(visitorAnalyticsEntity)
  mutable.date = currentDay
  mutable.visitorDataJson = visitorDataJson
  mutable.onlineCount = onlineCount
  mutable.totalUniqueVisitors = visitorSessions.size
  
  // Persist to storage
  await persistVisitorData(visitorDataJson)
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
  GltfContainer.create(flagEntity, { 
    src: BANNER_SRC,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })
  
  // Use the first spawn point as the default base (or restored position if available)
  const initialBase = flagStartState === FlagState.AtBase ? FLAG_SPAWN_POINTS[0] : { x: flagStartPos.x, y: flagStartPos.y, z: flagStartPos.z }
  
  // If starting at base, initialize drop anchor to match base coordinates (prevents 0,0,0 issue)
  if (flagStartState === FlagState.AtBase) {
    dropAnchor = { x: initialBase.x, y: initialBase.y, z: initialBase.z }
  }
  
  Flag.create(flagEntity, {
    teamId: 0,
    state: flagStartState,
    carrierPlayerId: '',
    baseX: initialBase.x, baseY: initialBase.y, baseZ: initialBase.z,
    dropAnchorX: dropAnchor.x, dropAnchorY: dropAnchor.y, dropAnchorZ: dropAnchor.z
  })
  syncEntity(flagEntity, [Transform.componentId, Flag.componentId, GltfContainer.componentId], SyncIds.FLAG)

  // Create countdown timer - use next UTC boundary for proper initialization
  const now = Date.now()
  const intervalMs = 5 * 60 * 1000 // 5 minutes
  const nextBoundary = (Math.floor(now / intervalMs) + 1) * intervalMs
  
  countdownEntity = engine.addEntity()
  CountdownTimer.create(countdownEntity, {
    roundEndTimeMs: nextBoundary,
    roundEndTriggered: false,
    roundEndDisplayUntilMs: 0,
    roundWinnerJson: ''
  })
  syncEntity(countdownEntity, [CountdownTimer.componentId], SyncIds.COUNTDOWN)
  
  console.log('[Server] Timer initialized, next round ends at:', new Date(nextBoundary).toISOString())

  // Load persisted leaderboard
  let savedLeaderboard = await Storage.get<string>('leaderboard')
  let leaderboardJson = savedLeaderboard || '[]'
  
  leaderboardEntity = engine.addEntity()
  LeaderboardState.create(leaderboardEntity, { json: leaderboardJson, date: '' })
  syncEntity(leaderboardEntity, [LeaderboardState.componentId], SyncIds.LEADERBOARD)
  
  // Check for daily reset on server startup
  await checkLeaderboardDailyReset()

  // Initialize visitor analytics
  await loadVisitorData()
  visitorAnalyticsEntity = engine.addEntity()
  VisitorAnalytics.create(visitorAnalyticsEntity, { 
    date: getTodayDateString(),
    visitorDataJson: '[]',
    onlineCount: 0,
    totalUniqueVisitors: 0
  })
  syncEntity(visitorAnalyticsEntity, [VisitorAnalytics.componentId], SyncIds.VISITOR_ANALYTICS)
  await syncVisitorAnalytics()

  // Register message handlers (added in next step)
  registerHandlers()

  // Register systems (added in next step)
  engine.addSystem(flagServerSystem)
  engine.addSystem(holdTimeServerSystem)
  engine.addSystem(playerTrackingSystem)
  engine.addSystem(countdownServerSystem)
  engine.addSystem(visitorTrackingServerSystem)

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
    
    // Update visitor session name if player is tracked
    const visitor = visitorSessions.get(context.from)
    if (visitor) {
      visitor.name = data.name
      console.log('[Server] Updated visitor name:', context.from.slice(0, 8), '->', data.name)
    }
    
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
    console.log('[Server] 📨 Received requestPickup from', context.from.slice(0, 8))
    handlePickup(context.from)
  })
  room.onMessage('requestDrop', (_data, context) => {
    if (!context) return
    console.log('[Server] 📨 Received requestDrop from', context.from.slice(0, 8))
    handleDrop(context.from)
  })
  room.onMessage('requestAttack', (_data, context) => {
    if (!context) return
    console.log('[Server] 📨 Received requestAttack from', context.from.slice(0, 8))
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
  if (playerPos) {
    // Drop at player's feet (not behind them) to prevent wall clipping
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

  // Start gravity — estimate ground from carrier's recent Y history
  computeGravityTarget(dropPos.y)

  room.send('dropSound', { t: 0 })
  persistFlagState()
}

function handleFlagSteal(victimId: string, attackerId: string): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) {
    console.log('[Server] ❌ Flag steal failed: no flag component')
    return
  }
  
  // Safety check: ensure victim actually has the flag
  if (flag.state !== FlagState.Carried || flag.carrierPlayerId !== victimId) {
    console.log('[Server] ❌ Flag steal failed: victim does not have flag. State:', flag.state, 'Carrier:', flag.carrierPlayerId.slice(0, 8), 'Expected victim:', victimId.slice(0, 8))
    return
  }

  console.log('[Server] 🚩 EXECUTING FLAG STEAL:', victimId.slice(0, 8), '->', attackerId.slice(0, 8))
  console.log('[Server]    Before: state =', flag.state, ', carrier =', flag.carrierPlayerId.slice(0, 8))

  // Directly transfer flag to attacker (no drop to ground)
  const mutable = Flag.getMutable(flagEntity)
  mutable.state = FlagState.Carried
  mutable.carrierPlayerId = attackerId

  console.log('[Server]    After:  state =', mutable.state, ', carrier =', mutable.carrierPlayerId.slice(0, 8))

  // Reset gravity state since flag isn't being dropped
  resetGravityState()
  
  // Play pickup sound for new carrier (global so everyone hears it)
  room.send('pickupSound', { t: 0 })
  
  // Persist the new flag state immediately
  persistFlagState()
  
  console.log('[Server] ✅ Flag steal completed successfully - new carrier:', attackerId.slice(0, 8))
}

function handleAttack(attackerId: string): void {
  const now = Date.now()
  
  console.log('[Server] 🎯 handleAttack called by:', attackerId.slice(0, 8))
  
  const lastAttack = lastAttackTime.get(attackerId) ?? 0
  if (now - lastAttack < HIT_COOLDOWN_MS) {
    console.log('[Server]    ⏳ Attack on cooldown for', attackerId.slice(0, 8), '- time since last:', (now - lastAttack), 'ms')
    return
  }
  lastAttackTime.set(attackerId, now)

  const attackerPos = getPlayerPosition(attackerId)
  if (!attackerPos) {
    console.log('[Server]    ❌ Attack failed: attacker position not found for', attackerId.slice(0, 8))
    return
  }

  console.log('[Server]    📍 Attacker position:', attackerPos.x.toFixed(1), attackerPos.y.toFixed(1), attackerPos.z.toFixed(1))

  // Find closest victim (excluding immune players)
  let closestId: string | null = null
  let closestPos: Vector3 | null = null
  let closestDist = HIT_RADIUS
  
  let playersChecked = 0
  let immunePlayers = 0

  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address === attackerId) continue
    playersChecked++
    
    // Check victim immunity (prevents tag-backs)
    const lastHit = lastHitTime.get(identity.address) ?? 0
    if (now - lastHit < VICTIM_IMMUNITY_MS) {
      immunePlayers++
      console.log('[Server]       🛡️ Player', identity.address.slice(0, 8), 'is IMMUNE (', (now - lastHit), 'ms since hit)')
      continue
    }
    
    const pos = getPlayerPosition(identity.address)
    if (!pos) continue
    const dist = Vector3.distance(attackerPos, pos)
    
    console.log('[Server]       👤 Player', identity.address.slice(0, 8), 'at distance:', dist.toFixed(2), 'm')
    
    if (dist < closestDist) {
      closestDist = dist
      closestId = identity.address
      closestPos = pos
    }
  }
  
  console.log('[Server]    Players checked:', playersChecked, 'Immune:', immunePlayers, 'Closest dist:', closestDist.toFixed(2))

  if (closestId && closestPos) {
    // Hit confirmed - mark victim as recently hit for immunity
    lastHitTime.set(closestId, now)
    
    console.log('[Server]    💥 HIT CONFIRMED! Attacker:', attackerId.slice(0, 8), 'Victim:', closestId.slice(0, 8), 'Distance:', closestDist.toFixed(2))
    room.send('hitVfx', { x: closestPos.x, y: closestPos.y, z: closestPos.z })
    room.send('stagger', { victimId: closestId })

    // STEAL flag if victim was carrying (instead of dropping)
    const flag = Flag.getOrNull(flagEntity)
    console.log('[Server]    🚩 Flag check - State:', flag?.state, 'Carrier:', flag?.carrierPlayerId?.slice(0, 8), 'Victim:', closestId.slice(0, 8))
    
    if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === closestId) {
      console.log('[Server]    ✅ VICTIM HAS FLAG! Initiating steal...')
      handleFlagSteal(closestId, attackerId)
      console.log('[Server]    🛡️ Victim', closestId.slice(0, 8), 'now has', VICTIM_IMMUNITY_MS, 'ms immunity (no tag-backs)')
    } else {
      console.log('[Server]    ℹ️  Regular hit (victim does not have flag)')
    }
  } else {
    // Miss — send attacker position, client computes forward offset locally
    console.log('[Server]    ❌ ATTACK MISSED - no valid targets in range')
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

    // Start visitor session tracking
    const playerName = playerNames.get(userId) || userId.slice(0, 8)
    const existingVisitor = visitorSessions.get(userId)
    
    if (existingVisitor) {
      // Returning visitor - update session start
      existingVisitor.sessionStartMs = Date.now()
      existingVisitor.name = playerName // Update name in case it changed
    } else {
      // New visitor today
      visitorSessions.set(userId, {
        name: playerName,
        sessionStartMs: Date.now(),
        totalMinutesToday: 0
      })
    }
    
    console.log('[Server] Player entered:', playerName, '(total visitors today:', visitorSessions.size, ')')
  }

  // Detect disconnected players
  const currentPlayerIds = new Set()
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    currentPlayerIds.add(identity.address)
  }

  for (const [userId, visitor] of visitorSessions) {
    if (visitor.sessionStartMs > 0 && !currentPlayerIds.has(userId)) {
      // Player disconnected - accumulate their session time
      const sessionMs = Date.now() - visitor.sessionStartMs
      const sessionMinutes = Math.floor(sessionMs / (1000 * 60))
      visitor.totalMinutesToday += sessionMinutes
      visitor.sessionStartMs = 0 // Mark as offline
      
      const playerName = visitor.name
      console.log('[Server] Player left:', playerName, 'session:', sessionMinutes, 'min, total today:', visitor.totalMinutesToday, 'min')
    }
  }
}

// Prevent duplicate round end triggers
let lastRoundEndBoundary = 0

function countdownServerSystem(): void {
  const now = Date.now()
  const timer = CountdownTimer.getOrNull(countdownEntity)
  if (!timer) return
  
  const intervalMs = 5 * 60 * 1000 // 5 minutes in milliseconds
  
  // Calculate the current 5-minute UTC boundary
  const currentBoundary = Math.floor(now / intervalMs) * intervalMs
  const timeSinceBoundary = now - currentBoundary
  
  // Round end: trigger when we cross a 5-minute UTC boundary (within 3 seconds tolerance for reliability)
  // Increased from 1s to 3s to ensure we don't miss the boundary due to server tick timing
  // Added safeguard: only trigger once per boundary to prevent duplicate popups
  if (!timer.roundEndTriggered && timeSinceBoundary < 3000 && currentBoundary !== lastRoundEndBoundary) {
    // We just crossed a boundary - trigger round end
    lastRoundEndBoundary = currentBoundary
    console.log('[Server] Round end triggered at UTC boundary:', new Date(currentBoundary).toISOString(), `(${timeSinceBoundary}ms after boundary)`)
    
    // Update the timer's roundEndTimeMs to the next boundary for the new round
    const mutable = CountdownTimer.getMutable(countdownEntity)
    mutable.roundEndTimeMs = currentBoundary + intervalMs // Next round ends at next boundary
    
    handleRoundEnd().catch(console.error)
  }
  
  // Failsafe: If we somehow missed the boundary window entirely, catch it here
  // This handles edge cases where server was lagging or system didn't run for >3 seconds
  if (!timer.roundEndTriggered && currentBoundary !== lastRoundEndBoundary && timeSinceBoundary >= 3000 && timeSinceBoundary < intervalMs / 2) {
    // We're past the trigger window but still in the first half of the round - we missed it!
    console.log('[Server] FAILSAFE: Missed round boundary, triggering late at', timeSinceBoundary, 'ms after boundary')
    lastRoundEndBoundary = currentBoundary
    
    const mutable = CountdownTimer.getMutable(countdownEntity)
    mutable.roundEndTimeMs = currentBoundary + intervalMs
    
    handleRoundEnd().catch(console.error)
  }

  // Splash finished — clear the splash and officially start new round
  if (timer.roundEndTriggered && now >= timer.roundEndDisplayUntilMs) {
    const mutable = CountdownTimer.getMutable(countdownEntity)
    mutable.roundEndTriggered = false
    console.log('[Server] Round splash finished, new round active')
  }
}

async function handleRoundEnd(): Promise<void> {
  const now = Date.now()

  // ── 0. Check for daily leaderboard reset ──
  await checkLeaderboardDailyReset()

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
  const intervalMs = 5 * 60 * 1000 // 5 minutes
  const nextRoundEndTime = (Math.floor(now / intervalMs) + 1) * intervalMs
  
  const timerMutable = CountdownTimer.getMutable(countdownEntity)
  timerMutable.roundEndTriggered = true
  timerMutable.roundEndDisplayUntilMs = now + SPLASH_DURATION_MS
  timerMutable.roundEndTimeMs = nextRoundEndTime
  timerMutable.roundWinnerJson = JSON.stringify(winnerSnapshot)
  
  console.log('[Server] Round ended, next round ends at:', new Date(nextRoundEndTime).toISOString())

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
    await persistLeaderboard(json)
  }

  // ── 5. Reset flag to random spawn point ──
  resetGravityState()
  const spawnPoint = getRandomSpawnPoint()
  console.log('[Server] Round ended, flag respawning at random location to prevent spawn camping')
  
  const flagMutable = Flag.getMutable(flagEntity)
  flagMutable.state = FlagState.AtBase
  flagMutable.carrierPlayerId = ''
  
  // Update flag's base position to the new spawn point
  flagMutable.baseX = spawnPoint.x
  flagMutable.baseY = spawnPoint.y
  flagMutable.baseZ = spawnPoint.z
  
  const t = Transform.getMutable(flagEntity)
  t.position = Vector3.create(spawnPoint.x, spawnPoint.y, spawnPoint.z)
  await persistFlagState()

  // ── 6. Reset all hold times (splash reads from snapshot, not live data) ──
  for (const [entity] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    PlayerFlagHoldTime.getMutable(entity).seconds = 0
  }
}

let visitorSyncTimer = 0

function visitorTrackingServerSystem(dt: number): void {
  visitorSyncTimer += dt
  
  // Sync visitor analytics every 5 seconds
  if (visitorSyncTimer >= 5.0) {
    visitorSyncTimer = 0
    
    // Check for daily reset
    void checkVisitorDailyReset()
    
    // Sync current visitor data
    void syncVisitorAnalytics()
  }
}
