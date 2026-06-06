/**
 * leaderboard.ts — Leaderboard types, parsing, patching, reset logic, and name updates.
 * Imports from: serverState, persistence, shared/components
 */

import {
  leaderboardEntity, allTimeLeaderboardEntity, monthlyLeaderboardEntity,
  playerNames, visitorSessions, monthlyVisitorSessions,
  isRealName,
  lastLeaderboardResetDay, setLastLeaderboardResetDay
} from './serverState'
import { persistLeaderboard, persistAllTimeLeaderboard, persistMonthlyLeaderboard } from './persistence'
import { Storage } from '@dcl/sdk/server'
import {
  LeaderboardState, AllTimeLeaderboardState, MonthlyLeaderboardState,
  getCurrentMonthString
} from '../shared/components'

// ── Types ──

export type LeaderboardEntry = { userId: string; name: string; roundsWon: number }

// ── Pure helpers ──

/** Parse a leaderboard JSON string into entries (safe — returns [] on error). */
export function parseLeaderboardJson(json: string | undefined | null): LeaderboardEntry[] {
  if (!json) return []
  try { return JSON.parse(json) } catch { return [] }
}

/**
 * Increment roundsWon for each winning player in a leaderboard entry array.
 * Mutates in place for efficiency.
 */
export function incrementLeaderboardWins(
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
export function patchLeaderboardNames(entries: LeaderboardEntry[], userId: string, name: string): boolean {
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
export function patchAllLeaderboardNames(json: string, label: string): string {
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

// ── Reset logic ──

/**
 * Check and perform daily leaderboard reset at midnight UTC.
 * Accepts a callback for snapshotting the report before clearing (analytics concern).
 * Returns true if a reset occurred.
 */
export async function checkLeaderboardDailyReset(
  onReset?: (leaderboardJson: string) => Promise<void>
): Promise<boolean> {
  const now = new Date()
  const currentDay = now.toISOString().slice(0, 10) // YYYY-MM-DD format

  // Load last reset day from storage if not set
  if (lastLeaderboardResetDay === '') {
    const savedResetDay = await Storage.get<string>('lastLeaderboardResetDay')
    setLastLeaderboardResetDay(savedResetDay || currentDay)
  }

  // Reset at midnight UTC (00:00) - check if new day and we haven't reset today
  if (lastLeaderboardResetDay !== currentDay) {
    console.log('[Server] Daily leaderboard reset at midnight UTC for new day:', currentDay)

    // Snapshot leaderboard wins into pendingReport before clearing
    const lb = LeaderboardState.getOrNull(leaderboardEntity)
    const leaderboardJson = (lb && lb.json) ? lb.json : '[]'
    if (onReset) {
      await onReset(leaderboardJson)
    }

    setLastLeaderboardResetDay(currentDay)

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

/** Check and perform monthly leaderboard reset at the start of each month (UTC). */
export async function checkMonthlyLeaderboardReset(): Promise<void> {
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

// ── Name update (cross-cutting: leaderboards + visitor sessions) ──

/**
 * Update a player's display name across all leaderboards and visitor sessions.
 * Returns true if the name was actually changed.
 */
export function updatePlayerName(userId: string, name: string): boolean {
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

  // Update daily + monthly leaderboards (full format)
  const standardLbs: Array<{
    getState: () => { json?: string } | null
    getMutable: () => { json: string }
    persist: (json: string) => Promise<void>
  }> = [
    { getState: () => LeaderboardState.getOrNull(leaderboardEntity), getMutable: () => LeaderboardState.getMutable(leaderboardEntity), persist: persistLeaderboard },
    { getState: () => MonthlyLeaderboardState.getOrNull(monthlyLeaderboardEntity), getMutable: () => MonthlyLeaderboardState.getMutable(monthlyLeaderboardEntity), persist: persistMonthlyLeaderboard },
  ]
  for (const lb of standardLbs) {
    const state = lb.getState()
    if (!state?.json) continue
    const entries = parseLeaderboardJson(state.json)
    if (patchLeaderboardNames(entries, userId, name)) {
      const json = JSON.stringify(entries)
      lb.getMutable().json = json
      lb.persist(json).catch(e => console.error('[Server] persist leaderboard error:', e))
    }
  }

  // Update all-time leaderboard (compact {n,w} synced, full format in Storage)
  Storage.get<string>('allTimeLeaderboard').then(full => {
    if (!full) return
    const entries = parseLeaderboardJson(full)
    if (patchLeaderboardNames(entries, userId, name)) {
      const fullJson = JSON.stringify(entries)
      persistAllTimeLeaderboard(fullJson).catch(e => console.error('[Server] persist all-time error:', e))
      entries.sort((a, b) => b.roundsWon - a.roundsWon)
      const compact = entries.slice(0, 500).map(e => ({ n: e.name, w: e.roundsWon }))
      AllTimeLeaderboardState.getMutable(allTimeLeaderboardEntity).json = JSON.stringify(compact)
    }
  }).catch(e => console.error('[Server] all-time name patch error:', e))

  return true
}
