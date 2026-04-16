import { engine } from '@dcl/sdk/ecs'
import { LeaderboardState, AllTimeLeaderboardState } from '../shared/components'

export interface LeaderboardEntry {
  userId: string
  name: string
  roundsWon: number
}

/** Read leaderboard from the synced LeaderboardState component (server writes it).
 *  Names are resolved server-side via AvatarBase scanning and persisted name directory. */
export function getLeaderboardEntries(): LeaderboardEntry[] {
  for (const [, lb] of engine.getEntitiesWith(LeaderboardState)) {
    if (!lb.json) return []
    try {
      const entries: LeaderboardEntry[] = JSON.parse(lb.json)
      // Sort by most wins; on tie, preserve original order (whoever was on the board first stays on top)
      const originalIndex = new Map(entries.map((e, i) => [e.userId, i]))
      entries.sort((a, b) => {
        if (b.roundsWon !== a.roundsWon) return b.roundsWon - a.roundsWon
        return (originalIndex.get(a.userId) ?? 0) - (originalIndex.get(b.userId) ?? 0)
      })
      return entries
    } catch {
      return []
    }
  }
  return []
}

/** Read all-time leaderboard from the synced AllTimeLeaderboardState component. */
export function getAllTimeLeaderboardEntries(): LeaderboardEntry[] {
  for (const [, lb] of engine.getEntitiesWith(AllTimeLeaderboardState)) {
    if (!lb.json) return []
    try {
      const entries: LeaderboardEntry[] = JSON.parse(lb.json)
      const originalIndex = new Map(entries.map((e, i) => [e.userId, i]))
      entries.sort((a, b) => {
        if (b.roundsWon !== a.roundsWon) return b.roundsWon - a.roundsWon
        return (originalIndex.get(a.userId) ?? 0) - (originalIndex.get(b.userId) ?? 0)
      })
      return entries
    } catch {
      return []
    }
  }
  return []
}
