import { engine, Transform, GltfContainer, PlayerIdentityData, AvatarBase, type Entity } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import { Storage } from '@dcl/sdk/server'
import {
  Flag, FlagState, PlayerFlagHoldTime, CountdownTimer, LeaderboardState, VisitorAnalytics,
  Banana, BANANA_LIFETIME_SEC, BANANA_COOLDOWN_SEC, BANANA_MAX_ACTIVE, BANANA_TRIGGER_RADIUS,
  Shell, SHELL_LIFETIME_SEC, SHELL_COOLDOWN_SEC, SHELL_MAX_ACTIVE, SHELL_SPEED, SHELL_MAX_RANGE, SHELL_HIT_RADIUS,
  getHoldTimeEntityEnumId, getNextRoundEndTimeMs, getNextBananaSyncId, getNextShellSyncId,
  FLAG_BASE_POSITION, FLAG_SPAWN_POINTS, getRandomSpawnPoint, SyncIds, getTodayDateString
} from '../shared/components'
import { room } from '../shared/messages'

// ── Constants ──
const PICKUP_RADIUS = 3
const HIT_RADIUS = 2.5
const HIT_COOLDOWN_MS = 450       // Attacker cooldown (how soon they can attack again)
const STEAL_IMMUNITY_MS = 3000    // Immunity for the player who STEALS the flag (time to escape the crowd)
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
const lastStealTime = new Map<string, number>()  // Track when a player stole the flag (they get immunity to escape)
const holdTimeEntities = new Map<string, Entity>()
const knownPlayers = new Set<string>()
const playerNames = new Map<string, string>()
let lastLeaderboardResetDay = ''

// ── Visitor tracking ──
const visitorSessions = new Map<string, { name: string; sessionStartMs: number; totalMinutesToday: number }>()
let lastVisitorResetDay = ''

// ── Banana state ──
const BANANA_MODEL_SRC = 'assets/scene/Models/banana.glb'
/** Track last banana drop time per player for cooldown. */
const lastBananaDropTime = new Map<string, number>()
/** Track active banana entities for cleanup, with per-banana gravity state. */
interface ActiveBanana {
  entity: Entity
  droppedBy: string
  droppedAtMs: number
  falling: boolean
  fallVelocity: number
  targetY: number          // ground Y estimated by client raycast
  groundResolved: boolean  // true once client raycast has reported ground
}
const activeBananas: ActiveBanana[] = []

// ── Shell state ──
const SHELL_MODEL_SRC = 'assets/scene/Models/shell.glb'
const SHELL_GROUND_OFFSET = 0.35  // Raise shell above ground so it doesn't clip terrain
const lastShellFireTime = new Map<string, number>()
interface ActiveShell {
  entity: Entity
  firedBy: string
  firedAtMs: number
  startX: number
  startY: number
  startZ: number
  dirX: number
  dirZ: number
  distanceTraveled: number
  maxDistance: number
  wallDistReported: boolean
  // Gravity
  currentY: number
  fallVelocity: number
  groundY: number        // latest ground height reported by client
  onGround: boolean      // true once shell has landed on a surface
}
const activeShells: ActiveShell[] = []

// Gravity state for dropped flag
let flagFalling = false
let flagFallVelocity = 0
let flagGravityTargetY = FLAG_MIN_Y
const carrierYSamples: { y: number; time: number }[] = []

function isRealName(name: string): boolean {
  return name.length > 0 && !name.startsWith('0x')
}

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

async function persistPlayerNames(): Promise<void> {
  const obj: Record<string, string> = {}
  for (const [userId, name] of playerNames) {
    if (isRealName(name)) obj[userId] = name
  }
  await Storage.set('playerNames', JSON.stringify(obj))
}

async function loadPlayerNames(): Promise<void> {
  try {
    const saved = await Storage.get<string>('playerNames')
    if (saved) {
      const obj: Record<string, string> = JSON.parse(saved)
      for (const [userId, name] of Object.entries(obj)) {
        if (isRealName(name)) {
          playerNames.set(userId, name)
        }
      }
      console.log('[Server] Loaded', playerNames.size, 'persisted player names')
    }
  } catch (err) {
    console.error('[Server] Failed to load player names:', err)
  }
}

async function persistVisitorData(visitorDataJson: string): Promise<void> {
  await Storage.set('visitorData', visitorDataJson)
  await Storage.set('lastVisitorResetDay', lastVisitorResetDay)
}

async function loadVisitorData(): Promise<void> {
  let savedData: string | null = null
  let savedResetDay: string | null = null
  
  try {
    savedData = await Storage.get<string>('visitorData')
    savedResetDay = await Storage.get<string>('lastVisitorResetDay')
  } catch (err) {
    console.error('[Server] Failed to load visitor data from storage:', err)
    return
  }
  
  if (savedData && savedResetDay) {
    try {
      const visitorRecords = JSON.parse(savedData)
      lastVisitorResetDay = savedResetDay
      
      // Restore visitor data if it's from today
      const currentDay = getTodayDateString()
      if (lastVisitorResetDay === currentDay) {
        for (const record of visitorRecords) {
          // Support both old format (totalMinutes) and new format (totalSeconds)
          const minutes = record.totalSeconds != null
            ? Math.floor(record.totalSeconds / 60)
            : (record.totalMinutes || 0)
          // Use persisted name directory if available, fall back to stored visitor name
          const bestName = (playerNames.has(record.userId) && isRealName(playerNames.get(record.userId)!))
            ? playerNames.get(record.userId)!
            : record.name
          visitorSessions.set(record.userId, {
            name: bestName,
            sessionStartMs: 0, // Not currently online after server restart
            totalMinutesToday: minutes
          })
          if (isRealName(bestName)) {
            playerNames.set(record.userId, bestName)
          }
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
  const now = Date.now()
  const onlineCount = Array.from(visitorSessions.values()).filter(v => v.sessionStartMs > 0).length
  
  // Build visitor data array — include ALL visitors (no filtering)
  const visitorData = Array.from(visitorSessions.entries()).map(([userId, data]) => {
    const isOnline = data.sessionStartMs > 0
    // Calculate total seconds (stored minutes + current session)
    let totalSeconds = data.totalMinutesToday * 60
    
    if (isOnline) {
      const sessionMs = now - data.sessionStartMs
      totalSeconds += Math.floor(sessionMs / 1000)
    }
    
    return {
      userId,
      name: data.name,
      isOnline,
      totalSeconds
    }
  })
  .sort((a, b) => {
    // Online first, then by time
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1
    return b.totalSeconds - a.totalSeconds
  })
  .slice(0, 100) // Limit to top 100
  
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

  // Load persisted flag state (with error handling)
  let savedFlag: string | null = null
  try {
    savedFlag = await Storage.get<string>('flagState')
  } catch (err) {
    console.error('[Server] Failed to load flag state from storage:', err)
  }
  
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

  // Load persisted player names FIRST so leaderboard and visitor restores can use them
  await loadPlayerNames()

  // Load persisted leaderboard (with error handling)
  let savedLeaderboard: string | null = null
  try {
    savedLeaderboard = await Storage.get<string>('leaderboard')
  } catch (err) {
    console.error('[Server] Failed to load leaderboard from storage:', err)
  }
  let leaderboardJson = savedLeaderboard || '[]'
  
  // Patch leaderboard entries with persisted real names (fix stale 0x... from prior sessions)
  try {
    const entries: { userId: string; name: string; roundsWon: number }[] = JSON.parse(leaderboardJson)
    let patched = false
    for (const entry of entries) {
      const knownName = playerNames.get(entry.userId)
      if (knownName && isRealName(knownName) && entry.name !== knownName) {
        entry.name = knownName
        patched = true
      }
    }
    if (patched) {
      leaderboardJson = JSON.stringify(entries)
      console.log('[Server] Patched leaderboard names from persisted name directory')
    }
  } catch { /* ignore */ }

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
  engine.addSystem(nameResolverServerSystem)
  engine.addSystem(bananaServerSystem)
  engine.addSystem(shellServerSystem)

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

/**
 * Update a player's display name across all server data stores.
 * Called when a real name is resolved (via registerName message or AvatarBase scan).
 * Returns true if the name was actually updated (was different from what we had).
 */
function updatePlayerName(userId: string, name: string): boolean {
  if (!isRealName(name)) return false
  
  const existing = playerNames.get(userId)
  if (existing === name) return false
  
  playerNames.set(userId, name)
  
  // Update visitor session
  const visitor = visitorSessions.get(userId)
  if (visitor) {
    visitor.name = name
  }
  
  // Update leaderboard entries
  const lb = LeaderboardState.getOrNull(leaderboardEntity)
  if (lb && lb.json) {
    try {
      const entries: { userId: string; name: string; roundsWon: number }[] = JSON.parse(lb.json)
      let changed = false
      for (const entry of entries) {
        if (entry.userId === userId && entry.name !== name) {
          entry.name = name
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
  
  return true
}

// ── Message handlers ──
function registerHandlers(): void {
  room.onMessage('registerName', (data, context) => {
    if (!context || !data.name) return
    if (updatePlayerName(context.from, data.name)) {
      console.log('[Server] registerName: updated', context.from.slice(0, 8), '->', data.name)
      persistPlayerNames()
    }
  })
  room.onMessage('requestPickup', (_data, context) => {
    if (!context) return
    console.log('[S.1] Received requestPickup from', context.from.slice(0, 8))
    handlePickup(context.from)
  })
  room.onMessage('requestDrop', (_data, context) => {
    if (!context) return
    console.log('[S.2] Received requestDrop from', context.from.slice(0, 8))
    handleDrop(context.from)
  })
  room.onMessage('requestAttack', (_data, context) => {
    if (!context) return
    console.log('[S.3] Received requestAttack from', context.from.slice(0, 8))
    handleAttack(context.from)
  })
  room.onMessage('requestBanana', (_data, context) => {
    if (!context) return
    console.log('[Server] Received requestBanana from', context.from.slice(0, 8))
    handleBananaDrop(context.from)
  })
  room.onMessage('requestShell', (data, context) => {
    if (!context) return
    console.log('[Server] Received requestShell from', context.from.slice(0, 8))
    handleShellFire(context.from, data.dirX, data.dirZ)
  })
  room.onMessage('reportShellWallDist', (data, context) => {
    if (!context) return
    // Find the shell by sync id approximation — use the most recent shell from this player
    for (const shell of activeShells) {
      if (shell.firedBy === context.from && !shell.wallDistReported) {
        shell.maxDistance = Math.min(shell.maxDistance, data.maxDist)
        shell.wallDistReported = true
        console.log('[Server] 🐚 Shell wall distance updated:', data.maxDist.toFixed(1), 'm')
        break
      }
    }
  })
  room.onMessage('reportShellGroundY', (data, context) => {
    if (!context) return
    // Find the shell closest to the reported X/Z and update its ground Y
    let closest: ActiveShell | null = null
    let closestDist = 5
    for (const shell of activeShells) {
      const pos = Transform.get(shell.entity).position
      const dx = pos.x - data.shellX
      const dz = pos.z - data.shellZ
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dist < closestDist) {
        closestDist = dist
        closest = shell
      }
    }
    if (closest) {
      closest.groundY = Math.max(0, data.groundY)
    }
  })
  room.onMessage('reportBananaGroundY', (data, context) => {
    if (!context) return
    // Find the banana closest to the reported X/Z and update its ground target
    let closest: ActiveBanana | null = null
    let closestDist = 3 // must be within 3m horizontally
    for (const banana of activeBananas) {
      const pos = Transform.get(banana.entity).position
      const dx = pos.x - data.bananaX
      const dz = pos.z - data.bananaZ
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dist < closestDist) {
        closestDist = dist
        closest = banana
      }
    }
    if (closest && !closest.groundResolved) {
      closest.targetY = Math.max(0, data.groundY)
      closest.groundResolved = true
      // If already at or below target, snap
      const currentY = Transform.get(closest.entity).position.y
      if (currentY <= closest.targetY) {
        const t = Transform.getMutable(closest.entity)
        t.position = Vector3.create(t.position.x, closest.targetY, t.position.z)
        closest.falling = false
        closest.fallVelocity = 0
      }
    }
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
    console.log('[S.30] Flag steal FAILED: no flag component')
    return
  }
  
  // Safety check: ensure victim actually has the flag
  if (flag.state !== FlagState.Carried || flag.carrierPlayerId !== victimId) {
    console.log('[S.31] Flag steal FAILED: victim does not have flag. State:', flag.state, 'Carrier:', flag.carrierPlayerId.slice(0, 8), 'Expected victim:', victimId.slice(0, 8))
    return
  }

  console.log('[S.32] EXECUTING FLAG STEAL:', victimId.slice(0, 8), '->', attackerId.slice(0, 8))
  console.log('[S.33] Before: state =', flag.state, ', carrier =', flag.carrierPlayerId.slice(0, 8))

  // Directly transfer flag to attacker (no drop to ground)
  const mutable = Flag.getMutable(flagEntity)
  mutable.state = FlagState.Carried
  mutable.carrierPlayerId = attackerId

  console.log('[S.34] After:  state =', mutable.state, ', carrier =', mutable.carrierPlayerId.slice(0, 8))

  // Grant steal immunity to the new carrier (3s protection to escape the crowd)
  lastStealTime.set(attackerId, Date.now())
  console.log('[S.34b] Granted', STEAL_IMMUNITY_MS, 'ms steal immunity to', attackerId.slice(0, 8))

  // Reset gravity state since flag isn't being dropped
  resetGravityState()
  
  // Play pickup sound for new carrier (global so everyone hears it)
  room.send('pickupSound', { t: 0 })
  
  // Persist the new flag state immediately
  persistFlagState()
  
  console.log('[S.35] Flag steal completed successfully - new carrier:', attackerId.slice(0, 8))
}

function handleAttack(attackerId: string): void {
  const now = Date.now()
  
  console.log('[S.10] handleAttack called by:', attackerId.slice(0, 8))
  
  const lastAttack = lastAttackTime.get(attackerId) ?? 0
  if (now - lastAttack < HIT_COOLDOWN_MS) {
    console.log('[S.11] Attack on cooldown for', attackerId.slice(0, 8), '- time since last:', (now - lastAttack), 'ms')
    return
  }
  lastAttackTime.set(attackerId, now)

  const attackerPos = getPlayerPosition(attackerId)
  if (!attackerPos) {
    console.log('[S.12] Attack failed: attacker position not found for', attackerId.slice(0, 8))
    return
  }

  console.log('[S.13] Attacker position:', attackerPos.x.toFixed(1), attackerPos.y.toFixed(1), attackerPos.z.toFixed(1))

  // Find closest victim (excluding immune players)
  let closestId: string | null = null
  let closestPos: Vector3 | null = null
  let closestDist = HIT_RADIUS
  
  let playersChecked = 0
  let immunePlayers = 0

  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address === attackerId) continue
    playersChecked++
    
    // Check steal immunity (player who just stole the flag gets 3s protection to escape)
    const stealTime = lastStealTime.get(identity.address) ?? 0
    if (now - stealTime < STEAL_IMMUNITY_MS) {
      immunePlayers++
      console.log('[S.14] Player', identity.address.slice(0, 8), 'is IMMUNE (just stole flag) -', (now - stealTime), 'ms since steal')
      continue
    }
    
    const pos = getPlayerPosition(identity.address)
    if (!pos) continue
    const dist = Vector3.distance(attackerPos, pos)
    
    console.log('[S.15] Player', identity.address.slice(0, 8), 'at distance:', dist.toFixed(2), 'm')
    
    if (dist < closestDist) {
      closestDist = dist
      closestId = identity.address
      closestPos = pos
    }
  }
  
  console.log('[S.16] Players checked:', playersChecked, 'Immune:', immunePlayers, 'Closest dist:', closestDist.toFixed(2))

  if (closestId && closestPos) {
    console.log('[S.20] HIT CONFIRMED! Attacker:', attackerId.slice(0, 8), 'Victim:', closestId.slice(0, 8), 'Distance:', closestDist.toFixed(2))
    room.send('hitVfx', { x: closestPos.x, y: closestPos.y, z: closestPos.z })
    room.send('stagger', { victimId: closestId })

    // STEAL flag if victim was carrying (instead of dropping)
    const flag = Flag.getOrNull(flagEntity)
    console.log('[S.21] Flag check - State:', flag?.state, 'Carrier:', flag?.carrierPlayerId?.slice(0, 8), 'Victim:', closestId.slice(0, 8))
    
    if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === closestId) {
      console.log('[S.22] VICTIM HAS FLAG! Initiating steal...')
      handleFlagSteal(closestId, attackerId)
      console.log('[S.23] Attacker', attackerId.slice(0, 8), 'now has', STEAL_IMMUNITY_MS, 'ms steal immunity')
    } else {
      console.log('[S.24] Regular hit (victim does not have flag)')
    }
  } else {
    // Miss — send attacker position, client computes forward offset locally
    console.log('[S.25] ATTACK MISSED - no valid targets in range')
    room.send('missVfx', { x: attackerPos.x, y: attackerPos.y, z: attackerPos.z })
  }
}

function handleBananaDrop(playerId: string): void {
  const now = Date.now()

  // Cooldown check
  const lastDrop = lastBananaDropTime.get(playerId) ?? 0
  if (now - lastDrop < BANANA_COOLDOWN_SEC * 1000) {
    console.log('[Server] Banana denied: cooldown active, wait', ((BANANA_COOLDOWN_SEC * 1000 - (now - lastDrop)) / 1000).toFixed(1), 's')
    return
  }

  // Max active banana check
  const playerBananas = activeBananas.filter(b => b.droppedBy === playerId)
  if (playerBananas.length >= BANANA_MAX_ACTIVE) {
    console.log('[Server] Banana denied: max active bananas reached (', BANANA_MAX_ACTIVE, ')')
    return
  }

  // Get player position
  const playerPos = getPlayerPosition(playerId)
  if (!playerPos) {
    console.log('[Server] Banana denied: player position not found')
    return
  }

  // Drop banana slightly behind the player (at their feet)
  const dropPos = Vector3.create(playerPos.x, playerPos.y - 0.2, playerPos.z)

  // Create synced banana entity
  const bananaEntity = engine.addEntity()
  Transform.create(bananaEntity, {
    position: dropPos,
    scale: Vector3.create(0.02, 0.02, 0.02)
  })
  GltfContainer.create(bananaEntity, {
    src: BANANA_MODEL_SRC,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })
  Banana.create(bananaEntity, {
    droppedByPlayerId: playerId,
    droppedAtMs: now,
  })
  syncEntity(bananaEntity, [Transform.componentId, GltfContainer.componentId, Banana.componentId], getNextBananaSyncId())

  activeBananas.push({
    entity: bananaEntity,
    droppedBy: playerId,
    droppedAtMs: now,
    falling: true,
    fallVelocity: 0,
    targetY: 0,                 // default floor until client reports ground (bananas sit on actual surface)
    groundResolved: false,
  })
  lastBananaDropTime.set(playerId, now)

  // Notify clients for sound/VFX + ground raycast
  room.send('bananaDropped', { x: dropPos.x, y: dropPos.y, z: dropPos.z })

  console.log('[Server] 🍌 Banana dropped by', playerId.slice(0, 8), 'at', dropPos.x.toFixed(1), dropPos.y.toFixed(1), dropPos.z.toFixed(1), '— active bananas:', activeBananas.length)
}

/** Server system: check banana gravity, triggers (player proximity), and expiry. */
function bananaServerSystem(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = activeBananas.length - 1; i >= 0; i--) {
    const banana = activeBananas[i]

    // Gravity — pull banana down to ground
    if (banana.falling) {
      banana.fallVelocity += FLAG_GRAVITY * clampedDt
      const pos = Transform.get(banana.entity).position
      let newY = pos.y - banana.fallVelocity * clampedDt
      if (newY <= banana.targetY) {
        newY = banana.targetY
        banana.falling = false
        banana.fallVelocity = 0
      }
      const t = Transform.getMutable(banana.entity)
      t.position = Vector3.create(pos.x, newY, pos.z)
    }

    // Expiry check
    const ageMs = now - banana.droppedAtMs
    if (ageMs > BANANA_LIFETIME_SEC * 1000) {
      console.log('[Server] 🍌 Banana expired, removing')
      engine.removeEntity(banana.entity)
      activeBananas.splice(i, 1)
      continue
    }

    // Trigger check — any player (except the dropper) walks over it
    const bananaPos = Transform.get(banana.entity).position
    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      if (identity.address === banana.droppedBy) continue // Can't trigger your own banana

      const playerPos = getPlayerPosition(identity.address)
      if (!playerPos) continue

      const dist = Vector3.distance(playerPos, bananaPos)
      if (dist < BANANA_TRIGGER_RADIUS) {
        console.log('[Server] 🍌 Banana triggered by', identity.address.slice(0, 8), '! Staggering...')

        // Drop the flag if the victim is carrying it
        const flag = Flag.getOrNull(flagEntity)
        if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === identity.address) {
          console.log('[Server] 🍌 Victim was carrying flag — forcing drop!')
          handleDrop(identity.address)
        }

        // Single message — client handles all effects (VFX, sound, stagger) in one frame
        room.send('bananaTriggered', { x: bananaPos.x, y: bananaPos.y, z: bananaPos.z, victimId: identity.address })

        // Remove the banana
        engine.removeEntity(banana.entity)
        activeBananas.splice(i, 1)
        break // This banana is consumed
      }
    }
  }
}

function handleShellFire(playerId: string, dirX: number, dirZ: number): void {
  const now = Date.now()

  // Cooldown check
  const lastFire = lastShellFireTime.get(playerId) ?? 0
  if (now - lastFire < SHELL_COOLDOWN_SEC * 1000) {
    console.log('[Server] Shell denied: cooldown active')
    return
  }

  // Max active check
  const playerShells = activeShells.filter(s => s.firedBy === playerId)
  if (playerShells.length >= SHELL_MAX_ACTIVE) {
    console.log('[Server] Shell denied: max active shells reached')
    return
  }

  // Get player position
  const playerPos = getPlayerPosition(playerId)
  if (!playerPos) {
    console.log('[Server] Shell denied: player position not found')
    return
  }

  // Normalize direction on XZ plane
  const len = Math.sqrt(dirX * dirX + dirZ * dirZ)
  if (len < 0.01) {
    console.log('[Server] Shell denied: invalid direction')
    return
  }
  const nDirX = dirX / len
  const nDirZ = dirZ / len

  // Spawn slightly in front of the player near ground level
  const spawnPos = Vector3.create(
    playerPos.x + nDirX * 1.0,
    playerPos.y + 0.2,
    playerPos.z + nDirZ * 1.0
  )

  // Create synced shell entity
  const shellEntity = engine.addEntity()
  Transform.create(shellEntity, {
    position: spawnPos,
    scale: Vector3.create(0.02, 0.02, 0.02),
    rotation: Quaternion.fromEulerDegrees(0, Math.atan2(nDirX, nDirZ) * (180 / Math.PI), 0)
  })
  GltfContainer.create(shellEntity, {
    src: SHELL_MODEL_SRC,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })
  Shell.create(shellEntity, {
    firedByPlayerId: playerId,
    firedAtMs: now,
    dirX: nDirX,
    dirZ: nDirZ,
    distanceTraveled: 0,
    maxDistance: SHELL_MAX_RANGE,
    active: true,
  })
  syncEntity(shellEntity, [Transform.componentId, GltfContainer.componentId, Shell.componentId], getNextShellSyncId())

  activeShells.push({
    entity: shellEntity,
    firedBy: playerId,
    firedAtMs: now,
    startX: spawnPos.x,
    startY: spawnPos.y,
    startZ: spawnPos.z,
    dirX: nDirX,
    dirZ: nDirZ,
    distanceTraveled: 0,
    maxDistance: SHELL_MAX_RANGE,
    wallDistReported: false,
    currentY: spawnPos.y,
    fallVelocity: 0,
    groundY: 0,
    onGround: false,
  })
  lastShellFireTime.set(playerId, now)

  room.send('shellDropped', { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z })
  console.log('[Server] 🐚 Shell fired by', playerId.slice(0, 8), 'dir:', nDirX.toFixed(2), nDirZ.toFixed(2))
}

/** Server system: move shells forward with gravity, check player hits, and handle expiry. */
function shellServerSystem(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = activeShells.length - 1; i >= 0; i--) {
    const shell = activeShells[i]

    // Safety expiry (time-based)
    if (now - shell.firedAtMs > SHELL_LIFETIME_SEC * 1000) {
      console.log('[Server] 🐚 Shell expired (timeout)')
      engine.removeEntity(shell.entity)
      activeShells.splice(i, 1)
      continue
    }

    // Move shell forward on XZ
    const moveDistance = SHELL_SPEED * clampedDt
    shell.distanceTraveled += moveDistance

    // Check if shell exceeded max range (wall hit)
    if (shell.distanceTraveled >= shell.maxDistance) {
      console.log('[Server] 🐚 Shell hit wall at', shell.distanceTraveled.toFixed(1), 'm')
      const shellPos = Transform.get(shell.entity).position
      room.send('shellTriggered', { x: shellPos.x, y: shellPos.y, z: shellPos.z, victimId: '' })
      engine.removeEntity(shell.entity)
      activeShells.splice(i, 1)
      continue
    }

    // Apply gravity — shell falls until it reaches groundY + offset, then rides along the surface
    const groundTarget = shell.groundY + SHELL_GROUND_OFFSET
    if (!shell.onGround) {
      shell.fallVelocity += FLAG_GRAVITY * clampedDt
      shell.currentY -= shell.fallVelocity * clampedDt
      if (shell.currentY <= groundTarget) {
        shell.currentY = groundTarget
        shell.fallVelocity = 0
        shell.onGround = true
      }
    } else {
      // On ground — follow terrain height as reported by client
      // Smoothly adjust to new groundY (terrain may go up or down)
      const diff = groundTarget - shell.currentY
      if (Math.abs(diff) < 0.05) {
        shell.currentY = groundTarget
      } else if (diff > 0) {
        // Ground is rising — snap up to stay on surface
        shell.currentY = groundTarget
      } else {
        // Ground is dropping — fall with gravity again
        shell.onGround = false
        shell.fallVelocity = 0
      }
    }

    // Update position (XZ from trajectory, Y from gravity)
    const newX = shell.startX + shell.dirX * shell.distanceTraveled
    const newZ = shell.startZ + shell.dirZ * shell.distanceTraveled
    const t = Transform.getMutable(shell.entity)
    t.position = Vector3.create(newX, shell.currentY, newZ)

    // Update synced component
    const shellComp = Shell.getMutable(shell.entity)
    shellComp.distanceTraveled = shell.distanceTraveled

    // Check player hits — any player (except the shooter)
    const shellPos = Transform.get(shell.entity).position
    let shellConsumed = false

    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      if (identity.address === shell.firedBy) continue

      const playerPos = getPlayerPosition(identity.address)
      if (!playerPos) continue

      const dist = Vector3.distance(playerPos, shellPos)
      if (dist < SHELL_HIT_RADIUS) {
        console.log('[Server] 🐚 Shell hit player', identity.address.slice(0, 8), 'at distance', shell.distanceTraveled.toFixed(1), 'm')

        // Drop the flag if the victim is carrying it
        const flag = Flag.getOrNull(flagEntity)
        if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === identity.address) {
          console.log('[Server] 🐚 Victim was carrying flag — forcing drop!')
          handleDrop(identity.address)
        }

        room.send('shellTriggered', { x: shellPos.x, y: shellPos.y, z: shellPos.z, victimId: identity.address })
        engine.removeEntity(shell.entity)
        activeShells.splice(i, 1)
        shellConsumed = true
        break
      }
    }
    if (shellConsumed) continue

    // Check banana collision — shell destroys both itself and the banana
    for (let j = activeBananas.length - 1; j >= 0; j--) {
      const banana = activeBananas[j]
      const bananaPos = Transform.get(banana.entity).position
      const dist = Vector3.distance(shellPos, bananaPos)
      if (dist < SHELL_HIT_RADIUS) {
        console.log('[Server] 🐚🍌 Shell hit banana! Both destroyed.')
        room.send('shellTriggered', { x: shellPos.x, y: shellPos.y, z: shellPos.z, victimId: '' })
        room.send('bananaTriggered', { x: bananaPos.x, y: bananaPos.y, z: bananaPos.z, victimId: '' })
        engine.removeEntity(shell.entity)
        activeShells.splice(i, 1)
        engine.removeEntity(banana.entity)
        activeBananas.splice(j, 1)
        shellConsumed = true
        break
      }
    }
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

  const carrierKey = flag.carrierPlayerId.toLowerCase()
  let entity = holdTimeEntities.get(carrierKey)
  
  // Safety net: create hold time entity if it doesn't exist yet
  // This handles edge cases where playerTrackingSystem hasn't detected the player yet
  if (!entity) {
    console.log('[Server] holdTimeServerSystem: creating missing hold time entity for', carrierKey.slice(0, 8))
    entity = engine.addEntity()
    PlayerFlagHoldTime.create(entity, { playerId: flag.carrierPlayerId, seconds: 0 })
    syncEntity(entity, [PlayerFlagHoldTime.componentId], getHoldTimeEntityEnumId(carrierKey))
    holdTimeEntities.set(carrierKey, entity)
    knownPlayers.add(carrierKey)
  }

  const mutable = PlayerFlagHoldTime.getMutable(entity)
  mutable.seconds += holdTimeAccum
  holdTimeAccum = 0
}

// Track which players are currently connected (detected this frame)
const currentlyConnected = new Set<string>()

function playerTrackingSystem(): void {
  // Build set of currently connected players
  const nowConnected = new Set<string>()
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    nowConnected.add(identity.address)
  }

  let changed = false

  // Detect new joins (including reconnections)
  for (const userId of nowConnected) {
    if (!currentlyConnected.has(userId)) {
      // Player just connected (or reconnected)
      currentlyConnected.add(userId)

      // Create synced hold time entity only on first ever join (case-insensitive)
      const userKey = userId.toLowerCase()
      if (!knownPlayers.has(userKey)) {
        knownPlayers.add(userKey)
        const entity = engine.addEntity()
        PlayerFlagHoldTime.create(entity, { playerId: userId, seconds: 0 })
        syncEntity(entity, [PlayerFlagHoldTime.componentId], getHoldTimeEntityEnumId(userKey))
        holdTimeEntities.set(userKey, entity)
      }

      // Start/restart visitor session — use persisted name if available
      const playerName = playerNames.get(userId) || userId.slice(0, 8)
      const existingVisitor = visitorSessions.get(userId)

      if (existingVisitor) {
        existingVisitor.sessionStartMs = Date.now()
        // Only upgrade the name, never downgrade a real name to 0x...
        if (isRealName(playerName) || !isRealName(existingVisitor.name)) {
          existingVisitor.name = playerName
        }
      } else {
        visitorSessions.set(userId, {
          name: playerName,
          sessionStartMs: Date.now(),
          totalMinutesToday: 0
        })
      }

      console.log('[Server] Player joined:', playerName, '(total visitors today:', visitorSessions.size, ')')
      changed = true
    }
  }

  // Detect disconnects
  for (const userId of currentlyConnected) {
    if (!nowConnected.has(userId)) {
      currentlyConnected.delete(userId)

      const visitor = visitorSessions.get(userId)
      if (visitor && visitor.sessionStartMs > 0) {
        const sessionMs = Date.now() - visitor.sessionStartMs
        const sessionMinutes = Math.floor(sessionMs / (1000 * 60))
        visitor.totalMinutesToday += sessionMinutes
        visitor.sessionStartMs = 0 // Mark as offline

        console.log('[Server] Player left:', visitor.name, 'session:', sessionMinutes, 'min, total today:', visitor.totalMinutesToday, 'min')
      }
      changed = true
    }
  }

  // Immediate sync when players join or leave
  if (changed) {
    void syncVisitorAnalytics()
  }
}

// Prevent duplicate round end triggers - track the actual roundEndTimeMs we processed
let lastProcessedRoundEndTime = 0

// Track last debug log time
let lastTimerDebugLog = 0

function countdownServerSystem(): void {
  const now = Date.now()
  const timer = CountdownTimer.getOrNull(countdownEntity)
  if (!timer) {
    console.log('[Server.ERROR] countdownServerSystem: No timer entity!')
    return
  }
  
  const intervalMs = 5 * 60 * 1000 // 5 minutes in milliseconds
  
  // Debug: Log timer state every 30 seconds
  if (now - lastTimerDebugLog > 30000) {
    lastTimerDebugLog = now
    const secondsUntilEnd = Math.floor((timer.roundEndTimeMs - now) / 1000)
    console.log('[Server.Timer] secondsUntilEnd:', secondsUntilEnd, 'roundEndTimeMs:', new Date(timer.roundEndTimeMs).toISOString(), 'triggered:', timer.roundEndTriggered)
  }
  
  // Round end: trigger exactly when we reach roundEndTimeMs (the UTC boundary)
  // The splash will show the winner from the previous round and display during the first 3 seconds of the new round
  if (!timer.roundEndTriggered && now >= timer.roundEndTimeMs) {
    // Prevent duplicate triggers - only process each roundEndTimeMs once
    if (timer.roundEndTimeMs === lastProcessedRoundEndTime) {
      return
    }
    lastProcessedRoundEndTime = timer.roundEndTimeMs
    
    const currentBoundary = Math.floor(now / intervalMs) * intervalMs
    const msAfter = now - timer.roundEndTimeMs
    
    console.log('[Server] ⏰ Round end! Triggered at roundEndTimeMs:', new Date(timer.roundEndTimeMs).toISOString(), `(${msAfter}ms after)`)
    console.log('[Server] Current boundary:', new Date(currentBoundary).toISOString())
    
    // Calculate next boundary
    const nextBoundary = (Math.floor(now / intervalMs) + 1) * intervalMs
    
    // Update the timer's roundEndTimeMs to the next boundary for the next round
    const mutable = CountdownTimer.getMutable(countdownEntity)
    mutable.roundEndTimeMs = nextBoundary
    
    console.log('[Server] Next round will end at:', new Date(nextBoundary).toISOString())
    
    handleRoundEnd().catch((err) => {
      console.error('[Server.ERROR] handleRoundEnd failed:', err)
    })
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

  // ── 2. Save top 3 snapshot for splash display ──
  const topPlayers = [...players]
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 3)
    .map(p => {
      const storedName = playerNames.get(p.userId)
      const displayName = storedName || p.userId.slice(0, 8)
      return {
        userId: p.userId,
        name: displayName,
        seconds: Math.floor(p.seconds)
      }
    })
  
  for (const p of topPlayers) {
    console.log('[Server] Top player:', p.name, '-', p.seconds, 'seconds')
  }

  // ── 3. Set timer: splash + winner data (roundEndTimeMs already set by countdownServerSystem) ──
  const timerMutable = CountdownTimer.getMutable(countdownEntity)
  timerMutable.roundEndTriggered = true
  timerMutable.roundEndDisplayUntilMs = now + SPLASH_DURATION_MS
  timerMutable.roundWinnerJson = JSON.stringify(topPlayers)
  
  console.log('[Server] Round end splash set, displayUntil:', new Date(timerMutable.roundEndDisplayUntilMs).toISOString())

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

  // ── 5. Remove all active bananas ──
  for (const banana of activeBananas) {
    engine.removeEntity(banana.entity)
  }
  activeBananas.length = 0
  lastBananaDropTime.clear()
  console.log('[Server] 🍌 All bananas cleared for new round')

  // ── 5b. Remove all active shells ──
  for (const shell of activeShells) {
    engine.removeEntity(shell.entity)
  }
  activeShells.length = 0
  lastShellFireTime.clear()
  console.log('[Server] 🐚 All shells cleared for new round')

  // ── 6. Reset flag to random spawn point ──
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
  
  // Sync visitor analytics every 10 seconds
  if (visitorSyncTimer >= 10.0) {
    visitorSyncTimer = 0
    
    // Check for daily reset
    void checkVisitorDailyReset()
    
    // Sync current visitor data
    void syncVisitorAnalytics()
  }
}

/**
 * Server-side name resolver — scans AvatarBase.name for all connected players
 * every few seconds. When a real display name appears (not empty, not 0x...),
 * it updates playerNames, visitorSessions, and leaderboard entries, then persists.
 * This catches names that weren't ready when the player first connected.
 */
let nameResolveTimer = 0
const NAME_RESOLVE_INTERVAL = 3.0

function nameResolverServerSystem(dt: number): void {
  nameResolveTimer += dt
  if (nameResolveTimer < NAME_RESOLVE_INTERVAL) return
  nameResolveTimer = 0

  let anyUpdated = false

  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    const userId = identity.address
    if (!userId) continue

    // Already have a real name — skip
    const existing = playerNames.get(userId)
    if (existing && isRealName(existing)) continue

    // Try reading AvatarBase.name
    const avatar = AvatarBase.getOrNull(entity)
    if (avatar && isRealName(avatar.name)) {
      if (updatePlayerName(userId, avatar.name)) {
        console.log('[Server] Name resolved via AvatarBase:', userId.slice(0, 8), '->', avatar.name)
        anyUpdated = true
      }
    }
  }

  if (anyUpdated) {
    persistPlayerNames()
    void syncVisitorAnalytics()
  }
}
