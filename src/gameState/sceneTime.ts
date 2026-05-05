import { engine } from '@dcl/sdk/ecs'
import { VisitorAnalytics, MonthlyVisitorAnalytics } from '../shared/components'

export type VisitorRecord = { userId: string; name: string; isOnline: boolean; totalSeconds: number }

// ── Cache: parse only when the raw JSON changes ──
let _dailyVisitorCache: { json: string; result: VisitorRecord[] } = { json: '', result: [] }
let _monthlyVisitorCache: { json: string; result: VisitorRecord[] } = { json: '', result: [] }

function parseVisitors(json: string, cache: { json: string; result: VisitorRecord[] }): VisitorRecord[] {
  if (json === cache.json) return cache.result
  try {
    const raw = JSON.parse(json)
    const result: VisitorRecord[] = raw.map((v: any) => ({
      userId: v.userId,
      name: v.name,
      isOnline: v.isOnline,
      totalSeconds: v.totalSeconds ?? (v.totalMinutes ? v.totalMinutes * 60 : 0)
    }))
    cache.json = json
    cache.result = result
    return result
  } catch (e) {
    console.error('[Client] Failed to parse visitor data:', e)
    cache.json = json
    cache.result = []
    return []
  }
}

/** Read visitor data from server-synced VisitorAnalytics component. */
export function getAllVisitors(): VisitorRecord[] {
  for (const [, analytics] of engine.getEntitiesWith(VisitorAnalytics)) {
    return parseVisitors(analytics.visitorDataJson, _dailyVisitorCache)
  }
  return []
}

export function getTodayVisitorCount(): number {
  for (const [, analytics] of engine.getEntitiesWith(VisitorAnalytics)) {
    return analytics.totalUniqueVisitors
  }
  return 0
}

export function getCurrentOnlineCount(): number {
  for (const [, analytics] of engine.getEntitiesWith(VisitorAnalytics)) {
    return analytics.onlineCount
  }
  return 0
}

// ── Monthly visitor data ──

export function getMonthlyVisitors(): VisitorRecord[] {
  for (const [, analytics] of engine.getEntitiesWith(MonthlyVisitorAnalytics)) {
    return parseVisitors(analytics.visitorDataJson, _monthlyVisitorCache)
  }
  return []
}

export function getMonthlyVisitorCount(): number {
  for (const [, analytics] of engine.getEntitiesWith(MonthlyVisitorAnalytics)) {
    return analytics.totalUniqueVisitors
  }
  return 0
}

export function getMonthlyOnlineCount(): number {
  for (const [, analytics] of engine.getEntitiesWith(MonthlyVisitorAnalytics)) {
    return analytics.onlineCount
  }
  return 0
}
