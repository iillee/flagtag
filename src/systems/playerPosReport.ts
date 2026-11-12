import { room } from '../shared/messages'
import { localPlayerPositionPayload } from '../shared/localPlayerPosition'
import { isPlausibleScenePosition } from '../shared/reportedPosition'

/**
 * ~5 Hz client -> server position heartbeat, same idea as pixelwars' botAim.
 * Lets the server keep a validated last-known position when avatar Transforms
 * are not replicated to the multiplayer server.
 */
export function playerPosReportSystem(): void {
  const p = localPlayerPositionPayload()
  if (!isPlausibleScenePosition(p.x, p.y, p.z)) return
  room.send('reportPlayerPos', p)
}