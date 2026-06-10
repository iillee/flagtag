/**
 * hitFlashState.ts — Red screen flash when the local player gets hit.
 * Triggered by the 'stagger' message. Fades out over ~300ms.
 */

let flashAlpha = 0
const FLASH_START_ALPHA = 0.35
const FLASH_FADE_SPEED = 2.0 // alpha units per second (~300ms full fade)

/** Trigger a hit flash (call when local player is hit). */
export function triggerHitFlash(): void {
  flashAlpha = FLASH_START_ALPHA
}

/** Get current flash alpha for UI rendering. Returns 0 when not flashing. */
export function getHitFlashAlpha(): number {
  return flashAlpha
}

/** Tick the flash fade — call from a system every frame. */
export function updateHitFlash(dt: number): void {
  if (flashAlpha > 0) {
    flashAlpha = Math.max(0, flashAlpha - FLASH_FADE_SPEED * dt)
  }
}
