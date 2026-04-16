import { engine } from '@dcl/sdk/ecs'
import { VisitorAnalytics } from '../shared/components'

/** Read visitor data from server-synced VisitorAnalytics component. */

export function getAllVisitors(): Array<{userId: string, name: string, isOnline: boolean, totalSeconds: number}> {
  for (const [, analytics] of engine.getEntitiesWith(VisitorAnalytics)) {
    try {
      const visitorData = JSON.parse(analytics.visitorDataJson)
      return visitorData.map((v: any) => ({
        userId: v.userId,
        name: v.name,
        isOnline: v.isOnline,
        totalSeconds: v.totalSeconds ?? (v.totalMinutes ? v.totalMinutes * 60 : 0)
      }))
    } catch (e) {
      console.error('[Client] Failed to parse visitor data:', e)
      return []
    }
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
