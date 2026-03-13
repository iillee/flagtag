import { getPlayer } from '@dcl/sdk/players'
import { isServer } from '@dcl/sdk/network'
import { engine } from '@dcl/sdk/ecs'
import { VisitorAnalytics } from '../shared/components'

/** Client-side visitor tracking - now reads from server-synced data */

/** Add player when they enter the scene - server handles tracking automatically */
export function addPlayerSession(userId: string, name: string): void {
  // Server now handles visitor tracking automatically
  // This function kept for compatibility but does nothing on client
  if (!isServer()) {
    console.log('[Client] Player session start (tracked server-side):', name)
  }
}

/** Remove player when they leave the scene - server handles tracking automatically */
export function removePlayerSession(userId: string): void {
  // Server now handles visitor tracking automatically
  // This function kept for compatibility but does nothing on client
  if (!isServer()) {
    console.log('[Client] Player session end (tracked server-side):', userId.slice(0, 8))
  }
}

/** Get total minutes for a player from server data */
export function getPlayerTotalMinutes(userId: string): number {
  const visitors = getAllVisitors()
  const visitor = visitors.find(v => v.userId === userId)
  return visitor ? visitor.totalMinutes : 0
}

/** Get all visitors from server-synced data */
export function getAllVisitors(): Array<{userId: string, name: string, isOnline: boolean, totalMinutes: number}> {
  // Read from server-synced VisitorAnalytics component
  for (const [, analytics] of engine.getEntitiesWith(VisitorAnalytics)) {
    try {
      const visitorData = JSON.parse(analytics.visitorDataJson)
      return visitorData.map((v: any) => ({
        userId: v.userId,
        name: v.name,
        isOnline: v.isOnline,
        totalMinutes: v.totalMinutes
      }))
    } catch (e) {
      console.error('[Client] Failed to parse visitor data:', e)
      return []
    }
  }
  
  // Fallback if no server data available yet
  return []
}

/** Get unique visitor count for today from server data */
export function getTodayVisitorCount(): number {
  for (const [, analytics] of engine.getEntitiesWith(VisitorAnalytics)) {
    return analytics.totalUniqueVisitors
  }
  return 0
}

/** Get current online player count from server data */
export function getCurrentOnlineCount(): number {
  for (const [, analytics] of engine.getEntitiesWith(VisitorAnalytics)) {
    return analytics.onlineCount
  }
  return 0
}