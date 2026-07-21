const SESSION_ENTROPY_RANGE = 0x1_0000_0000

/** Create a server-lifetime nonce so restarts inside one timer boundary remain distinct. */
export function createScoreSessionId(startedAtMs: number, randomValue: number): string {
  const timestamp = Number.isFinite(startedAtMs) ? Math.max(0, Math.floor(startedAtMs)) : 0
  const normalizedRandom = Number.isFinite(randomValue)
    ? Math.min(Math.max(randomValue, 0), 1 - Number.EPSILON)
    : 0
  const entropy = Math.floor(normalizedRandom * SESSION_ENTROPY_RANGE)
  return `${timestamp.toString(36)}-${entropy.toString(36)}`
}

/** Build the identifier stamped onto every score entity for one server round. */
export function buildScoreRoundId(sessionId: string, roundEndTimeMs: number): string {
  const boundary = Number.isFinite(roundEndTimeMs) ? Math.max(0, Math.floor(roundEndTimeMs)) : 0
  return `${sessionId}:${boundary}`
}
