import { engine } from '@dcl/sdk/ecs'
import { LeaderboardState, AllTimeLeaderboardState } from '../shared/components'

export interface LeaderboardEntry {
  userId: string
  name: string
  roundsWon: number
}

/** Addresses hidden from leaderboard display (still tracked server-side). */
const HIDDEN_ADDRESSES: Set<string> = new Set([
  '0x1e93e534c5e26b01ed242410b43ae23dd0faa52b', // ile
  '0x874b9d062b060e004c3167974c42f5e6878fae0c', // tester
])

// ── Cache: parse + sort only when the raw JSON changes ──
let _dailyCache: { json: string; result: LeaderboardEntry[] } = { json: '', result: [] }
let _allTimeCache: { json: string; result: LeaderboardEntry[] } = { json: '', result: [] }

function parseAndSort(json: string, cache: { json: string; result: LeaderboardEntry[] }): LeaderboardEntry[] {
  if (json === cache.json) return cache.result
  if (!json) { cache.json = json; cache.result = []; return [] }
  try {
    const entries: LeaderboardEntry[] = JSON.parse(json)
    const visible = entries.filter(e => !HIDDEN_ADDRESSES.has(e.userId.toLowerCase()))
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


/** Names hidden from all-time leaderboard display. */
const HIDDEN_NAMES: Set<string> = new Set(['ile', 'Tester'])

/** Read all-time leaderboard from the synced AllTimeLeaderboardState component.
 *  All-time uses compact format [{n,w}] to stay under CRDT size limits. */
export function getAllTimeLeaderboardEntries(): LeaderboardEntry[] {
  for (const [, lb] of engine.getEntitiesWith(AllTimeLeaderboardState)) {
    if (lb.json === _allTimeCache.json) return _allTimeCache.result
    if (!lb.json) { _allTimeCache.json = lb.json; _allTimeCache.result = []; return [] }
    try {
      const raw: any[] = JSON.parse(lb.json)
      // Support tuple [name,wins] (current), compact {n,w}, and full {userId,name,roundsWon}
      const entries: LeaderboardEntry[] = raw
        .map(e => {
          if (Array.isArray(e)) return { userId: '', name: e[0] || '', roundsWon: e[1] ?? 0 }
          return {
            userId: e.userId || e.u || '',
            name: e.name || e.n || '',
            roundsWon: e.roundsWon ?? e.w ?? 0,
          }
        })
        .filter(e => !HIDDEN_NAMES.has(e.name))
      entries.sort((a, b) => b.roundsWon - a.roundsWon)
      _allTimeCache.json = lb.json
      _allTimeCache.result = entries
      return entries
    } catch {
      _allTimeCache.json = lb.json
      _allTimeCache.result = []
      return []
    }
  }
  return []
}
