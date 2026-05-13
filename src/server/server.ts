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
  SPLASH_DURATION_MS,
  MUSHROOM_CX, MUSHROOM_CZ, MUSHROOM_RADIUS, MUSHROOM_CANDIDATES,
  isRealName, getPlayerPosition,
  lastVisitorResetDay, setLastVisitorResetDay,
  lastMonthlyVisitorResetMonth, setLastMonthlyVisitorResetMonth,
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
  PROJECTILE_HIT_RADIUS,
  FLAG_BASE_POSITION, FLAG_SPAWN_POINTS, getRandomSpawnPoint, SyncIds, getTodayDateString, getCurrentMonthString
} from '../shared/components'
import { room } from '../shared/messages'
import {
  CoinState, COIN_STATE_SYNC_ID, COIN_PICKUP_RADIUS
} from '../shared/coins'
import {
  loadPlayerCoinBalance, setPlayerCoinBalance, addPlayerCoins, getOrCreateWalletEntity,
  loadPlayerUpgrades, savePlayerUpgrades, getOrCreateUpgradeEntity,
  loadPlayerLifetimeWins, addPlayerLifetimeWin, getOrCreateLifetimeWinsEntity,
  coinServerSystem, awardRoundCoins, registerEconomyHandlers
} from './economy'
import {
  handleDrop, flushHoldTimeAccum, clearHoldTimeAccum, getHoldTimeAccumFor,
  resetGravityState, getOrCreateHoldTimeEntity,
  flagServerSystem, holdTimeServerSystem, checkProximitySteal,
  registerFlagHandlers
} from './flagLogic'
import {
  activeTraps, activeProjectiles, activeOrbits,
  removeTrap, removeProjectile, clearCombatCooldowns, clearAllCombatCooldowns,
  bananaServerSystem, shellServerSystem, orbitServerSystem,
  registerCombatHandlers
} from './combat'
import {
  registerZombieHandlers, zombieServerSystem,
} from './zombieSystem'
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

// Coin state, upgrade/progression state moved to economy.ts

// Entity references moved to serverState.ts

// holdTimeAccum, holdTimeCarrierKey moved to flagLogic.ts

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
  return (PlayerFlagHoldTime.getOrNull(entity)?.seconds ?? 0) + getHoldTimeAccumFor(key)
}

// lastStealTime, holdTimeEntities, knownPlayers, playerNames moved to serverState.ts
// lastLeaderboardResetDay moved to serverState.ts

// getOrCreateHoldTimeEntity moved to flagLogic.ts

// visitorSessions, monthlyVisitorSessions, playerBoomerangColors, deathPenaltyCooldowns moved to serverState.ts
// lastVisitorResetDay, lastMonthlyVisitorResetMonth, hourlyPeakConcurrent, peakConcurrent, peakConcurrentTime moved to serverState.ts

// Trap, projectile, orbit state moved to combat.ts


// Gravity state, carrier tracking moved to flagLogic.ts

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
  registerFlagHandlers()
  registerEconomyHandlers()
  registerCombatHandlers()
  registerZombieHandlers()

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

// computeGravityTarget, resetGravityState moved to flagLogic.ts
// updatePlayerName moved to leaderboard.ts
// Coin helpers, upgrade helpers, store logic, coinServerSystem, awardRoundCoins moved to economy.ts

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
  // requestPickup, requestDrop, requestReloadRespawn moved to flagLogic.ts (registerFlagHandlers)
  // deathPenalty handler moved to economy.ts (registerEconomyHandlers)
  // requestBanana, requestShell, reportShellWallDist, reportShellGroundY, reportBananaGroundY,
  // requestOrbit, orbitHitWall, chargeBurnout, reportBoost, chargeStart, chargeStop
  // moved to combat.ts (registerCombatHandlers)
  // reportGroundY moved to flagLogic.ts (registerFlagHandlers)

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
  // Orbit, charge, boost handlers moved to combat.ts (registerCombatHandlers)
  // colorChanged handler moved to economy.ts (registerEconomyHandlers)

  // ── Updraft location request ──
  room.onMessage('requestUpdraftLocation', (_data, _context) => {
    try {
      room.send('updraftLocation', { index: updraftActiveIndex })
    } catch (err) { console.error('[Server] ❌ requestUpdraftLocation handler error:', err) }
  })

  // Admin: manually trigger Discord analytics report
  const ADMIN_ADDRESSES = ['0x1e93e534c5e26b01ed242410b43ae23dd0faa52b']
  // requestCoinPickup, requestWalletBalance moved to economy.ts (registerEconomyHandlers)

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

  // requestUpgrades, buyBoomerang, equipBoomerang moved to economy.ts (registerEconomyHandlers)
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

// handlePickup, handleDrop, handleFlagSteal, checkProximitySteal moved to flagLogic.ts
// handleTrapDrop, bananaServerSystem, handleProjectileFire, shellServerSystem,
// handleOrbitRequest, orbitServerSystem moved to combat.ts

// ── Server Systems ──

// flagServerSystem moved to flagLogic.ts

// flushHoldTimeAccum, holdTimeServerSystem moved to flagLogic.ts

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
      clearCombatCooldowns(userKey)
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
  clearHoldTimeAccum()

  // ── 3. Remove all active traps ──
  for (const trap of activeTraps) {
    removeTrap(trap)
  }
  activeTraps.length = 0
  console.log('[Server] 🪤 All traps cleared for new round')

  // ── 3b. Remove all active projectiles + orbits ──
  for (const projectile of activeProjectiles) {
    removeProjectile(projectile)
  }
  activeProjectiles.length = 0
  for (const orbit of activeOrbits) {
    room.send('orbitEnded', { playerId: orbit.playerId })
  }
  activeOrbits.length = 0
  clearAllCombatCooldowns()
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
// Zombie/ghost system moved to zombieSystem.ts
