/**
 * dropPrediction.ts - client-side prediction bookkeeping for banana/bomb drops.
 *
 * The dropping player spawns a local visual the instant they press drop and
 * tags it with a nonce sent in requestBanana. The server echoes the nonce in
 * bananaDropped / bombDropped (adopt the prediction) or bananaDenied (remove
 * it). Unconfirmed predictions are removed after DROP_PREDICTION_TIMEOUT_MS.
 * Gameplay (hits, explosions) stays server-authoritative.
 */

export const DROP_PREDICTION_TIMEOUT_MS = 2000
/** Server pos within this distance of the prediction: keep the predicted pose (no visible snap). */
export const DROP_PREDICTION_SNAP_EPS_M = 0.5

let nonceCounter = 0

/** Non-zero, increasing per client. 0 means "no prediction" on the wire. */
export function nextDropNonce(): number {
  nonceCounter = (nonceCounter % 2_000_000_000) + 1
  return nonceCounter
}

export function isPredictionExpired(createdAtMs: number, nowMs: number): boolean {
  return nowMs - createdAtMs > DROP_PREDICTION_TIMEOUT_MS
}

/** Index of the pending prediction with this nonce, or -1. nonce 0 never matches. */
export function findPrediction<T extends { nonce: number }>(list: readonly T[], nonce: number | undefined): number {
  if (!nonce) return -1
  for (let i = 0; i < list.length; i++) if (list[i].nonce === nonce) return i
  return -1
}

/** True when the authoritative XZ differs enough from the prediction to snap to it. */
export function needsServerSnap(px: number, pz: number, sx: number, sz: number): boolean {
  const dx = px - sx, dz = pz - sz
  return dx * dx + dz * dz > DROP_PREDICTION_SNAP_EPS_M * DROP_PREDICTION_SNAP_EPS_M
}
