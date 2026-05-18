import { engine } from '@dcl/sdk/ecs'
import { Flag, FlagState } from '../shared/components'
import { room } from '../shared/messages'

/**
 * Detects if the local player was carrying the flag when the scene reloaded.
 * Polls for up to ~1 second after scene load, then removes itself.
 *
 * NOTE: This system has never worked reliably — the server may not process
 * the requestReloadRespawn message correctly. Extracted as-is for cleanup;
 * fixing the underlying issue is a separate task.
 */
export function setupReloadDrop(localUserId: string) {
  let reloadCheckFrames = 0
  const RELOAD_CHECK_MAX_FRAMES = 60 // ~1 second at 60fps

  engine.addSystem(function reloadDropSystem() {
    reloadCheckFrames++
    for (const [, flag] of engine.getEntitiesWith(Flag)) {
      if (flag.state === FlagState.Carried && flag.carrierPlayerId === localUserId.toLowerCase()) {
        console.log('[Main] Detected flag carry on scene load (likely /reload) — requesting respawn')
        room.send('requestReloadRespawn', { t: 0 })
      }
      // Flag data found — remove this system regardless
      engine.removeSystem(reloadDropSystem)
      return
    }
    // Give up after max frames
    if (reloadCheckFrames >= RELOAD_CHECK_MAX_FRAMES) {
      engine.removeSystem(reloadDropSystem)
    }
  })
}
