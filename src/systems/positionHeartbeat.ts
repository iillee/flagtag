/**
 * positionHeartbeat.ts — Client-side ~8Hz position reporter.
 *
 * Sends the local avatar's own position to the authoritative server over
 * WebSocket. The server's CRDT view of remote-player Transforms can be
 * cross-wired to another player's live position
 * (docs/BUG_stale-crdt-transform-in-combat.md), so the server prefers this
 * channel for every authoritative proximity decision (trap/bomb/projectile
 * hits, proximity steal, force-drop position). Mirrors the pattern PR #6
 * established for shooter position on requestShell/requestBanana, but as a
 * continuous stream so VICTIM-side reads are protected too.
 */
import { engine, Transform } from '@dcl/sdk/ecs'
import { room } from '../shared/messages'

// Single source of truth for the cadence (pure module, safe in the client bundle).
export { HEARTBEAT_SEND_INTERVAL_S } from '../server/positionTrust'

export function positionHeartbeatSystem(_dt: number): void {
  if (!Transform.has(engine.PlayerEntity)) return
  const p = Transform.get(engine.PlayerEntity).position
  room.send('posHeartbeat', { x: p.x, y: p.y, z: p.z })
}
