/**
 * analytics.ts — Visitor tracking, Discord webhook (player join notifications).
 */

import { Storage, EnvVar } from '@dcl/sdk/server'
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

// ── Discord webhook loading ──

export async function loadDiscordWebhookUrl(): Promise<void> {
  DISCORD_WEBHOOK_URL = (await EnvVar.get('DISCORD_WEBHOOK_URL')) || ''
  if (!DISCORD_WEBHOOK_URL) {
    console.log('[Server] ⚠️ DISCORD_WEBHOOK_URL env var not set — Discord notifications disabled')
  } else {
    console.log('[Server] ✅ Discord webhook URL loaded from EnvVar')
  }
}

// ── Player join Discord notification ──

export async function sendPlayerJoinToDiscord(playerName: string, address: string, onlineCount: number): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) return
  try {
    const { getRealm } = await import('~system/Runtime')
    const realm = await getRealm({})
    if (realm.realmInfo?.isPreview) return

    const content = `👋 **${playerName}** joined Flag Tag (${address.slice(0, 6)}…${address.slice(-4)}) — **${onlineCount}** online`
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })
  } catch (err) {
    console.error('[Server] Discord join notification failed:', err)
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
