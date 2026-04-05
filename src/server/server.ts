import { engine, Transform, PlayerIdentityData, AvatarBase, type Entity } from '@dcl/sdk/ecs'
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
const HIT_RADIUS = 3.0
const HIT_COOLDOWN_MS = 450       // Attacker cooldown (how soon they can attack again)
const STEAL_IMMUNITY_MS = 3000    // Immunity for the player who STEALS the flag (time to escape the crowd)
const HOLD_TIME_SYNC_INTERVAL = 0.5  // Sync hold time every 0.5s (was 0.2s) — reduces CRDT pressure; client interpolates between updates
// Bob/spin constants removed — animation is now client-side only
const SPLASH_DURATION_MS = 3000
const FLAG_GRAVITY = 15          // m/s² (slightly faster than real gravity for snappy game feel)
const FLAG_MIN_Y = 0.5           // absolute minimum Y (ground plane)
const CARRIER_Y_WINDOW_SEC = 2.0 // seconds of carrier Y history to estimate ground level
const BANNER_SRC = 'assets/asset-packs/small_red_banner/Banner_Red_02/Banner_Red_02.glb'

// ── Mushroom constants ──
const MUSHROOM_COUNT = 1
// Shield lasts until hit or round end
const MUSHROOM_SCENE_MIN_X = 2
const MUSHROOM_SCENE_MAX_X = 158
const MUSHROOM_SCENE_MIN_Z = 2
const MUSHROOM_SCENE_MAX_Z = 238

interface ServerMushroom {
  id: number
  x: number
  z: number
  pickedUp: boolean
}
const activeMushrooms: ServerMushroom[] = []
let mushroomIdCounter = 0
const mushroomShieldActive = new Set<string>()  // playerIds with active shields

function hasServerShield(playerId: string): boolean {
  return mushroomShieldActive.has(playerId)
}

/** Consume the shield — returns true if player had an active shield */
function consumeShield(playerId: string): boolean {
  if (!mushroomShieldActive.has(playerId)) return false
  mushroomShieldActive.delete(playerId)
  console.log('[Server] 🛡️ Shield consumed for', playerId.slice(0, 8))
  room.send('shieldConsumed', { playerId })
  room.send('playerShieldActive', { playerId, active: 0 })
  return true
}

// ── Server state ──
let flagEntity: Entity
let countdownEntity: Entity
let leaderboardEntity: Entity
let visitorAnalyticsEntity: Entity

let holdTimeAccum = 0

const lastAttackTime = new Map<string, number>()
const lastStealTime = new Map<string, number>()  // Track when a player stole the flag (they get immunity to escape)
const holdTimeEntities = new Map<string, Entity>()
const knownPlayers = new Set<string>()
const playerNames = new Map<string, string>()
let lastLeaderboardResetDay = ''

/**
 * Single entry point for creating/retrieving a PlayerFlagHoldTime entity.
 * Prevents the race condition where both playerTrackingSystem and
 * holdTimeServerSystem create duplicate entities for the same player.
 */
function getOrCreateHoldTimeEntity(userKey: string): Entity {
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
  // CRDT write throttle — sync distanceTraveled at 10Hz instead of 60fps
  lastSyncedDist: number
}
const activeShells: ActiveShell[] = []
const SHELL_SYNC_INTERVAL = 0.1 // seconds between Shell component CRDT writes

// Gravity state for dropped flag
let flagFalling = false
let flagFallVelocity = 0
let flagGravityTargetY = FLAG_MIN_Y
const carrierYSamples: { y: number; time: number }[] = []

// Carrier staleness detection — force-drop if carrier position is unavailable
const CARRIER_NO_POSITION_TIMEOUT_MS = 5000   // No position data → likely disconnected
let lastCarrierPositionMs = 0          // Last time we got a valid position from carrier

function resetCarrierTracking(): void {
  lastCarrierPositionMs = 0
  carrierYSamples.length = 0
}

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
          playerNames.set(userId.toLowerCase(), name)
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
          const recordKey = (record.userId || '').toLowerCase()
          // Use persisted name directory if available, fall back to stored visitor name
          const bestName = (playerNames.has(recordKey) && isRealName(playerNames.get(recordKey)!))
            ? playerNames.get(recordKey)!
            : record.name
          visitorSessions.set(recordKey, {
            name: bestName,
            sessionStartMs: 0, // Not currently online after server restart
            totalMinutesToday: minutes
          })
          if (isRealName(bestName)) {
            playerNames.set(recordKey, bestName)
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
  // NOTE: GltfContainer is NOT created on the server — clients attach the visual mesh locally.
  // This avoids a Bevy renderer issue where server-synced GltfContainer sometimes fails to trigger GLB loading.
  
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
  syncEntity(flagEntity, [Transform.componentId, Flag.componentId], SyncIds.FLAG)

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
      const knownName = playerNames.get(entry.userId.toLowerCase())
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

  // ── Reconcile stale CRDT entities from previous server lifetime ──
  // After a server restart, in-memory Maps are empty but old synced
  // PlayerFlagHoldTime entities persist in CRDT state. Reclaim them
  // to prevent duplicates. Reset scores to 0 since round state is lost.
  let reconciledCount = 0
  for (const [entity, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    const key = data.playerId.toLowerCase()
    if (!holdTimeEntities.has(key)) {
      holdTimeEntities.set(key, entity)
      knownPlayers.add(key)
      // Reset score — we can't trust stale mid-round values after restart
      PlayerFlagHoldTime.getMutable(entity).seconds = 0
      reconciledCount++
    } else {
      // Duplicate entity for same player — remove it
      engine.removeEntity(entity)
      console.log('[Server] Removed duplicate hold-time entity for', key.slice(0, 8))
    }
  }
  if (reconciledCount > 0) {
    console.log('[Server] Reconciled', reconciledCount, 'stale hold-time entities from previous server lifetime')
  }

  // Register message handlers
  registerHandlers()

  // Register systems
  // Wrap all systems in try/catch — one bad frame shouldn't crash the server
  const safeSystem = (name: string, fn: (dt: number) => void) => (dt: number) => {
    try { fn(dt) } catch (err) { console.error(`[Server] ❌ ${name} error:`, err) }
  }
  engine.addSystem(safeSystem('flagServerSystem', flagServerSystem))
  engine.addSystem(safeSystem('holdTimeServerSystem', holdTimeServerSystem))
  engine.addSystem(safeSystem('playerTrackingSystem', playerTrackingSystem))
  engine.addSystem(safeSystem('countdownServerSystem', countdownServerSystem))
  engine.addSystem(safeSystem('visitorTrackingServerSystem', visitorTrackingServerSystem))
  engine.addSystem(safeSystem('nameResolverServerSystem', nameResolverServerSystem))
  engine.addSystem(safeSystem('bananaServerSystem', bananaServerSystem))
  engine.addSystem(safeSystem('shellServerSystem', shellServerSystem))

  // ── Spawn mushrooms ──
  spawnMushrooms()

  console.log('[Server] Flag Tag server ready')
}

// ── Helper: find player position by wallet address (case-insensitive) ──
function getPlayerPosition(address: string): Vector3 | null {
  const needle = address.toLowerCase()
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address.toLowerCase() === needle) return Transform.get(entity).position
  }
  return null
}

function getPlayerRotation(address: string): Quaternion | null {
  const needle = address.toLowerCase()
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address.toLowerCase() === needle) return Transform.get(entity).rotation
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
  resetCarrierTracking()
}

/**
 * Update a player's display name across all server data stores.
 * Called when a real name is resolved (via registerName message or AvatarBase scan).
 * Returns true if the name was actually updated (was different from what we had).
 */
function updatePlayerName(userId: string, name: string): boolean {
  if (!isRealName(name)) return false
  
  const key = userId.toLowerCase()
  const existing = playerNames.get(key)
  if (existing === name) return false
  
  playerNames.set(key, name)
  
  // Update visitor session
  const visitor = visitorSessions.get(key)
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
        if (entry.userId.toLowerCase() === key && entry.name !== name) {
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
    try {
      if (!context || !data.name) return
      const from = context.from.toLowerCase()
      if (updatePlayerName(from, data.name)) {
        console.log('[Server] registerName: updated', from.slice(0, 8), '->', data.name)
        persistPlayerNames()
      }
    } catch (err) { console.error('[Server] ❌ registerName handler error:', err) }
  })
  room.onMessage('requestPickup', (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      handlePickup(from)
    } catch (err) { console.error('[Server] ❌ requestPickup handler error:', err) }
  })
  room.onMessage('requestDrop', (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      handleDrop(from)
    } catch (err) { console.error('[Server] ❌ requestDrop handler error:', err) }
  })
  room.onMessage('requestAttack', (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      handleAttack(from)
    } catch (err) { console.error('[Server] ❌ requestAttack handler error:', err) }
  })
  room.onMessage('requestBanana', (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      handleBananaDrop(from)
    } catch (err) { console.error('[Server] ❌ requestBanana handler error:', err) }
  })
  room.onMessage('requestShell', (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      handleShellFire(from, data.dirX, data.dirZ)
    } catch (err) { console.error('[Server] ❌ requestShell handler error:', err) }
  })
  room.onMessage('reportShellWallDist', (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      for (const shell of activeShells) {
        if (shell.firedBy === from && !shell.wallDistReported) {
          shell.maxDistance = Math.min(shell.maxDistance, data.maxDist)
          shell.wallDistReported = true
          console.log('[Server] 🐚 Shell wall distance updated:', data.maxDist.toFixed(1), 'm')
          break
        }
      }
    } catch (err) { console.error('[Server] ❌ reportShellWallDist handler error:', err) }
  })
  room.onMessage('reportShellGroundY', (data, context) => {
    try {
      if (!context) return
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
    } catch (err) { console.error('[Server] ❌ reportShellGroundY handler error:', err) }
  })
  room.onMessage('reportBananaGroundY', (data, context) => {
    try {
      if (!context) return
      let closest: ActiveBanana | null = null
      let closestDist = 3
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
        const currentY = Transform.get(closest.entity).position.y
        if (currentY <= closest.targetY) {
          const t = Transform.getMutable(closest.entity)
          t.position = Vector3.create(t.position.x, closest.targetY, t.position.z)
          closest.falling = false
          closest.fallVelocity = 0
        }
      }
    } catch (err) { console.error('[Server] ❌ reportBananaGroundY handler error:', err) }
  })
  room.onMessage('reportGroundY', (data, context) => {
    try {
      if (!context) return
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
        persistFlagState()
      } else if (!flagFalling) {
        flagFalling = true
        flagFallVelocity = 0
      }
    } catch (err) { console.error('[Server] ❌ reportGroundY handler error:', err) }
  })

  // ── Mushroom position request (client asks on connect) ──
  room.onMessage('requestMushroomPositions', (_data, _context) => {
    try {
      const remaining = activeMushrooms.filter(m => !m.pickedUp).map(m => ({ id: m.id, x: m.x, z: m.z }))
      room.send('mushroomPositions', { mushroomsJson: JSON.stringify(remaining) })
    } catch (err) { console.error('[Server] ❌ requestMushroomPositions handler error:', err) }
  })

  // ── Mushroom pickup ──
  room.onMessage('pickupMushroom', (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const mid = (data as any).id as number
      const mushroom = activeMushrooms.find(m => m.id === mid)
      if (!mushroom || mushroom.pickedUp) return
      mushroom.pickedUp = true
      console.log('[Server] 🍄 Mushroom', mid, 'picked up by', from.slice(0, 8))
      mushroomShieldActive.add(from)
      room.send('mushroomPickedUp', { id: mid, playerId: from })
      room.send('mushroomShield', { durationMs: 0 })
      room.send('playerShieldActive', { playerId: from, active: 1 })
      // Spawn a replacement mushroom
      spawnOneMushroom()
    } catch (err) { console.error('[Server] ❌ pickupMushroom handler error:', err) }
  })
}

function handlePickup(playerId: string): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) return
  if (flag.state !== FlagState.AtBase && flag.state !== FlagState.Dropped) return

  const playerPos = getPlayerPosition(playerId)
  if (!playerPos) return

  const flagPos = Transform.get(flagEntity).position
  const dist = Vector3.distance(playerPos, flagPos)
  if (dist > PICKUP_RADIUS) return
  console.log('[Server] 🚩 Pickup by', playerId.slice(0, 8))

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
  if (!flag) return
  if (flag.state !== FlagState.Carried || flag.carrierPlayerId !== victimId) return

  const mutable = Flag.getMutable(flagEntity)
  mutable.state = FlagState.Carried
  mutable.carrierPlayerId = attackerId

  lastStealTime.set(attackerId, Date.now())
  resetGravityState()
  room.send('pickupSound', { t: 0 })
  persistFlagState()
}

function handleAttack(attackerId: string): void {
  const now = Date.now()
  
  const lastAttack = lastAttackTime.get(attackerId) ?? 0
  if (now - lastAttack < HIT_COOLDOWN_MS) return
  lastAttackTime.set(attackerId, now)

  const attackerPos = getPlayerPosition(attackerId)
  if (!attackerPos) return

  // Find closest victim (excluding immune players)
  let closestId: string | null = null
  let closestPos: Vector3 | null = null
  let closestDist = HIT_RADIUS

  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    const victimAddr = identity.address.toLowerCase()
    if (victimAddr === attackerId) continue
    
    // Check steal immunity (player who just stole the flag gets 3s protection to escape)
    const stealTime = lastStealTime.get(victimAddr) ?? 0
    if (now - stealTime < STEAL_IMMUNITY_MS) continue
    
    const pos = getPlayerPosition(victimAddr)
    if (!pos) continue
    const dist = Vector3.distance(attackerPos, pos)
    
    if (dist < closestDist) {
      closestDist = dist
      closestId = victimAddr
      closestPos = pos
    }
  }

  if (closestId && closestPos) {
    // Shield blocks melee
    if (consumeShield(closestId)) {
      console.log('[Server] ⚔️🛡️ Melee blocked by shield for', closestId.slice(0, 8))
      room.send('missVfx', { x: closestPos.x, y: closestPos.y, z: closestPos.z })
      return
    }

    room.send('hitVfx', { x: closestPos.x, y: closestPos.y, z: closestPos.z })
    room.send('stagger', { victimId: closestId })

    // STEAL flag if victim was carrying
    const flag = Flag.getOrNull(flagEntity)
    if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === closestId) {
      console.log('[Server] ⚔️ Flag stolen:', attackerId.slice(0, 8), '<-', closestId.slice(0, 8))
      handleFlagSteal(closestId, attackerId)
    }
  } else {
    // Miss — send attacker position, client computes forward offset locally
    room.send('missVfx', { x: attackerPos.x, y: attackerPos.y, z: attackerPos.z })
  }
}

function handleBananaDrop(playerId: string): void {
  const now = Date.now()

  // Cooldown check
  const lastDrop = lastBananaDropTime.get(playerId) ?? 0
  const bananaCd = BANANA_COOLDOWN_SEC
  if (now - lastDrop < bananaCd * 1000) {
    console.log('[Server] Banana denied: cooldown active, wait', ((bananaCd * 1000 - (now - lastDrop)) / 1000).toFixed(1), 's')
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
    scale: Vector3.create(1, 1, 1)
  })
  // NOTE: GltfContainer is NOT created on the server — clients attach the visual mesh locally.
  Banana.create(bananaEntity, {
    droppedByPlayerId: playerId,
    droppedAtMs: now,
  })
  syncEntity(bananaEntity, [Transform.componentId, Banana.componentId], getNextBananaSyncId())

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
      const addr = identity.address.toLowerCase()
      // Self-hit: immune for 2 seconds after dropping, then fair game
      if (addr === banana.droppedBy && (now - banana.droppedAtMs) < 2000) continue

      const playerPos = getPlayerPosition(addr)
      if (!playerPos) continue

      const dist = Vector3.distance(playerPos, bananaPos)
      if (dist < BANANA_TRIGGER_RADIUS) {
        // Shield blocks the hit — banana is consumed but no stagger/drop
        if (consumeShield(addr)) {
          console.log('[Server] 🍌🛡️ Banana blocked by shield for', addr.slice(0, 8))
          room.send('bananaTriggered', { x: bananaPos.x, y: bananaPos.y, z: bananaPos.z, victimId: '' })
        } else {
          console.log('[Server] 🍌 Banana triggered by', addr.slice(0, 8), '! Staggering...')

          // Drop the flag if the victim is carrying it
          const flag = Flag.getOrNull(flagEntity)
          if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === addr) {
            console.log('[Server] 🍌 Victim was carrying flag — forcing drop!')
            handleDrop(addr)
          }

          room.send('bananaTriggered', { x: bananaPos.x, y: bananaPos.y, z: bananaPos.z, victimId: addr })
        }

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
  const shellCd = SHELL_COOLDOWN_SEC
  if (now - lastFire < shellCd * 1000) {
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
    scale: Vector3.create(1, 1, 1),
    rotation: Quaternion.fromEulerDegrees(0, Math.atan2(nDirX, nDirZ) * (180 / Math.PI), 0)
  })
  // NOTE: GltfContainer is NOT created on the server — clients attach the visual mesh locally.
  Shell.create(shellEntity, {
    firedByPlayerId: playerId,
    firedAtMs: now,
    startX: spawnPos.x,
    startY: spawnPos.y,
    startZ: spawnPos.z,
    dirX: nDirX,
    dirZ: nDirZ,
    distanceTraveled: 0,
    maxDistance: SHELL_MAX_RANGE,
    active: true,
  })
  // NOTE: Transform is intentionally NOT synced for shells.
  // Syncing Transform at 60fps per shell saturates the CRDT buffer and freezes
  // ALL synced components (including the scoreboard). Clients use local visual
  // entities positioned via Shell component data (startX/Y/Z + direction + distanceTraveled).
  syncEntity(shellEntity, [Shell.componentId], getNextShellSyncId())

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
    groundY: Math.max(0, playerPos.y - 0.88),  // Approximate ground level from player height (~0.88m avatar offset)
    onGround: false,
    lastSyncedDist: 0,
  })
  lastShellFireTime.set(playerId, now)

  room.send('shellDropped', { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z, dirX: nDirX, dirZ: nDirZ })
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

    // Update synced component — throttled to avoid CRDT saturation.
    // Client extrapolates locally between updates for smooth motion.
    const distDelta = shell.distanceTraveled - shell.lastSyncedDist
    if (distDelta >= SHELL_SPEED * SHELL_SYNC_INTERVAL) {
      const shellComp = Shell.getMutable(shell.entity)
      shellComp.distanceTraveled = shell.distanceTraveled
      shell.lastSyncedDist = shell.distanceTraveled
    }

    // Check player hits — any player (except the shooter)
    const shellPos = Transform.get(shell.entity).position
    let shellConsumed = false

    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      const addr = identity.address.toLowerCase()
      if (addr === shell.firedBy) continue

      const playerPos = getPlayerPosition(addr)
      if (!playerPos) continue

      const dist = Vector3.distance(playerPos, shellPos)
      if (dist < SHELL_HIT_RADIUS) {
        // Shield blocks the hit — shell is consumed but no stagger/drop
        if (consumeShield(addr)) {
          console.log('[Server] 🐚🛡️ Shell blocked by shield for', addr.slice(0, 8))
          room.send('shellTriggered', { x: shellPos.x, y: shellPos.y, z: shellPos.z, victimId: '' })
        } else {
          console.log('[Server] 🐚 Shell hit player', addr.slice(0, 8), 'at distance', shell.distanceTraveled.toFixed(1), 'm')

          // Drop the flag if the victim is carrying it
          const flag = Flag.getOrNull(flagEntity)
          if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === addr) {
            console.log('[Server] 🐚 Victim was carrying flag — forcing drop!')
            handleDrop(addr)
          }

          room.send('shellTriggered', { x: shellPos.x, y: shellPos.y, z: shellPos.z, victimId: addr })
        }
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

  // Track carrier Y for gravity target estimation + staleness detection
  if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
    const nowMs = Date.now()
    const carrierPos = getPlayerPosition(flag.carrierPlayerId)
    if (carrierPos) {
      lastCarrierPositionMs = nowMs

      // Y samples for gravity estimation
      const nowSec = nowMs / 1000
      carrierYSamples.push({ y: carrierPos.y, time: nowSec })
      while (carrierYSamples.length > 0 && nowSec - carrierYSamples[0].time > CARRIER_Y_WINDOW_SEC) {
        carrierYSamples.shift()
      }
    }

    // Staleness check: force-drop if carrier position is unavailable for 5s
    if (lastCarrierPositionMs > 0 && (nowMs - lastCarrierPositionMs) > CARRIER_NO_POSITION_TIMEOUT_MS) {
      console.log('[Server] ⚠️ STALE CARRIER DETECTED:', flag.carrierPlayerId.slice(0, 8), '- no position data for', Math.round((nowMs - lastCarrierPositionMs) / 1000) + 's — force-dropping flag')
      const flagPos = Transform.get(flagEntity).position
      const mutable = Flag.getMutable(flagEntity)
      mutable.state = FlagState.Dropped
      mutable.carrierPlayerId = ''
      mutable.dropAnchorX = flagPos.x
      mutable.dropAnchorY = flagPos.y
      mutable.dropAnchorZ = flagPos.z
      resetCarrierTracking()
      computeGravityTarget(flagPos.y)
      room.send('dropSound', { t: 0 })
      persistFlagState()
    }
  } else {
    // Not carried — reset tracking so next pickup starts fresh
    resetCarrierTracking()
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

  // Server only writes the raw rest position — no bob/spin animation.
  // Bob and spin are handled client-side to eliminate ~10Hz CRDT writes.
  // Only write Transform when the flag is falling (gravity updates).
  if (flag.state !== FlagState.Carried && flagFalling) {
    const restX = flag.state === FlagState.AtBase ? flag.baseX : flag.dropAnchorX
    const restY = flag.state === FlagState.AtBase ? flag.baseY : currentAnchorY
    const restZ = flag.state === FlagState.AtBase ? flag.baseZ : flag.dropAnchorZ
    const t = Transform.getMutable(flagEntity)
    t.position = Vector3.create(restX, restY, restZ)
  }

  // Detect carrier disconnect (case-insensitive address comparison)
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
      const flagPos = Transform.get(flagEntity).position
      const mutable = Flag.getMutable(flagEntity)
      mutable.state = FlagState.Dropped
      mutable.carrierPlayerId = ''
      mutable.dropAnchorX = flagPos.x
      mutable.dropAnchorY = flagPos.y
      mutable.dropAnchorZ = flagPos.z

      resetCarrierTracking()
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
  // Use centralized helper — safe to call even if entity already exists
  const entity = getOrCreateHoldTimeEntity(carrierKey)

  const mutable = PlayerFlagHoldTime.getMutable(entity)
  mutable.seconds += holdTimeAccum
  holdTimeAccum = 0
}

// Track which players are currently connected (detected this frame)
const currentlyConnected = new Set<string>()

function playerTrackingSystem(): void {
  // Build set of currently connected players (normalized to lowercase)
  const nowConnected = new Set<string>()
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    nowConnected.add(identity.address.toLowerCase())
  }

  let changed = false

  // Detect new joins (including reconnections)
  for (const userKey of nowConnected) {
    if (!currentlyConnected.has(userKey)) {
      // Player just connected (or reconnected)
      currentlyConnected.add(userKey)

      // Create synced hold time entity if this is a new player
      getOrCreateHoldTimeEntity(userKey)

      // Start/restart visitor session — use persisted name if available
      const playerName = playerNames.get(userKey) || userKey.slice(0, 8)
      const existingVisitor = visitorSessions.get(userKey)

      if (existingVisitor) {
        existingVisitor.sessionStartMs = Date.now()
        // Only upgrade the name, never downgrade a real name to 0x...
        if (isRealName(playerName) || !isRealName(existingVisitor.name)) {
          existingVisitor.name = playerName
        }
      } else {
        visitorSessions.set(userKey, {
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
  for (const userKey of currentlyConnected) {
    if (!nowConnected.has(userKey)) {
      currentlyConnected.delete(userKey)

      const visitor = visitorSessions.get(userKey)
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
      const pKey = p.userId.toLowerCase()
      const storedName = playerNames.get(pKey)
      const displayName = storedName || pKey.slice(0, 8)
      return {
        userId: pKey,
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
      const pKey = p.userId.toLowerCase()
      const existing = entries.find((e) => e.userId.toLowerCase() === pKey)
      if (existing) {
        existing.roundsWon += 1
        const displayName = playerNames.get(pKey)
        if (displayName) existing.name = displayName
      } else {
        const displayName = playerNames.get(pKey) || pKey.slice(0, 8)
        entries.push({ userId: pKey, name: displayName, roundsWon: 1 })
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

  // ── 5c. Clear combat cooldown maps to prevent memory growth ──
  lastAttackTime.clear()
  lastStealTime.clear()

  // ── 5d. Respawn mushrooms ──
  for (const pid of mushroomShieldActive) {
    room.send('playerShieldActive', { playerId: pid, active: 0 })
  }
  mushroomShieldActive.clear()
  spawnMushrooms()
  console.log('[Server] 🍄 Mushrooms respawned for new round')

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

  // ── 7. Reset hold times — remove entities for disconnected players to prevent CRDT accumulation ──
  // Connected players keep their entity (reset to 0). Disconnected players' entities are fully removed.
  const connectedNow = new Set<string>()
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    connectedNow.add(identity.address.toLowerCase())
  }

  const entitiesToRemove: string[] = []
  for (const [userKey, entity] of holdTimeEntities) {
    if (connectedNow.has(userKey)) {
      // Still connected — reset score to 0
      PlayerFlagHoldTime.getMutable(entity).seconds = 0
    } else {
      // Disconnected — fully remove the synced entity to free CRDT space
      entitiesToRemove.push(userKey)
    }
  }
  for (const userKey of entitiesToRemove) {
    const entity = holdTimeEntities.get(userKey)!
    engine.removeEntity(entity)
    holdTimeEntities.delete(userKey)
    knownPlayers.delete(userKey)
  }
  if (entitiesToRemove.length > 0) {
    console.log('[Server] Cleaned up', entitiesToRemove.length, 'hold-time entities for disconnected players')
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
    const userId = identity.address.toLowerCase()
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

// ── Mushroom spawning ──
function spawnOneMushroom(): void {
  const x = MUSHROOM_SCENE_MIN_X + Math.random() * (MUSHROOM_SCENE_MAX_X - MUSHROOM_SCENE_MIN_X)
  const z = MUSHROOM_SCENE_MIN_Z + Math.random() * (MUSHROOM_SCENE_MAX_Z - MUSHROOM_SCENE_MIN_Z)
  const m = { id: mushroomIdCounter++, x, z, pickedUp: false }
  activeMushrooms.push(m)
  console.log('[Server] 🍄 Spawned replacement mushroom', m.id, 'at', x.toFixed(1), z.toFixed(1))
  room.send('mushroomPositions', { mushroomsJson: JSON.stringify([{ id: m.id, x: m.x, z: m.z }]) })
}

function spawnMushrooms(): void {
  activeMushrooms.length = 0
  for (let i = 0; i < MUSHROOM_COUNT; i++) {
    const x = MUSHROOM_SCENE_MIN_X + Math.random() * (MUSHROOM_SCENE_MAX_X - MUSHROOM_SCENE_MIN_X)
    const z = MUSHROOM_SCENE_MIN_Z + Math.random() * (MUSHROOM_SCENE_MAX_Z - MUSHROOM_SCENE_MIN_Z)
    activeMushrooms.push({
      id: mushroomIdCounter++,
      x, z,
      pickedUp: false
    })
  }
  console.log('[Server] 🍄 Spawned', MUSHROOM_COUNT, 'mushrooms')
  // Broadcast to all connected clients
  const positions = activeMushrooms.map(m => ({ id: m.id, x: m.x, z: m.z }))
  room.send('mushroomPositions', { mushroomsJson: JSON.stringify(positions) })
}
