import { engine, Transform } from '@dcl/sdk/ecs'

/** Sender's own position for action/heartbeat messages. (0,0,0) means the Transform is not ready. */
export function localPlayerPositionPayload(): { x: number; y: number; z: number } {
  if (!Transform.has(engine.PlayerEntity)) return { x: 0, y: 0, z: 0 }
  const p = Transform.get(engine.PlayerEntity).position
  return { x: p.x, y: p.y, z: p.z }
}