import { engine } from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/players'
import { room } from '../shared/messages'
import { addPlayer } from '../gameState/flagHoldTime'

/**
 * Periodically retries resolving the local player's display name.
 * Names aren't always available immediately on connect — this polls
 * up to 10 times (every 5s) until a real name is found.
 */
export function setupNameRetry(initialName: string) {
  let registeredName = initialName
  let retryTimer = 2.0
  let retryCount = 0

  engine.addSystem((dt: number) => {
    if (retryCount >= 10) return
    retryTimer -= dt
    if (retryTimer <= 0) {
      retryCount++
      retryTimer = 5.0
      const updated = getPlayer()
      const newName = updated?.name || ''
      const isRealName = newName.length > 0 && !newName.startsWith('0x')
      if (isRealName && newName !== registeredName) {
        registeredName = newName
        room.send('registerName', { name: newName })
        addPlayer(updated!.userId, newName)
      }
    }
  })

  return {
    /** Update the tracked name (e.g. from onEnterScene) */
    updateName(name: string) { registeredName = name }
  }
}
