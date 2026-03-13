import { engine } from '@dcl/sdk/ecs'
import { CountdownTimer } from '../shared/components'

let debugTimer = 0

export function roundEndDebugSystem(dt: number): void {
  debugTimer += dt
  
  if (debugTimer >= 10) {
    debugTimer = 0
    
    const timers = [...engine.getEntitiesWith(CountdownTimer)]
    console.log('[UI.DEBUG] CountdownTimer entities found:', timers.length)
    
    if (timers.length > 0) {
      const [, t] = timers[0]
      const now = Date.now()
      const timeToEnd = Math.max(0, Math.floor((t.roundEndTimeMs - now) / 1000))
      console.log('[UI.DEBUG] Timer - triggered:', t.roundEndTriggered, 'timeToEnd:', timeToEnd, 's', 'displayUntil:', t.roundEndDisplayUntilMs)
    } else {
      console.log('[UI.DEBUG] NO TIMER - Component not syncing from server!')
    }
  }
}
