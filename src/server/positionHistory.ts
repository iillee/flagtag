/**
 * positionHistory.ts — Rolling per-player position samples and the lag-forgiving proximity
 * scan that reads them.
 *
 * Pure module: no engine imports, and deliberately no `Vector3` in the public surface, so
 * the scan stays unit-testable under jest (mirroring stealCandidate.ts / ghostTargeting.ts).
 * serverState.ts owns the per-address Map, the clock, and the Transform reads; every
 * per-sample decision lives here.
 *
 * Consumers: combat's lag-forgiving hit checks (a projectile that would have hit the victim
 * ~300ms ago still counts). NOT the proximity steal — see the note in flagLogic.ts on why a
 * lookback is wrong there.
 */

/** A point in world space. Structural so this module needs no `Vector3` import. */
export interface Point3 { x: number; y: number; z: number }

export interface PosSample extends Point3 { t: number }

/** How much history to keep per player. Bounds every caller's usable lookback. */
export const POS_HISTORY_MAX_MS = 500

/**
 * Append `sample` and drop everything older than `cutoffT` from the front. Mutates
 * `samples` in place — a per-player time-windowed deque owned by the caller (not a ring
 * buffer: there is no fixed capacity and no wraparound).
 *
 * The freshly pushed sample is itself subject to the trim, so a caller passing a `cutoffT`
 * newer than `sample.t` ends up with an empty buffer. Callers derive both from the same
 * clock reading, so that does not arise in practice.
 *
 * Samples are appended in non-decreasing time order, which is what lets
 * anySampleWithinRadius stop scanning at the first sample it finds behind a cutoff.
 */
export function pushSample(samples: PosSample[], sample: PosSample, cutoffT: number): void {
  samples.push(sample)
  while (samples.length > 0 && samples[0].t < cutoffT) samples.shift()
}

/**
 * Reject the parameter combinations that would make a proximity test meaningless, so both
 * entry points below fail CLOSED (nobody in range) rather than open.
 *
 * This matters because the natural failure is open, not closed: `s.t < NaN` is false, so a
 * non-finite `cutoffT` would skip the break, scan the entire buffer, and silently ignore the
 * caller's lookback window. A negative radius is worse than useless — comparing squared
 * magnitudes effectively takes `abs(radius)`, so it would report a hit inside `|radius|`.
 * (Only the live-position fallback previously used `Vector3.distance(...) < radius`, which
 * rejected a negative radius outright; the history scan always compared squared magnitudes
 * and so always had this behaviour. The guard makes both branches deny.)
 *
 * Same posture as isRateLimited in cooldownValidation.ts: corrupt inputs deny, never grant.
 */
function proximityInputsUsable(radius: number, cutoffT: number): boolean {
  return Number.isFinite(cutoffT) && Number.isFinite(radius) && radius >= 0
}

/**
 * True if any sample at or after `cutoffT` lies strictly within `radius` of (tx, ty, tz).
 * Returns false for unusable inputs — see proximityInputsUsable.
 *
 * The `cutoffT` comparison is what enforces the caller's lookback: without it, an in-radius
 * sample from outside the window could authorize a hit. Scanning newest-first and *breaking*
 * (rather than continuing) at the first out-of-window sample is purely an optimization that
 * time-ordered samples make safe — it bounds the walk to the window instead of the whole
 * buffer, and cannot change the result.
 *
 * Distance is full 3D, including Y. A player directly above the target at the same XZ is
 * therefore NOT within radius, which is what stops someone on a roof from counting as
 * adjacent to a player below.
 */
export function anySampleWithinRadius(
  samples: readonly PosSample[],
  tx: number, ty: number, tz: number,
  radius: number,
  cutoffT: number
): boolean {
  if (!proximityInputsUsable(radius, cutoffT)) return false
  const r2 = radius * radius
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]
    if (s.t < cutoffT) break
    const dx = s.x - tx, dy = s.y - ty, dz = s.z - tz
    if (dx * dx + dy * dy + dz * dz < r2) return true
  }
  return false
}

/**
 * Full lag-forgiving proximity test: consult position history when there is any, otherwise
 * fall back to the player's live position.
 *
 * The fallback covers a player sampled zero times so far — reachable because message handlers
 * (e.g. combat's resolveActionPosition) can run before the first recordPlayerPositions tick
 * after a join, whereas the per-tick systems always run after it.
 *
 * `currentPos` is a THUNK, not a value: resolving a live position scans every entity, so it
 * must not be paid on the common path where history exists. Callers rely on that laziness.
 */
export function wasEverWithinRadius(
  samples: readonly PosSample[] | undefined,
  tx: number, ty: number, tz: number,
  radius: number,
  cutoffT: number,
  currentPos: () => Point3 | null
): boolean {
  if (!proximityInputsUsable(radius, cutoffT)) return false
  if (samples && samples.length > 0) {
    return anySampleWithinRadius(samples, tx, ty, tz, radius, cutoffT)
  }
  const cur = currentPos()
  if (!cur) return false
  const dx = cur.x - tx, dy = cur.y - ty, dz = cur.z - tz
  return dx * dx + dy * dy + dz * dz < radius * radius
}
