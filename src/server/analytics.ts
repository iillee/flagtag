/**
 * analytics.ts — Visitor tracking, Discord webhook (player join notifications).
 */

import { Storage, EnvVar } from '@dcl/sdk/server'
import { getRealm } from '~system/Runtime'
import {
  visitorSessions, monthlyVisitorSessions, playerNames, isRealName,
  visitorAnalyticsEntity, monthlyVisitorAnalyticsEntity,
  lastVisitorResetDay, setLastVisitorResetDay,
  lastMonthlyVisitorResetMonth, setLastMonthlyVisitorResetMonth,
} from './serverState'
import { persistVisitorData } from './persistence'
import {
  VisitorAnalytics, MonthlyVisitorAnalytics,
  getTodayDateString, getCurrentMonthString
} from '../shared/components'

// ── Module-local state ──

let DISCORD_WEBHOOK_URL = ''
export let isPreview = false

// ── Discord webhook loading ──

export async function loadDiscordWebhookUrl(): Promise<void> {
  // Detect preview mode to suppress Discord spam during local testing
  try {
    const realm = await getRealm({})
    isPreview = realm.realmInfo?.isPreview ?? false
    if (isPreview) {
      console.log('[Server] 🔇 Preview mode detected — Discord notifications disabled')
    }
  } catch (err) {
    console.log('[Server] ⚠️ Could not detect realm info:', err)
  }

  DISCORD_WEBHOOK_URL = (await EnvVar.get('DISCORD_WEBHOOK_URL')) || ''
  if (!DISCORD_WEBHOOK_URL) {
    console.log('[Server] ⚠️ DISCORD_WEBHOOK_URL env var not set — Discord notifications disabled')
  } else {
    console.log('[Server] ✅ Discord webhook URL loaded from EnvVar')
  }
}

// ── Player join Discord notification ──

/** Addresses to suppress from Discord join notifications (known bots) */
const JOIN_NOTIFY_BLOCKED: Set<string> = new Set([
  '0x5c61f3a6bee08f43f886bf20adac296495ee77a2', // Schneeflocke1
])

/** Pending join notifications — we delay sending to allow name resolution */
const pendingJoinNotifications: Map<string, { address: string, onlineCount: number, scheduledAt: number }> = new Map()
const JOIN_NOTIFY_DELAY_MS = 5000
const JOIN_NOTIFY_MAX_WAIT_MS = 15000 // Max time to wait for name resolution before dropping

export function schedulePlayerJoinDiscord(playerName: string, address: string, onlineCount: number): void {
  const userKey = address.toLowerCase()
  if (JOIN_NOTIFY_BLOCKED.has(userKey)) return
  pendingJoinNotifications.set(userKey, { address, onlineCount, scheduledAt: Date.now() })
}

/** Called from visitorTrackingServerSystem to flush any pending notifications whose delay has elapsed */
export function flushPendingJoinNotifications(): void {
  if (!DISCORD_WEBHOOK_URL || isPreview) return
  const now = Date.now()
  for (const [userKey, pending] of pendingJoinNotifications) {
    if (now - pending.scheduledAt < JOIN_NOTIFY_DELAY_MS) continue
    pendingJoinNotifications.delete(userKey)

    // Use the best name available now (name resolver should have run by this point)
    const knownName = playerNames.get(userKey)
    if (!knownName || !isRealName(knownName)) {
      // Not resolved yet — keep waiting up to max wait, then drop (likely a bot)
      if (now - pending.scheduledAt < JOIN_NOTIFY_MAX_WAIT_MS) continue
      pendingJoinNotifications.delete(userKey)
      continue
    }

    const resolvedName = knownName
    const content = `👋 **${resolvedName}** joined Flag Tag (${pending.address.slice(0, 6)}…${pending.address.slice(-4)}) — **${pending.onlineCount}** online`
    fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    }).then(() => {}, () => {})
  }
}

// ── Daily visitor reset ──

export async function checkVisitorDailyReset(): Promise<boolean> {
  const currentDay = getTodayDateString()

  if (lastVisitorResetDay !== currentDay) {
    console.log('[Server] Daily visitor reset at midnight UTC for new day:', currentDay)
    setLastVisitorResetDay(currentDay)
    visitorSessions.clear()
    await syncVisitorAnalytics()
    console.log('[Server] Visitor data reset completed')
    return true
  }

  return false
}

// ── Sync visitor analytics to CRDT + Storage ──

export async function syncVisitorAnalytics(): Promise<void> {
  const currentDay = getTodayDateString()
  const now = Date.now()
  const onlineCount = Array.from(visitorSessions.values()).filter(v => v.sessionStartMs > 0).length

  const visitorData = Array.from(visitorSessions.entries()).map(([userId, data]) => {
    const isOnline = data.sessionStartMs > 0
    let totalSeconds = data.totalSecondsToday

    if (isOnline) {
      const sessionMs = now - data.sessionStartMs
      totalSeconds += Math.floor(sessionMs / 1000)
    }

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
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1
    return b.totalSeconds - a.totalSeconds
  })
  .slice(0, 100)

  const visitorDataJson = JSON.stringify(visitorData)

  const mutable = VisitorAnalytics.getMutable(visitorAnalyticsEntity)
  mutable.date = currentDay
  mutable.visitorDataJson = visitorDataJson
  mutable.onlineCount = onlineCount
  mutable.totalUniqueVisitors = visitorSessions.size

  await persistVisitorData(visitorDataJson)
}

// ── Monthly visitor analytics ──

export async function syncMonthlyVisitorAnalytics(): Promise<void> {
  const currentMonth = getCurrentMonthString()
  const now = Date.now()
  const onlineCount = Array.from(monthlyVisitorSessions.values()).filter(v => v.sessionStartMs > 0).length

  const visitorData = Array.from(monthlyVisitorSessions.entries()).map(([userId, data]) => {
    const isOnline = data.sessionStartMs > 0
    let totalSeconds = data.totalSecondsMonth
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
  .slice(0, 100)

  const visitorDataJson = JSON.stringify(visitorData)
  const mutable = MonthlyVisitorAnalytics.getMutable(monthlyVisitorAnalyticsEntity)
  mutable.month = currentMonth
  mutable.visitorDataJson = visitorDataJson
  mutable.onlineCount = onlineCount
  mutable.totalUniqueVisitors = monthlyVisitorSessions.size

  await Storage.set('monthlyVisitorData', visitorDataJson)
  await Storage.set('monthlyVisitorResetMonth', currentMonth)
}

// ── Monthly visitor reset ──

export async function checkMonthlyVisitorReset(): Promise<void> {
  const currentMonth = getCurrentMonthString()
  if (lastMonthlyVisitorResetMonth !== '' && lastMonthlyVisitorResetMonth !== currentMonth) {
    console.log('[Server] Monthly visitor reset for new month:', currentMonth)
    monthlyVisitorSessions.clear()
    setLastMonthlyVisitorResetMonth(currentMonth)
    await syncMonthlyVisitorAnalytics()
    console.log('[Server] Monthly visitor data reset completed')
  }
}

// ── Visitor tracking system (runs every 10s) ──

let visitorSyncTimer = 0

export function visitorTrackingServerSystem(dt: number): void {
  visitorSyncTimer += dt

  if (visitorSyncTimer >= 10.0) {
    visitorSyncTimer = 0

    flushPendingJoinNotifications()
    checkVisitorDailyReset().catch(e => console.error('[Server] checkVisitorDailyReset error:', e))
    checkMonthlyVisitorReset().catch(e => console.error('[Server] checkMonthlyVisitorReset error:', e))
    syncVisitorAnalytics().catch(e => console.error('[Server] syncVisitorAnalytics error:', e))
    syncMonthlyVisitorAnalytics().catch(e => console.error('[Server] syncMonthlyVisitorAnalytics error:', e))
  }
}

/** Restore monthly visitor session data from Storage. Called once during setupServer. */
export async function restoreMonthlyVisitorData(): Promise<void> {
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
}
