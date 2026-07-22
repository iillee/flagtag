/**
 * persistence.ts — Storage get/set wrapper functions.
 * Handles saving and loading game state to/from Decentraland Storage.
 */

import { storageGet, storageSet } from './safeStorage'
import { getTodayDateString } from '../shared/components'
import {
  playerNames, visitorSessions, isRealName,
  lastVisitorResetDay, setLastVisitorResetDay,
} from './serverState'

// NOTE: Flag state is intentionally NOT persisted to Storage.
// The flag Transform + Flag component are already CRDT-synced to all clients via
// syncEntity() in server.ts, which is the only replication the running scene needs.
// Persisting to Storage was only used to restore mid-round flag state after a server
// restart, but nothing else about the round survives a restart (hold-time accumulators,
// round timer, projectiles, ghosts, player sessions) so a "resumed" round produced a
// half-consistent state and was a suspected contributor to the "flag stuck" bug
// (KNOWN_BUGS.md Bug 2a). Boot now always initializes the flag at AtBase / spawn.
// Removing this dropped ~75-85% of the scene's total Storage write volume.

export async function persistLeaderboard(json: string): Promise<void> {
  await storageSet('leaderboard', json)
}

export async function persistAllTimeLeaderboard(json: string): Promise<void> {
  await storageSet('allTimeLeaderboard', json)
}

export async function persistMonthlyLeaderboard(json: string): Promise<void> {
  await storageSet('monthlyLeaderboard', json)
}

export async function persistPlayerNames(): Promise<void> {
  const obj: Record<string, string> = {}
  for (const [userId, name] of playerNames) {
    if (isRealName(name)) obj[userId] = name
  }
  await storageSet('playerNames', JSON.stringify(obj))
}

export async function loadPlayerNames(): Promise<void> {
  try {
    const saved = await storageGet<string>('playerNames')
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

let lastWrittenVisitorResetDay: string | null = null

export async function persistVisitorData(visitorDataJson: string): Promise<void> {
  await storageSet('visitorData', visitorDataJson)
  // The reset day only changes once a day — don't rewrite it on every flush.
  if (lastVisitorResetDay !== lastWrittenVisitorResetDay) {
    await storageSet('lastVisitorResetDay', lastVisitorResetDay)
    lastWrittenVisitorResetDay = lastVisitorResetDay
  }
}

export async function loadVisitorData(): Promise<void> {
  let savedData: string | null = null
  let savedResetDay: string | null = null
  
  try {
    savedData = await storageGet<string>('visitorData')
    savedResetDay = await storageGet<string>('lastVisitorResetDay')
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
        console.log('[Server] Visitor data was from', lastVisitorResetDay, 'but today is', currentDay, '- clearing for new day')
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
