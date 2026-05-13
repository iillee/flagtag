import { engine, Transform, PlayerIdentityData, AvatarBase, type Entity } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import {
  flagEntity, setFlagEntity, countdownEntity, setCountdownEntity,
  leaderboardEntity, setLeaderboardEntity, allTimeLeaderboardEntity, setAllTimeLeaderboardEntity,
  monthlyLeaderboardEntity, setMonthlyLeaderboardEntity,
  visitorAnalyticsEntity, setVisitorAnalyticsEntity, monthlyVisitorAnalyticsEntity, setMonthlyVisitorAnalyticsEntity,
  coinStateEntity, setCoinStateEntity,
  holdTimeEntities, knownPlayers, playerNames, walletEntities, upgradeEntities, lifetimeWinsEntities,
  playerBoomerangColors, playerCoinBalances, playerUpgradeData, playerLifetimeWinsCache,
  deathPenaltyCooldowns, lastStealTime,
  visitorSessions, monthlyVisitorSessions, currentlyConnected,
  PICKUP_RADIUS, PROXIMITY_STEAL_RADIUS, STEAL_IMMUNITY_MS, HOLD_TIME_SYNC_INTERVAL,
  SPLASH_DURATION_MS, FLAG_GRAVITY, FLAG_MIN_Y, CARRIER_Y_WINDOW_SEC, CARRIER_NO_POSITION_TIMEOUT_MS,
  MUSHROOM_CX, MUSHROOM_CZ, MUSHROOM_RADIUS, MUSHROOM_CANDIDATES,
  isRealName, getPlayerPosition,
  lastVisitorResetDay, setLastVisitorResetDay,
  lastMonthlyVisitorResetMonth, setLastMonthlyVisitorResetMonth
} from './serverState'
import {
  persistFlagState, persistLeaderboard, persistAllTimeLeaderboard, persistMonthlyLeaderboard,
  persistPlayerNames, loadPlayerNames, loadVisitorData
} from './persistence'
import {
  updateConcurrentTracking, loadDiscordWebhookUrl, loadDailyReportSentDay,
  sendPendingReport, sendDailyAnalyticsToDiscord, snapshotPendingReport,
  syncVisitorAnalytics, syncMonthlyVisitorAnalytics,
  checkPreMidnightReport, checkVisitorDailyReset, checkMonthlyVisitorReset,
  visitorTrackingServerSystem
} from './analytics'
import {
  type LeaderboardEntry, parseLeaderboardJson, incrementLeaderboardWins,
  patchLeaderboardNames, patchAllLeaderboardNames,
  checkLeaderboardDailyReset, checkMonthlyLeaderboardReset,
  updatePlayerName
} from './leaderboard'
import { syncEntity } from '@dcl/sdk/network'
import { Storage } from '@dcl/sdk/server'
import {
  Flag, FlagState, PlayerFlagHoldTime, CountdownTimer, LeaderboardState, AllTimeLeaderboardState, MonthlyLeaderboardState, VisitorAnalytics, MonthlyVisitorAnalytics,
  Trap, TRAP_LIFETIME_SEC, TRAP_COOLDOWN_SEC, TRAP_MAX_ACTIVE, TRAP_TRIGGER_RADIUS,
  Projectile, PROJECTILE_LIFETIME_SEC, PROJECTILE_COOLDOWN_SEC, PROJECTILE_MAX_ACTIVE, PROJECTILE_SPEED, PROJECTILE_MAX_RANGE, PROJECTILE_HIT_RADIUS,
  Zombie, ZOMBIE_DETECT_RADIUS, ZOMBIE_SPEED, ZOMBIE_FAST_SPEED, ZOMBIE_FAST_DIST, ZOMBIE_HIT_RADIUS, ZOMBIE_SPAWN_INTERVAL, ZOMBIE_MAX_ACTIVE,
  getNextZombieSyncId, recycleZombieSyncId,
  getHoldTimeEntityEnumId, getNextTrapSyncId, recycleTrapSyncId, getNextProjectileSyncId, recycleProjectileSyncId,
  FLAG_BASE_POSITION, FLAG_SPAWN_POINTS, getRandomSpawnPoint, SyncIds, getTodayDateString, getCurrentMonthString
} from '../shared/components'
import { room } from '../shared/messages'
import { isNightTime, updateWorldTime } from '../shared/dayNight'
import {
  CoinState, PlayerWallet, COIN_STATE_SYNC_ID, COIN_RESPAWN_INTERVAL_SEC, COIN_PICKUP_RADIUS,
  ROUND_PARTICIPATION_COINS, ROUND_PLACEMENT_BONUS, COINS_PER_HOLD_SECOND, MAX_COINS,
  getWalletSyncId
} from '../shared/coins'
import {
  PlayerUpgrades, PlayerLifetimeWins,
  getUpgradesSyncId, getLifetimeWinsSyncId,
  parseUpgrades, serializeUpgrades, BOOMERANG_STORE,
  type UpgradeData
} from '../shared/upgrades'
import type { BoomerangColor } from '../gameState/boomerangColor'

// Constants moved to serverState.ts

// Mushroom constants moved to serverState.ts
const MUSHROOM_COUNT = 1

interface ServerMushroom {
  id: number
  candidates: { x: number; z: number }[]
  pickedUp: boolean
}
const activeMushrooms: ServerMushroom[] = []
let mushroomIdCounter = 0
// mushroomShieldActive removed — mushrooms no longer block hits

// ── Coin state ──
// coinStateEntity, playerCoinBalances, walletEntities moved to serverState.ts
/** Set of coinIds currently picked up (empty spots waiting for random respawn) */
const coinCooldowns = new Set<string>()
/** Timer tracking seconds until next random coin respawn */
let coinRespawnTimer = 0

// Upgrade/progression state moved to serverState.ts

// Entity references moved to serverState.ts

let holdTimeAccum = 0
let holdTimeCarrierKey = '' // Track WHO we're accumulating for

// ── Lightning state ──
const LIGHTNING_ROLL_INTERVAL = 5 // seconds between probability rolls
const LIGHTNING_WARNING_DURATION = 3 // seconds warning before strike
let lightningRollTimer = 0
let lightningStrikeScheduled = false
let lightningWarningTimer = 0
let _lightningOriginalCarrierId = '' // carrier when warning started — reserved for future use

function getLightningStrikeChance(points: number): number {
  if (points < 100) return 0.0
  if (points < 200) return 0.05 + (points - 100) / 100 * 0.05  // 5–10%
  if (points < 250) return 0.10 + (points - 200) / 50 * 0.30   // 10–40%
  if (points < 280) return 0.40 + (points - 250) / 30 * 0.30   // 40–70%
  return 0.70 + (points - 280) / 20 * 0.25                     // 70–95%
}

function getCarrierHoldSeconds(): number {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag || flag.state !== FlagState.Carried || !flag.carrierPlayerId) return 0
  const key = flag.carrierPlayerId.toLowerCase()
  const entity = holdTimeEntities.get(key)
  if (!entity) return 0
  return (PlayerFlagHoldTime.getOrNull(entity)?.seconds ?? 0) + (holdTimeCarrierKey === key ? holdTimeAccum : 0)
}

// lastStealTime, holdTimeEntities, knownPlayers, playerNames moved to serverState.ts
// lastLeaderboardResetDay moved to serverState.ts

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
// Note: getOrCreateHoldTimeEntity stays here for now — uses holdTimeEntities/knownPlayers from serverState

// visitorSessions, monthlyVisitorSessions, playerBoomerangColors, deathPenaltyCooldowns moved to serverState.ts
// lastVisitorResetDay, lastMonthlyVisitorResetMonth, hourlyPeakConcurrent, peakConcurrent, peakConcurrentTime moved to serverState.ts

// ── Trap state ──
// TRAP_MODEL_SRC removed — server doesn't create visuals
/** Track last trap drop time per player for cooldown. */
const lastTrapDropTime = new Map<string, number>()
/** Track active trap entities for cleanup, with per-trap gravity state. */
interface ActiveTrap {
  entity: Entity
  syncId: number
  droppedBy: string
  droppedAtMs: number
  falling: boolean
  fallVelocity: number
  targetY: number          // ground Y estimated by client raycast
  groundResolved: boolean  // true once client raycast has reported ground
}
const activeTraps: ActiveTrap[] = []

/** Remove a trap entity and recycle its sync ID back to the pool. */
function removeTrap(trap: ActiveTrap): void {
  engine.removeEntity(trap.entity)
  recycleTrapSyncId(trap.syncId)
}

/** Remove a projectile entity and recycle its sync ID back to the pool. */
function removeProjectile(projectile: ActiveProjectile): void {
  engine.removeEntity(projectile.entity)
  recycleProjectileSyncId(projectile.syncId)
}

// ── Green orbit state ──
const ORBIT_DURATION_MS = 3500       // 3.5 seconds of spinning
const ORBIT_RADIUS = 4.0            // meters from player center
const ORBIT_HIT_RADIUS = 2.0        // how close a victim must be to the orbit ring
const ORBIT_COOLDOWN_SEC = 7        // total cooldown after orbit ends
interface ActiveOrbit {
  playerId: string
  startedAtMs: number
  hitPlayers: Set<string>  // each player can only be hit once per orbit
}
const activeOrbits: ActiveOrbit[] = []
const lastOrbitTime = new Map<string, number>()

// ── Projectile state ──
// PROJECTILE_MODEL_SRC removed — server doesn't create visuals
// PROJECTILE_GROUND_OFFSET removed — unused on server
const lastProjectileFireTime = new Map<string, number>()
interface ActiveProjectile {
  entity: Entity
  syncId: number
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
  hitWall: boolean        // true if maxDistance was shortened by a wall
  // Gravity
  currentY: number
  fallVelocity: number
  groundY: number        // latest ground height reported by client
  onGround: boolean      // true once projectile has landed on a surface
  // CRDT write throttle — sync distanceTraveled at 10Hz instead of 60fps

  // Boomerang return
  returning: boolean
  returnX: number  // current position during return
  returnY: number
  returnZ: number
  // Charge speed (30 = tap, 60 = full charge)
  chargeSpeed: number
  // Charge scale (1 = normal, up to 3 for green boomerang)
  chargeScale: number
}
const activeProjectiles: ActiveProjectile[] = []


// Gravity state for dropped flag
let flagFalling = false
let flagFallVelocity = 0
let flagGravityTargetY = FLAG_MIN_Y
const carrierYSamples: { y: number; time: number }[] = []
let lastDropperId = ''  // Who dropped the flag — only accept reportGroundY from them

// CARRIER_NO_POSITION_TIMEOUT_MS moved to serverState.ts
// Carrier staleness detection — force-drop if carrier position is unavailable
let lastCarrierPositionMs = 0          // Last time we got a valid position from carrier

let lastKnownCarrierPos: Vector3 | null = null  // Best-effort position for force-drops when getPlayerPosition is null

function resetCarrierTracking(): void {
  lastCarrierPositionMs = 0
  carrierYSamples.length = 0
  lastKnownCarrierPos = null
}

// isRealName moved to serverState.ts

// ── Persistence helpers ──
// persistFlagState, persistLeaderboard, persistAllTimeLeaderboard, persistMonthlyLeaderboard,
// persistPlayerNames, loadPlayerNames, persistVisitorData, loadVisitorData moved to persistence.ts

// checkLeaderboardDailyReset, checkMonthlyLeaderboardReset moved to leaderboard.ts

// updateConcurrentTracking, buildDailyReport, snapshotPendingReport, sendPendingReport,
// DISCORD_WEBHOOK_URL, loadDiscordWebhookUrl, sendDailyAnalyticsToDiscord, sendDiscordFallbackText,
// dailyReportSentForDay, loadDailyReportSentDay, checkPreMidnightReport, checkVisitorDailyReset,
// syncVisitorAnalytics, syncMonthlyVisitorAnalytics, checkMonthlyVisitorReset,
// visitorTrackingServerSystem moved to analytics.ts

// ── Setup ──

export async function setupServer(): Promise<void> {
  console.log('[Server] Starting Flag Tag server...')

  // Load Discord webhook URL from environment variable
  await loadDiscordWebhookUrl()

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
  setFlagEntity(engine.addEntity())
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
  
  setCountdownEntity(engine.addEntity())
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
  let leaderboardJson = patchAllLeaderboardNames(savedLeaderboard || '[]', 'leaderboard')

  setLeaderboardEntity(engine.addEntity())
  LeaderboardState.create(leaderboardEntity, { json: leaderboardJson, date: '' })
  syncEntity(leaderboardEntity, [LeaderboardState.componentId], SyncIds.LEADERBOARD)

  // Load persisted all-time leaderboard
  let savedAllTime: string | null = null
  try {
    savedAllTime = await Storage.get<string>('allTimeLeaderboard')
  } catch (err) {
    console.error('[Server] Failed to load all-time leaderboard from storage:', err)
  }
  let allTimeJson = patchAllLeaderboardNames(savedAllTime || '[]', 'all-time leaderboard')

  setAllTimeLeaderboardEntity(engine.addEntity())
  AllTimeLeaderboardState.create(allTimeLeaderboardEntity, { json: allTimeJson })
  syncEntity(allTimeLeaderboardEntity, [AllTimeLeaderboardState.componentId], SyncIds.ALLTIME_LEADERBOARD)

  // Load persisted monthly leaderboard
  let savedMonthly: string | null = null
  let savedMonthlyMonth: string | null = null
  try {
    savedMonthly = await Storage.get<string>('monthlyLeaderboard')
    savedMonthlyMonth = await Storage.get<string>('monthlyLeaderboardMonth')
  } catch (err) {
    console.error('[Server] Failed to load monthly leaderboard from storage:', err)
  }
  const currentMonth = getCurrentMonthString()
  // Reset if stored month doesn't match current month
  let monthlyJson = patchAllLeaderboardNames(
    (savedMonthlyMonth === currentMonth && savedMonthly) ? savedMonthly : '[]',
    'monthly leaderboard'
  )

  setMonthlyLeaderboardEntity(engine.addEntity())
  MonthlyLeaderboardState.create(monthlyLeaderboardEntity, { json: monthlyJson, month: currentMonth })
  syncEntity(monthlyLeaderboardEntity, [MonthlyLeaderboardState.componentId], SyncIds.MONTHLY_LEADERBOARD)
  
  // Load report tracking state before resets (needed by snapshot logic)
  await loadDailyReportSentDay()

  // Send any pending deferred report from a previous day before resetting
  await sendPendingReport()

  // Check for daily/monthly reset on server startup
  await checkLeaderboardDailyReset(snapshotPendingReport)
  await checkMonthlyLeaderboardReset()

  // Initialize visitor analytics
  await loadVisitorData()
  setVisitorAnalyticsEntity(engine.addEntity())
  VisitorAnalytics.create(visitorAnalyticsEntity, { 
    date: getTodayDateString(),
    visitorDataJson: '[]',
    onlineCount: 0,
    totalUniqueVisitors: 0
  })
  syncEntity(visitorAnalyticsEntity, [VisitorAnalytics.componentId], SyncIds.VISITOR_ANALYTICS)
  await syncVisitorAnalytics()

  // Initialize monthly visitor analytics
  const currentMonthForVisitors = getCurrentMonthString()
  let savedMonthlyVisitorData: string | null = null
  let savedMonthlyVisitorMonth: string | null = null
  try {
    savedMonthlyVisitorData = await Storage.get<string>('monthlyVisitorData')
    savedMonthlyVisitorMonth = await Storage.get<string>('monthlyVisitorResetMonth')
  } catch (err) {
    console.error('[Server] Failed to load monthly visitor data:', err)
  }
  setLastMonthlyVisitorResetMonth(savedMonthlyVisitorMonth || currentMonthForVisitors)

  // Restore monthly visitor data if same month
  if (savedMonthlyVisitorData && lastMonthlyVisitorResetMonth === currentMonthForVisitors) {
    try {
      const records = JSON.parse(savedMonthlyVisitorData)
      for (const record of records) {
        const seconds = record.totalSeconds != null ? record.totalSeconds : (record.totalMinutes || 0) * 60
        const recordKey = (record.userId || '').toLowerCase()
        const bestName = (playerNames.has(recordKey) && isRealName(playerNames.get(recordKey)!))
          ? playerNames.get(recordKey)!
          : record.name
        monthlyVisitorSessions.set(recordKey, {
          name: bestName,
          sessionStartMs: 0,
          totalSecondsMonth: seconds
        })
      }
      console.log('[Server] Restored monthly visitor data for', currentMonthForVisitors, '- loaded', records.length, 'visitors')
    } catch (e) {
      console.error('[Server] Failed to parse monthly visitor data:', e)
    }
  } else if (lastMonthlyVisitorResetMonth !== currentMonthForVisitors) {
    console.log('[Server] Monthly visitor data was from', lastMonthlyVisitorResetMonth, 'but current month is', currentMonthForVisitors, '- starting fresh')
    setLastMonthlyVisitorResetMonth(currentMonthForVisitors)
  }

  setMonthlyVisitorAnalyticsEntity(engine.addEntity())
  MonthlyVisitorAnalytics.create(monthlyVisitorAnalyticsEntity, {
    month: currentMonthForVisitors,
    visitorDataJson: '[]',
    onlineCount: 0,
    totalUniqueVisitors: 0
  })
  syncEntity(monthlyVisitorAnalyticsEntity, [MonthlyVisitorAnalytics.componentId], SyncIds.MONTHLY_VISITOR_ANALYTICS)
  await syncMonthlyVisitorAnalytics()

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

  // ── Initialize coin state entity ──
  setCoinStateEntity(engine.addEntity())
  CoinState.create(coinStateEntity, { cooldownJson: '{}' })
  syncEntity(coinStateEntity, [CoinState.componentId], COIN_STATE_SYNC_ID)
  console.log('[Server] Coin state entity initialized')

  // Register message handlers
  registerHandlers()

  // Register systems
  // Wrap all systems in try/catch — one bad frame shouldn't crash the server
  const safeSystem = (name: string, fn: (dt: number) => void) => (dt: number) => {
    try { fn(dt) } catch (err) { console.error(`[Server] ❌ ${name} error:`, err) }
  }
  engine.addSystem(safeSystem('flagServerSystem', flagServerSystem))
  engine.addSystem(safeSystem('holdTimeServerSystem', holdTimeServerSystem))
  engine.addSystem(safeSystem('lightningServerSystem', lightningServerSystem))
  engine.addSystem(safeSystem('playerTrackingSystem', playerTrackingSystem))
  engine.addSystem(safeSystem('countdownServerSystem', countdownServerSystem))
  engine.addSystem(safeSystem('visitorTrackingServerSystem', visitorTrackingServerSystem))
  engine.addSystem(safeSystem('nameResolverServerSystem', nameResolverServerSystem))
  engine.addSystem(safeSystem('proximityStealSystem', checkProximitySteal))
  engine.addSystem(safeSystem('bananaServerSystem', bananaServerSystem))
  engine.addSystem(safeSystem('shellServerSystem', shellServerSystem))
  engine.addSystem(safeSystem('orbitServerSystem', orbitServerSystem))
  engine.addSystem(safeSystem('updraftServerSystem', updraftServerSystem))
  engine.addSystem(safeSystem('zombieServerSystem', zombieServerSystem)) // Ghost system enabled
  engine.addSystem(safeSystem('coinServerSystem', coinServerSystem))

  // ── Spawn mushrooms ──
  spawnMushrooms()

  console.log('[Server] Flag Tag server ready')
}

// ── Helper: find player position by wallet address (case-insensitive) ──
// getPlayerPosition moved to serverState.ts

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
// updatePlayerName moved to leaderboard.ts

// ── Coin helpers ──

async function loadPlayerCoinBalance(walletAddress: string): Promise<number> {
  const key = walletAddress.toLowerCase()
  // Check in-memory cache first
  const cached = playerCoinBalances.get(key)
  if (cached !== undefined) return cached

  try {
    const saved = await Storage.get<string>(`coins:${key}`)
    const balance = saved ? parseInt(saved, 10) : 0
    playerCoinBalances.set(key, balance)
    return balance
  } catch (err) {
    console.error('[Coins] Failed to load balance for', key.slice(0, 8), err)
    return 0
  }
}

async function setPlayerCoinBalance(walletAddress: string, amount: number): Promise<void> {
  const key = walletAddress.toLowerCase()
  playerCoinBalances.set(key, amount)
  
  // Update synced wallet entity
  const walletEntity = getOrCreateWalletEntity(key)
  PlayerWallet.getMutable(walletEntity).coins = amount
  
  // Persist
  try {
    await Storage.set(`coins:${key}`, String(amount))
  } catch (err) {
    console.error('[Coins] Failed to persist balance for', key.slice(0, 8), err)
  }
}

async function addPlayerCoins(walletAddress: string, amount: number): Promise<number> {
  const current = await loadPlayerCoinBalance(walletAddress)
  const newBalance = Math.min(current + amount, MAX_COINS)
  await setPlayerCoinBalance(walletAddress, newBalance)
  return newBalance
}

function getOrCreateWalletEntity(walletAddress: string): Entity {
  const key = walletAddress.toLowerCase()
  let entity = walletEntities.get(key)
  if (entity) return entity

  entity = engine.addEntity()
  const balance = playerCoinBalances.get(key) ?? 0
  PlayerWallet.create(entity, { playerId: key, coins: balance })
  syncEntity(entity, [PlayerWallet.componentId], getWalletSyncId(key))
  walletEntities.set(key, entity)
  console.log('[Coins] Created wallet entity for', key.slice(0, 8), 'balance:', balance)
  return entity
}

// ── Upgrade / progression helpers ──

async function loadPlayerUpgrades(walletAddress: string): Promise<UpgradeData> {
  const key = walletAddress.toLowerCase()
  const cached = playerUpgradeData.get(key)
  if (cached) return cached

  try {
    const saved = await Storage.get<string>(`upgrades:${key}`)
    const data = saved ? parseUpgrades(saved) : { boomerangs: ['r'] as BoomerangColor[], equipped: 'r' as BoomerangColor }
    playerUpgradeData.set(key, data)
    return data
  } catch (err) {
    console.error('[Upgrades] Failed to load for', key.slice(0, 8), err)
    return { boomerangs: ['r'], equipped: 'r' }
  }
}

async function savePlayerUpgrades(walletAddress: string, data: UpgradeData): Promise<void> {
  const key = walletAddress.toLowerCase()
  playerUpgradeData.set(key, data)

  // Update synced entity
  const entity = getOrCreateUpgradeEntity(key)
  PlayerUpgrades.getMutable(entity).upgradesJson = serializeUpgrades(data)

  try {
    await Storage.set(`upgrades:${key}`, serializeUpgrades(data))
  } catch (err) {
    console.error('[Upgrades] Failed to persist for', key.slice(0, 8), err)
  }
}

function getOrCreateUpgradeEntity(walletAddress: string): Entity {
  const key = walletAddress.toLowerCase()
  let entity = upgradeEntities.get(key)
  if (entity) return entity

  entity = engine.addEntity()
  const data = playerUpgradeData.get(key) ?? { boomerangs: ['r'], equipped: 'r' }
  PlayerUpgrades.create(entity, { playerId: key, upgradesJson: serializeUpgrades(data) })
  syncEntity(entity, [PlayerUpgrades.componentId], getUpgradesSyncId(key))
  upgradeEntities.set(key, entity)
  console.log('[Upgrades] Created entity for', key.slice(0, 8))
  return entity
}

async function loadPlayerLifetimeWins(walletAddress: string): Promise<number> {
  const key = walletAddress.toLowerCase()
  const cached = playerLifetimeWinsCache.get(key)
  if (cached !== undefined) return cached

  try {
    const saved = await Storage.get<string>(`lifetimeWins:${key}`)
    let wins = saved ? parseInt(saved, 10) : 0

    // Reconcile with all-time leaderboard — always take the higher value
    // (covers initial seeding and any drift from before lifetime wins tracking)
    const atEntries = parseLeaderboardJson(AllTimeLeaderboardState.getOrNull(allTimeLeaderboardEntity)?.json)
    const entry = atEntries.find(e => e.userId.toLowerCase() === key)
    if (entry && entry.roundsWon > wins) {
      console.log('[LifetimeWins] Reconciled', key.slice(0, 8), 'from', wins, 'to', entry.roundsWon, '(all-time leaderboard)')
      wins = entry.roundsWon
      await Storage.set(`lifetimeWins:${key}`, String(wins))
    }

    playerLifetimeWinsCache.set(key, wins)
    return wins
  } catch (err) {
    console.error('[LifetimeWins] Failed to load for', key.slice(0, 8), err)
    return 0
  }
}

async function addPlayerLifetimeWin(walletAddress: string): Promise<number> {
  const key = walletAddress.toLowerCase()
  const current = await loadPlayerLifetimeWins(key)
  const newWins = current + 1
  playerLifetimeWinsCache.set(key, newWins)

  // Update synced entity
  const entity = getOrCreateLifetimeWinsEntity(key)
  PlayerLifetimeWins.getMutable(entity).wins = newWins

  try {
    await Storage.set(`lifetimeWins:${key}`, String(newWins))
  } catch (err) {
    console.error('[LifetimeWins] Failed to persist for', key.slice(0, 8), err)
  }

  return newWins
}

function getOrCreateLifetimeWinsEntity(walletAddress: string): Entity {
  const key = walletAddress.toLowerCase()
  let entity = lifetimeWinsEntities.get(key)
  if (entity) return entity

  entity = engine.addEntity()
  const wins = playerLifetimeWinsCache.get(key) ?? 0
  PlayerLifetimeWins.create(entity, { playerId: key, wins })
  syncEntity(entity, [PlayerLifetimeWins.componentId], getLifetimeWinsSyncId(key))
  lifetimeWinsEntities.set(key, entity)
  console.log('[LifetimeWins] Created entity for', key.slice(0, 8), 'wins:', wins)
  return entity
}

async function handleBuyBoomerang(playerId: string, color: string): Promise<void> {
  const key = playerId.toLowerCase()
  const boomerangColor = color as BoomerangColor
  
  // Find the store item
  const item = BOOMERANG_STORE.find(i => i.id === boomerangColor)
  if (!item) {
    room.send('buyResult', { success: false, color, reason: 'Invalid item', newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  // Already owned?
  const upgrades = await loadPlayerUpgrades(key)
  if (upgrades.boomerangs.includes(boomerangColor)) {
    room.send('buyResult', { success: false, color, reason: 'Already owned', newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  // Check flag requirement
  const wins = await loadPlayerLifetimeWins(key)
  if (wins < item.flagsRequired) {
    room.send('buyResult', { success: false, color, reason: `Need ${item.flagsRequired} flags (you have ${wins})`, newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  // Check coin balance
  const balance = await loadPlayerCoinBalance(key)
  if (balance < item.coinCost) {
    room.send('buyResult', { success: false, color, reason: `Need ${item.coinCost} coins (you have ${balance})`, newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  // Deduct coins
  const newBalance = balance - item.coinCost
  await setPlayerCoinBalance(key, newBalance)

  // Add boomerang to owned list + auto-equip
  upgrades.boomerangs.push(boomerangColor)
  upgrades.equipped = boomerangColor
  await savePlayerUpgrades(key, upgrades)

  // Update the player's boomerang color on server side
  playerBoomerangColors.set(key, boomerangColor)

  console.log('[Store] Player', key.slice(0, 8), 'bought', item.label, 'for', item.coinCost, 'coins. New balance:', newBalance)

  room.send('buyResult', {
    success: true,
    color,
    reason: '',
    newBalance,
    upgradesJson: serializeUpgrades(upgrades)
  }, { to: [key] })

  // Broadcast color change to all players
  room.send('playerColorChanged', { playerId: key, color: boomerangColor })
}

function updateCoinStateCRDT(): void {
  const obj: Record<string, number> = {}
  for (const coinId of coinCooldowns) {
    obj[coinId] = 1 // value doesn't matter, just presence
  }
  CoinState.getMutable(coinStateEntity).cooldownJson = JSON.stringify(obj)
}

/** Server system: periodically respawn one random coin from the empty pool */
function coinServerSystem(dt: number): void {
  if (coinCooldowns.size === 0) return
  
  coinRespawnTimer += dt
  if (coinRespawnTimer < COIN_RESPAWN_INTERVAL_SEC) return
  coinRespawnTimer = 0
  
  // Pick a random coin from the cooldown set to respawn
  const cooldownArray = Array.from(coinCooldowns)
  const idx = Math.floor(Math.random() * cooldownArray.length)
  const coinId = cooldownArray[idx]
  
  coinCooldowns.delete(coinId)
  room.send('coinRespawned', { coinId })
  updateCoinStateCRDT()
  console.log('[Coins] Coin respawned (random):', coinId, '| remaining empty:', coinCooldowns.size)
}

/** Award coins to players at end of round based on hold time and placement */
async function awardRoundCoins(players: { userId: string; seconds: number }[]): Promise<void> {
  if (players.length === 0) return
  
  // Sort by seconds descending for placement
  const sorted = [...players].sort((a, b) => b.seconds - a.seconds)
  
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]
    let coins = ROUND_PARTICIPATION_COINS
    
    // Hold time coins
    coins += Math.floor(p.seconds * COINS_PER_HOLD_SECOND)
    
    // Placement bonus (1st, 2nd, 3rd)
    if (i < ROUND_PLACEMENT_BONUS.length && p.seconds > 0) {
      coins += ROUND_PLACEMENT_BONUS[i]
    }
    
    if (coins > 0) {
      const newBalance = await addPlayerCoins(p.userId, coins)
      // Send balance update to the specific player
      room.send('walletBalance', { playerId: p.userId, coins: newBalance }, { to: [p.userId] })
      // Send detailed breakdown so client can show "You Earned" UI
      const holdTimeCoins = Math.floor(p.seconds * COINS_PER_HOLD_SECOND)
      const placementBonus = (i < ROUND_PLACEMENT_BONUS.length && p.seconds > 0) ? ROUND_PLACEMENT_BONUS[i] : 0
      room.send('roundCoinsEarned', {
        playerId: p.userId,
        total: coins,
        participation: ROUND_PARTICIPATION_COINS,
        holdTime: holdTimeCoins,
        placement: placementBonus,
        rank: i + 1,
        newBalance
      }, { to: [p.userId] })
      console.log('[Coins] Awarded', coins, 'coins to', p.userId.slice(0, 8), '(new balance:', newBalance, ')')
    }
  }
}

// ── Message handlers ──
function registerHandlers(): void {
  room.onMessage('registerName', (data, context) => {
    try {
      if (!context || !data.name) return
      const from = context.from.toLowerCase()
      if (updatePlayerName(from, data.name)) {
        console.log('[Server] registerName: updated', from.slice(0, 8), '->', data.name)
        persistPlayerNames().catch(e => console.error('[Server] persistPlayerNames error:', e))
      }
      // Send all existing player boomerang colors to the new joiner
      for (const [playerId, color] of playerBoomerangColors) {
        if (playerId !== from) {
          room.send('playerColorChanged', { playerId, color })
        }
      }
    } catch (err) { console.error('[Server] ❌ registerName handler error:', err) }
  })
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

  // Death penalty — deduct coins on death (drowning, lightning, ghost)
  const DEATH_PENALTY_COINS = 10
  // deathPenaltyCooldowns is module-level so playerTrackingSystem can clean it up on disconnect
  room.onMessage('deathPenalty', async (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const now = Date.now()
      const lastDeath = deathPenaltyCooldowns.get(from) ?? 0
      if (now - lastDeath < 3000) return // 3s cooldown to prevent duplicate messages
      deathPenaltyCooldowns.set(from, now)

      const current = await loadPlayerCoinBalance(from)
      const penalty = Math.min(DEATH_PENALTY_COINS, current) // don't go negative
      const newBalance = current - penalty
      await setPlayerCoinBalance(from, newBalance)
      room.send('walletBalance', { playerId: from, coins: newBalance }, { to: [from] })
      room.send('deathPenaltyApplied', { playerId: from, penalty, newBalance }, { to: [from] })
      console.log(`[Server] 💀 Death penalty: ${from.slice(0, 8)} lost ${penalty} coins (${current} → ${newBalance})`)
    } catch (err) { console.error('[Server] ❌ deathPenalty handler error:', err) }
  })
  // Reload-respawn: player reloaded scene while carrying flag → respawn at random point
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
  room.onMessage('requestBanana', (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      handleTrapDrop(from)
    } catch (err) { console.error('[Server] ❌ requestBanana handler error:', err) }
  })
  room.onMessage('requestShell', (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      // Accept optional chargeSpeed/chargeRange from charge mechanic, clamped to valid ranges
      const chargeSpeed = typeof data.chargeSpeed === 'number' ? Math.max(PROJECTILE_SPEED, Math.min(60, data.chargeSpeed)) : PROJECTILE_SPEED
      const chargeRange = typeof data.chargeRange === 'number' ? Math.max(20, Math.min(PROJECTILE_MAX_RANGE, data.chargeRange)) : 20
      const chargeScale = typeof data.chargeScale === 'number' ? Math.max(1, Math.min(3, data.chargeScale)) : 1
      handleProjectileFire(from, data.dirX, data.dirZ, data.color || 'r', chargeSpeed, chargeRange, chargeScale)
    } catch (err) { console.error('[Server] ❌ requestShell handler error:', err) }
  })
  room.onMessage('reportShellWallDist', (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      for (const projectile of activeProjectiles) {
        if (projectile.firedBy === from && !projectile.wallDistReported) {
          const oldMax = projectile.maxDistance
          projectile.maxDistance = Math.min(projectile.maxDistance, data.maxDist)
          if (projectile.maxDistance < oldMax) projectile.hitWall = true
          projectile.wallDistReported = true
          console.log('[Server] 🎯 Projectile wall distance updated:', data.maxDist.toFixed(1), 'm')
          break
        }
      }
    } catch (err) { console.error('[Server] ❌ reportShellWallDist handler error:', err) }
  })
  room.onMessage('reportShellGroundY', (data, context) => {
    try {
      if (!context) return
      let closest: ActiveProjectile | null = null
      let closestDist = 5
      for (const projectile of activeProjectiles) {
        const pos = Transform.get(projectile.entity).position
        const dx = pos.x - data.shellX
        const dz = pos.z - data.shellZ
        const dist = Math.sqrt(dx * dx + dz * dz)
        if (dist < closestDist) {
          closestDist = dist
          closest = projectile
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
      let closest: ActiveTrap | null = null
      let closestDist = 3
      for (const trap of activeTraps) {
        const pos = Transform.get(trap.entity).position
        const dx = pos.x - data.bananaX
        const dz = pos.z - data.bananaZ
        const dist = Math.sqrt(dx * dx + dz * dz)
        if (dist < closestDist) {
          closestDist = dist
          closest = trap
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
      const from = context.from.toLowerCase()
      // Only accept ground report from the player who dropped the flag
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

  // ── Mushroom position request (client asks on connect) ──
  room.onMessage('requestMushroomPositions', (_data, _context) => {
    try {
      const remaining = activeMushrooms.filter(m => !m.pickedUp).map(mushroomToPayload)
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
      room.send('mushroomPickedUp', { id: mid, playerId: from })
      // Spawn a replacement mushroom
      spawnOneMushroom()
    } catch (err) { console.error('[Server] ❌ pickupMushroom handler error:', err) }
  })

  // Mushroom reroll removed — candidates are now sent upfront

  // ── Green orbit ──
  room.onMessage('requestOrbit', (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const startAngle = typeof _data.startAngle === 'number' ? _data.startAngle : 0
      handleOrbitRequest(from, startAngle)
    } catch (err) { console.error('[Server] ❌ requestOrbit handler error:', err) }
  })

  // ── Green orbit wall hit ──
  room.onMessage('orbitHitWall', (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const idx = activeOrbits.findIndex(o => o.playerId === from)
      if (idx === -1) return
      console.log('[Server] 🌀 Orbit hit wall for', from.slice(0, 8), '— ending orbit')
      room.send('orbitEnded', { playerId: from })
      activeOrbits.splice(idx, 1)
    } catch (err) { console.error('[Server] ❌ orbitHitWall handler error:', err) }
  })

  // ── Boomerang color change ──
  room.onMessage('colorChanged', async (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const color = (data.color || 'r') as BoomerangColor
      // Validate ownership — only allow equipped boomerangs the player owns
      const upgrades = await loadPlayerUpgrades(from)
      if (!upgrades.boomerangs.includes(color)) {
        console.log(`[Server] colorChanged rejected — ${from.slice(0, 8)} doesn't own ${color}`)
        // Send back their actual equipped color
        room.send('playerColorChanged', { playerId: from, color: upgrades.equipped })
        return
      }
      playerBoomerangColors.set(from, color)
      console.log(`[Server] Player ${from.slice(0, 8)} changed boomerang color to ${color}`)
      // Broadcast to ALL clients (including sender, so they can confirm)
      room.send('playerColorChanged', { playerId: from, color })
    } catch (err) { console.error('[Server] ❌ colorChanged handler error:', err) }
  })

  // ── Boomerang charge sync ──
  // ── Burnout self-stun — rebroadcast hit VFX to all clients ──
  room.onMessage('chargeBurnout', (data, context) => {
    if (!context) return
    room.send('hitVfx', { x: data.x || 0, y: data.y || 0, z: data.z || 0 })
  })

  // ── Speed boost trail sync ──
  room.onMessage('reportBoost', (data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    room.send('playerBoosted', { playerId: from, tier: data.tier || 'coin', duration: data.duration || 3 })
  })

  room.onMessage('chargeStart', (data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    room.send('playerChargeStart', { playerId: from, t: data.t || 0 })
  })
  room.onMessage('chargeStop', (data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    room.send('playerChargeStop', { playerId: from, t: data.t || 0 })
  })


  // ── Updraft location request ──
  room.onMessage('requestUpdraftLocation', (_data, _context) => {
    try {
      room.send('updraftLocation', { index: updraftActiveIndex })
    } catch (err) { console.error('[Server] ❌ requestUpdraftLocation handler error:', err) }
  })

  // Admin: manually trigger Discord analytics report
  const ADMIN_ADDRESSES = ['0x1e93e534c5e26b01ed242410b43ae23dd0faa52b']
  // ── Coin message handlers ──
  
  room.onMessage('requestCoinPickup', (data, context) => {
    if (!context || !data.coinId) return
    const from = context.from.toLowerCase()
    const coinId = data.coinId
    
    // Check if coin is already picked up
    if (coinCooldowns.has(coinId)) {
      console.log('[Coins] Pickup rejected — coin already picked up:', coinId)
      return
    }
    
    // Add to empty pool (will respawn randomly later)
    coinCooldowns.add(coinId)
    updateCoinStateCRDT()
    
    // Award coin to player
    addPlayerCoins(from, 1).then(newBalance => {
      room.send('coinPickedUp', { coinId, playerId: from, newBalance })
      console.log('[Coins] Coin picked up:', coinId, 'by', from.slice(0, 8), 'balance:', newBalance)
    }).catch(err => console.error('[Coins] Error awarding coin:', err))
  })
  
  room.onMessage('requestWalletBalance', async (_data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    const balance = await loadPlayerCoinBalance(from)
    getOrCreateWalletEntity(from)  // ensure wallet entity exists and is synced
    room.send('walletBalance', { playerId: from, coins: balance }, { to: [from] })
    console.log('[Coins] Sent wallet balance to', from.slice(0, 8), ':', balance)
  })

  room.onMessage('testDiscord', (_data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    if (!ADMIN_ADDRESSES.includes(from)) {
      console.log('[Server] testDiscord rejected from non-admin:', from)
      return
    }
    console.log('[Server] 📊 Admin triggered Discord analytics report')
    sendDailyAnalyticsToDiscord().then(() => {
      console.log('[Server] ✅ Manual Discord report sent')
    }).catch(err => {
      console.error('[Server] ❌ Manual Discord report failed:', err)
    })
  })

  // ── Store / upgrade handlers ──

  room.onMessage('requestUpgrades', async (_data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    // Load and sync upgrades + lifetime wins
    const upgrades = await loadPlayerUpgrades(from)
    getOrCreateUpgradeEntity(from)
    const wins = await loadPlayerLifetimeWins(from)
    getOrCreateLifetimeWinsEntity(from)
    // Send direct message so client gets data immediately (CRDT sync can be slow)
    room.send('upgradesResponse', { upgradesJson: serializeUpgrades(upgrades), wins }, { to: [from] })
    console.log('[Store] Sent upgrades to', from.slice(0, 8), '- owned:', upgrades.boomerangs.join(','), 'wins:', wins)

    // Auto-equip their saved boomerang color
    if (upgrades.equipped && upgrades.equipped !== 'r') {
      playerBoomerangColors.set(from, upgrades.equipped)
      room.send('playerColorChanged', { playerId: from, color: upgrades.equipped })
    }
  })

  room.onMessage('buyBoomerang', async (data, context) => {
    if (!context || !data.color) return
    const from = context.from.toLowerCase()
    try {
      await handleBuyBoomerang(from, data.color)
    } catch (err) {
      console.error('[Store] buyBoomerang error:', err)
    }
  })

  room.onMessage('equipBoomerang', async (data, context) => {
    if (!context || !data.color) return
    const from = context.from.toLowerCase()
    const color = data.color as BoomerangColor
    
    const upgrades = await loadPlayerUpgrades(from)
    if (!upgrades.boomerangs.includes(color)) {
      console.log('[Store] equipBoomerang rejected — not owned:', color, 'by', from.slice(0, 8))
      return
    }
    
    upgrades.equipped = color
    await savePlayerUpgrades(from, upgrades)
    playerBoomerangColors.set(from, color)
    room.send('playerColorChanged', { playerId: from, color })
    console.log('[Store] Player', from.slice(0, 8), 'equipped', color)
  })
}

// ── Updraft state ──
const UPDRAFT_CHIMNEY_COUNT = 49
const UPDRAFT_ROTATE_SEC = 60
let updraftActiveIndex = Math.floor(Math.random() * UPDRAFT_CHIMNEY_COUNT)
let updraftTimer = 0

function updraftServerSystem(dt: number) {
  updraftTimer += dt
  if (updraftTimer >= UPDRAFT_ROTATE_SEC) {
    updraftTimer = 0
    // Pick a random chimney that isn't the current one
    let next = Math.floor(Math.random() * (UPDRAFT_CHIMNEY_COUNT - 1))
    if (next >= updraftActiveIndex) next++
    updraftActiveIndex = next
    room.send('updraftLocation', { index: updraftActiveIndex })
    console.log('[Server] 💨 Updraft moved to chimney', updraftActiveIndex)
  }
}

// ── Leaderboard helpers (deduplicated) ──

// LeaderboardEntry, parseLeaderboardJson, incrementLeaderboardWins,
// patchLeaderboardNames, patchAllLeaderboardNames moved to leaderboard.ts

function handlePickup(playerId: string): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) return
  if (flag.state !== FlagState.AtBase && flag.state !== FlagState.Dropped) return

  const playerPos = getPlayerPosition(playerId)
  if (playerPos) {
    const flagPos = Transform.get(flagEntity).position
    const dist = Vector3.distance(playerPos, flagPos)
    if (dist > PICKUP_RADIUS) return
  } else {
    // Player position not yet synced — trust client-side proximity check
    console.log('[Server] ⚠️ handlePickup: no position for', playerId.slice(0, 8), '— trusting client proximity')
  }

  // Flush any leftover hold time from a previous carrier (safety)
  flushHoldTimeAccum()

  const mutable = Flag.getMutable(flagEntity)
  mutable.state = FlagState.Carried
  mutable.carrierPlayerId = playerId

  resetGravityState()
  lastCarrierPositionMs = Date.now() // Start staleness timer so force-drop works even if position never syncs
  lastStealTime.set(playerId, Date.now()) // Grant immunity on pickup too
  room.send('pickupConfirmed', { playerId })
  room.send('flagImmunity', { playerId, durationMs: STEAL_IMMUNITY_MS })
  room.send('pickupSound', { t: 0 })
  persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
}

function handleDrop(playerId: string): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag) return
  if (flag.state !== FlagState.Carried || flag.carrierPlayerId !== playerId) return

  // Flush accumulated hold time to the carrier BEFORE dropping
  flushHoldTimeAccum()

  const playerPos = getPlayerPosition(playerId)
  let dropPos: Vector3
  if (playerPos) {
    // Drop at player's feet (not behind them) to prevent wall clipping
    dropPos = Vector3.add(playerPos, Vector3.create(0, 0.5, 0))
  } else if (lastKnownCarrierPos) {
    // Use last tracked position instead of stale flagEntity Transform
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

  // Track who dropped — only accept reportGroundY from this player
  lastDropperId = playerId

  // Start gravity — estimate ground from carrier's recent Y history
  computeGravityTarget(dropPos.y)

  room.send('dropSound', { t: 0 })
  persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
}

function handleFlagSteal(victimId: string, attackerId: string): void {
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
  lastCarrierPositionMs = Date.now() // Start staleness timer for new carrier
  room.send('pickupConfirmed', { playerId: attackerId })
  room.send('flagImmunity', { playerId: attackerId, durationMs: STEAL_IMMUNITY_MS })
  room.send('pickupSound', { t: 0 })
  persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
}

/** Proximity steal — called every server tick to check if any player is close enough to steal the flag. */
function checkProximitySteal(): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag || flag.state !== FlagState.Carried || !flag.carrierPlayerId) return

  const carrierId = flag.carrierPlayerId
  const carrierPos = getPlayerPosition(carrierId)
  if (!carrierPos) return

  const now = Date.now()
  // Carrier has steal immunity — nobody can take it from them yet
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

function handleTrapDrop(playerId: string): void {
  const now = Date.now()

  // Cooldown check
  const lastDrop = lastTrapDropTime.get(playerId) ?? 0
  const bananaCd = TRAP_COOLDOWN_SEC
  if (now - lastDrop < bananaCd * 1000) {
    console.log('[Server] Trap denied: cooldown active, wait', ((bananaCd * 1000 - (now - lastDrop)) / 1000).toFixed(1), 's')
    room.send('bananaDenied', { reason: 'cooldown' }, { to: [playerId] })
    return
  }

  // Max active trap check
  const playerTraps = activeTraps.filter(b => b.droppedBy === playerId)
  if (playerTraps.length >= TRAP_MAX_ACTIVE) {
    console.log('[Server] Trap denied: max active traps reached (', TRAP_MAX_ACTIVE, ')')
    room.send('bananaDenied', { reason: 'max_active' }, { to: [playerId] })
    return
  }

  // Get player position
  const playerPos = getPlayerPosition(playerId)
  if (!playerPos) {
    console.log('[Server] Trap denied: player position not found')
    room.send('bananaDenied', { reason: 'no_position' }, { to: [playerId] })
    return
  }

  // Drop trap slightly behind the player (at their feet)
  const dropPos = Vector3.create(playerPos.x, playerPos.y - 0.2, playerPos.z)

  // Create synced trap entity
  const trapEntity = engine.addEntity()
  Transform.create(trapEntity, {
    position: dropPos,
    scale: Vector3.create(1, 1, 1)
  })
  // NOTE: GltfContainer is NOT created on the server — clients attach the visual mesh locally.
  Trap.create(trapEntity, {
    droppedByPlayerId: playerId,
    droppedAtMs: now,
  })
  const trapSyncId = getNextTrapSyncId()
  syncEntity(trapEntity, [Transform.componentId, Trap.componentId], trapSyncId)

  activeTraps.push({
    entity: trapEntity,
    syncId: trapSyncId,
    droppedBy: playerId,
    droppedAtMs: now,
    falling: true,
    fallVelocity: 0,
    targetY: 0,                 // default floor until client reports ground (traps sit on actual surface)
    groundResolved: false,
  })
  lastTrapDropTime.set(playerId, now)

  // Notify clients for sound/VFX + ground raycast
  room.send('bananaDropped', { x: dropPos.x, y: dropPos.y, z: dropPos.z, ownerId: playerId })

  console.log('[Server] 🪤 Trap dropped by', playerId.slice(0, 8), 'at', dropPos.x.toFixed(1), dropPos.y.toFixed(1), dropPos.z.toFixed(1), '— active traps:', activeTraps.length)
}

/** Server system: check trap gravity, triggers (player proximity), and expiry. */
function bananaServerSystem(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = activeTraps.length - 1; i >= 0; i--) {
    const trap = activeTraps[i]

    // Defensive guard: if the entity's Transform was already removed (race condition
    // with boomerang/zombie collisions), clean up the ghost entry to prevent pool leaks.
    if (!Transform.has(trap.entity)) {
      console.log('[Server] 🪤⚠️ Ghost trap detected (no Transform) — cleaning up. droppedBy:', trap.droppedBy.slice(0, 8))
      activeTraps.splice(i, 1)
      continue
    }

    // Gravity — pull trap down to ground
    if (trap.falling) {
      trap.fallVelocity += FLAG_GRAVITY * clampedDt
      const pos = Transform.get(trap.entity).position
      let newY = pos.y - trap.fallVelocity * clampedDt
      if (newY <= trap.targetY) {
        newY = trap.targetY
        trap.falling = false
        trap.fallVelocity = 0
      }
      const t = Transform.getMutable(trap.entity)
      t.position = Vector3.create(pos.x, newY, pos.z)
    }

    // Expiry check
    const ageMs = now - trap.droppedAtMs
    if (ageMs > TRAP_LIFETIME_SEC * 1000) {
      console.log('[Server] 🪤 Trap expired, removing')
      removeTrap(trap)
      activeTraps.splice(i, 1)
      continue
    }

    // Trigger check — any player (except the dropper) walks over it
    const trapPos = Transform.get(trap.entity).position
    let trapConsumed = false

    // Check ghost-trap collision
    for (let gi = activeZombies.length - 1; gi >= 0; gi--) {
      const z = activeZombies[gi]
      const dx = z.posX - trapPos.x
      const dy = z.posY - trapPos.y
      const dz = z.posZ - trapPos.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist < TRAP_TRIGGER_RADIUS) {
        console.log('[Server] 🪤👻 Trap hit ghost! Killing ghost.')
        room.send('bananaTriggered', { x: trapPos.x, y: trapPos.y, z: trapPos.z, victimId: '' })
        room.send('zombieKilled', { x: z.posX, y: z.posY, z: z.posZ })
        engine.removeEntity(z.entity); recycleZombieSyncId(z.syncId)
        activeZombies.splice(gi, 1)
        zombieRespawnCooldown = ZOMBIE_RESPAWN_COOLDOWN
        removeTrap(trap)
        activeTraps.splice(i, 1)
        trapConsumed = true
        break
      }
    }
    if (trapConsumed) continue

    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      const addr = identity.address.toLowerCase()
      // Self-hit: immune for 2 seconds after dropping, then fair game
      if (addr === trap.droppedBy && (now - trap.droppedAtMs) < 2000) continue

      const playerPos = getPlayerPosition(addr)
      if (!playerPos) continue

      const dist = Vector3.distance(playerPos, trapPos)
      if (dist < TRAP_TRIGGER_RADIUS) {
        console.log('[Server] 🪤 Trap triggered by', addr.slice(0, 8), '! Staggering...')

        // Drop the flag if the victim is carrying it
        const flag = Flag.getOrNull(flagEntity)
        if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === addr) {
          console.log('[Server] 🪤 Victim was carrying flag — forcing drop!')
          handleDrop(addr)
        }

        room.send('bananaTriggered', { x: trapPos.x, y: trapPos.y, z: trapPos.z, victimId: addr })

        // Remove the trap
        removeTrap(trap)
        activeTraps.splice(i, 1)
        break // This trap is consumed
      }
    }
  }
}

function handleOrbitRequest(playerId: string, startAngle: number = 0): void {
  const now = Date.now()

  // Cooldown check
  const lastOrb = lastOrbitTime.get(playerId) ?? 0
  if (now - lastOrb < ORBIT_COOLDOWN_SEC * 1000) {
    console.log('[Server] Orbit denied: cooldown active')
    return
  }

  // Can't orbit while already orbiting
  if (activeOrbits.some(o => o.playerId === playerId)) {
    console.log('[Server] Orbit denied: already orbiting')
    return
  }

  // Can't orbit while a projectile is in flight
  if (activeProjectiles.some(p => p.firedBy === playerId)) {
    console.log('[Server] Orbit denied: projectile in flight')
    return
  }

  const playerPos = getPlayerPosition(playerId)
  if (!playerPos) {
    console.log('[Server] Orbit denied: player position not found')
    return
  }

  activeOrbits.push({
    playerId,
    startedAtMs: now,
    hitPlayers: new Set()
  })
  lastOrbitTime.set(playerId, now)

  room.send('orbitStarted', { playerId, durationMs: ORBIT_DURATION_MS, startAngle })
  console.log('[Server] 🌀 Orbit started by', playerId.slice(0, 8))
}

/** Server system: check orbit hits and expiry. */
function orbitServerSystem(_dt: number): void {
  const now = Date.now()

  for (let i = activeOrbits.length - 1; i >= 0; i--) {
    const orbit = activeOrbits[i]

    // Expiry
    if (now - orbit.startedAtMs > ORBIT_DURATION_MS) {
      console.log('[Server] 🌀 Orbit ended for', orbit.playerId.slice(0, 8))
      room.send('orbitEnded', { playerId: orbit.playerId })
      activeOrbits.splice(i, 1)
      continue
    }

    // Get orbiter position
    const orbiterPos = getPlayerPosition(orbit.playerId)
    if (!orbiterPos) continue

    // Check all players for hits
    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      const addr = identity.address.toLowerCase()
      if (addr === orbit.playerId) continue
      if (orbit.hitPlayers.has(addr)) continue  // already hit this orbit

      const victimPos = getPlayerPosition(addr)
      if (!victimPos) continue

      const dist = Vector3.distance(orbiterPos, victimPos)
      // Hit if within orbit radius + hit radius (the boomerang sweeps through)
      if (dist < ORBIT_RADIUS + ORBIT_HIT_RADIUS && dist > 0.5) {
        orbit.hitPlayers.add(addr)
        console.log('[Server] 🌀 Orbit hit player', addr.slice(0, 8), '— ending orbit')

        // Drop flag if victim is carrying
        const flag = Flag.getOrNull(flagEntity)
        if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === addr) {
          console.log('[Server] 🌀 Orbit victim was carrying flag — forcing drop!')
          handleDrop(addr)
        }

        room.send('orbitHit', { x: victimPos.x, y: victimPos.y, z: victimPos.z, victimId: addr, attackerId: orbit.playerId })
        // End orbit on hit — boomerang returns to player
        room.send('orbitEnded', { playerId: orbit.playerId })
        activeOrbits.splice(i, 1)
        break
      }
    }
  }
}

function handleProjectileFire(playerId: string, dirX: number, dirZ: number, color: string = 'r', chargeSpeed: number = PROJECTILE_SPEED, chargeRange: number = 20, chargeScale: number = 1): void {
  const now = Date.now()

  // Cooldown check
  const lastFire = lastProjectileFireTime.get(playerId) ?? 0
  const shellCd = PROJECTILE_COOLDOWN_SEC
  // Yellow gets a shorter cooldown window to allow the rapid 2nd throw
  const effectiveCd = color === 'y' ? 0.2 : shellCd
  if (now - lastFire < effectiveCd * 1000) {
    console.log('[Server] Projectile denied: cooldown active')
    return
  }

  // Max active check (yellow allows 2)
  const playerProjectiles = activeProjectiles.filter(s => s.firedBy === playerId)
  const maxActive = color === 'y' ? 2 : PROJECTILE_MAX_ACTIVE
  if (playerProjectiles.length >= maxActive) {
    console.log('[Server] Projectile denied: max active projectiles reached')
    return
  }

  // Get player position
  const playerPos = getPlayerPosition(playerId)
  if (!playerPos) {
    console.log('[Server] Projectile denied: player position not found')
    return
  }

  // Normalize direction on XZ plane
  const len = Math.sqrt(dirX * dirX + dirZ * dirZ)
  if (len < 0.01) {
    console.log('[Server] Projectile denied: invalid direction')
    return
  }
  const nDirX = dirX / len
  const nDirZ = dirZ / len

  // Spawn slightly in front of the player near ground level
  const spawnPos = Vector3.create(
    playerPos.x + nDirX * 1.0,
    playerPos.y + 0.8,
    playerPos.z + nDirZ * 1.0
  )

  // Create synced projectile entity
  const projectileEntity = engine.addEntity()
  Transform.create(projectileEntity, {
    position: spawnPos,
    scale: Vector3.create(1, 1, 1),
    rotation: Quaternion.fromEulerDegrees(0, Math.atan2(nDirX, nDirZ) * (180 / Math.PI), 0)
  })
  // NOTE: GltfContainer is NOT created on the server — clients attach the visual mesh locally.
  Projectile.create(projectileEntity, {
    firedByPlayerId: playerId,
    firedAtMs: now,
    startX: spawnPos.x,
    startY: spawnPos.y,
    startZ: spawnPos.z,
    dirX: nDirX,
    dirZ: nDirZ,
    distanceTraveled: 0,
    maxDistance: chargeRange,
    active: true,
  })
  // NOTE: Transform is intentionally NOT synced for projectiles.
  // Syncing Transform at 60fps per projectile saturates the CRDT buffer and freezes
  // ALL synced components (including the scoreboard). Clients use local visual
  // entities positioned via Projectile component data (startX/Y/Z + direction + distanceTraveled).
  const projectileSyncId = getNextProjectileSyncId()
  syncEntity(projectileEntity, [Projectile.componentId], projectileSyncId)

  activeProjectiles.push({
    entity: projectileEntity,
    syncId: projectileSyncId,
    firedBy: playerId,
    firedAtMs: now,
    startX: spawnPos.x,
    startY: spawnPos.y,
    startZ: spawnPos.z,
    dirX: nDirX,
    dirZ: nDirZ,
    distanceTraveled: 0,
    maxDistance: chargeRange,
    wallDistReported: false,
    hitWall: false,
    currentY: spawnPos.y,
    fallVelocity: 0,
    groundY: Math.max(0, playerPos.y - 0.88),  // Approximate ground level from player height (~0.88m avatar offset)
    onGround: false,

    returning: false,
    returnX: spawnPos.x,
    returnY: spawnPos.y,
    returnZ: spawnPos.z,
    chargeSpeed,
    chargeScale,

  })
  lastProjectileFireTime.set(playerId, now)

  room.send('shellDropped', { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z, dirX: nDirX, dirZ: nDirZ, color, firedBy: playerId, chargeSpeed, chargeRange, chargeScale })
  console.log('[Server] 🎯 Projectile fired by', playerId.slice(0, 8), 'dir:', nDirX.toFixed(2), nDirZ.toFixed(2))
}

/** Server system: move projectiles forward (and return), check player hits, and handle expiry. */
function shellServerSystem(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = activeProjectiles.length - 1; i >= 0; i--) {
    const projectile = activeProjectiles[i]

    // Safety expiry (time-based)
    if (now - projectile.firedAtMs > PROJECTILE_LIFETIME_SEC * 1000) {
      console.log('[Server] 🎯 Projectile expired (timeout)')
      room.send('shellReturned', { firedBy: projectile.firedBy })
      removeProjectile(projectile)
      activeProjectiles.splice(i, 1)
      continue
    }

    const moveDistance = (projectile.chargeSpeed || PROJECTILE_SPEED) * clampedDt

    if (!projectile.returning) {
      // ── Outbound flight ──
      projectile.distanceTraveled += moveDistance

      // Check if projectile exceeded max range → start returning
      if (projectile.distanceTraveled >= projectile.maxDistance) {
        console.log('[Server] 🎯 Projectile reached max range at', projectile.distanceTraveled.toFixed(1), 'm — returning')
        projectile.returning = true
        // Snap position to max range point
        projectile.returnX = projectile.startX + projectile.dirX * projectile.distanceTraveled
        projectile.returnY = projectile.startY
        projectile.returnZ = projectile.startZ + projectile.dirZ * projectile.distanceTraveled
        // Send triggered with no victim so client starts return visual
        const projectilePos = Transform.get(projectile.entity).position
        room.send('shellTriggered', { x: projectilePos.x, y: projectilePos.y, z: projectilePos.z, victimId: '', peak: !projectile.hitWall, firedBy: projectile.firedBy })
      } else {
        // Straight line forward
        const newX = projectile.startX + projectile.dirX * projectile.distanceTraveled
        const newZ = projectile.startZ + projectile.dirZ * projectile.distanceTraveled
        const t = Transform.getMutable(projectile.entity)
        t.position = Vector3.create(newX, projectile.startY, newZ)
        projectile.returnX = newX
        projectile.returnY = projectile.startY
        projectile.returnZ = newZ
      }
    } else {
      // ── Return flight — home in on shooter's chest height ──
      const CHEST_OFFSET = 0.8
      const shooterPos = getPlayerPosition(projectile.firedBy)
      const rawTarget = shooterPos || Vector3.create(projectile.startX, projectile.startY, projectile.startZ)
      const targetPos = Vector3.create(rawTarget.x, rawTarget.y + CHEST_OFFSET, rawTarget.z)

      const dx = targetPos.x - projectile.returnX
      const dy = targetPos.y - projectile.returnY
      const dz = targetPos.z - projectile.returnZ
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

      if (dist < PROJECTILE_HIT_RADIUS) {
        // Returned to shooter — remove and notify clients
        console.log('[Server] 🎯 Projectile returned to shooter')
        room.send('shellReturned', { firedBy: projectile.firedBy })
        removeProjectile(projectile)
        activeProjectiles.splice(i, 1)
        continue
      }

      // Move toward shooter
      const nx = dx / dist, ny = dy / dist, nz = dz / dist
      projectile.returnX += nx * moveDistance
      projectile.returnY += ny * moveDistance
      projectile.returnZ += nz * moveDistance
      const t = Transform.getMutable(projectile.entity)
      t.position = Vector3.create(projectile.returnX, projectile.returnY, projectile.returnZ)

      // Return target resolved client-side via CRDT player transforms
    }

      // NOTE: Projectile CRDT writes removed — clients use message-based visuals
    // (shellDropped/shellTriggered/shellReturned) which are instant WebSocket delivery.
    // Syncing distanceTraveled at 10Hz was contributing to CRDT buffer saturation.

    // Check player hits — any player (except the shooter on outbound, ALL players on return)
    const projectilePos = Transform.get(projectile.entity).position
    let shellConsumed = false

    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      const addr = identity.address.toLowerCase()
      // Skip the shooter — can't hit yourself with your own boomerang
      if (addr === projectile.firedBy) continue

      const playerPos = getPlayerPosition(addr)
      if (!playerPos) continue

      const dist = Vector3.distance(playerPos, projectilePos)
      if (dist < PROJECTILE_HIT_RADIUS * projectile.chargeScale) {
        console.log('[Server] 🎯 Projectile hit player', addr.slice(0, 8), projectile.returning ? '(return)' : '(outbound)')

        // Drop the flag if the victim is carrying it
        const flag = Flag.getOrNull(flagEntity)
        if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === addr) {
          console.log('[Server] 🎯 Victim was carrying flag — forcing drop!')
          handleDrop(addr)
        }

        room.send('shellTriggered', { x: projectilePos.x, y: projectilePos.y, z: projectilePos.z, victimId: addr, firedBy: projectile.firedBy })

        if (projectile.returning) {
          // On return: consumed on hit
          room.send('shellReturned', { firedBy: projectile.firedBy })
          removeProjectile(projectile)
          activeProjectiles.splice(i, 1)
          shellConsumed = true
        } else {
          // On outbound: hit triggers return, keep flying back
          projectile.returning = true
          projectile.returnX = projectilePos.x
          projectile.returnY = projectilePos.y
          projectile.returnZ = projectilePos.z
          console.log('[Server] 🎯 Projectile hit on outbound — returning to shooter')
        }
        break
      }
    }
    if (shellConsumed) continue

    // Check trap collision — projectile destroys the trap, then returns
    for (let j = activeTraps.length - 1; j >= 0; j--) {
      const trap = activeTraps[j]
      const trapPos = Transform.get(trap.entity).position
      const dist = Vector3.distance(projectilePos, trapPos)
      if (dist < PROJECTILE_HIT_RADIUS * projectile.chargeScale) {
        console.log('[Server] 🎯🪤 Projectile hit trap!', projectile.returning ? 'Both destroyed.' : 'Trap destroyed, projectile returning.')
        room.send('shellTriggered', { x: projectilePos.x, y: projectilePos.y, z: projectilePos.z, victimId: '', firedBy: projectile.firedBy })
        room.send('bananaTriggered', { x: trapPos.x, y: trapPos.y, z: trapPos.z, victimId: '' })
        removeTrap(trap)
        activeTraps.splice(j, 1)

        if (projectile.returning) {
          // On return: consumed
          room.send('shellReturned', { firedBy: projectile.firedBy })
          removeProjectile(projectile)
          activeProjectiles.splice(i, 1)
          shellConsumed = true
        } else {
          // On outbound: trap destroyed, projectile returns
          projectile.returning = true
          projectile.returnX = projectilePos.x
          projectile.returnY = projectilePos.y
          projectile.returnZ = projectilePos.z
        }
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
      lastKnownCarrierPos = Vector3.create(carrierPos.x, carrierPos.y, carrierPos.z)

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
      flushHoldTimeAccum()
      // Use last known carrier position if available, otherwise fall back to stale flagEntity Transform
      const dropPos = lastKnownCarrierPos
        ? Vector3.create(lastKnownCarrierPos.x, lastKnownCarrierPos.y + 0.5, lastKnownCarrierPos.z)
        : Transform.get(flagEntity).position
      const mutable = Flag.getMutable(flagEntity)
      mutable.state = FlagState.Dropped
      mutable.carrierPlayerId = ''
      mutable.dropAnchorX = dropPos.x
      mutable.dropAnchorY = dropPos.y
      mutable.dropAnchorZ = dropPos.z
      lastDropperId = ''  // No specific dropper — accept first non-quarantined report
      resetCarrierTracking()
      computeGravityTarget(dropPos.y)
      room.send('dropSound', { t: 0 })
      persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
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
      persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
    }
    currentAnchorY = newY
    const flagMutable = Flag.getMutable(flagEntity)
    flagMutable.dropAnchorY = newY
  }

  // Water respawn: if flag drops below water level, respawn at a random spawn point
  const WATER_RESPAWN_Y = 1.58
  if (flag.state === FlagState.Dropped && currentAnchorY <= WATER_RESPAWN_Y) {
    const spawn = getRandomSpawnPoint()
    console.log('[Server] 🌊 Flag fell in water (Y=' + currentAnchorY.toFixed(2) + ') — respawning at', spawn.x, spawn.y, spawn.z)
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
      lastDropperId = ''  // No specific dropper — accept first non-quarantined report

      resetCarrierTracking()
      computeGravityTarget(dropPos.y)

      room.send('dropSound', { t: 0 })
      persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
    }
  }
}

/**
 * Flush any accumulated hold time to the specified player.
 * Called when the carrier changes or the flag is dropped so that
 * no accumulated time is lost or credited to the wrong player.
 */
function flushHoldTimeAccum(): void {
  if (holdTimeAccum > 0 && holdTimeCarrierKey) {
    const entity = getOrCreateHoldTimeEntity(holdTimeCarrierKey)
    const mutable = PlayerFlagHoldTime.getMutable(entity)
    mutable.seconds += holdTimeAccum
    console.log('[Server] Flushed', holdTimeAccum.toFixed(2), 's hold time to', holdTimeCarrierKey.slice(0, 8), '(total:', mutable.seconds.toFixed(1), 's)')
  }
  holdTimeAccum = 0
  holdTimeCarrierKey = ''
}

function holdTimeServerSystem(dt: number): void {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag || flag.state !== FlagState.Carried || !flag.carrierPlayerId) {
    // Flag not carried — flush any remaining time to the previous carrier
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

  // Use centralized helper — safe to call even if entity already exists
  const entity = getOrCreateHoldTimeEntity(carrierKey)

  const mutable = PlayerFlagHoldTime.getMutable(entity)
  mutable.seconds += holdTimeAccum
  holdTimeAccum = 0
}

function lightningServerSystem(dt: number): void {
  const flag = Flag.getOrNull(flagEntity)
  const carried = flag && flag.state === FlagState.Carried && !!flag.carrierPlayerId

  // Handle active warning countdown
  if (lightningStrikeScheduled) {
    lightningWarningTimer += dt
    if (lightningWarningTimer >= LIGHTNING_WARNING_DURATION) {
      lightningStrikeScheduled = false
      lightningWarningTimer = 0

      // If someone is carrying the flag, they get zapped.
      // If the flag was dropped, strike the flag's position with no victim.
      const victimId = carried ? flag!.carrierPlayerId! : ''

      // Determine strike position: carrier's position if carried, flag position if dropped
      let strikePos = { x: 256, y: 5, z: 256 } // fallback center
      if (carried && victimId) {
        for (const [entity] of engine.getEntitiesWith(PlayerIdentityData)) {
          const identity = PlayerIdentityData.get(entity)
          if (identity.address.toLowerCase() === victimId.toLowerCase()) {
            const t = Transform.getOrNull(entity)
            if (t) strikePos = { x: t.position.x, y: t.position.y, z: t.position.z }
            break
          }
        }
      } else {
        // Flag is on the ground — strike the flag's position
        const flagT = Transform.getOrNull(flagEntity)
        if (flagT) strikePos = { x: flagT.position.x, y: flagT.position.y, z: flagT.position.z }
      }

      console.log('[Server] ⚡ Lightning strike at', strikePos.x.toFixed(1), strikePos.y.toFixed(1), strikePos.z.toFixed(1), 'victim:', victimId || '(none - flag only)')
      room.send('lightningStrike', { x: strikePos.x, y: strikePos.y, z: strikePos.z, victimId })

      // Drop the flag if it's still being carried
      if (carried) {
        const mutable = Flag.getMutable(flagEntity)
        mutable.state = FlagState.Dropped
        mutable.carrierPlayerId = ''
        flushHoldTimeAccum()
        persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
      }

      _lightningOriginalCarrierId = ''
    }
    return // Don't roll while a strike is pending
  }

  // No rolling if flag isn't carried
  if (!carried) {
    lightningRollTimer = 0
    return
  }

  lightningRollTimer += dt
  if (lightningRollTimer >= LIGHTNING_ROLL_INTERVAL) {
    lightningRollTimer = 0
    const score = getCarrierHoldSeconds()
    const chance = getLightningStrikeChance(score)
    if (chance > 0 && Math.random() < chance) {
      console.log(`[Server] ⚡ Lightning roll succeeded! Score: ${score.toFixed(0)}, Chance: ${(chance * 100).toFixed(1)}%`)
      lightningStrikeScheduled = true
      lightningWarningTimer = 0
      _lightningOriginalCarrierId = flag!.carrierPlayerId!
      room.send('lightningWarning', { t: 0 })
    } else if (chance > 0) {
      console.log(`[Server] ⚡ Lightning roll failed. Score: ${score.toFixed(0)}, Chance: ${(chance * 100).toFixed(1)}%`)
    }
  }
}

// currentlyConnected moved to serverState.ts

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
      
      // Load coin balance and create wallet entity
      loadPlayerCoinBalance(userKey).then(() => {
        getOrCreateWalletEntity(userKey)
      }).catch(err => console.error('[Coins] Error loading wallet for', userKey.slice(0, 8), err))

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
          totalSecondsToday: 0
        })
      }

      // Monthly visitor tracking
      const existingMonthlyVisitor = monthlyVisitorSessions.get(userKey)
      if (existingMonthlyVisitor) {
        existingMonthlyVisitor.sessionStartMs = Date.now()
        if (isRealName(playerName) || !isRealName(existingMonthlyVisitor.name)) {
          existingMonthlyVisitor.name = playerName
        }
      } else {
        monthlyVisitorSessions.set(userKey, {
          name: playerName,
          sessionStartMs: Date.now(),
          totalSecondsMonth: 0
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
        const sessionSeconds = Math.floor(sessionMs / 1000)
        visitor.totalSecondsToday += sessionSeconds
        visitor.sessionStartMs = 0 // Mark as offline

        const totalMin = Math.floor(visitor.totalSecondsToday / 60)
        console.log('[Server] Player left:', visitor.name, 'session:', sessionSeconds, 's, total today:', totalMin, 'min')
      }

      // Monthly visitor disconnect tracking
      const monthlyVisitor = monthlyVisitorSessions.get(userKey)
      if (monthlyVisitor && monthlyVisitor.sessionStartMs > 0) {
        const sessionMs = Date.now() - monthlyVisitor.sessionStartMs
        const sessionSeconds = Math.floor(sessionMs / 1000)
        monthlyVisitor.totalSecondsMonth += sessionSeconds
        monthlyVisitor.sessionStartMs = 0
      }

      // Clean up per-player maps to prevent unbounded growth
      playerBoomerangColors.delete(userKey)
      playerCoinBalances.delete(userKey)
      playerUpgradeData.delete(userKey)
      playerLifetimeWinsCache.delete(userKey)
      lastTrapDropTime.delete(userKey)
      lastProjectileFireTime.delete(userKey)
      lastOrbitTime.delete(userKey)
      lastStealTime.delete(userKey)
      deathPenaltyCooldowns.delete(userKey)

      changed = true
    }
  }

  // Immediate sync when players join or leave
  if (changed) {
    updateConcurrentTracking()
    syncVisitorAnalytics().catch(e => console.error('[Server] syncVisitorAnalytics error:', e))
    syncMonthlyVisitorAnalytics().catch(e => console.error('[Server] syncMonthlyVisitorAnalytics error:', e))
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
      // Emergency recovery: ensure flag is reset and players are respawned
      // even if something in the handler crashed
      try {
        const flag = Flag.getOrNull(flagEntity)
        if (flag && flag.state === FlagState.Carried) {
          const mutable = Flag.getMutable(flagEntity)
          mutable.state = FlagState.AtBase
          mutable.carrierPlayerId = ''
        }
        lightningRollTimer = 0
        lightningStrikeScheduled = false
        lightningWarningTimer = 0
        _lightningOriginalCarrierId = ''
        room.send('respawnPlayers', { t: 0, winnersJson: '[]' })
        console.log('[Server] ⚠️ Emergency round-end recovery executed')
      } catch (recoveryErr) {
        console.error('[Server.ERROR] Emergency recovery also failed:', recoveryErr)
      }
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

  // ══════════════════════════════════════════════════════════════════════
  // CRITICAL: All state mutations that affect holdTimeServerSystem MUST
  // happen synchronously BEFORE any `await`. During `await` gaps, the
  // engine runs systems — if the flag is still Carried, holdTimeServerSystem
  // keeps accumulating time and can write it back AFTER we reset scores.
  // ══════════════════════════════════════════════════════════════════════

  // ── 0a. Flush any in-progress hold time so final scores are accurate ──
  flushHoldTimeAccum()

  // ── 0b. Reset flag to random spawn point IMMEDIATELY (before any await) ──
  // This ensures holdTimeServerSystem sees AtBase on the very next frame
  // and stops accumulating time.
  resetGravityState()
  const spawnPoint = getRandomSpawnPoint()
  console.log('[Server] Round ended, flag respawning at random location to prevent spawn camping')
  
  const flagMutable = Flag.getMutable(flagEntity)
  flagMutable.state = FlagState.AtBase
  flagMutable.carrierPlayerId = ''
  flagMutable.baseX = spawnPoint.x
  flagMutable.baseY = spawnPoint.y
  flagMutable.baseZ = spawnPoint.z
  
  const flagT = Transform.getMutable(flagEntity)
  flagT.position = Vector3.create(spawnPoint.x, spawnPoint.y, spawnPoint.z)

  // ── 1. Determine winner(s) — read scores BEFORE resetting them ──
  let maxSeconds = 0
  const players: { userId: string; seconds: number }[] = []

  for (const [, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    if (data.seconds > 0) {
      players.push({ userId: data.playerId, seconds: data.seconds })
      if (data.seconds > maxSeconds) maxSeconds = data.seconds
    }
  }

  // ── 2. Reset ALL hold times to 0 synchronously ──
  // Iterate the ENTIRE ECS (not just holdTimeEntities map) to catch any
  // stale/orphaned entities that might show old scores on clients.
  const connectedNow = new Set<string>()
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    connectedNow.add(identity.address.toLowerCase())
  }

  const entitiesToRemove: string[] = []
  for (const [entity, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    const key = data.playerId.toLowerCase()
    if (connectedNow.has(key)) {
      PlayerFlagHoldTime.getMutable(entity).seconds = 0
    } else {
      // Disconnected — mark for removal
      entitiesToRemove.push(key)
    }
  }
  for (const userKey of entitiesToRemove) {
    const entity = holdTimeEntities.get(userKey)
    if (entity) {
      engine.removeEntity(entity)
      holdTimeEntities.delete(userKey)
      knownPlayers.delete(userKey)
    }
  }
  if (entitiesToRemove.length > 0) {
    console.log('[Server] Cleaned up', entitiesToRemove.length, 'hold-time entities for disconnected players')
  }

  // Force-clear accumulator again (holdTimeServerSystem cannot have run since
  // step 0a because we haven't hit any await yet, but be defensive)
  holdTimeAccum = 0
  holdTimeCarrierKey = ''

  // ── 3. Remove all active traps ──
  for (const trap of activeTraps) {
    removeTrap(trap)
  }
  activeTraps.length = 0
  lastTrapDropTime.clear()
  console.log('[Server] 🪤 All traps cleared for new round')

  // ── 3b. Remove all active projectiles + orbits ──
  for (const projectile of activeProjectiles) {
    removeProjectile(projectile)
  }
  activeProjectiles.length = 0
  lastProjectileFireTime.clear()
  // Clear active orbits
  for (const orbit of activeOrbits) {
    room.send('orbitEnded', { playerId: orbit.playerId })
  }
  activeOrbits.length = 0
  lastOrbitTime.clear()
  console.log('[Server] 🎯 All projectiles + orbits cleared for new round')

  // ── 3c. Clear combat cooldown maps to prevent memory growth ──
  lastStealTime.clear()

  // ── 3d. Reset lightning state ──
  lightningRollTimer = 0
  lightningStrikeScheduled = false
  lightningWarningTimer = 0
  _lightningOriginalCarrierId = ''

  // ── 3e. Respawn mushrooms ──
  spawnMushrooms()
  console.log('[Server] 🍄 Mushrooms respawned for new round')

  // ── 3f. Compute top 3 BEFORE sending respawnPlayers (avoids CRDT race) ──
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

  const winnersJson = JSON.stringify(topPlayers)

  // ── 3g. Respawn all players at spawn point immediately ──
  room.send('respawnPlayers', { t: 0, winnersJson })
  console.log('[Server] 📍 Respawning all players at spawn point')

  // ══════════════════════════════════════════════════════════════════════
  // All synchronous state mutations done. Safe to await now.
  // holdTimeServerSystem will see AtBase and not accumulate.
  // ══════════════════════════════════════════════════════════════════════

  // ── 4. Set timer: splash + winner data (CRDT backup — clients use message data) ──
  const timerMutable = CountdownTimer.getMutable(countdownEntity)
  timerMutable.roundEndTriggered = true
  timerMutable.roundEndDisplayUntilMs = now + SPLASH_DURATION_MS
  timerMutable.roundWinnerJson = winnersJson
  
  console.log('[Server] Round end splash set, displayUntil:', new Date(timerMutable.roundEndDisplayUntilMs).toISOString())

  // ── 5b. Award coins for round participation & placement ──
  await awardRoundCoins(players)

  // ── 6. Check for daily/monthly leaderboard reset ──
  await checkLeaderboardDailyReset(snapshotPendingReport)
  await checkMonthlyLeaderboardReset()

  // ── 7. Update all three leaderboards (async persistence is safe now) ──
  if (maxSeconds > 0) {
    // Daily
    const dailyEntries = parseLeaderboardJson(LeaderboardState.getOrNull(leaderboardEntity)?.json)
    incrementLeaderboardWins(dailyEntries, players, maxSeconds)
    const dailyJson = JSON.stringify(dailyEntries)
    LeaderboardState.getMutable(leaderboardEntity).json = dailyJson
    await persistLeaderboard(dailyJson)

    // All-time
    const atEntries = parseLeaderboardJson(AllTimeLeaderboardState.getOrNull(allTimeLeaderboardEntity)?.json)
    incrementLeaderboardWins(atEntries, players, maxSeconds)
    const atJson = JSON.stringify(atEntries)
    AllTimeLeaderboardState.getMutable(allTimeLeaderboardEntity).json = atJson
    await persistAllTimeLeaderboard(atJson)

    // Monthly
    const currentMonth = getCurrentMonthString()
    const mlLb = MonthlyLeaderboardState.getOrNull(monthlyLeaderboardEntity)
    const mlEntries = (mlLb?.month === currentMonth) ? parseLeaderboardJson(mlLb?.json) : []
    incrementLeaderboardWins(mlEntries, players, maxSeconds)
    const mlJson = JSON.stringify(mlEntries)
    const mlMutable = MonthlyLeaderboardState.getMutable(monthlyLeaderboardEntity)
    mlMutable.json = mlJson
    mlMutable.month = currentMonth
    await persistMonthlyLeaderboard(mlJson)
    await Storage.set('monthlyLeaderboardMonth', currentMonth)
  }

  // ── 7b. Award lifetime wins (flags) to winners ──
  if (maxSeconds > 0) {
    const winners = players.filter(p => p.seconds >= maxSeconds)
    for (const w of winners) {
      const newWins = await addPlayerLifetimeWin(w.userId)
      console.log('[LifetimeWins] Player', w.userId.slice(0, 8), 'now has', newWins, 'lifetime wins')
    }
  }

  // ── 8. Persist flag state ──
  await persistFlagState()
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
    persistPlayerNames().catch(e => console.error('[Server] persistPlayerNames error:', e))
    syncVisitorAnalytics().catch(e => console.error('[Server] syncVisitorAnalytics error:', e))
  }
}

// ── Mushroom spawning ──
function randomMushroomCandidates(): { x: number; z: number }[] {
  const candidates: { x: number; z: number }[] = []
  for (let i = 0; i < MUSHROOM_CANDIDATES; i++) {
    const angle = Math.random() * Math.PI * 2
    const r = MUSHROOM_RADIUS * Math.sqrt(Math.random())
    candidates.push({ x: MUSHROOM_CX + Math.cos(angle) * r, z: MUSHROOM_CZ + Math.sin(angle) * r })
  }
  return candidates
}

function mushroomToPayload(m: ServerMushroom): any {
  return { id: m.id, candidates: m.candidates }
}

function spawnOneMushroom(): void {
  const candidates = randomMushroomCandidates()
  const m: ServerMushroom = { id: mushroomIdCounter++, candidates, pickedUp: false }
  activeMushrooms.push(m)
  console.log('[Server] 🍄 Spawned replacement mushroom', m.id, 'with', candidates.length, 'candidates')
  room.send('mushroomPositions', { mushroomsJson: JSON.stringify([mushroomToPayload(m)]) })
}

function spawnMushrooms(): void {
  activeMushrooms.length = 0
  for (let i = 0; i < MUSHROOM_COUNT; i++) {
    const candidates = randomMushroomCandidates()
    activeMushrooms.push({
      id: mushroomIdCounter++,
      candidates,
      pickedUp: false
    })
  }
  console.log('[Server] 🍄 Spawned', MUSHROOM_COUNT, 'mushrooms')
  const positions = activeMushrooms.map(mushroomToPayload)
  room.send('mushroomPositions', { mushroomsJson: JSON.stringify(positions), fullReset: true })
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Zombie Server System ──
// ══════════════════════════════════════════════════════════════════════════════

const ZOMBIE_SPAWN_POS = Vector3.create(225, 1.25, 287) // Black cube location

interface ActiveZombie {
  entity: Entity
  syncId: number
  hp: number
  posX: number
  posY: number
  posZ: number
  spawnedAtMs: number
  lastStaggerTime: Map<string, number> // prevent rapid re-stagger per player
  lastHitMs: number // prevent multiple hits from same projectile pass
  lastCrdtSyncTime: number // throttle Zombie component CRDT writes to ~5Hz
}

const activeZombies: ActiveZombie[] = []
let zombieSpawnTimer = 10 // first spawn after 10s
let zombieRespawnCooldown = 0 // cooldown after ghost is killed
const ZOMBIE_RESPAWN_COOLDOWN = 30 // seconds before respawn after death
const ZOMBIE_STAGGER_COOLDOWN_MS = 3000 // can only stagger same player every 3s
const ZOMBIE_IDLE_ORBIT_SPEED = 0.5 // rad/s when no target

// Listen for zombie hit reports from clients
room.onMessage('zombieHit', (data, sender) => {
  // Validate: find the zombie entity, reduce HP
  for (let i = activeZombies.length - 1; i >= 0; i--) {
    const z = activeZombies[i]
    // Match by entity ID sent as zombieId (we use entity number)
    if ((z.entity as number) === data.zombieId) {
      z.hp--
      console.log('[Server] 🧟 Zombie hit! HP:', z.hp)
      if (z.hp <= 0) {
        // Kill zombie
        console.log('[Server] 🧟 Zombie killed!')
        room.send('zombieKilled', { x: z.posX, y: z.posY, z: z.posZ })
        engine.removeEntity(z.entity); recycleZombieSyncId(z.syncId)
        activeZombies.splice(i, 1)
        zombieRespawnCooldown = ZOMBIE_RESPAWN_COOLDOWN
      }
      break
    }
  }
})

function despawnAllZombies(): void {
  for (const z of activeZombies) {
    Zombie.deleteFrom(z.entity)
    engine.removeEntity(z.entity); recycleZombieSyncId(z.syncId)
  }
  activeZombies.length = 0
}

function zombieServerSystem(dt: number): void {
  const clampedDt = Math.min(dt, 0.1)
  const now = Date.now()

  // Keep world time cache fresh for night detection
  updateWorldTime()

  // ── Ghost only spawns at night ──
  if (!isNightTime()) {
    if (activeZombies.length > 0) {
      despawnAllZombies()
      console.log('[Server] ☀️ Dawn — despawning ghost')
    }
    zombieSpawnTimer = 5 // ready to spawn quickly when night falls
    return
  }

  // ── Spawn timer (single ghost, 30s respawn cooldown after death) ──
  if (zombieRespawnCooldown > 0) {
    zombieRespawnCooldown -= clampedDt
  }
  if (activeZombies.length === 0 && zombieRespawnCooldown <= 0) {
    zombieSpawnTimer -= clampedDt
    if (zombieSpawnTimer <= 0) {
      spawnZombie()
      zombieSpawnTimer = 0
    }
  }

  // ── Update each zombie ──
  for (let i = activeZombies.length - 1; i >= 0; i--) {
    const z = activeZombies[i]

    // Find nearest player
    let nearestDist = Infinity
    let nearestPos: Vector3 | null = null
    let nearestId = ''

    for (const [, identity, transform] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      const pPos = transform.position
      const dx = pPos.x - z.posX
      const dy = Math.abs(pPos.y - z.posY)
      const dz = pPos.z - z.posZ
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dy > 20) continue // ignore players too far above/below
      if (dist < nearestDist) {
        nearestDist = dist
        nearestPos = pPos
        nearestId = identity.address.toLowerCase()
      }
    }

    if (nearestPos && nearestDist < ZOMBIE_DETECT_RADIUS) {
      // Move toward player
      const speed = nearestDist < ZOMBIE_FAST_DIST ? ZOMBIE_FAST_SPEED : ZOMBIE_SPEED
      const dx = nearestPos.x - z.posX
      const dz = nearestPos.z - z.posZ
      const dist2d = Math.sqrt(dx * dx + dz * dz)
      if (dist2d > 0.1) {
        z.posX += (dx / dist2d) * speed * clampedDt
        z.posZ += (dz / dist2d) * speed * clampedDt
      }
      // Match target Y (float above ground at player level)
      z.posY += (nearestPos.y - z.posY) * 2.0 * clampedDt

      // Check contact → send ghostTouching (scare meter fills on client)
      if (nearestDist < ZOMBIE_HIT_RADIUS) {
        room.send('ghostTouching', { victimId: nearestId })
      }
    } else {
      // Idle: slow orbit around spawn point
      const elapsed = (now - z.spawnedAtMs) / 1000
      const angle = elapsed * ZOMBIE_IDLE_ORBIT_SPEED
      const orbitRadius = 3
      const targetX = ZOMBIE_SPAWN_POS.x + Math.cos(angle) * orbitRadius
      const targetZ = ZOMBIE_SPAWN_POS.z + Math.sin(angle) * orbitRadius
      z.posX += (targetX - z.posX) * 2.0 * clampedDt
      z.posZ += (targetZ - z.posZ) * 2.0 * clampedDt
      z.posY += (ZOMBIE_SPAWN_POS.y - z.posY) * 2.0 * clampedDt
    }

    // Update local Transform (used for server-side collision checks only — NOT synced)
    const t = Transform.getMutable(z.entity)
    t.position = Vector3.create(z.posX, z.posY, z.posZ)

    // Throttled CRDT write (~5Hz) — update Zombie.targetX/Y/Z for client interpolation
    const ZOMBIE_CRDT_INTERVAL_MS = 200
    if (now - z.lastCrdtSyncTime >= ZOMBIE_CRDT_INTERVAL_MS) {
      z.lastCrdtSyncTime = now
      const zm = Zombie.getMutable(z.entity)
      zm.targetX = z.posX
      zm.targetY = z.posY
      zm.targetZ = z.posZ
    }
  }

  // ── Check projectile-zombie collisions ──
  const HIT_COOLDOWN_MS = 500 // prevent same projectile hitting multiple times per pass
  for (const proj of activeProjectiles) {
    const projPos = Transform.get(proj.entity).position
    for (let i = activeZombies.length - 1; i >= 0; i--) {
      const z = activeZombies[i]
      if (now - z.lastHitMs < HIT_COOLDOWN_MS) continue
      const dx = projPos.x - z.posX
      const dy = projPos.y - z.posY
      const dz = projPos.z - z.posZ
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist < PROJECTILE_HIT_RADIUS * (proj.chargeScale || 1)) {
        z.hp--
        z.lastHitMs = now
        console.log('[Server] 🧟 Projectile hit zombie! HP:', z.hp)
        room.send('hitVfx', { x: z.posX, y: z.posY + 1, z: z.posZ })
        if (z.hp <= 0) {
          console.log('[Server] 🧟 Zombie killed by projectile!')
          room.send('zombieKilled', { x: z.posX, y: z.posY, z: z.posZ })
          engine.removeEntity(z.entity); recycleZombieSyncId(z.syncId)
          activeZombies.splice(i, 1)
          zombieRespawnCooldown = ZOMBIE_RESPAWN_COOLDOWN
        }
        // Trigger boomerang return (same as hitting a player)
        if (!proj.returning) {
          proj.returning = true
          proj.returnX = projPos.x
          proj.returnY = projPos.y
          proj.returnZ = projPos.z
          room.send('shellTriggered', { x: projPos.x, y: projPos.y, z: projPos.z, victimId: '', peak: true, firedBy: proj.firedBy })
          console.log('[Server] 🧟 Projectile rebounding off zombie')
        }
        break
      }
    }
  }
}

function spawnZombie(): void {
  const entity = engine.addEntity()
  const pos = ZOMBIE_SPAWN_POS
  Transform.create(entity, {
    position: Vector3.create(pos.x, pos.y, pos.z),
    scale: Vector3.create(1, 1, 1)
  })
  Zombie.create(entity, {
    hp: 2,
    spawnX: pos.x, spawnY: pos.y, spawnZ: pos.z,
    active: true,
    targetX: pos.x, targetY: pos.y, targetZ: pos.z,
  })
  // NOTE: Only sync Zombie component — NOT Transform.
  // Writing Transform every frame (~30 CRDT writes/s) saturates the CRDT buffer
  // and freezes all other synced components (scoreboard, flag state, hold time).
  // Clients interpolate toward Zombie.targetX/Y/Z which is updated at 5Hz.
  const zombieSyncId = getNextZombieSyncId()
  syncEntity(entity, [Zombie.componentId], zombieSyncId)

  activeZombies.push({
    entity,
    syncId: zombieSyncId,
    hp: 2,
    posX: pos.x,
    posY: pos.y,
    posZ: pos.z,
    spawnedAtMs: Date.now(),
    lastStaggerTime: new Map(),
    lastHitMs: 0,
    lastCrdtSyncTime: 0,
  })
  console.log('[Server] 🧟 Zombie spawned at', pos.x, pos.y, pos.z)
}
