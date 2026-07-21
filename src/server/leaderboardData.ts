export type LeaderboardEntry = { userId: string; name: string; roundsWon: number }

function isLeaderboardEntry(value: unknown): value is LeaderboardEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry.userId === 'string'
    && entry.userId.length > 0
    && typeof entry.name === 'string'
    && Number.isSafeInteger(entry.roundsWon)
    && (entry.roundsWon as number) >= 0
}

/** Parse persisted leaderboard data without ever accepting a non-array or malformed entry. */
export function parseLeaderboardJsonStrict(json: string): LeaderboardEntry[] {
  const value = JSON.parse(json) as unknown
  if (!Array.isArray(value) || !value.every(isLeaderboardEntry)) {
    throw new Error('Leaderboard JSON has an invalid shape')
  }
  return value
}

/** Display-safe parser. Mutation paths must use parseLeaderboardJsonStrict instead. */
export function parseLeaderboardJsonSafe(json: string | undefined | null): LeaderboardEntry[] {
  if (!json) return []
  try {
    return parseLeaderboardJsonStrict(json)
  } catch {
    return []
  }
}

export function isValidLeaderboardJson(json: string | null): boolean {
  if (json === null) return true
  try {
    parseLeaderboardJsonStrict(json)
    return true
  } catch {
    return false
  }
}
