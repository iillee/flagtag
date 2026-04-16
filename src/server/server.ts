import { engine, Transform, PlayerIdentityData, AvatarBase, type Entity } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import { Storage } from '@dcl/sdk/server'
import {
  Flag, FlagState, PlayerFlagHoldTime, CountdownTimer, LeaderboardState, VisitorAnalytics,
  Trap, TRAP_LIFETIME_SEC, TRAP_COOLDOWN_SEC, TRAP_MAX_ACTIVE, TRAP_TRIGGER_RADIUS,
  Projectile, PROJECTILE_LIFETIME_SEC, PROJECTILE_COOLDOWN_SEC, PROJECTILE_MAX_ACTIVE, PROJECTILE_SPEED, PROJECTILE_MAX_RANGE, PROJECTILE_HIT_RADIUS,
  getHoldTimeEntityEnumId, getNextRoundEndTimeMs, getNextTrapSyncId, getNextProjectileSyncId,
  FLAG_BASE_POSITION, FLAG_SPAWN_POINTS, getRandomSpawnPoint, SyncIds, getTodayDateString
} from '../shared/components'
import { room } from '../shared/messages'

// ── Constants ──
const PICKUP_RADIUS = 3
const PROXIMITY_STEAL_RADIUS = 2.0  // Auto-steal flag when within this distance of carrier
const STEAL_IMMUNITY_MS = 3000    // Immunity for the player who STEALS the flag (time to escape the crowd)
const HOLD_TIME_SYNC_INTERVAL = 0.5  // Sync hold time every 0.5s (was 0.2s) — reduces CRDT pressure; client interpolates between updates
// Bob/spin constants removed — animation is now client-side only
const SPLASH_DURATION_MS = 3000
const FLAG_GRAVITY = 15          // m/s² (slightly faster than real gravity for snappy game feel)
const FLAG_MIN_Y = 1.5           // absolute minimum Y (ground plane)
const CARRIER_Y_WINDOW_SEC = 2.0 // seconds of carrier Y history to estimate ground level
const BANNER_SRC = 'models/Banner_Red_02/Banner_Red_02.glb'

// ── Mushroom constants ──
const MUSHROOM_COUNT = 1
// Shield lasts until hit or round end
// Mushroom spawn constrained to boundary cylinder
const MUSHROOM_CX = 250.75
const MUSHROOM_CZ = 255.5
const MUSHROOM_RADIUS = 128

const MUSHROOM_MAX_REROLLS = 10

interface ServerMushroom {
  id: number
  x: number
  z: number
  pickedUp: boolean
  rerolls: number
}
const activeMushrooms: ServerMushroom[] = []
let mushroomIdCounter = 0
// mushroomShieldActive removed — mushrooms no longer block hits

// ── Server state ──
let flagEntity: Entity
let countdownEntity: Entity
let leaderboardEntity: Entity
let visitorAnalyticsEntity: Entity

let holdTimeAccum = 0
let holdTimeCarrierKey = '' // Track WHO we're accumulating for

// ── Lightning state ──
const LIGHTNING_ROLL_INTERVAL = 5 // seconds between probability rolls
const LIGHTNING_WARNING_DURATION = 3 // seconds warning before strike
let lightningRollTimer = 0
let lightningStrikeScheduled = false
let lightningWarningTimer = 0
let lightningOriginalCarrierId = '' // carrier when warning started — strike completes even if dropped

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

// lastAttackTime removed — melee attack replaced by proximity steal
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
const playerBoomerangColors = new Map<string, string>() // playerId -> color ('r','y','b','g')
let lastVisitorResetDay = ''

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
const TRAP_MODEL_SRC = 'models/banana_scaled.glb'
/** Track last trap drop time per player for cooldown. */
const lastTrapDropTime = new Map<string, number>()
/** Track active trap entities for cleanup, with per-trap gravity state. */
interface ActiveTrap {
  entity: Entity
  droppedBy: string
  droppedAtMs: number
  falling: boolean
  fallVelocity: number
  targetY: number          // ground Y estimated by client raycast
  groundResolved: boolean  // true once client raycast has reported ground
}
const activeTraps: ActiveTrap[] = []

// ── Projectile state ──
const PROJECTILE_MODEL_SRC = 'models/boomerang.r.glb'
const PROJECTILE_GROUND_OFFSET = 0.35  // Raise projectile above ground so it doesn't clip terrain
const lastProjectileFireTime = new Map<string, number>()
interface ActiveProjectile {
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
  hitWall: boolean        // true if maxDistance was shortened by a wall
  // Gravity
  currentY: number
  fallVelocity: number
  groundY: number        // latest ground height reported by client
  onGround: boolean      // true once projectile has landed on a surface
  // CRDT write throttle — sync distanceTraveled at 10Hz instead of 60fps
  lastSyncedDist: number
  // Boomerang return
  returning: boolean
  returnX: number  // current position during return
  returnY: number
  returnZ: number
}
const activeProjectiles: ActiveProjectile[] = []
const PROJECTILE_SYNC_INTERVAL = 0.1 // seconds between Projectile component CRDT writes

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
        console.log('[Server] Visitor data was from', lastVisitorResetDay, 'but today is', currentDay, '- sending analytics before reset')
        // Restore yesterday's data temporarily so we can send the Discord report
        for (const record of visitorRecords) {
          const minutes = record.totalSeconds != null
            ? Math.floor(record.totalSeconds / 60)
            : (record.totalMinutes || 0)
          const recordKey = (record.userId || '').toLowerCase()
          const bestName = (playerNames.has(recordKey) && isRealName(playerNames.get(recordKey)!))
            ? playerNames.get(recordKey)!
            : record.name
          visitorSessions.set(recordKey, {
            name: bestName,
            sessionStartMs: 0,
            totalMinutesToday: minutes
          })
        }
        // Send yesterday's analytics to Discord before clearing
        await sendDailyAnalyticsToDiscord()
        // Now clear for the new day
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

// ── Discord webhook for daily analytics ──
const DISCORD_WEBHOOK_URL = 'https://discordapp.com/api/webhooks/1490808436097679540/wEwupNTGN90YCZ46iPHSt_YEm6SW6xS8x4Ybw4Ls1JVfQzgVXkeJ7VHWl67F2tS8Fug2'

async function sendDailyAnalyticsToDiscord(): Promise<void> {
  try {
    const now = Date.now()

    // Build per-user data: address, time spent, stars (wins)
    const winsMap = new Map<string, number>()
    const lb = LeaderboardState.getOrNull(leaderboardEntity)
    if (lb && lb.json) {
      try {
        const entries = JSON.parse(lb.json) as Array<{ userId: string; roundsWon: number }>
        for (const e of entries) winsMap.set(e.userId.toLowerCase(), e.roundsWon)
      } catch { /* ignore */ }
    }

    const users = Array.from(visitorSessions.entries()).map(([userId, data]) => {
      let totalSeconds = data.totalMinutesToday * 60
      if (data.sessionStartMs > 0) {
        totalSeconds += Math.floor((now - data.sessionStartMs) / 1000)
      }
      return {
        address: userId,
        name: data.name || userId.slice(0, 8),
        time_seconds: totalSeconds,
        stars: winsMap.get(userId) || 0
      }
    }).sort((a, b) => b.time_seconds - a.time_seconds)

    // Build structured JSON report for AI agent consumption
    const report = {
      scene: 'flagtag.dcl.eth',
      date: lastVisitorResetDay,
      unique_users: users.length,
      total_time_seconds: users.reduce((sum, u) => sum + u.time_seconds, 0),
      peak_concurrent: { count: peakConcurrent, time: peakConcurrentTime },
      hourly_peak: hourlyPeakConcurrent.map((count, hour) => `${hour}:00 - ${count}`),
      users
    }

    const jsonBlock = JSON.stringify(report, null, 2)

    // Discord has a 2000 char message limit. If the JSON fits in a code block, send inline.
    // Otherwise, split across multiple messages.
    const MAX_BLOCK_LEN = 1900 // leave room for ```json wrapper
    const messages: string[] = []

    if (jsonBlock.length <= MAX_BLOCK_LEN) {
      messages.push(`\`\`\`json\n${jsonBlock}\n\`\`\``)
    } else {
      // Send header message then chunked user data
      const header = JSON.stringify({ scene: report.scene, date: report.date, unique_users: report.unique_users, peak_concurrent: report.peak_concurrent, hourly_peak: report.hourly_peak }, null, 2)
      messages.push(`\`\`\`json\n${header}\n\`\`\``)

      // Chunk users array into messages that fit
      let chunk: typeof users = []
      let chunkLen = 0
      for (const user of users) {
        const userJson = JSON.stringify(user)
        if (chunkLen + userJson.length + 5 > MAX_BLOCK_LEN && chunk.length > 0) {
          messages.push(`\`\`\`json\n${JSON.stringify(chunk, null, 2)}\n\`\`\``)
          chunk = []
          chunkLen = 0
        }
        chunk.push(user)
        chunkLen += userJson.length + 5
      }
      if (chunk.length > 0) {
        messages.push(`\`\`\`json\n${JSON.stringify(chunk, null, 2)}\n\`\`\``)
      }
    }

    // Build multipart form data to attach JSON file + send code block message
    const filename = `${report.date}_flagtag_analytics.json`
    const boundary = '----DclAnalytics' + Date.now()
    const messageContent = messages.join('\n')

    const bodyParts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ content: messageContent })}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${filename}"\r\nContent-Type: application/json\r\n\r\n${jsonBlock}`,
      `--${boundary}--`
    ]
    const body = bodyParts.join('\r\n')

    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body
    })
    console.log('[Server] Discord webhook response:', res.status)
  } catch (err) {
    console.error('[Server] Failed to send Discord webhook:', err)
  }
}

// ── Pre-midnight Discord report ──
// Send the daily report during the last hour (23:00–23:59 UTC) so all data is intact.
// The actual reset still happens at midnight UTC.
let dailyReportSentForDay = ''

async function checkPreMidnightReport(): Promise<void> {
  const now = new Date()
  const currentDay = now.toISOString().slice(0, 10)
  
  // Already sent today's report
  if (dailyReportSentForDay === currentDay) return
  
  // Send anytime during the last hour of the UTC day (23:00–23:59)
  // Wider window = much less likely to miss if server has brief downtime
  const hour = now.getUTCHours()
  if (hour === 23) {
    console.log('[Server] 📊 Sending pre-midnight daily analytics report for', currentDay)
    dailyReportSentForDay = currentDay
    await sendDailyAnalyticsToDiscord()
  }
}

// Check and perform daily visitor reset at 12:00 AM UTC (midnight)
async function checkVisitorDailyReset(): Promise<boolean> {
  const currentDay = getTodayDateString()
  
  if (lastVisitorResetDay !== currentDay) {
    console.log('[Server] Daily visitor reset at midnight UTC for new day:', currentDay)
    
    // Send analytics to Discord as a fallback if the pre-midnight report didn't fire
    // (e.g. server was down at 23:55 UTC)
    if (dailyReportSentForDay !== lastVisitorResetDay) {
      console.log('[Server] Pre-midnight report was missed, sending now before reset')
      await sendDailyAnalyticsToDiscord()
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
  engine.addSystem(safeSystem('lightningServerSystem', lightningServerSystem))
  engine.addSystem(safeSystem('playerTrackingSystem', playerTrackingSystem))
  engine.addSystem(safeSystem('countdownServerSystem', countdownServerSystem))
  engine.addSystem(safeSystem('visitorTrackingServerSystem', visitorTrackingServerSystem))
  engine.addSystem(safeSystem('nameResolverServerSystem', nameResolverServerSystem))
  engine.addSystem(safeSystem('proximityStealSystem', checkProximitySteal))
  engine.addSystem(safeSystem('bananaServerSystem', bananaServerSystem))
  engine.addSystem(safeSystem('shellServerSystem', shellServerSystem))
  engine.addSystem(safeSystem('updraftServerSystem', updraftServerSystem))

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
        persistLeaderboard(json).catch(e => console.error('[Server] persistLeaderboard error:', e))
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
  // Reload-respawn: player reloaded scene while carrying flag → respawn at random point
  room.onMessage('requestReloadRespawn', (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const flag = Flag.getOrNull(flagEntity)
      if (!flag || flag.state !== FlagState.Carried || flag.carrierPlayerId !== from) return
      console.log('[Server] 🔄 Player', from.slice(0, 8), 'reloaded while carrying flag — respawning flag')
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
      handleProjectileFire(from, data.dirX, data.dirZ, data.color || 'r')
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
      room.send('mushroomPickedUp', { id: mid, playerId: from })
      // Spawn a replacement mushroom
      spawnOneMushroom()
    } catch (err) { console.error('[Server] ❌ pickupMushroom handler error:', err) }
  })

  // ── Mushroom reroll (client detected water landing) ──
  room.onMessage('rerollMushroom', (data, _context) => {
    try {
      const mid = (data as any).id as number
      const mushroom = activeMushrooms.find(m => m.id === mid && !m.pickedUp)
      if (!mushroom) return
      if (mushroom.rerolls >= MUSHROOM_MAX_REROLLS) {
        console.log('[Server] 🍄 Mushroom', mid, 'hit max rerolls, resending current position')
        room.send('mushroomPositions', { mushroomsJson: JSON.stringify([{ id: mushroom.id, x: mushroom.x, z: mushroom.z }]) })
        return
      }
      mushroom.rerolls++
      const rerollPos = randomMushroomPos()
      mushroom.x = rerollPos.x
      mushroom.z = rerollPos.z
      console.log('[Server] 🍄 Rerolled mushroom', mid, 'to', mushroom.x.toFixed(1), mushroom.z.toFixed(1), `(attempt ${mushroom.rerolls}/${MUSHROOM_MAX_REROLLS})`)
      room.send('mushroomPositions', { mushroomsJson: JSON.stringify([{ id: mushroom.id, x: mushroom.x, z: mushroom.z }]) })
    } catch (err) { console.error('[Server] ❌ rerollMushroom handler error:', err) }
  })

  // ── Boomerang color change ──
  room.onMessage('colorChanged', (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const color = data.color || 'r'
      playerBoomerangColors.set(from, color)
      console.log(`[Server] Player ${from} changed boomerang color to ${color}`)
      // Broadcast to ALL clients (including sender, so they can confirm)
      room.send('playerColorChanged', { playerId: from, color })
    } catch (err) { console.error('[Server] ❌ colorChanged handler error:', err) }
  })

  // ── Updraft location request ──
  room.onMessage('requestUpdraftLocation', (_data, _context) => {
    try {
      room.send('updraftLocation', { index: updraftActiveIndex })
    } catch (err) { console.error('[Server] ❌ requestUpdraftLocation handler error:', err) }
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

  // Flush any leftover hold time from a previous carrier (safety)
  flushHoldTimeAccum()

  const mutable = Flag.getMutable(flagEntity)
  mutable.state = FlagState.Carried
  mutable.carrierPlayerId = playerId

  resetGravityState()
  lastStealTime.set(playerId, Date.now()) // Grant immunity on pickup too
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
  syncEntity(trapEntity, [Transform.componentId, Trap.componentId], getNextTrapSyncId())

  activeTraps.push({
    entity: trapEntity,
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
      engine.removeEntity(trap.entity)
      activeTraps.splice(i, 1)
      continue
    }

    // Trigger check — any player (except the dropper) walks over it
    const trapPos = Transform.get(trap.entity).position
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
        engine.removeEntity(trap.entity)
        activeTraps.splice(i, 1)
        break // This trap is consumed
      }
    }
  }
}

function handleProjectileFire(playerId: string, dirX: number, dirZ: number, color: string = 'r'): void {
  const now = Date.now()

  // Cooldown check
  const lastFire = lastProjectileFireTime.get(playerId) ?? 0
  const shellCd = PROJECTILE_COOLDOWN_SEC
  if (now - lastFire < shellCd * 1000) {
    console.log('[Server] Projectile denied: cooldown active')
    return
  }

  // Max active check
  const playerProjectiles = activeProjectiles.filter(s => s.firedBy === playerId)
  if (playerProjectiles.length >= PROJECTILE_MAX_ACTIVE) {
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
    maxDistance: PROJECTILE_MAX_RANGE,
    active: true,
  })
  // NOTE: Transform is intentionally NOT synced for projectiles.
  // Syncing Transform at 60fps per projectile saturates the CRDT buffer and freezes
  // ALL synced components (including the scoreboard). Clients use local visual
  // entities positioned via Projectile component data (startX/Y/Z + direction + distanceTraveled).
  syncEntity(projectileEntity, [Projectile.componentId], getNextProjectileSyncId())

  activeProjectiles.push({
    entity: projectileEntity,
    firedBy: playerId,
    firedAtMs: now,
    startX: spawnPos.x,
    startY: spawnPos.y,
    startZ: spawnPos.z,
    dirX: nDirX,
    dirZ: nDirZ,
    distanceTraveled: 0,
    maxDistance: PROJECTILE_MAX_RANGE,
    wallDistReported: false,
    hitWall: false,
    currentY: spawnPos.y,
    fallVelocity: 0,
    groundY: Math.max(0, playerPos.y - 0.88),  // Approximate ground level from player height (~0.88m avatar offset)
    onGround: false,
    lastSyncedDist: 0,
    returning: false,
    returnX: spawnPos.x,
    returnY: spawnPos.y,
    returnZ: spawnPos.z,

  })
  lastProjectileFireTime.set(playerId, now)

  room.send('shellDropped', { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z, dirX: nDirX, dirZ: nDirZ, color, firedBy: playerId })
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
      engine.removeEntity(projectile.entity)
      activeProjectiles.splice(i, 1)
      continue
    }

    const moveDistance = PROJECTILE_SPEED * clampedDt

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
        room.send('shellTriggered', { x: projectilePos.x, y: projectilePos.y, z: projectilePos.z, victimId: '', peak: !projectile.hitWall })
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
        // Returned to shooter — remove silently
        console.log('[Server] 🎯 Projectile returned to shooter')
        engine.removeEntity(projectile.entity)
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

    // Update synced component — throttled to avoid CRDT saturation.
    const distDelta = projectile.distanceTraveled - projectile.lastSyncedDist
    if (distDelta >= PROJECTILE_SPEED * PROJECTILE_SYNC_INTERVAL) {
      const shellComp = Projectile.getMutable(projectile.entity)
      shellComp.distanceTraveled = projectile.distanceTraveled
      projectile.lastSyncedDist = projectile.distanceTraveled
    }

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
      if (dist < PROJECTILE_HIT_RADIUS) {
        console.log('[Server] 🎯 Projectile hit player', addr.slice(0, 8), projectile.returning ? '(return)' : '(outbound)')

        // Drop the flag if the victim is carrying it
        const flag = Flag.getOrNull(flagEntity)
        if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === addr) {
          console.log('[Server] 🎯 Victim was carrying flag — forcing drop!')
          handleDrop(addr)
        }

        room.send('shellTriggered', { x: projectilePos.x, y: projectilePos.y, z: projectilePos.z, victimId: addr })

        if (projectile.returning) {
          // On return: consumed on hit
          engine.removeEntity(projectile.entity)
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
      if (dist < PROJECTILE_HIT_RADIUS) {
        console.log('[Server] 🎯🪤 Projectile hit trap!', projectile.returning ? 'Both destroyed.' : 'Trap destroyed, projectile returning.')
        room.send('shellTriggered', { x: projectilePos.x, y: projectilePos.y, z: projectilePos.z, victimId: '' })
        room.send('bananaTriggered', { x: trapPos.x, y: trapPos.y, z: trapPos.z, victimId: '' })
        engine.removeEntity(trap.entity)
        activeTraps.splice(j, 1)

        if (projectile.returning) {
          // On return: consumed
          engine.removeEntity(projectile.entity)
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

      lightningOriginalCarrierId = ''
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
      lightningOriginalCarrierId = flag!.carrierPlayerId!
      room.send('lightningWarning', { t: 0 })
    } else if (chance > 0) {
      console.log(`[Server] ⚡ Lightning roll failed. Score: ${score.toFixed(0)}, Chance: ${(chance * 100).toFixed(1)}%`)
    }
  }
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
    updateConcurrentTracking()
    syncVisitorAnalytics().catch(e => console.error('[Server] syncVisitorAnalytics error:', e))
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
        lightningOriginalCarrierId = ''
        room.send('respawnPlayers', { t: 0 })
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

  // ── 0a. Flush any in-progress hold time so final scores are accurate ──
  flushHoldTimeAccum()

  // ── 0b. Check for daily leaderboard reset ──
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

  // ── 5. Remove all active traps ──
  for (const trap of activeTraps) {
    engine.removeEntity(trap.entity)
  }
  activeTraps.length = 0
  lastTrapDropTime.clear()
  console.log('[Server] 🪤 All traps cleared for new round')

  // ── 5b. Remove all active projectiles ──
  for (const projectile of activeProjectiles) {
    engine.removeEntity(projectile.entity)
  }
  activeProjectiles.length = 0
  lastProjectileFireTime.clear()
  console.log('[Server] 🎯 All projectiles cleared for new round')

  // ── 5c. Clear combat cooldown maps to prevent memory growth ──
  lastStealTime.clear()

  // ── 5d. Respawn mushrooms ──
  spawnMushrooms()
  console.log('[Server] 🍄 Mushrooms respawned for new round')

  // ── 5e. Reset lightning state ──
  lightningRollTimer = 0
  lightningStrikeScheduled = false
  lightningWarningTimer = 0
  lightningOriginalCarrierId = ''

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

  // ── 6b. Respawn all players at spawn point immediately ──
  room.send('respawnPlayers', { t: 0 })
  console.log('[Server] 📍 Respawning all players at spawn point')

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
    
    // Check if it's time to send the pre-midnight report (23:55 UTC)
    checkPreMidnightReport().catch(e => console.error('[Server] checkPreMidnightReport error:', e))
    
    // Check for daily reset (midnight UTC)
    checkVisitorDailyReset().catch(e => console.error('[Server] checkVisitorDailyReset error:', e))
    
    // Sync current visitor data
    syncVisitorAnalytics().catch(e => console.error('[Server] syncVisitorAnalytics error:', e))
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

// ── Mushroom spawning ──
function randomMushroomPos(): { x: number; z: number } {
  const angle = Math.random() * Math.PI * 2
  const r = MUSHROOM_RADIUS * Math.sqrt(Math.random())
  return { x: MUSHROOM_CX + Math.cos(angle) * r, z: MUSHROOM_CZ + Math.sin(angle) * r }
}

function spawnOneMushroom(): void {
  const { x, z } = randomMushroomPos()
  const m = { id: mushroomIdCounter++, x, z, pickedUp: false, rerolls: 0 }
  activeMushrooms.push(m)
  console.log('[Server] 🍄 Spawned replacement mushroom', m.id, 'at', x.toFixed(1), z.toFixed(1))
  room.send('mushroomPositions', { mushroomsJson: JSON.stringify([{ id: m.id, x: m.x, z: m.z }]) })
}

function spawnMushrooms(): void {
  activeMushrooms.length = 0
  for (let i = 0; i < MUSHROOM_COUNT; i++) {
    const { x, z } = randomMushroomPos()
    activeMushrooms.push({
      id: mushroomIdCounter++,
      x, z,
      pickedUp: false,
      rerolls: 0
    })
  }
  console.log('[Server] 🍄 Spawned', MUSHROOM_COUNT, 'mushrooms')
  // Broadcast to all connected clients
  const positions = activeMushrooms.map(m => ({ id: m.id, x: m.x, z: m.z }))
  room.send('mushroomPositions', { mushroomsJson: JSON.stringify(positions), fullReset: true })
}
