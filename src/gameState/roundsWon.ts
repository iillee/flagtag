import { engine } from '@dcl/sdk/ecs'
import { LeaderboardState, AllTimeLeaderboardState } from '../shared/components'

export interface LeaderboardEntry {
  userId: string
  name: string
  roundsWon: number
}

/** Addresses to hide from the in-game leaderboard display (data is still stored server-side). */
const HIDDEN_LEADERBOARD_ADDRESSES = [
  '0x1e93e534c5e26b01ed242410b43ae23dd0faa52b', // ile
  '0x874b9d062b060e004c3167974c42f5e6878fae0c', // tester
]

function isHiddenFromLeaderboard(entry: LeaderboardEntry): boolean {
  return HIDDEN_LEADERBOARD_ADDRESSES.includes(entry.userId.toLowerCase())
}

/** Read leaderboard from the synced LeaderboardState component (server writes it).
 *  Names are resolved server-side via AvatarBase scanning and persisted name directory. */
export function getLeaderboardEntries(): LeaderboardEntry[] {
  for (const [, lb] of engine.getEntitiesWith(LeaderboardState)) {
    if (!lb.json) return []
    try {
      const entries: LeaderboardEntry[] = JSON.parse(lb.json)
      const visible = entries.filter(e => !isHiddenFromLeaderboard(e))
      const originalIndex = new Map(visible.map((e, i) => [e.userId, i]))
      visible.sort((a, b) => {
        if (b.roundsWon !== a.roundsWon) return b.roundsWon - a.roundsWon
        return (originalIndex.get(a.userId) ?? 0) - (originalIndex.get(b.userId) ?? 0)
      })
      return visible
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
      const visible = entries.filter(e => !isHiddenFromLeaderboard(e))
      const originalIndex = new Map(visible.map((e, i) => [e.userId, i]))
      visible.sort((a, b) => {
        if (b.roundsWon !== a.roundsWon) return b.roundsWon - a.roundsWon
        return (originalIndex.get(a.userId) ?? 0) - (originalIndex.get(b.userId) ?? 0)
      })
      return visible
    } catch {
      return []
    }
  }
  return []
}
