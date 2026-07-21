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

export const CARRIER_CONFIRMATION_TTL_MS = 3000

export type InterpolationCarrierResolution = {
  carrierId: string
  confirmationExpired: boolean
}

/**
 * Prefer a recent server-confirmed carrier over CRDT. A stale CRDT value can
 * contain the previous carrier during a steal, so treating confirmation only as
 * a fallback for an empty CRDT value credits interpolation to the wrong player.
 */
export function resolveInterpolationCarrier(
  crdtCarrierId: string,
  confirmedCarrierId: string,
  confirmedAtMs: number,
  nowMs: number
): InterpolationCarrierResolution {
  const hasConfirmation = confirmedCarrierId.length > 0
  const confirmationIsFresh = hasConfirmation
    && nowMs - confirmedAtMs < CARRIER_CONFIRMATION_TTL_MS

  return {
    carrierId: confirmationIsFresh ? confirmedCarrierId : crdtCarrierId,
    confirmationExpired: hasConfirmation && !confirmationIsFresh
  }
}

/** Until the first heartbeat arrives, accept boot-time CRDT data for compatibility. */
export function isScoreFromActiveRound(scoreRoundId: string, activeRoundId: string): boolean {
  return activeRoundId.length === 0 || scoreRoundId === activeRoundId
}
