/**
 * Merge replicated hold-time values with the highest displayed values seen this
 * round (the monotonic display clamp). The clamp map may introduce a missing key
 * because a player's dynamic CRDT entity can arrive late or stall while their
 * best displayed value should hold.
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

// (isScoreFromActiveRound removed 2026-08-19 with the flagHeartbeat, its only round-id
// source. Cross-round filtering now relies on the server zeroing + re-stamping every
// PlayerFlagHoldTime entity at round end.)

/**
 * Max seconds the displayed score may run ahead of the last CRDT-anchored value.
 *
 * Normal play re-anchors every HOLD_TIME_SYNC_INTERVAL (~2s), so honest interpolation never
 * approaches this. Only two situations do, and both should freeze rather than invent: a stalled
 * PlayerFlagHoldTime CRDT, and a carrier that ONLY a stale Flag CRDT still claims exists (a
 * voluntary drop whose CRDT never propagated). Before the flagHeartbeat was removed, its 1Hz
 * re-anchor corrected both within seconds; nothing does now, and the monotonic display clamp
 * would lock any overshoot in for the rest of the round.
 */
export const INTERPOLATION_UNANCHORED_CAP_SEC = 12

/**
 * Seconds of local interpolation to add on top of the last anchored value — elapsed time,
 * capped. See INTERPOLATION_UNANCHORED_CAP_SEC. Non-finite or negative elapsed contributes
 * nothing rather than moving the score backwards.
 */
export function cappedInterpolationSeconds(
  elapsedSec: number,
  capSec: number = INTERPOLATION_UNANCHORED_CAP_SEC
): number {
  if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) return 0
  return elapsedSec > capSec ? capSec : elapsedSec
}

/**
 * Whether a replicated value BELOW the last known one proves the round actually reset — the
 * only condition under which the monotonic display clamp may be cleared outside the WS
 * round-end signal.
 *
 * Requires the new value to be nonzero. Zero is ambiguous in exactly the way that matters: it
 * is what a stalled entity reads, and what an ABSENT entity reads (a per-frame possibility
 * under the entity churn this scene has a documented history of). Treating either as a reset
 * wipes the clamp for EVERY player — collapsing precisely the rows the clamp exists to hold up
 * — so a zero must mean "no information", never "reset".
 */
export function isTrueScoreReset(newSeconds: number, lastKnownSeconds: number): boolean {
  return Number.isFinite(newSeconds) && newSeconds > 0 && newSeconds < lastKnownSeconds
}
