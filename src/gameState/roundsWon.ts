import { engine } from '@dcl/sdk/ecs'
import { LeaderboardState } from '../shared/components'
import { getKnownPlayerName } from './flagHoldTime'

export interface LeaderboardEntry {
  userId: string
  name: string
  roundsWon: number
}

/** Read leaderboard from the synced LeaderboardState component (server writes it).
 *  Overrides stored names with locally-known display names when available. */
export function getLeaderboardEntries(): LeaderboardEntry[] {
  for (const [, lb] of engine.getEntitiesWith(LeaderboardState)) {
    if (!lb.json) return []
    try {
      const entries: LeaderboardEntry[] = JSON.parse(lb.json)
      // Override server-stored names with client-side known names
      for (const entry of entries) {
        const localName = getKnownPlayerName(entry.userId)
        if (localName) {
          entry.name = localName
        }
      }
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
