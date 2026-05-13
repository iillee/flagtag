/**
 * analytics.ts — Visitor tracking, Discord webhooks, and daily reports.
 * Imports from serverState, persistence, and shared components.
 */

import { Storage, EnvVar } from '@dcl/sdk/server'
import {
  visitorSessions, monthlyVisitorSessions, playerNames, isRealName,
  visitorAnalyticsEntity, monthlyVisitorAnalyticsEntity, leaderboardEntity,
  lastVisitorResetDay, setLastVisitorResetDay,
  lastMonthlyVisitorResetMonth, setLastMonthlyVisitorResetMonth,
  hourlyPeakConcurrent, setHourlyPeakConcurrent,
  peakConcurrent, setPeakConcurrent, peakConcurrentTime, setPeakConcurrentTime
} from './serverState'
import { persistVisitorData } from './persistence'
import {
  VisitorAnalytics, MonthlyVisitorAnalytics, LeaderboardState,
  getTodayDateString, getCurrentMonthString
} from '../shared/components'

// ── Module-local state ──

let DISCORD_WEBHOOK_URL = ''
let dailyReportSentForDay = ''

// ── Concurrent user tracking ──

export function updateConcurrentTracking(): void {
  const onlineCount = Array.from(visitorSessions.values()).filter(v => v.sessionStartMs > 0).length
  const now = new Date()
  const hour = now.getUTCHours()
  if (onlineCount > hourlyPeakConcurrent[hour]) {
    hourlyPeakConcurrent[hour] = onlineCount
  }
  if (onlineCount > peakConcurrent) {
    setPeakConcurrent(onlineCount)
    const hh = String(now.getUTCHours()).padStart(2, '0')
    const mm = String(now.getUTCMinutes()).padStart(2, '0')
    setPeakConcurrentTime(`${hh}:${mm}`)
  }
}

// ── Discord webhook loading ──

export async function loadDiscordWebhookUrl(): Promise<void> {
  DISCORD_WEBHOOK_URL = (await EnvVar.get('DISCORD_WEBHOOK_URL')) || ''
  if (!DISCORD_WEBHOOK_URL) {
    console.log('[Server] ⚠️ DISCORD_WEBHOOK_URL env var not set — Discord reports will be disabled')
  } else {
    console.log('[Server] ✅ Discord webhook URL loaded from EnvVar')
  }
}

// ── Daily report building ──

export function buildDailyReport(leaderboardJson: string): any {
  const now = Date.now()
  const winsMap = new Map<string, number>()
  try {
    const entries = JSON.parse(leaderboardJson) as Array<{ userId: string; roundsWon: number }>
    for (const e of entries) winsMap.set(e.userId.toLowerCase(), e.roundsWon)
  } catch { /* ignore */ }

  const users = Array.from(visitorSessions.entries()).map(([userId, data]) => {
    let totalSeconds = data.totalSecondsToday
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

// ── Pending report snapshot/send ──

export async function snapshotPendingReport(leaderboardJson: string): Promise<void> {
  try {
    const existing = await Storage.get<string>('pendingReport')
    if (existing) {
      console.log('[Server] Pending report already exists, skipping snapshot')
      return
    }

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

export async function sendPendingReport(): Promise<void> {
  try {
    if (!DISCORD_WEBHOOK_URL) return
    const { getRealm } = await import('~system/Runtime')
    const realm = await getRealm({})
    if (realm.realmInfo?.isPreview) return

    const pendingJson = await Storage.get<string>('pendingReport')
    if (!pendingJson) return

    const report = JSON.parse(pendingJson)
    console.log('[Server] 📬 Found pending report for', report.date, '- sending now')

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
      dailyReportSentForDay = report.date
      await Storage.set('dailyReportSentForDay', report.date)
    } else {
      console.error('[Server] ❌ Deferred report webhook failed:', res.status)
    }
  } catch (err) {
    console.error('[Server] Failed to send pending report:', err)
  }
}

// ── Full daily analytics Discord report ──

export async function sendDailyAnalyticsToDiscord(): Promise<void> {
  try {
    if (!DISCORD_WEBHOOK_URL) {
      console.log('[Server] Skipping Discord webhook — no URL configured')
      return
    }
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

    const summaryLines = [
      `📊 **Flag Tag Daily Report** — ${report.date}`,
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

async function sendDiscordFallbackText(summary: string, users: Array<{ address: string; name: string; time_seconds: number; flags: number }>): Promise<void> {
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: summary + '\n⚠️ _File attachment failed — sending as text._' })
    })

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

// ── Daily report sent tracking ──

export async function loadDailyReportSentDay(): Promise<void> {
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

// ── Pre-midnight report ──

export async function checkPreMidnightReport(): Promise<void> {
  const now = new Date()
  const currentDay = now.toISOString().slice(0, 10)

  if (dailyReportSentForDay === currentDay) return

  const hour = now.getUTCHours()
  if (hour === 23) {
    console.log('[Server] 📊 Sending pre-midnight daily analytics report for', currentDay)
    dailyReportSentForDay = currentDay
    await Storage.set('dailyReportSentForDay', currentDay)
    await sendDailyAnalyticsToDiscord()
  }
}

// ── Daily visitor reset ──

export async function checkVisitorDailyReset(): Promise<boolean> {
  const currentDay = getTodayDateString()

  if (lastVisitorResetDay !== currentDay) {
    console.log('[Server] Daily visitor reset at midnight UTC for new day:', currentDay)

    if (dailyReportSentForDay !== lastVisitorResetDay) {
      console.log('[Server] Pre-midnight report was missed, snapshotting and sending before reset')
      const lb = LeaderboardState.getOrNull(leaderboardEntity)
      const leaderboardJson = (lb && lb.json) ? lb.json : '[]'
      await snapshotPendingReport(leaderboardJson)
      dailyReportSentForDay = lastVisitorResetDay
      await Storage.set('dailyReportSentForDay', lastVisitorResetDay)
      await sendPendingReport()
    }

    setLastVisitorResetDay(currentDay)

    visitorSessions.clear()
    setHourlyPeakConcurrent(new Array(24).fill(0))
    setPeakConcurrent(0)
    setPeakConcurrentTime('')

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

    checkPreMidnightReport().catch(e => console.error('[Server] checkPreMidnightReport error:', e))
    checkVisitorDailyReset().catch(e => console.error('[Server] checkVisitorDailyReset error:', e))
    checkMonthlyVisitorReset().catch(e => console.error('[Server] checkMonthlyVisitorReset error:', e))
    syncVisitorAnalytics().catch(e => console.error('[Server] syncVisitorAnalytics error:', e))
    syncMonthlyVisitorAnalytics().catch(e => console.error('[Server] syncMonthlyVisitorAnalytics error:', e))
  }
}
