/**
 * hitFlashState.ts — Red screen flash when the local player gets hit.
 * Lasts the full stun duration, fading out linearly.
 */

let flashAlpha = 0
const FLASH_START_ALPHA = 0.35
const DEFAULT_DURATION_MS = 1000 // default stun duration

let flashDurationSec = 0
let flashElapsed = 0

/** Trigger a hit flash that lasts the full stun duration (ms). */
export function triggerHitFlash(durationMs: number = DEFAULT_DURATION_MS): void {
  flashAlpha = FLASH_START_ALPHA
  flashDurationSec = durationMs / 1000
  flashElapsed = 0
}

/** Get current flash alpha for UI rendering. Returns 0 when not flashing. */
export function getHitFlashAlpha(): number {
  return flashAlpha
}

/** Tick the flash fade — call from a system every frame. */
export function updateHitFlash(dt: number): void {
  if (flashAlpha > 0 && flashDurationSec > 0) {
    flashElapsed += dt
    const t = Math.min(1, flashElapsed / flashDurationSec)
    flashAlpha = FLASH_START_ALPHA * (1 - t)
    if (flashAlpha < 0.001) flashAlpha = 0
  }
}
