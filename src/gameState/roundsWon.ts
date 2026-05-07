import { engine } from '@dcl/sdk/ecs'
import { LeaderboardState, AllTimeLeaderboardState, MonthlyLeaderboardState } from '../shared/components'

export interface LeaderboardEntry {
  userId: string
  name: string
  roundsWon: number
}

/** No addresses are hidden from the leaderboard — all players are shown. */

// ── Cache: parse + sort only when the raw JSON changes ──
let _dailyCache: { json: string; result: LeaderboardEntry[] } = { json: '', result: [] }
let _monthlyCache: { json: string; result: LeaderboardEntry[] } = { json: '', result: [] }
let _allTimeCache: { json: string; result: LeaderboardEntry[] } = { json: '', result: [] }

function parseAndSort(json: string, cache: { json: string; result: LeaderboardEntry[] }): LeaderboardEntry[] {
  if (json === cache.json) return cache.result
  if (!json) { cache.json = json; cache.result = []; return [] }
  try {
    const entries: LeaderboardEntry[] = JSON.parse(json)
    const visible = entries
    const originalIndex = new Map(visible.map((e, i) => [e.userId, i]))
    visible.sort((a, b) => {
      if (b.roundsWon !== a.roundsWon) return b.roundsWon - a.roundsWon
      return (originalIndex.get(a.userId) ?? 0) - (originalIndex.get(b.userId) ?? 0)
    })
    cache.json = json
    cache.result = visible
    return visible
  } catch {
    cache.json = json
    cache.result = []
    return []
  }
}

/** Read leaderboard from the synced LeaderboardState component (server writes it). */
export function getLeaderboardEntries(): LeaderboardEntry[] {
  for (const [, lb] of engine.getEntitiesWith(LeaderboardState)) {
    return parseAndSort(lb.json, _dailyCache)
  }
  return []
}

/** Read monthly leaderboard from the synced MonthlyLeaderboardState component. */
export function getMonthlyLeaderboardEntries(): LeaderboardEntry[] {
  for (const [, lb] of engine.getEntitiesWith(MonthlyLeaderboardState)) {
    return parseAndSort(lb.json, _monthlyCache)
  }
  return []
}

/** Read all-time leaderboard from the synced AllTimeLeaderboardState component. */
export function getAllTimeLeaderboardEntries(): LeaderboardEntry[] {
  for (const [, lb] of engine.getEntitiesWith(AllTimeLeaderboardState)) {
    return parseAndSort(lb.json, _allTimeCache)
  }
  return []
}
