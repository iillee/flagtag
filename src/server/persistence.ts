/**
 * persistence.ts — Storage get/set wrapper functions.
 * Handles saving and loading game state to/from Decentraland Storage.
 */

import { Transform } from '@dcl/sdk/ecs'
import { Storage } from '@dcl/sdk/server'
import { Flag } from '../shared/components'
import { getTodayDateString } from '../shared/components'
import {
  flagEntity, playerNames, visitorSessions, isRealName,
  lastVisitorResetDay, setLastVisitorResetDay,
} from './serverState'

// Serialize flag-state writes through a single chain. The many fire-and-forget callers
// (pickup, drop, steal, gravity) can otherwise put two Storage.set('flagState') in flight
// and land them out of order, persisting a stale state. Each queued write reads the LIVE
// flag state when it runs, so the last write always reflects the current state.
let flagPersistChain: Promise<void> = Promise.resolve()

export function persistFlagState(): Promise<void> {
  flagPersistChain = flagPersistChain.then(doPersistFlagState, doPersistFlagState)
  return flagPersistChain
}

async function doPersistFlagState(): Promise<void> {
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

export async function persistLeaderboard(json: string): Promise<void> {
  await Storage.set('leaderboard', json)
}

export async function persistAllTimeLeaderboard(json: string): Promise<void> {
  await Storage.set('allTimeLeaderboard', json)
}

export async function persistMonthlyLeaderboard(json: string): Promise<void> {
  await Storage.set('monthlyLeaderboard', json)
}

export async function persistPlayerNames(): Promise<void> {
  const obj: Record<string, string> = {}
  for (const [userId, name] of playerNames) {
    if (isRealName(name)) obj[userId] = name
  }
  await Storage.set('playerNames', JSON.stringify(obj))
}

export async function loadPlayerNames(): Promise<void> {
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

export async function persistVisitorData(visitorDataJson: string): Promise<void> {
  await Storage.set('visitorData', visitorDataJson)
  await Storage.set('lastVisitorResetDay', lastVisitorResetDay)
}

export async function loadVisitorData(): Promise<void> {
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
      setLastVisitorResetDay(savedResetDay)
      
      // Restore visitor data if it's from today
      const currentDay = getTodayDateString()
      if (lastVisitorResetDay === currentDay) {
        for (const record of visitorRecords) {
          // Support both old format (totalMinutes) and new format (totalSeconds)
          const seconds = record.totalSeconds != null
            ? record.totalSeconds
            : (record.totalMinutes || 0) * 60
          const recordKey = (record.userId || '').toLowerCase()
          // Use persisted name directory if available, fall back to stored visitor name
          const bestName = (playerNames.has(recordKey) && isRealName(playerNames.get(recordKey)!))
            ? playerNames.get(recordKey)!
            : record.name
          visitorSessions.set(recordKey, {
            name: bestName,
            sessionStartMs: 0, // Not currently online after server restart
            totalSecondsToday: seconds
          })
          if (isRealName(bestName)) {
            playerNames.set(recordKey, bestName)
          }
        }
        console.log('[Server] Restored visitor data for', currentDay, '- loaded', visitorRecords.length, 'visitors')
      } else {
        console.log('[Server] Visitor data was from', lastVisitorResetDay, 'but today is', currentDay, '- clearing for new day (report handled via pendingReport snapshot)')
        // Clear for the new day — the pending report snapshot was already saved during leaderboard reset
        visitorSessions.clear()
        setLastVisitorResetDay(currentDay)
      }
    } catch (e) {
      console.error('[Server] Failed to load visitor data:', e)
      setLastVisitorResetDay(getTodayDateString())
    }
  } else {
    setLastVisitorResetDay(getTodayDateString())
    console.log('[Server] No visitor data found, starting fresh for', lastVisitorResetDay)
  }
}
