/**
 * leaderboard.ts — Leaderboard types, parsing, patching, reset logic, and name updates.
 * Imports from: serverState, persistence, shared/components
 */

import {
  leaderboardEntity, allTimeLeaderboardEntity,
  playerNames, visitorSessions, monthlyVisitorSessions,
  isRealName,
  lastLeaderboardResetDay, setLastLeaderboardResetDay
} from './serverState'
import { persistLeaderboard, persistAllTimeLeaderboard } from './persistence'
import { storageGet, storageSet } from './safeStorage'
import {
  LeaderboardState, AllTimeLeaderboardState
} from '../shared/components'
import {
  type LeaderboardEntry,
  parseLeaderboardJsonSafe,
  parseLeaderboardJsonStrict,
} from './leaderboardData'
import { AsyncSerialQueue } from './asyncSerialQueue'
import { commitDailyLeaderboardReset } from './leaderboardLifecycle'

// ── Types ──

export type { LeaderboardEntry } from './leaderboardData'

// ── Daily leaderboard load state ──
// False until the daily board has been successfully seeded from Storage. While false,
// the round-end daily update must not persist: the synced state was seeded with a
// false-empty '[]' after a failed boot read, and persisting increments computed from
// it would wipe the stored board — the exact hazard the strict reads exist to prevent.
// Boot and round reset paths attempt a strict recovery before any reset/update until
// one succeeds. (updatePlayerName is already safe while false: an empty board has no
// entries to patch, so it never persists.)
let dailyLeaderboardLoaded = false

export function markDailyLeaderboardLoaded(): void {
  dailyLeaderboardLoaded = true
}

export function isDailyLeaderboardLoaded(): boolean {
  return dailyLeaderboardLoaded
}

/** Strictly recover the full daily board before any reset or round update may write it. */
export async function recoverDailyLeaderboard(): Promise<void> {
  if (dailyLeaderboardLoaded) return
  const storedRaw = (await storageGet<string>('leaderboard')) ?? '[]'
  parseLeaderboardJsonStrict(storedRaw)
  const storedDaily = patchAllLeaderboardNames(storedRaw, 'leaderboard')
  LeaderboardState.getMutable(leaderboardEntity).json = storedDaily
  markDailyLeaderboardLoaded()
  console.log('[Server] ✅ Daily leaderboard recovered and validated from Storage')
}

// ── Pure helpers ──

/** Parse a leaderboard JSON string into entries (safe — returns [] on error). */
export function parseLeaderboardJson(json: string | undefined | null): LeaderboardEntry[] {
  return parseLeaderboardJsonSafe(json)
}

// All full all-time leaderboard read-modify-writes share this queue. Name changes and
// round wins used to race through independent Storage reads and the later stale write
// could erase a win that had already landed.
const allTimeMutationQueue = new AsyncSerialQueue()

// Compact wire format: array of [name, wins] tuples. Saves ~35% vs {n,w} objects
// and keeps the synced CRDT payload comfortably under the ~13KB per-message limit.
// Capped to top 250 — deeper ranks are not shown in-world (paginated UI stops there).
const ALLTIME_SYNC_CAP = 250
export function syncAllTimeLeaderboard(entries: LeaderboardEntry[]): void {
  const compact = [...entries]
    .sort((a, b) => b.roundsWon - a.roundsWon)
    .slice(0, ALLTIME_SYNC_CAP)
    .map(e => [e.name, e.roundsWon] as [string, number])
  const json = JSON.stringify(compact)
  console.log('[Server] All-time leaderboard sync:', entries.length, 'total,', compact.length, 'synced,', json.length, 'bytes')
  AllTimeLeaderboardState.getMutable(allTimeLeaderboardEntity).json = json
}

function mutateAllTimeLeaderboard(mutate: (entries: LeaderboardEntry[]) => boolean): Promise<void> {
  const run = async () => {
    const full = (await storageGet<string>('allTimeLeaderboard')) ?? '[]'
    // Strict on mutation paths: malformed persisted data is preserved for diagnosis,
    // never silently replaced with a valid-looking empty board.
    const entries = parseLeaderboardJsonStrict(full)
    if (!mutate(entries)) return
    await persistAllTimeLeaderboard(JSON.stringify(entries))
    syncAllTimeLeaderboard(entries)
  }
  return allTimeMutationQueue.run(run)
}

export function incrementAllTimeLeaderboardWins(
  winners: { userId: string; seconds: number }[],
  maxSeconds: number
): Promise<void> {
  return mutateAllTimeLeaderboard(entries => {
    incrementLeaderboardWins(entries, winners, maxSeconds)
    return true
  })
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

/** Check and perform the daily leaderboard reset at midnight UTC. */
export async function checkLeaderboardDailyReset(): Promise<boolean> {
  if (!dailyLeaderboardLoaded) {
    throw new Error('Daily leaderboard is not loaded; refusing to reset persisted data')
  }
  const now = new Date()
  const currentDay = now.toISOString().slice(0, 10) // YYYY-MM-DD format

  // Load last reset day from storage if not set
  if (lastLeaderboardResetDay === '') {
    const savedResetDay = await storageGet<string>('lastLeaderboardResetDay')
    setLastLeaderboardResetDay(savedResetDay || currentDay)
  }

  // Reset at midnight UTC (00:00) - check if new day and we haven't reset today
  if (lastLeaderboardResetDay !== currentDay) {
    console.log('[Server] Daily leaderboard reset at midnight UTC for new day:', currentDay)

    // Both Storage writes must land before the CRDT or in-memory reset marker is
    // published. A partial failure remains retryable and blocks this round's update.
    await commitDailyLeaderboardReset({
      persistEmptyLeaderboard: () => persistLeaderboard('[]'),
      persistResetDay: () => storageSet('lastLeaderboardResetDay', currentDay),
      publishEmptyLeaderboard: () => {
        LeaderboardState.getMutable(leaderboardEntity).json = '[]'
      },
      markResetDay: () => setLastLeaderboardResetDay(currentDay),
    })

    console.log('[Server] Leaderboard reset completed')
    return true
  }

  return false
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

  // Update the in-memory daily leaderboard. The durable player-name directory is
  // persisted by the caller and patches leaderboard names on boot, so writing the
  // whole daily board here is unnecessary and could race a round-end win persist.
  const standardLbs: Array<{
    getState: () => { json?: string } | null
    getMutable: () => { json: string }
  }> = [
    { getState: () => LeaderboardState.getOrNull(leaderboardEntity), getMutable: () => LeaderboardState.getMutable(leaderboardEntity) },
  ]
  for (const lb of standardLbs) {
    const state = lb.getState()
    if (!state?.json) continue
    const entries = parseLeaderboardJson(state.json)
    if (patchLeaderboardNames(entries, userId, name)) {
      const json = JSON.stringify(entries)
      lb.getMutable().json = json
    }
  }

  // Update all-time leaderboard (compact {n,w} synced, full format in Storage)
  mutateAllTimeLeaderboard(entries => patchLeaderboardNames(entries, userId, name))
    .catch(e => console.error('[Server] all-time name patch error:', e))

  return true
}
