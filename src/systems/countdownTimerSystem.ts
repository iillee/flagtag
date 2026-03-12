import { engine } from '@dcl/sdk/ecs'
import { CountdownTimer } from '../shared/components'

/**
 * Client-side only: tracks the round-end splash display.
 * The server manages all round logic (resets, leaderboard, flag).
 * The client just reads the synced CountdownTimer for UI.
 */
let prevRoundEndTriggered = false

export function countdownClientSystem(_dt: number): void {
  for (const [, timer] of engine.getEntitiesWith(CountdownTimer)) {
    // Detect transition to round-end (for any client-side effects if needed)
    if (timer.roundEndTriggered && !prevRoundEndTriggered) {
      // Round just ended — UI reads roundEndTriggered directly
    }
    prevRoundEndTriggered = timer.roundEndTriggered
    break
  }
}
