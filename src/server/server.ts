import { engine, Transform, PlayerIdentityData, AvatarBase, type Entity } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import { Storage } from '@dcl/sdk/server'
import {
  Sword, SwordState, PlayerSurvivalTime, InfectionState, PlayerInfected,
  CountdownTimer, LeaderboardState, AllTimeLeaderboardState, MonthlyLeaderboardState, VisitorAnalytics, MonthlyVisitorAnalytics,
  Trap, TRAP_LIFETIME_SEC, TRAP_COOLDOWN_SEC, TRAP_MAX_ACTIVE, TRAP_TRIGGER_RADIUS,
  getSurvivalTimeEntityEnumId, getInfectedEntityEnumId, getNextTrapSyncId, recycleTrapSyncId,
  SWORD_BASE_POSITION, SWORD_SPAWN_POINTS, getRandomSpawnPoint, SyncIds, getTodayDateString, getCurrentMonthString,
  INFECTION_RADIUS, SWORD_ATTACK_RADIUS, SLIME_RESPAWN_COOLDOWN_SEC, INFECTION_IMMUNITY_MS
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

// ── Infection state ──
let infectionStateEntity: Entity
/** Map of player userId → PlayerInfected entity */
const infectedEntities = new Map<string, Entity>()
/** Set of currently infected player userIds */
const infectedPlayers = new Set<string>()
/** Map of recently infected players → timestamp (for brief immunity) */
const infectionImmunityUntil = new Map<string, number>()
/** Whether infection round is active (Patient Zero has been chosen) */
let infectionRoundActive = false
/** Patient Zero userId for current round */
let patientZeroId = ''
/** Timestamp when survival time tracking started for this round */
let survivalTimeStartMs = 0

// ── Constants ──
const SWORD_PICKUP_RADIUS = 3
const SURVIVAL_TIME_SYNC_INTERVAL = 0.5  // Sync survival time every 0.5s — reduces CRDT pressure
const SPLASH_DURATION_MS = 3000
const SWORD_GRAVITY = 15          // m/s² (slightly faster than real gravity for snappy game feel)
const SWORD_MIN_Y = 1.5           // absolute minimum Y (ground plane)
const CARRIER_Y_WINDOW_SEC = 2.0 // seconds of carrier Y history to estimate ground level

// ── Coin state ──
let coinStateEntity: Entity
/** Set of coinIds currently picked up (empty spots waiting for random respawn) */
const coinCooldowns = new Set<string>()
/** Timer tracking seconds until next random coin respawn */
let coinRespawnTimer = 0
/** Map of wallet address → coin balance (in-memory cache, persisted to Storage) */
const playerCoinBalances = new Map<string, number>()
/** Map of wallet address → wallet entity */
const walletEntities = new Map<string, Entity>()

// ── Upgrade / progression state ──
/** Map of wallet address → upgrade data (in-memory cache, persisted to Storage) */
const playerUpgradeData = new Map<string, UpgradeData>()
/** Map of wallet address → upgrade entity */
const upgradeEntities = new Map<string, Entity>()
/** Map of wallet address → lifetime wins (in-memory cache, persisted to Storage) */
const playerLifetimeWinsCache = new Map<string, number>()
/** Map of wallet address → lifetime wins entity */
const lifetimeWinsEntities = new Map<string, Entity>()

// ── Server state ──
let swordEntity: Entity
let countdownEntity: Entity
let leaderboardEntity: Entity
let allTimeLeaderboardEntity: Entity
let monthlyLeaderboardEntity: Entity
let visitorAnalyticsEntity: Entity
let monthlyVisitorAnalyticsEntity: Entity

// Survival time accumulator (for all humans — accumulated per-tick, flushed periodically)
let survivalTimeAccumTimer = 0

const survivalTimeEntities = new Map<string, Entity>()
const knownPlayers = new Set<string>()
const playerNames = new Map<string, string>()
let lastLeaderboardResetDay = ''

/**
 * Single entry point for creating/retrieving a PlayerSurvivalTime entity.
 */
function getOrCreateSurvivalTimeEntity(userKey: string): Entity {
  const key = userKey.toLowerCase()
  let entity = survivalTimeEntities.get(key)
  if (entity) return entity

  entity = engine.addEntity()
  PlayerSurvivalTime.create(entity, { playerId: key, seconds: 0 })
  syncEntity(entity, [PlayerSurvivalTime.componentId], getSurvivalTimeEntityEnumId(key))
  survivalTimeEntities.set(key, entity)
  knownPlayers.add(key)
  console.log('[Server] Created survival-time entity for', key.slice(0, 8))
  return entity
}

/**
 * Single entry point for creating/retrieving a PlayerInfected entity.
 */
function getOrCreateInfectedEntity(userKey: string): Entity {
  const key = userKey.toLowerCase()
  let entity = infectedEntities.get(key)
  if (entity) return entity

  entity = engine.addEntity()
  PlayerInfected.create(entity, { playerId: key, isInfected: false, infectedAtMs: 0, respawnCooldownUntilMs: 0 })
  syncEntity(entity, [PlayerInfected.componentId], getInfectedEntityEnumId(key))
  infectedEntities.set(key, entity)
  console.log('[Server] Created infected entity for', key.slice(0, 8))
  return entity
}

// ── Visitor tracking ──
const visitorSessions = new Map<string, { name: string; sessionStartMs: number; totalMinutesToday: number }>()
const monthlyVisitorSessions = new Map<string, { name: string; sessionStartMs: number; totalMinutesMonth: number }>()
const playerBoomerangColors = new Map<string, string>() // playerId -> color ('r','y','b','g')
let lastVisitorResetDay = ''
let lastMonthlyVisitorResetMonth = ''

// ── Concurrent user tracking (hourly peaks) ──
// 24 entries, index = UTC hour. Each stores the max concurrent users seen that hour.
let hourlyPeakConcurrent: number[] = new Array(24).fill(0)
let peakConcurrent = 0
let peakConcurrentTime = '' // HH:MM UTC when peak occurred

function updateConcurrentTracking(): void {
  const onlineCount = Array.from(visitorSessions.values()).filter(v => v.sessionStartMs > 0).length
  const now = new Date()
  const hour = now.getUTCHours()
  if (onlineCount > hourlyPeakConcurrent[hour]) {
    hourlyPeakConcurrent[hour] = onlineCount
  }
  if (onlineCount > peakConcurrent) {
    peakConcurrent = onlineCount
    peakConcurrentTime = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`
  }
}

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



// Gravity state for dropped sword
let swordFalling = false
let swordFallVelocity = 0
let swordGravityTargetY = SWORD_MIN_Y
const carrierYSamples: { y: number; time: number }[] = []
let lastDropperId = ''  // Who dropped the sword — only accept reportGroundY from them

// Carrier staleness detection — force-drop if carrier position is unavailable
const CARRIER_NO_POSITION_TIMEOUT_MS = 5000   // No position data → likely disconnected
let lastCarrierPositionMs = 0          // Last time we got a valid position from carrier

let lastKnownCarrierPos: Vector3 | null = null  // Best-effort position for force-drops when getPlayerPosition is null

function resetCarrierTracking(): void {
  lastCarrierPositionMs = 0
  carrierYSamples.length = 0
  lastKnownCarrierPos = null
}

function isRealName(name: string): boolean {
  return name.length > 0 && !name.startsWith('0x')
}

// ── Persistence helpers ──
async function persistSwordState(): Promise<void> {
  const sword = Sword.getOrNull(swordEntity)
  if (!sword) return
  const pos = Transform.get(swordEntity).position
  await Storage.set('swordState', JSON.stringify({
    state: sword.state,
    x: pos.x, y: pos.y, z: pos.z,
    carrierPlayerId: sword.carrierPlayerId,
    dropAnchorX: sword.dropAnchorX,
    dropAnchorY: sword.dropAnchorY,
    dropAnchorZ: sword.dropAnchorZ
  }))
}

async function persistLeaderboard(json: string): Promise<void> {
  await Storage.set('leaderboard', json)
}

async function persistAllTimeLeaderboard(json: string): Promise<void> {
  await Storage.set('allTimeLeaderboard', json)
}

async function persistMonthlyLeaderboard(json: string): Promise<void> {
  await Storage.set('monthlyLeaderboard', json)
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
  await Storage.set('concurrentData', JSON.stringify({
    hourlyPeak: hourlyPeakConcurrent,
    peak: peakConcurrent,
    peakTime: peakConcurrentTime
  }))
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
  
  console.log('[Server] Storage.get visitorData:', savedData ? `${savedData.length} chars` : 'null')
  console.log('[Server] Storage.get lastVisitorResetDay:', savedResetDay || 'null')

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
        // Restore concurrent tracking data
        try {
          const savedConcurrent = await Storage.get<string>('concurrentData')
          if (savedConcurrent) {
            const cd = JSON.parse(savedConcurrent)
            if (cd.hourlyPeak && cd.hourlyPeak.length === 24) hourlyPeakConcurrent = cd.hourlyPeak
            if (cd.peak != null) peakConcurrent = cd.peak
            if (cd.peakTime) peakConcurrentTime = cd.peakTime
            console.log('[Server] Restored concurrent tracking data, peak:', peakConcurrent, 'at', peakConcurrentTime)
          }
        } catch { /* ignore */ }
      } else {
        console.log('[Server] Visitor data was from', lastVisitorResetDay, 'but today is', currentDay, '- clearing for new day (report handled via pendingReport snapshot)')
        // Clear for the new day — the pending report snapshot was already saved during leaderboard reset
        visitorSessions.clear()
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
    
    // Snapshot leaderboard wins into pendingReport before clearing
    const lb = LeaderboardState.getOrNull(leaderboardEntity)
    const leaderboardJson = (lb && lb.json) ? lb.json : '[]'
    await snapshotPendingReport(leaderboardJson)
    
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

// Check and perform monthly leaderboard reset at the start of each month (UTC)
async function checkMonthlyLeaderboardReset(): Promise<void> {
  const currentMonth = getCurrentMonthString()
  const mlLb = MonthlyLeaderboardState.getOrNull(monthlyLeaderboardEntity)
  if (mlLb && mlLb.month && mlLb.month !== currentMonth) {
    console.log('[Server] Monthly leaderboard reset for new month:', currentMonth, '(was:', mlLb.month, ')')
    const mlMutable = MonthlyLeaderboardState.getMutable(monthlyLeaderboardEntity)
    mlMutable.json = '[]'
    mlMutable.month = currentMonth
    await persistMonthlyLeaderboard('[]')
    await Storage.set('monthlyLeaderboardMonth', currentMonth)
    console.log('[Server] Monthly leaderboard reset completed')
  }
}

// ── Pending report snapshot (deferred Discord report) ──
// Snapshots daily data before reset so the report can be sent on next server startup
// even if no one was online at report time.

/** Build the daily analytics report object (shared by snapshot + live send). */
function buildDailyReport(leaderboardJson: string): any {
  const now = Date.now()
  const winsMap = new Map<string, number>()
  try {
    const entries = JSON.parse(leaderboardJson) as Array<{ userId: string; roundsWon: number }>
    for (const e of entries) winsMap.set(e.userId.toLowerCase(), e.roundsWon)
  } catch { /* ignore */ }

  const users = Array.from(visitorSessions.entries()).map(([userId, data]) => {
    let totalSeconds = data.totalMinutesToday * 60
    if (data.sessionStartMs > 0) {
      totalSeconds += Math.floor((now - data.sessionStartMs) / 1000)
    }
    return {
      address: userId,
      name: data.name || userId.slice(0, 8),
      time_seconds: totalSeconds,
      flags: winsMap.get(userId) || 0
    }
  }).sort((a, b) => b.time_seconds - a.time_seconds)

  const totalSeconds = users.reduce((sum, u) => sum + u.time_seconds, 0)
  return {
    scene: 'flagtag.dcl.eth',
    date: lastVisitorResetDay,
    unique_users: users.length,
    playtime: `${Math.floor(totalSeconds / 60)} minutes`,
    total_time_seconds: totalSeconds,
    peak_concurrent: { count: peakConcurrent, time: peakConcurrentTime },
    hourly_peak: hourlyPeakConcurrent.map((count, hour) => `${hour}:00 - ${count}`),
    users
  }
}

async function snapshotPendingReport(leaderboardJson: string): Promise<void> {
  try {
    // Don't overwrite an existing pending report that hasn't been sent yet
    const existing = await Storage.get<string>('pendingReport')
    if (existing) {
      console.log('[Server] Pending report already exists, skipping snapshot')
      return
    }

    // If report was already sent for this day (via pre-midnight), no need to snapshot
    if (dailyReportSentForDay === lastVisitorResetDay) {
      console.log('[Server] Report already sent for', lastVisitorResetDay, '- skipping snapshot')
      return
    }

    const report = buildDailyReport(leaderboardJson)
    await Storage.set('pendingReport', JSON.stringify(report))
    console.log('[Server] 📸 Snapshot saved for deferred report:', lastVisitorResetDay, `(${report.users.length} users)`)
  } catch (err) {
    console.error('[Server] Failed to snapshot pending report:', err)
  }
}

async function sendPendingReport(): Promise<void> {
  try {
    const { getRealm } = await import('~system/Runtime')
    const realm = await getRealm({})
    if (realm.realmInfo?.isPreview) return

    const pendingJson = await Storage.get<string>('pendingReport')
    if (!pendingJson) return

    const report = JSON.parse(pendingJson)
    console.log('[Server] 📬 Found pending report for', report.date, '- sending now')

    // Build summary text
    const summaryLines = [
      `📊 **Flag Tag Daily Report** — ${report.date} *(deferred)*`,
      `👥 **${report.unique_users}** unique users | ⏱️ **${report.playtime}** total playtime`,
      `📈 Peak concurrent: **${report.peak_concurrent.count}** at ${report.peak_concurrent.time} UTC`,
      `See attached JSON for full user details (addresses, names, playtime, flags).`
    ]
    const summaryText = summaryLines.join('\n')
    const fullJson = JSON.stringify(report, null, 2)
    const fileName = `flagtag-report-${report.date}.json`

    const boundary = '----DCLWebhookBoundary' + Date.now()
    const multipartBody = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="payload_json"`,
      `Content-Type: application/json`,
      ``,
      JSON.stringify({ content: summaryText }),
      `--${boundary}`,
      `Content-Disposition: form-data; name="files[0]"; filename="${fileName}"`,
      `Content-Type: application/json`,
      ``,
      fullJson,
      `--${boundary}--`
    ].join('\r\n')

    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: multipartBody
    })

    if (res.status >= 200 && res.status < 300) {
      console.log('[Server] ✅ Deferred report sent successfully for', report.date)
      await Storage.delete('pendingReport')
      // Mark as sent so we don't re-snapshot
      dailyReportSentForDay = report.date
      await Storage.set('dailyReportSentForDay', report.date)
    } else {
      console.error('[Server] ❌ Deferred report webhook failed:', res.status)
    }
  } catch (err) {
    console.error('[Server] Failed to send pending report:', err)
  }
}

// ── Discord webhook for daily analytics ──
const DISCORD_WEBHOOK_URL = 'https://discordapp.com/api/webhooks/1490808436097679540/wEwupNTGN90YCZ46iPHSt_YEm6SW6xS8x4Ybw4Ls1JVfQzgVXkeJ7VHWl67F2tS8Fug2'

async function sendDailyAnalyticsToDiscord(): Promise<void> {
  try {
    // Skip webhook in local preview
    const { getRealm } = await import('~system/Runtime')
    const realm = await getRealm({})
    if (realm.realmInfo?.isPreview) {
      console.log('[Server] Skipping Discord webhook — running in preview mode')
      return
    }

    console.log('[Server] Discord report: visitorSessions.size =', visitorSessions.size)

    const lb = LeaderboardState.getOrNull(leaderboardEntity)
    const report = buildDailyReport(lb?.json || '[]')
    const { users } = report

    // Build a short summary for the Discord message text
    const summaryLines = [
      `📊 **Flag Tag Daily Report** — ${report.date}`,
      `👥 **${report.unique_users}** unique users | ⏱️ **${report.playtime}** total playtime`,
      `📈 Peak concurrent: **${report.peak_concurrent.count}** at ${report.peak_concurrent.time} UTC`,
      `See attached JSON for full user details (addresses, names, playtime, flags).`
    ]
    const summaryText = summaryLines.join('\n')

    // Full report JSON as file attachment (no truncation, full addresses)
    const fullJson = JSON.stringify(report, null, 2)
    const fileName = `flagtag-report-${report.date}.json`

    // Build multipart/form-data manually (FormData not available in DCL runtime)
    const boundary = '----DCLWebhookBoundary' + Date.now()
    const multipartBody = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="payload_json"`,
      `Content-Type: application/json`,
      ``,
      JSON.stringify({ content: summaryText }),
      `--${boundary}`,
      `Content-Disposition: form-data; name="files[0]"; filename="${fileName}"`,
      `Content-Type: application/json`,
      ``,
      fullJson,
      `--${boundary}--`
    ].join('\r\n')

    // Send with retry logic
    console.log(`[Server] Discord webhook: sending report with attachment (${users.length} users, ${fullJson.length} bytes)`)
    let success = false
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      if (attempt > 0) {
        console.log(`[Server] Discord webhook retry ${attempt}`)
        await new Promise(resolve => setTimeout(() => resolve(undefined), 3000))
      }
      try {
        const res = await fetch(DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body: multipartBody
        })
        console.log(`[Server] Discord webhook response:`, res.status)
        if (res.status === 429) {
          const body = await res.text()
          console.log('[Server] Discord rate limited:', body)
          await new Promise(resolve => setTimeout(() => resolve(undefined), 5000))
          continue
        }
        if (!res.ok) {
          const text = await res.text()
          console.error('[Server] Discord webhook error body:', text)
          // If multipart fails (e.g. runtime doesn't support it), fall back to text-only
          if (attempt === 2) {
            console.log('[Server] Multipart failed after retries, falling back to text-only messages')
            await sendDiscordFallbackText(summaryText, users)
          }
        } else {
          success = true
        }
      } catch (fetchErr) {
        console.error('[Server] Discord webhook fetch error:', fetchErr)
        if (attempt === 2) {
          console.log('[Server] Multipart failed after retries, falling back to text-only messages')
          await sendDiscordFallbackText(summaryText, users)
        }
      }
    }
  } catch (err) {
    console.error('[Server] Failed to send Discord webhook:', err)
  }
}

// ── Fallback: send report as chunked text messages if multipart fails ──
async function sendDiscordFallbackText(summary: string, users: Array<{ address: string; name: string; time_seconds: number; flags: number }>): Promise<void> {
  try {
    // Send summary first
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: summary + '\n⚠️ _File attachment failed — sending as text._' })
    })

    // Build compact user lines and chunk them under 1900 chars
    const lines = users.map(u => {
      const mins = Math.floor(u.time_seconds / 60)
      return `\`${u.name}\` ${u.address.slice(0, 10)}… ${mins}m ${u.flags}🚩`
    })

    let chunk = '```\n'
    for (const line of lines) {
      if (chunk.length + line.length + 5 > 1900) {
        chunk += '```'
        await fetch(DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: chunk })
        })
        await new Promise(resolve => setTimeout(() => resolve(undefined), 1000))
        chunk = '```\n'
      }
      chunk += line + '\n'
    }
    if (chunk.length > 4) {
      chunk += '```'
      await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: chunk })
      })
    }
    console.log('[Server] ✅ Fallback text report sent')
  } catch (err) {
    console.error('[Server] ❌ Fallback text report failed:', err)
  }
}

// ── Pre-midnight Discord report ──
// Send the daily report once at 23:55 UTC so all data is intact before midnight reset.
// Persisted to Storage so server restarts don't re-trigger.
// Only fires on the deployed world (requires ENABLE_DISCORD_REPORTS=true EnvVar).
let dailyReportSentForDay = ''


async function loadDailyReportSentDay(): Promise<void> {
  try {
    const saved = await Storage.get<string>('dailyReportSentForDay')
    if (saved) {
      dailyReportSentForDay = saved
      console.log('[Server] Loaded dailyReportSentForDay:', saved)
    }
  } catch (err) {
    console.error('[Server] Failed to load dailyReportSentForDay:', err)
  }
}

async function checkPreMidnightReport(): Promise<void> {
  const now = new Date()
  const currentDay = now.toISOString().slice(0, 10)
  
  // Already sent today's report
  if (dailyReportSentForDay === currentDay) return
  
  // Send during the last hour of the UTC day (23:00–23:59)
  const hour = now.getUTCHours()
  if (hour === 23) {
    console.log('[Server] 📊 Sending pre-midnight daily analytics report for', currentDay)
    dailyReportSentForDay = currentDay
    await Storage.set('dailyReportSentForDay', currentDay)
    await sendDailyAnalyticsToDiscord()
  }
}

// Check and perform daily visitor reset at 12:00 AM UTC (midnight)
async function checkVisitorDailyReset(): Promise<boolean> {
  const currentDay = getTodayDateString()
  
  if (lastVisitorResetDay !== currentDay) {
    console.log('[Server] Daily visitor reset at midnight UTC for new day:', currentDay)
    
    // Snapshot and send report if the pre-midnight report didn't fire
    if (dailyReportSentForDay !== lastVisitorResetDay) {
      console.log('[Server] Pre-midnight report was missed, snapshotting and sending before reset')
      // Snapshot with current leaderboard data (still available since this runs before leaderboard reset)
      const lb = LeaderboardState.getOrNull(leaderboardEntity)
      const leaderboardJson = (lb && lb.json) ? lb.json : '[]'
      await snapshotPendingReport(leaderboardJson)
      dailyReportSentForDay = lastVisitorResetDay
      await Storage.set('dailyReportSentForDay', lastVisitorResetDay)
      await sendPendingReport()
    }
    
    lastVisitorResetDay = currentDay
    
    // Clear visitor data for new day
    visitorSessions.clear()
    hourlyPeakConcurrent = new Array(24).fill(0)
    peakConcurrent = 0
    peakConcurrentTime = ''
    
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
    
    // Always prefer the authoritative playerNames directory over the session name
    const bestName = (playerNames.has(userId) && isRealName(playerNames.get(userId)!))
      ? playerNames.get(userId)!
      : data.name

    return {
      userId,
      name: bestName,
      isOnline,
      totalSeconds
    }
  })
  .sort((a, b) => {
    // Online first, then by time
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1
    return b.totalSeconds - a.totalSeconds
  })
  .slice(0, 100) // Limit synced display data — >100 can exceed CRDT string size limits
  
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

async function syncMonthlyVisitorAnalytics(): Promise<void> {
  const currentMonth = getCurrentMonthString()
  const now = Date.now()
  const onlineCount = Array.from(monthlyVisitorSessions.values()).filter(v => v.sessionStartMs > 0).length

  const visitorData = Array.from(monthlyVisitorSessions.entries()).map(([userId, data]) => {
    const isOnline = data.sessionStartMs > 0
    let totalSeconds = data.totalMinutesMonth * 60
    if (isOnline) {
      const sessionMs = now - data.sessionStartMs
      totalSeconds += Math.floor(sessionMs / 1000)
    }
    const bestName = (playerNames.has(userId) && isRealName(playerNames.get(userId)!))
      ? playerNames.get(userId)!
      : data.name
    return { userId, name: bestName, isOnline, totalSeconds }
  })
  .sort((a, b) => {
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1
    return b.totalSeconds - a.totalSeconds
  })
  .slice(0, 100) // Limit synced display data — >100 can exceed CRDT string size limits

  const visitorDataJson = JSON.stringify(visitorData)
  const mutable = MonthlyVisitorAnalytics.getMutable(monthlyVisitorAnalyticsEntity)
  mutable.month = currentMonth
  mutable.visitorDataJson = visitorDataJson
  mutable.onlineCount = onlineCount
  mutable.totalUniqueVisitors = monthlyVisitorSessions.size

  await Storage.set('monthlyVisitorData', visitorDataJson)
  await Storage.set('monthlyVisitorResetMonth', currentMonth)
}

async function checkMonthlyVisitorReset(): Promise<void> {
  const currentMonth = getCurrentMonthString()
  if (lastMonthlyVisitorResetMonth !== '' && lastMonthlyVisitorResetMonth !== currentMonth) {
    console.log('[Server] Monthly visitor reset for new month:', currentMonth)
    monthlyVisitorSessions.clear()
    lastMonthlyVisitorResetMonth = currentMonth
    await syncMonthlyVisitorAnalytics()
    console.log('[Server] Monthly visitor data reset completed')
  }
}

// ── Setup ──

export async function setupServer(): Promise<void> {
  console.log('[Server] Starting Contagion server...')

  // Load persisted sword state (with error handling)
  let savedSword: string | null = null
  try {
    savedSword = await Storage.get<string>('swordState')
  } catch (err) {
    console.error('[Server] Failed to load sword state from storage:', err)
  }
  
  let swordStartState = SwordState.AtBase
  let swordStartPos = Vector3.create(SWORD_BASE_POSITION.x, SWORD_BASE_POSITION.y, SWORD_BASE_POSITION.z)
  let dropAnchor = { x: 0, y: 0, z: 0 }

  if (savedSword) {
    try {
      const data = JSON.parse(savedSword)
      if (data.state === SwordState.Dropped) {
        swordStartState = SwordState.Dropped
        swordStartPos = Vector3.create(data.x, data.y, data.z)
        dropAnchor = { x: data.dropAnchorX || data.x, y: data.dropAnchorY || data.y, z: data.dropAnchorZ || data.z }
      }
      if (data.state === SwordState.Carried) {
        swordStartState = SwordState.Dropped
        swordStartPos = Vector3.create(data.x, data.y, data.z)
        dropAnchor = { x: data.x, y: data.y, z: data.z }
      }
    } catch { /* invalid data, use defaults */ }
  }

  // Create sword entity
  swordEntity = engine.addEntity()
  Transform.create(swordEntity, {
    position: swordStartPos,
    rotation: Quaternion.fromEulerDegrees(0, 0, 0),
    scale: Vector3.create(1, 1, 1)
  })
  
  const initialBase = swordStartState === SwordState.AtBase ? SWORD_SPAWN_POINTS[0] : { x: swordStartPos.x, y: swordStartPos.y, z: swordStartPos.z }
  
  if (swordStartState === SwordState.AtBase) {
    dropAnchor = { x: initialBase.x, y: initialBase.y, z: initialBase.z }
  }
  
  Sword.create(swordEntity, {
    state: swordStartState,
    carrierPlayerId: '',
    baseX: initialBase.x, baseY: initialBase.y, baseZ: initialBase.z,
    dropAnchorX: dropAnchor.x, dropAnchorY: dropAnchor.y, dropAnchorZ: dropAnchor.z
  })
  syncEntity(swordEntity, [Transform.componentId, Sword.componentId], SyncIds.SWORD)

  // Create infection state entity
  infectionStateEntity = engine.addEntity()
  InfectionState.create(infectionStateEntity, {
    patientZeroId: '',
    infectedPlayersJson: '[]',
    humansRemaining: 0,
    roundActive: false,
  })
  syncEntity(infectionStateEntity, [InfectionState.componentId], SyncIds.INFECTION_STATE)

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
  let leaderboardJson = patchAllLeaderboardNames(savedLeaderboard || '[]', 'leaderboard')

  leaderboardEntity = engine.addEntity()
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

  allTimeLeaderboardEntity = engine.addEntity()
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

  monthlyLeaderboardEntity = engine.addEntity()
  MonthlyLeaderboardState.create(monthlyLeaderboardEntity, { json: monthlyJson, month: currentMonth })
  syncEntity(monthlyLeaderboardEntity, [MonthlyLeaderboardState.componentId], SyncIds.MONTHLY_LEADERBOARD)
  
  // Load report tracking state before resets (needed by snapshot logic)
  await loadDailyReportSentDay()

  // Send any pending deferred report from a previous day before resetting
  await sendPendingReport()

  // Check for daily/monthly reset on server startup
  await checkLeaderboardDailyReset()
  await checkMonthlyLeaderboardReset()

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
  lastMonthlyVisitorResetMonth = savedMonthlyVisitorMonth || currentMonthForVisitors

  // Restore monthly visitor data if same month
  if (savedMonthlyVisitorData && lastMonthlyVisitorResetMonth === currentMonthForVisitors) {
    try {
      const records = JSON.parse(savedMonthlyVisitorData)
      for (const record of records) {
        const minutes = record.totalSeconds != null ? Math.floor(record.totalSeconds / 60) : (record.totalMinutes || 0)
        const recordKey = (record.userId || '').toLowerCase()
        const bestName = (playerNames.has(recordKey) && isRealName(playerNames.get(recordKey)!))
          ? playerNames.get(recordKey)!
          : record.name
        monthlyVisitorSessions.set(recordKey, {
          name: bestName,
          sessionStartMs: 0,
          totalMinutesMonth: minutes
        })
      }
      console.log('[Server] Restored monthly visitor data for', currentMonthForVisitors, '- loaded', records.length, 'visitors')
    } catch (e) {
      console.error('[Server] Failed to parse monthly visitor data:', e)
    }
  } else if (lastMonthlyVisitorResetMonth !== currentMonthForVisitors) {
    console.log('[Server] Monthly visitor data was from', lastMonthlyVisitorResetMonth, 'but current month is', currentMonthForVisitors, '- starting fresh')
    lastMonthlyVisitorResetMonth = currentMonthForVisitors
  }

  monthlyVisitorAnalyticsEntity = engine.addEntity()
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
  for (const [entity, data] of engine.getEntitiesWith(PlayerSurvivalTime)) {
    const key = data.playerId.toLowerCase()
    if (!survivalTimeEntities.has(key)) {
      survivalTimeEntities.set(key, entity)
      knownPlayers.add(key)
      PlayerSurvivalTime.getMutable(entity).seconds = 0
      reconciledCount++
    } else {
      engine.removeEntity(entity)
      console.log('[Server] Removed duplicate survival-time entity for', key.slice(0, 8))
    }
  }
  if (reconciledCount > 0) {
    console.log('[Server] Reconciled', reconciledCount, 'stale survival-time entities from previous server lifetime')
  }
  // Reconcile stale PlayerInfected entities
  for (const [entity, data] of engine.getEntitiesWith(PlayerInfected)) {
    const key = data.playerId.toLowerCase()
    if (!infectedEntities.has(key)) {
      infectedEntities.set(key, entity)
      // Reset infection state on server restart
      const m = PlayerInfected.getMutable(entity)
      m.isInfected = false
      m.infectedAtMs = 0
      m.respawnCooldownUntilMs = 0
    } else {
      engine.removeEntity(entity)
    }
  }

  // ── Initialize coin state entity ──
  coinStateEntity = engine.addEntity()
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
  engine.addSystem(safeSystem('swordServerSystem', swordServerSystem))
  engine.addSystem(safeSystem('survivalTimeServerSystem', survivalTimeServerSystem))
  engine.addSystem(safeSystem('infectionServerSystem', infectionServerSystem))
  engine.addSystem(safeSystem('playerTrackingSystem', playerTrackingSystem))
  engine.addSystem(safeSystem('countdownServerSystem', countdownServerSystem))
  engine.addSystem(safeSystem('visitorTrackingServerSystem', visitorTrackingServerSystem))
  engine.addSystem(safeSystem('nameResolverServerSystem', nameResolverServerSystem))
  engine.addSystem(safeSystem('bananaServerSystem', bananaServerSystem))
  engine.addSystem(safeSystem('updraftServerSystem', updraftServerSystem))
  engine.addSystem(safeSystem('coinServerSystem', coinServerSystem))

  // Auto-start infection round once 2+ players are connected (checked each frame)
  let infectionAutoStarted = false
  engine.addSystem(function autoStartInfection() {
    if (infectionAutoStarted) return
    if (infectionRoundActive) { infectionAutoStarted = true; return }
    let count = 0
    for (const [,] of engine.getEntitiesWith(PlayerIdentityData)) { count++ }
    if (count >= 2) {
      infectionAutoStarted = true
      startInfectionRound()
      console.log('[Server] 🧟 Auto-started infection round (2+ players connected)')
    }
  })

  console.log('[Server] Contagion server ready')
}

// ── Helper: find player position by wallet address (case-insensitive) ──
function getPlayerPosition(address: string): Vector3 | null {
  const needle = address.toLowerCase()
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address.toLowerCase() === needle) return Transform.get(entity).position
  }
  return null
}

// ── Gravity helpers ──

/**
 * Compute where the sword should land based on the carrier's recent ground-level Y.
 */
function computeGravityTarget(dropY: number): void {
  let minY = Infinity
  for (const s of carrierYSamples) {
    if (s.y < minY) minY = s.y
  }
  // If we have history, use the lowest recent Y + small offset; otherwise assume near drop point
  const groundEstimate = minY === Infinity ? dropY - 0.5 : minY
  swordGravityTargetY = Math.max(SWORD_MIN_Y, groundEstimate + 0.5)
  carrierYSamples.length = 0

  if (dropY > swordGravityTargetY + 0.1) {
    swordFalling = true
    swordFallVelocity = 0
  } else {
    swordFalling = false
  }
}

function resetGravityState(): void {
  swordFalling = false
  swordFallVelocity = 0
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
  
  // Update monthly visitor session
  const monthlyVisitor = monthlyVisitorSessions.get(key)
  if (monthlyVisitor) {
    monthlyVisitor.name = name
  }
  
  // Update all three leaderboards
  const leaderboards: Array<{
    getState: () => { json?: string } | null
    getMutable: () => { json: string }
    persist: (json: string) => Promise<void>
  }> = [
    { getState: () => LeaderboardState.getOrNull(leaderboardEntity), getMutable: () => LeaderboardState.getMutable(leaderboardEntity), persist: persistLeaderboard },
    { getState: () => AllTimeLeaderboardState.getOrNull(allTimeLeaderboardEntity), getMutable: () => AllTimeLeaderboardState.getMutable(allTimeLeaderboardEntity), persist: persistAllTimeLeaderboard },
    { getState: () => MonthlyLeaderboardState.getOrNull(monthlyLeaderboardEntity), getMutable: () => MonthlyLeaderboardState.getMutable(monthlyLeaderboardEntity), persist: persistMonthlyLeaderboard },
  ]
  for (const lb of leaderboards) {
    const state = lb.getState()
    if (!state?.json) continue
    const entries = parseLeaderboardJson(state.json)
    if (patchLeaderboardNames(entries, userId, name)) {
      const json = JSON.stringify(entries)
      lb.getMutable().json = json
      lb.persist(json).catch(e => console.error('[Server] persist leaderboard error:', e))
    }
  }
  
  return true
}

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
  // room.send('playerColorChanged', { playerId: key, color: boomerangColor })
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
          // room.send('playerColorChanged', { playerId, color })
        }
      }
    } catch (err) { console.error('[Server] ❌ registerName handler error:', err) }
  })
  room.onMessage('requestSwordPickup', (_data, context) => {
    try {
      if (!context) return
      handleSwordPickup(context.from.toLowerCase())
    } catch (err) { console.error('[Server] ❌ requestSwordPickup handler error:', err) }
  })
  room.onMessage('requestSwordDrop', (_data, context) => {
    try {
      if (!context) return
      handleSwordDrop(context.from.toLowerCase())
    } catch (err) { console.error('[Server] ❌ requestSwordDrop handler error:', err) }
  })
  room.onMessage('requestSwordAttack', (_data, context) => {
    try {
      if (!context) return
      handleSwordAttack(context.from.toLowerCase())
    } catch (err) { console.error('[Server] ❌ requestSwordAttack handler error:', err) }
  })

  // Death penalty — deduct coins on death (drowning, lightning, ghost)
  const DEATH_PENALTY_COINS = 10
  const deathPenaltyCooldowns = new Map<string, number>() // prevent spam
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
  // Reload-respawn: player reloaded scene while carrying sword → respawn at random point
  room.onMessage('requestReloadRespawn', (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const sword = Sword.getOrNull(swordEntity)
      if (!sword || sword.state !== SwordState.Carried || sword.carrierPlayerId !== from) return
      const spawn = getRandomSpawnPoint()
      const mutable = Sword.getMutable(swordEntity)
      mutable.state = SwordState.AtBase
      mutable.carrierPlayerId = ''
      mutable.baseX = spawn.x
      mutable.baseY = spawn.y
      mutable.baseZ = spawn.z
      const t = Transform.getMutable(swordEntity)
      t.position = Vector3.create(spawn.x, spawn.y, spawn.z)
      persistSwordState().catch(e => console.error('[Server] persistSwordState error:', e))
    } catch (err) { console.error('[Server] ❌ requestReloadRespawn handler error:', err) }
  })
  room.onMessage('requestBanana', (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      handleTrapDrop(from)
    } catch (err) { console.error('[Server] ❌ requestBanana handler error:', err) }
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
      if (lastDropperId && from !== lastDropperId) return
      const sword = Sword.getOrNull(swordEntity)
      if (!sword || sword.state !== SwordState.Dropped) return

      const newTarget = Math.max(SWORD_MIN_Y, data.y + 0.5)
      swordGravityTargetY = newTarget

      const currentAnchorY = sword.dropAnchorY
      if (currentAnchorY <= newTarget) {
        const swordMutable = Sword.getMutable(swordEntity)
        swordMutable.dropAnchorY = newTarget
        swordFalling = false
        swordFallVelocity = 0
        persistSwordState().catch(e => console.error('[Server] persistSwordState error:', e))
      } else if (!swordFalling) {
        swordFalling = true
        swordFallVelocity = 0
      }
    } catch (err) { console.error('[Server] ❌ reportGroundY handler error:', err) }
  })

  // ── Speed boost trail sync ──
  room.onMessage('reportBoost', (data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    room.send('playerBoosted', { playerId: from, tier: data.tier || 'coin', duration: data.duration || 3 })
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
      // room.send('playerColorChanged', { playerId: from, color: upgrades.equipped })
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
    // room.send('playerColorChanged', { playerId: from, color })
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

type LeaderboardEntry = { userId: string; name: string; roundsWon: number }

/** Parse a leaderboard JSON string into entries (safe — returns [] on error). */
function parseLeaderboardJson(json: string | undefined | null): LeaderboardEntry[] {
  if (!json) return []
  try { return JSON.parse(json) } catch { return [] }
}

/**
 * Increment roundsWon for each winning player in a leaderboard entry array.
 * Mutates in place for efficiency.
 */
function incrementLeaderboardWins(
  entries: LeaderboardEntry[],
  winners: { userId: string; seconds: number }[],
  maxSeconds: number
): void {
  for (const p of winners) {
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
}

/**
 * Patch a single player's name in a leaderboard entry array. Returns true if any changed.
 */
function patchLeaderboardNames(entries: LeaderboardEntry[], userId: string, name: string): boolean {
  const key = userId.toLowerCase()
  let changed = false
  for (const entry of entries) {
    if (entry.userId.toLowerCase() === key && entry.name !== name) {
      entry.name = name
      changed = true
    }
  }
  return changed
}

/**
 * Patch ALL entries in a leaderboard JSON string using the persisted playerNames directory.
 * Returns the (possibly updated) JSON string.
 */
function patchAllLeaderboardNames(json: string, label: string): string {
  const entries = parseLeaderboardJson(json)
  let patched = false
  for (const entry of entries) {
    const knownName = playerNames.get(entry.userId.toLowerCase())
    if (knownName && isRealName(knownName) && entry.name !== knownName) {
      entry.name = knownName
      patched = true
    }
  }
  if (patched) {
    console.log(`[Server] Patched ${label} names from persisted name directory`)
    return JSON.stringify(entries)
  }
  return json
}

// ── Sword handlers ──

function handleSwordPickup(playerId: string): void {
  const sword = Sword.getOrNull(swordEntity)
  if (!sword) return
  if (sword.state !== SwordState.AtBase && sword.state !== SwordState.Dropped) return

  // Only humans can pick up the sword
  if (infectedPlayers.has(playerId)) {
    console.log('[Server] ⚔️ Sword pickup denied — player is infected:', playerId.slice(0, 8))
    return
  }

  const playerPos = getPlayerPosition(playerId)
  if (playerPos) {
    const swordPos = Transform.get(swordEntity).position
    const dist = Vector3.distance(playerPos, swordPos)
    if (dist > SWORD_PICKUP_RADIUS) return
  } else {
    console.log('[Server] ⚠️ handleSwordPickup: no position for', playerId.slice(0, 8), '— trusting client proximity')
  }

  const mutable = Sword.getMutable(swordEntity)
  mutable.state = SwordState.Carried
  mutable.carrierPlayerId = playerId

  resetGravityState()
  lastCarrierPositionMs = Date.now()
  room.send('swordPickupConfirmed', { playerId })
  room.send('swordPickupSound', { t: 0 })
  persistSwordState().catch(e => console.error('[Server] persistSwordState error:', e))
  console.log('[Server] ⚔️ Sword picked up by', playerId.slice(0, 8))
}

function handleSwordDrop(playerId: string): void {
  const sword = Sword.getOrNull(swordEntity)
  if (!sword) return
  if (sword.state !== SwordState.Carried || sword.carrierPlayerId !== playerId) return

  const playerPos = getPlayerPosition(playerId)
  let dropPos: Vector3
  if (playerPos) {
    dropPos = Vector3.add(playerPos, Vector3.create(0, 0.5, 0))
  } else if (lastKnownCarrierPos) {
    dropPos = Vector3.add(lastKnownCarrierPos, Vector3.create(0, 0.5, 0))
  } else {
    dropPos = Transform.get(swordEntity).position
  }

  const mutable = Sword.getMutable(swordEntity)
  mutable.state = SwordState.Dropped
  mutable.carrierPlayerId = ''
  mutable.dropAnchorX = dropPos.x
  mutable.dropAnchorY = dropPos.y
  mutable.dropAnchorZ = dropPos.z

  const t = Transform.getMutable(swordEntity)
  t.position = dropPos

  lastDropperId = playerId
  computeGravityTarget(dropPos.y)

  room.send('swordDropSound', { t: 0 })
  persistSwordState().catch(e => console.error('[Server] persistSwordState error:', e))
  console.log('[Server] ⚔️ Sword dropped by', playerId.slice(0, 8))
}

/** Force-drop the sword (e.g. when carrier gets infected) */
function forceSwordDrop(playerId: string): void {
  const sword = Sword.getOrNull(swordEntity)
  if (!sword || sword.state !== SwordState.Carried || sword.carrierPlayerId !== playerId) return
  handleSwordDrop(playerId)
}

/** Sword attack — sword carrier swings at nearby slimes */
const SWORD_ATTACK_COOLDOWN_MS = 1000
let lastSwordAttackMs = 0

function handleSwordAttack(playerId: string): void {
  const sword = Sword.getOrNull(swordEntity)
  if (!sword || sword.state !== SwordState.Carried || sword.carrierPlayerId !== playerId) return

  const now = Date.now()
  if (now - lastSwordAttackMs < SWORD_ATTACK_COOLDOWN_MS) return
  lastSwordAttackMs = now

  const attackerPos = getPlayerPosition(playerId)
  if (!attackerPos) return

  // Send attack VFX to all clients
  room.send('swordAttackVfx', { x: attackerPos.x, y: attackerPos.y, z: attackerPos.z, attackerId: playerId })

  // Check all infected players within sword range
  for (const slimeId of infectedPlayers) {
    // Skip slimes that are already in respawn cooldown
    const infectedEntity = infectedEntities.get(slimeId)
    if (infectedEntity) {
      const inf = PlayerInfected.getOrNull(infectedEntity)
      if (inf && inf.respawnCooldownUntilMs > now) continue
    }

    const slimePos = getPlayerPosition(slimeId)
    if (!slimePos) continue

    const dist = Vector3.distance(attackerPos, slimePos)
    if (dist < SWORD_ATTACK_RADIUS) {
      // Kill the slime!
      console.log('[Server] ⚔️ Sword killed slime:', slimeId.slice(0, 8))
      const cooldownUntil = now + SLIME_RESPAWN_COOLDOWN_SEC * 1000

      if (infectedEntity) {
        const m = PlayerInfected.getMutable(infectedEntity)
        m.respawnCooldownUntilMs = cooldownUntil
      }

      room.send('slimeKilled', { slimeId, killedBy: playerId, x: slimePos.x, y: slimePos.y, z: slimePos.z })
      room.send('stagger', { victimId: slimeId })
      break // One kill per swing
    }
  }
}

// ── Infection logic ──

/** Infect a human player. Called by infectionServerSystem on proximity. */
function infectPlayer(victimId: string, attackerId: string): void {
  if (infectedPlayers.has(victimId)) return // already infected

  const now = Date.now()
  infectedPlayers.add(victimId)
  infectionImmunityUntil.set(victimId, now + INFECTION_IMMUNITY_MS)

  // Update the player's infection entity
  const entity = getOrCreateInfectedEntity(victimId)
  const m = PlayerInfected.getMutable(entity)
  m.isInfected = true
  m.infectedAtMs = now
  m.respawnCooldownUntilMs = 0

  // If the victim was carrying the sword, force-drop it
  forceSwordDrop(victimId)

  // Update global infection state
  syncInfectionState()

  room.send('playerInfected', { victimId, attackerId })
  room.send('stagger', { victimId })
  console.log('[Server] 🧟 Player infected:', victimId.slice(0, 8), 'by', attackerId.slice(0, 8), '| humans remaining:', getHumansRemaining())

  // Check for early round end
  const remaining = getHumansRemaining()
  if (remaining <= 1 && infectionRoundActive) {
    console.log('[Server] 🏆 All humans infected (or 1 left) — triggering early round end')
    // The countdownServerSystem will detect this via earlyRoundEndRequested
    earlyRoundEndRequested = true
  }
}

/** Flag for early round end when all humans are infected */
let earlyRoundEndRequested = false

/** Count humans remaining (connected, not infected) */
function getHumansRemaining(): number {
  let count = 0
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    const addr = identity.address.toLowerCase()
    if (!infectedPlayers.has(addr)) count++
  }
  return count
}

/** Sync the global InfectionState component to all clients */
function syncInfectionState(): void {
  const m = InfectionState.getMutable(infectionStateEntity)
  m.patientZeroId = patientZeroId
  m.infectedPlayersJson = JSON.stringify(Array.from(infectedPlayers))
  m.humansRemaining = getHumansRemaining()
  m.roundActive = infectionRoundActive
}

/** Pick a random connected player as Patient Zero */
function startInfectionRound(): void {
  const connected: string[] = []
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    connected.push(identity.address.toLowerCase())
  }

  if (connected.length < 2) {
    console.log('[Server] 🧟 Not enough players for infection round (', connected.length, ')')
    infectionRoundActive = false
    syncInfectionState()
    return
  }

  // Pick random Patient Zero
  const idx = Math.floor(Math.random() * connected.length)
  patientZeroId = connected[idx]
  infectionRoundActive = true
  survivalTimeStartMs = Date.now()
  earlyRoundEndRequested = false

  // Clear previous infection state
  infectedPlayers.clear()
  infectionImmunityUntil.clear()

  // Infect Patient Zero
  infectedPlayers.add(patientZeroId)
  const entity = getOrCreateInfectedEntity(patientZeroId)
  const m = PlayerInfected.getMutable(entity)
  m.isInfected = true
  m.infectedAtMs = Date.now()
  m.respawnCooldownUntilMs = 0

  // Reset all other players to human
  for (const addr of connected) {
    if (addr === patientZeroId) continue
    const e = getOrCreateInfectedEntity(addr)
    const inf = PlayerInfected.getMutable(e)
    inf.isInfected = false
    inf.infectedAtMs = 0
    inf.respawnCooldownUntilMs = 0
  }

  syncInfectionState()
  room.send('roundStartInfection', { patientZeroId })
  console.log('[Server] 🧟 Infection round started! Patient Zero:', patientZeroId.slice(0, 8), '| Humans:', connected.length - 1)
}

function handleTrapDrop(playerId: string): void {
  const now = Date.now()

  // Cooldown check
  const lastDrop = lastTrapDropTime.get(playerId) ?? 0
  const bananaCd = TRAP_COOLDOWN_SEC
  if (now - lastDrop < bananaCd * 1000) {
    console.log('[Server] Trap denied: cooldown active, wait', ((bananaCd * 1000 - (now - lastDrop)) / 1000).toFixed(1), 's')
    return
  }

  // Max active trap check
  const playerTraps = activeTraps.filter(b => b.droppedBy === playerId)
  if (playerTraps.length >= TRAP_MAX_ACTIVE) {
    console.log('[Server] Trap denied: max active traps reached (', TRAP_MAX_ACTIVE, ')')
    return
  }

  // Get player position
  const playerPos = getPlayerPosition(playerId)
  if (!playerPos) {
    console.log('[Server] Trap denied: player position not found')
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

    // Gravity — pull trap down to ground
    if (trap.falling) {
      trap.fallVelocity += SWORD_GRAVITY * clampedDt
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

    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      const addr = identity.address.toLowerCase()
      // Self-hit: immune for 2 seconds after dropping, then fair game
      if (addr === trap.droppedBy && (now - trap.droppedAtMs) < 2000) continue

      const playerPos = getPlayerPosition(addr)
      if (!playerPos) continue

      const dist = Vector3.distance(playerPos, trapPos)
      if (dist < TRAP_TRIGGER_RADIUS) {
        console.log('[Server] 🪤 Trap triggered by', addr.slice(0, 8), '! Staggering...')

        // Drop the sword if the victim is carrying it
        forceSwordDrop(addr)

        room.send('bananaTriggered', { x: trapPos.x, y: trapPos.y, z: trapPos.z, victimId: addr })

        // Remove the trap
        removeTrap(trap)
        activeTraps.splice(i, 1)
        break // This trap is consumed
      }
    }
  }
}

// ── Removed: orbit system, projectile system (not needed for Contagion) ──

// ── Server Systems ──

function swordServerSystem(dt: number): void {
  const sword = Sword.getOrNull(swordEntity)
  if (!sword) return

  const clampedDt = Math.min(dt, 0.1)

  // Track carrier Y for gravity target estimation + staleness detection
  if (sword.state === SwordState.Carried && sword.carrierPlayerId) {
    const nowMs = Date.now()
    const carrierPos = getPlayerPosition(sword.carrierPlayerId)
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
      console.log('[Server] ⚠️ STALE SWORD CARRIER:', sword.carrierPlayerId.slice(0, 8), '— force-dropping sword')
      const dropPos = lastKnownCarrierPos
        ? Vector3.create(lastKnownCarrierPos.x, lastKnownCarrierPos.y + 0.5, lastKnownCarrierPos.z)
        : Transform.get(swordEntity).position
      const mutable = Sword.getMutable(swordEntity)
      mutable.state = SwordState.Dropped
      mutable.carrierPlayerId = ''
      mutable.dropAnchorX = dropPos.x
      mutable.dropAnchorY = dropPos.y
      mutable.dropAnchorZ = dropPos.z
      lastDropperId = ''
      resetCarrierTracking()
      computeGravityTarget(dropPos.y)
      room.send('swordDropSound', { t: 0 })
      persistSwordState().catch(e => console.error('[Server] persistSwordState error:', e))
    }
  } else {
    resetCarrierTracking()
  }

  // Gravity for dropped sword
  let currentAnchorY = sword.dropAnchorY
  if (sword.state === SwordState.Dropped && swordFalling) {
    swordFallVelocity += SWORD_GRAVITY * clampedDt
    let newY = currentAnchorY - swordFallVelocity * clampedDt
    if (newY <= swordGravityTargetY) {
      newY = swordGravityTargetY
      swordFalling = false
      swordFallVelocity = 0
      persistSwordState().catch(e => console.error('[Server] persistSwordState error:', e))
    }
    currentAnchorY = newY
    const swordMutable = Sword.getMutable(swordEntity)
    swordMutable.dropAnchorY = newY
  }

  // Water respawn
  const WATER_RESPAWN_Y = 1.58
  if (sword.state === SwordState.Dropped && currentAnchorY <= WATER_RESPAWN_Y) {
    const spawn = getRandomSpawnPoint()
    console.log('[Server] 🌊 Sword fell in water — respawning at', spawn.x, spawn.y, spawn.z)
    const swordMutable2 = Sword.getMutable(swordEntity)
    swordMutable2.state = SwordState.AtBase
    swordMutable2.carrierPlayerId = ''
    swordMutable2.baseX = spawn.x
    swordMutable2.baseY = spawn.y
    swordMutable2.baseZ = spawn.z
    swordMutable2.dropAnchorX = spawn.x
    swordMutable2.dropAnchorY = spawn.y
    swordMutable2.dropAnchorZ = spawn.z
    const t2 = Transform.getMutable(swordEntity)
    t2.position = Vector3.create(spawn.x, spawn.y, spawn.z)
    swordFalling = false
    swordFallVelocity = 0
    persistSwordState().catch(e => console.error('[Server] persistSwordState error:', e))
  }

  // Only write Transform when falling (gravity updates)
  if (sword.state !== SwordState.Carried && swordFalling) {
    const restX = sword.state === SwordState.AtBase ? sword.baseX : sword.dropAnchorX
    const restY = sword.state === SwordState.AtBase ? sword.baseY : currentAnchorY
    const restZ = sword.state === SwordState.AtBase ? sword.baseZ : sword.dropAnchorZ
    const t = Transform.getMutable(swordEntity)
    t.position = Vector3.create(restX, restY, restZ)
  }

  // Detect carrier disconnect
  if (sword.state === SwordState.Carried && sword.carrierPlayerId) {
    let carrierConnected = false
    const carrierLower = sword.carrierPlayerId.toLowerCase()
    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
      if (identity.address.toLowerCase() === carrierLower) {
        carrierConnected = true
        break
      }
    }
    if (!carrierConnected) {
      console.log('[Server] ⚠️ Sword carrier', carrierLower.slice(0, 8), 'disconnected — dropping sword')
      const dropPos = lastKnownCarrierPos
        ? Vector3.create(lastKnownCarrierPos.x, lastKnownCarrierPos.y + 0.5, lastKnownCarrierPos.z)
        : Transform.get(swordEntity).position
      const mutable = Sword.getMutable(swordEntity)
      mutable.state = SwordState.Dropped
      mutable.carrierPlayerId = ''
      mutable.dropAnchorX = dropPos.x
      mutable.dropAnchorY = dropPos.y
      mutable.dropAnchorZ = dropPos.z
      lastDropperId = ''
      resetCarrierTracking()
      computeGravityTarget(dropPos.y)
      room.send('swordDropSound', { t: 0 })
      persistSwordState().catch(e => console.error('[Server] persistSwordState error:', e))
    }
  }
}

/** Survival time system — all living humans accumulate survival time each tick */
function survivalTimeServerSystem(dt: number): void {
  if (!infectionRoundActive) return

  const clampedDt = Math.min(dt, 0.1)
  survivalTimeAccumTimer += clampedDt

  if (survivalTimeAccumTimer < SURVIVAL_TIME_SYNC_INTERVAL) return
  const elapsed = survivalTimeAccumTimer
  survivalTimeAccumTimer = 0

  // Award survival time to all connected humans (not infected)
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    const addr = identity.address.toLowerCase()
    if (infectedPlayers.has(addr)) continue // slimes don't get survival time

    const entity = getOrCreateSurvivalTimeEntity(addr)
    const mutable = PlayerSurvivalTime.getMutable(entity)
    mutable.seconds += elapsed
  }
}

/** Infection system — check slime-human proximity every tick */
function infectionServerSystem(_dt: number): void {
  if (!infectionRoundActive) return

  const now = Date.now()

  // Check slime respawn cooldowns
  for (const slimeId of infectedPlayers) {
    const entity = infectedEntities.get(slimeId)
    if (!entity) continue
    const inf = PlayerInfected.getOrNull(entity)
    if (inf && inf.respawnCooldownUntilMs > 0 && now >= inf.respawnCooldownUntilMs) {
      // Slime respawn!
      const m = PlayerInfected.getMutable(entity)
      m.respawnCooldownUntilMs = 0
      room.send('slimeRespawned', { slimeId })
      console.log('[Server] 🧟 Slime respawned:', slimeId.slice(0, 8))
    }
  }

  // Check proximity between active slimes and humans
  for (const slimeId of infectedPlayers) {
    // Skip slimes in respawn cooldown
    const slimeInfEntity = infectedEntities.get(slimeId)
    if (slimeInfEntity) {
      const inf = PlayerInfected.getOrNull(slimeInfEntity)
      if (inf && inf.respawnCooldownUntilMs > 0 && now < inf.respawnCooldownUntilMs) continue
    }

    const slimePos = getPlayerPosition(slimeId)
    if (!slimePos) continue

    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      const humanId = identity.address.toLowerCase()
      if (infectedPlayers.has(humanId)) continue // skip other slimes

      // Check immunity
      const immuneUntil = infectionImmunityUntil.get(humanId) ?? 0
      if (now < immuneUntil) continue

      const humanPos = getPlayerPosition(humanId)
      if (!humanPos) continue

      const dist = Vector3.distance(slimePos, humanPos)
      if (dist < INFECTION_RADIUS) {
        infectPlayer(humanId, slimeId)
        break // One infection per slime per tick
      }
    }
  }

  // Handle disconnected players — remove from infected set
  const connectedNow = new Set<string>()
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    connectedNow.add(identity.address.toLowerCase())
  }
  for (const slimeId of Array.from(infectedPlayers)) {
    if (!connectedNow.has(slimeId)) {
      infectedPlayers.delete(slimeId)
      syncInfectionState()
    }
  }
}

// ── Removed: flagServerSystem, holdTimeServerSystem, lightningServerSystem, checkProximitySteal ──
// ── Removed: orbitServerSystem, shellServerSystem, handleProjectileFire ──
// These are all replaced by swordServerSystem, survivalTimeServerSystem, infectionServerSystem

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

      // Create synced survival time + infection entities
      getOrCreateSurvivalTimeEntity(userKey)
      getOrCreateInfectedEntity(userKey)
      
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
          totalMinutesToday: 0
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
          totalMinutesMonth: 0
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

      // Monthly visitor disconnect tracking
      const monthlyVisitor = monthlyVisitorSessions.get(userKey)
      if (monthlyVisitor && monthlyVisitor.sessionStartMs > 0) {
        const sessionMs = Date.now() - monthlyVisitor.sessionStartMs
        const sessionMinutes = Math.floor(sessionMs / (1000 * 60))
        monthlyVisitor.totalMinutesMonth += sessionMinutes
        monthlyVisitor.sessionStartMs = 0
      }

      // Clean up per-player maps to prevent unbounded growth
      playerBoomerangColors.delete(userKey)

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
  
  const intervalMs = 5 * 60 * 1000

  // Debug: Log timer state every 30 seconds
  if (now - lastTimerDebugLog > 30000) {
    lastTimerDebugLog = now
    const secondsUntilEnd = Math.floor((timer.roundEndTimeMs - now) / 1000)
    console.log('[Server.Timer] secondsUntilEnd:', secondsUntilEnd, 'triggered:', timer.roundEndTriggered, 'infected:', infectedPlayers.size, 'humans:', getHumansRemaining())
  }

  // Early round end — all humans infected
  if (earlyRoundEndRequested && !timer.roundEndTriggered) {
    earlyRoundEndRequested = false
    console.log('[Server] ⏰ Early round end — all humans infected!')
    handleRoundEnd().catch((err) => {
      console.error('[Server.ERROR] handleRoundEnd (early) failed:', err)
      room.send('respawnPlayers', { t: 0, winnersJson: '[]' })
    })
    // Don't update roundEndTimeMs — the next UTC boundary is still the next round's end
    return
  }
  
  // Normal round end at UTC boundary
  if (!timer.roundEndTriggered && now >= timer.roundEndTimeMs) {
    if (timer.roundEndTimeMs === lastProcessedRoundEndTime) return
    lastProcessedRoundEndTime = timer.roundEndTimeMs
    
    const msAfter = now - timer.roundEndTimeMs
    console.log('[Server] ⏰ Round end! Triggered at roundEndTimeMs:', new Date(timer.roundEndTimeMs).toISOString(), `(${msAfter}ms after)`)
    
    const nextBoundary = (Math.floor(now / intervalMs) + 1) * intervalMs
    const mutable = CountdownTimer.getMutable(countdownEntity)
    mutable.roundEndTimeMs = nextBoundary
    console.log('[Server] Next round will end at:', new Date(nextBoundary).toISOString())
    
    handleRoundEnd().catch((err) => {
      console.error('[Server.ERROR] handleRoundEnd failed:', err)
      try {
        const sword = Sword.getOrNull(swordEntity)
        if (sword && sword.state === SwordState.Carried) {
          const m = Sword.getMutable(swordEntity)
          m.state = SwordState.AtBase
          m.carrierPlayerId = ''
        }
        infectedPlayers.clear()
        infectionRoundActive = false
        syncInfectionState()
        room.send('respawnPlayers', { t: 0, winnersJson: '[]' })
        console.log('[Server] ⚠️ Emergency round-end recovery executed')
      } catch (recoveryErr) {
        console.error('[Server.ERROR] Emergency recovery also failed:', recoveryErr)
      }
    })
  }
  
  // Splash finished — start new infection round
  if (timer.roundEndTriggered && now >= timer.roundEndDisplayUntilMs) {
    const mutable = CountdownTimer.getMutable(countdownEntity)
    mutable.roundEndTriggered = false
    console.log('[Server] Round splash finished — starting new infection round')
    startInfectionRound()
  }
}

async function handleRoundEnd(): Promise<void> {
  const now = Date.now()

  // ══════════════════════════════════════════════════════════════════════
  // CRITICAL: All state mutations MUST happen synchronously BEFORE any `await`.
  // ══════════════════════════════════════════════════════════════════════

  // ── 0. Stop infection round ──
  infectionRoundActive = false
  earlyRoundEndRequested = false

  // ── 0b. Reset sword to random spawn point IMMEDIATELY ──
  resetGravityState()
  const spawnPoint = getRandomSpawnPoint()
  console.log('[Server] Round ended, sword respawning at random location')
  
  const swordMutable = Sword.getMutable(swordEntity)
  swordMutable.state = SwordState.AtBase
  swordMutable.carrierPlayerId = ''
  swordMutable.baseX = spawnPoint.x
  swordMutable.baseY = spawnPoint.y
  swordMutable.baseZ = spawnPoint.z
  
  const swordT = Transform.getMutable(swordEntity)
  swordT.position = Vector3.create(spawnPoint.x, spawnPoint.y, spawnPoint.z)

  // ── 1. Determine winner(s) — longest survival time wins ──
  let maxSeconds = 0
  const players: { userId: string; seconds: number }[] = []

  for (const [, data] of engine.getEntitiesWith(PlayerSurvivalTime)) {
    if (data.seconds > 0) {
      players.push({ userId: data.playerId, seconds: data.seconds })
      if (data.seconds > maxSeconds) maxSeconds = data.seconds
    }
  }

  // ── 2. Reset ALL survival times to 0 synchronously ──
  const connectedNow = new Set<string>()
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    connectedNow.add(identity.address.toLowerCase())
  }

  const entitiesToRemove: string[] = []
  for (const [entity, data] of engine.getEntitiesWith(PlayerSurvivalTime)) {
    const key = data.playerId.toLowerCase()
    if (connectedNow.has(key)) {
      PlayerSurvivalTime.getMutable(entity).seconds = 0
    } else {
      entitiesToRemove.push(key)
    }
  }
  for (const userKey of entitiesToRemove) {
    const entity = survivalTimeEntities.get(userKey)
    if (entity) {
      engine.removeEntity(entity)
      survivalTimeEntities.delete(userKey)
      knownPlayers.delete(userKey)
    }
  }
  if (entitiesToRemove.length > 0) {
    console.log('[Server] Cleaned up', entitiesToRemove.length, 'survival-time entities for disconnected players')
  }

  // Reset survival time accumulator
  survivalTimeAccumTimer = 0

  // ── 3. Reset infection state ──
  infectedPlayers.clear()
  infectionImmunityUntil.clear()
  patientZeroId = ''
  // Reset all PlayerInfected components
  for (const [entity] of engine.getEntitiesWith(PlayerInfected)) {
    const m = PlayerInfected.getMutable(entity)
    m.isInfected = false
    m.infectedAtMs = 0
    m.respawnCooldownUntilMs = 0
  }
  syncInfectionState()

  // ── 3a. Remove all active traps ──
  for (const trap of activeTraps) {
    removeTrap(trap)
  }
  activeTraps.length = 0
  lastTrapDropTime.clear()
  console.log('[Server] 🪤 All traps cleared for new round')

  // ── 4. Compute top 3 BEFORE sending respawnPlayers ──
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
    console.log('[Server] Top survivor:', p.name, '-', p.seconds, 'seconds')
  }

  const winnersJson = JSON.stringify(topPlayers)

  // ── 5. Respawn all players ──
  room.send('respawnPlayers', { t: 0, winnersJson })
  console.log('[Server] 📍 Respawning all players')

  // ══════════════════════════════════════════════════════════════════════
  // All synchronous state mutations done. Safe to await now.
  // ══════════════════════════════════════════════════════════════════════

  // ── 6. Set timer splash ──
  const timerMutable = CountdownTimer.getMutable(countdownEntity)
  timerMutable.roundEndTriggered = true
  timerMutable.roundEndDisplayUntilMs = now + SPLASH_DURATION_MS
  timerMutable.roundWinnerJson = winnersJson

  // ── 7. Award coins ──
  await awardRoundCoins(players)

  // ── 8. Leaderboard updates ──
  await checkLeaderboardDailyReset()
  await checkMonthlyLeaderboardReset()

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

  // ── 9. Award lifetime wins to survivors with max time ──
  if (maxSeconds > 0) {
    const winners = players.filter(p => p.seconds >= maxSeconds)
    for (const w of winners) {
      const newWins = await addPlayerLifetimeWin(w.userId)
      console.log('[LifetimeWins] Player', w.userId.slice(0, 8), 'now has', newWins, 'lifetime wins')
    }
  }

  // ── 10. Persist sword state ──
  await persistSwordState()
}

let visitorSyncTimer = 0

function visitorTrackingServerSystem(dt: number): void {
  visitorSyncTimer += dt
  
  // Sync visitor analytics every 10 seconds
  if (visitorSyncTimer >= 10.0) {
    visitorSyncTimer = 0
    
    // Check if it's time to send the pre-midnight report (23:55 UTC)
    checkPreMidnightReport().catch(e => console.error('[Server] checkPreMidnightReport error:', e))
    
    // Check for daily reset (midnight UTC)
    checkVisitorDailyReset().catch(e => console.error('[Server] checkVisitorDailyReset error:', e))
    
    // Check for monthly visitor reset
    checkMonthlyVisitorReset().catch(e => console.error('[Server] checkMonthlyVisitorReset error:', e))
    
    // Sync current visitor data
    syncVisitorAnalytics().catch(e => console.error('[Server] syncVisitorAnalytics error:', e))
    syncMonthlyVisitorAnalytics().catch(e => console.error('[Server] syncMonthlyVisitorAnalytics error:', e))
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
    persistPlayerNames().catch(e => console.error('[Server] persistPlayerNames error:', e))
    syncVisitorAnalytics().catch(e => console.error('[Server] syncVisitorAnalytics error:', e))
  }
}

