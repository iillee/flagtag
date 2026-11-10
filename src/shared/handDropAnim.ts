/**
 * handDropAnim.ts - pure tuning + easing for the left-hand drop wind-up
 * (see systems/handDrop.ts). No engine imports, so it is unit-testable.
 */

/** Wind-up length: F press -> item placed. This is the added drop delay. */
export const HAND_DROP_WINDUP_SEC = 0.3
/** Final in-hand uniform scale per item (ground visuals are banana 1, bomb 2). */
export const HAND_DROP_BANANA_SCALE = 0.6
export const HAND_DROP_BOMB_SCALE = 0.9
/** Local offset from the left-hand anchor (m). */
export const HAND_DROP_OFFSET = { x: 0, y: 0.05, z: 0.08 }
/** Local rotation in degrees (Euler XYZ) relative to the hand anchor. */
export const HAND_DROP_ROTATION_DEG = { x: 0, y: 0, z: 0 }

/** Ease-out cubic 0..1 scale factor at `elapsedSec` into a wind-up of `durationSec`. */
export function handScaleAt(elapsedSec: number, durationSec: number = HAND_DROP_WINDUP_SEC): number {
  if (durationSec <= 0) return 1
  const t = Math.min(1, Math.max(0, elapsedSec / durationSec))
  const u = 1 - t
  return 1 - u * u * u
}
