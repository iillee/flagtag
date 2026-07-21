/**
 * Merge replicated hold-time values with the highest authoritative values seen
 * this round. The authoritative map may introduce a missing key because dynamic
 * CRDT entities can arrive late or stall while the websocket heartbeat remains
 * current.
 */
export function mergeMonotonicHoldTimes(
  synced: Map<string, number>,
  authoritative: Map<string, number>
): void {
  for (const [playerId, seconds] of synced) {
    const highestSeen = authoritative.get(playerId) ?? 0
    if (seconds > highestSeen) authoritative.set(playerId, seconds)
  }

  for (const [playerId, seconds] of authoritative) {
    if (seconds > (synced.get(playerId) ?? 0)) synced.set(playerId, seconds)
  }
}
