/**
 * server.ts — Entry point for the Flag Tag server.
 * Wires up all domain modules, creates entities, registers systems and handlers.
 */

import { engine, Transform, PlayerIdentityData, type Entity } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import {
  flagEntity, setFlagEntity, countdownEntity, setCountdownEntity,
  leaderboardEntity, setLeaderboardEntity, allTimeLeaderboardEntity, setAllTimeLeaderboardEntity,
  monthlyLeaderboardEntity, setMonthlyLeaderboardEntity,
  visitorAnalyticsEntity, setVisitorAnalyticsEntity, monthlyVisitorAnalyticsEntity, setMonthlyVisitorAnalyticsEntity,
  coinStateEntity, setCoinStateEntity,
  holdTimeEntities, knownPlayers, playerNames,
  playerBoomerangColors,
  isRealName,
  lastMonthlyVisitorResetMonth, setLastMonthlyVisitorResetMonth,
  monthlyVisitorSessions,
} from './serverState'
import { persistPlayerNames, loadPlayerNames, loadVisitorData } from './persistence'
import {
  loadDiscordWebhookUrl, loadDailyReportSentDay,
  sendPendingReport, snapshotPendingReport,
  syncVisitorAnalytics, syncMonthlyVisitorAnalytics,
  visitorTrackingServerSystem
} from './analytics'
import { patchAllLeaderboardNames, checkLeaderboardDailyReset, checkMonthlyLeaderboardReset, updatePlayerName } from './leaderboard'
import { syncEntity } from '@dcl/sdk/network'
import { Storage } from '@dcl/sdk/server'
import {
  Flag, FlagState, PlayerFlagHoldTime, CountdownTimer, LeaderboardState, AllTimeLeaderboardState, MonthlyLeaderboardState, VisitorAnalytics, MonthlyVisitorAnalytics,
  FLAG_BASE_POSITION, FLAG_SPAWN_POINTS, SyncIds, getTodayDateString, getCurrentMonthString
} from '../shared/components'
import { room } from '../shared/messages'
import { CoinState, COIN_STATE_SYNC_ID } from '../shared/coins'
import { registerEconomyHandlers, coinServerSystem } from './economy'
import { flagServerSystem, holdTimeServerSystem, checkProximitySteal, registerFlagHandlers } from './flagLogic'
import { bananaServerSystem, shellServerSystem, orbitServerSystem, registerCombatHandlers } from './combat'
import { registerZombieHandlers, zombieServerSystem } from './zombieSystem'
import { registerMushroomHandlers, spawnMushrooms } from './mushroomSystem'
import { playerTrackingSystem, nameResolverServerSystem } from './playerTracking'
import { countdownServerSystem, lightningServerSystem, updraftServerSystem, registerRoundHandlers } from './roundManager'

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
  
  const initialBase = flagStartState === FlagState.AtBase ? FLAG_SPAWN_POINTS[0] : { x: flagStartPos.x, y: flagStartPos.y, z: flagStartPos.z }
  
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

  // Create countdown timer
  const now = Date.now()
  const intervalMs = 5 * 60 * 1000
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

  // Load persisted player names FIRST
  await loadPlayerNames()

  // Load persisted leaderboard
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
  let monthlyJson = patchAllLeaderboardNames(
    (savedMonthlyMonth === currentMonth && savedMonthly) ? savedMonthly : '[]',
    'monthly leaderboard'
  )

  setMonthlyLeaderboardEntity(engine.addEntity())
  MonthlyLeaderboardState.create(monthlyLeaderboardEntity, { json: monthlyJson, month: currentMonth })
  syncEntity(monthlyLeaderboardEntity, [MonthlyLeaderboardState.componentId], SyncIds.MONTHLY_LEADERBOARD)
  
  // Load report tracking state before resets
  await loadDailyReportSentDay()

  // Send any pending deferred report
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
  let reconciledCount = 0
  for (const [entity, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    const key = data.playerId.toLowerCase()
    if (!holdTimeEntities.has(key)) {
      holdTimeEntities.set(key, entity)
      knownPlayers.add(key)
      PlayerFlagHoldTime.getMutable(entity).seconds = 0
      reconciledCount++
    } else {
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
  registerMushroomHandlers()
  registerRoundHandlers()

  // Register systems
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
  engine.addSystem(safeSystem('zombieServerSystem', zombieServerSystem))
  engine.addSystem(safeSystem('coinServerSystem', coinServerSystem))

  // ── Spawn mushrooms ──
  spawnMushrooms()

  console.log('[Server] Flag Tag server ready')
}

// ── Message handlers (remaining) ──
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
}
