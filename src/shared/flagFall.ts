/**
 * flagFall.ts — Pure analytic helpers for message-driven flag gravity.
 *
 * Replaces the per-frame CRDT-write gravity loop with the bomb/banana
 * pattern: server broadcasts one `flagFallStart` message with the initial
 * conditions, then every client (and the server, for pickup validation)
 * computes the flag's Y position analytically from `(now - dropTime)`.
 *
 *   y(t) = startY - 0.5 · g · t²   (clamped to targetY on landing)
 *
 * This eliminates ~60 CRDT writes/sec on the flag entity during multi-second
 * falls (the historical CRDT-saturation profile — see
 * docs/CRDT_SATURATION_REDUCTION.md and the bomb visual system in
 * src/systems/bombSystem.ts, which uses the same pattern with visibly
 * smoother results).
 *
 * Why analytic rather than Euler:
 *   - Every renderer (server + each client) computes the SAME Y for the same
 *     `now`, so mid-fall pickup validation stays exact — no throttle
 *     staleness, no drift from accumulated float error.
 *   - Client visuals interpolate at 60fps by re-evaluating the formula every
 *     frame with no network dependency during the fall.
 */

/**
 * Compute the flag's Y position at `nowMs` for a fall that started at
 * (`startY`, `dropTimeMs`) targeting `targetY` under `gravity` (positive m/s²).
 *
 * - Before `dropTimeMs`: returns startY (fall hasn't begun; guards against
 *   clock skew or replayed messages).
 * - After landing: clamped to targetY. Callers can detect landing by testing
 *   `computeFallY(...) === targetY`, or use `computeLandTimeMs` up front.
 */
export function computeFallY(
  startY: number,
  targetY: number,
  dropTimeMs: number,
  nowMs: number,
  gravity: number
): number {
  const t = (nowMs - dropTimeMs) / 1000
  if (t <= 0) return startY
  const y = startY - 0.5 * gravity * t * t
  return y <= targetY ? targetY : y
}

/**
 * Time (ms since dropTimeMs) at which the fall lands on targetY.
 * Returns 0 if targetY >= startY (nothing to fall through).
 *
 * Server schedules its "land now" transition using this so it can:
 *   1. Trigger the final CRDT write + `flagLanded` broadcast on the exact
 *      right tick.
 *   2. Not need to poll the analytic Y every frame just to detect landing.
 */
export function computeLandTimeMs(
  startY: number,
  targetY: number,
  gravity: number
): number {
  const drop = startY - targetY
  if (drop <= 0) return 0
  const seconds = Math.sqrt((2 * drop) / gravity)
  return seconds * 1000
}

/**
 * Gravity constant (m/s²) shared by server (analytic pickup validation +
 * landing scheduling) and every client's local visual sim. MUST be the same
 * value on both sides for determinism — that's the whole point of the
 * message-driven pattern. Server re-exports this via serverState for legacy
 * imports; new code should import from here.
 */
export const FLAG_GRAVITY = 15
