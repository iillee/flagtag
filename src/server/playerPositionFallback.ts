import { engine, Transform, PlayerIdentityData, AvatarBase, AvatarEquippedData, type Entity } from '@dcl/sdk/ecs'
import { room } from '../shared/messages'
import { countFreshReportedPositions, noteClientPosition, takeReportedPositionStats } from './reportedPositionStore'

let snapshotLogged = false

function componentLabel(comp: { componentName?: string; componentId?: number }): string {
  return String(comp.componentName || comp.componentId || 'unknown')
}

function listComponentsOn(entity: Entity): string[] {
  const names: string[] = []
  for (const comp of engine.componentsIter()) {
    try {
      if (typeof (comp as { has?: (e: Entity) => boolean }).has === 'function' && (comp as { has: (e: Entity) => boolean }).has(entity)) {
        names.push(componentLabel(comp as { componentName?: string; componentId?: number }))
      }
    } catch {
      // Some component definitions throw on has(); skip them in the snapshot.
    }
  }
  names.sort()
  return names
}

/**
 * One-time dump of every PlayerIdentityData entity and the components on it.
 * Confirms whether live no-position rejections are "no identity", "identity
 * without Transform", or an address mismatch.
 */
export function logPlayerEntitySnapshot(reason: string): void {
  if (snapshotLogged) return
  snapshotLogged = true
  const players: Array<Record<string, unknown>> = []
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    const tf = Transform.getOrNull(entity)
    players.push({
      entity: entity as number,
      addr: (identity.address || '').slice(0, 8),
      isGuest: Boolean((identity as { isGuest?: boolean }).isGuest),
      hasTransform: !!tf,
      hasAvatarBase: AvatarBase.getOrNull(entity) !== null,
      hasAvatarEquipped: AvatarEquippedData.getOrNull(entity) !== null,
      parent: tf?.parent ?? null,
      pos: tf
        ? { x: +tf.position.x.toFixed(2), y: +tf.position.y.toFixed(2), z: +tf.position.z.toFixed(2) }
        : null,
      comps: listComponentsOn(entity)
    })
  }
  console.log('[Server] player-entity snapshot (', reason, '):', JSON.stringify({
    identityCount: players.length,
    reportedFresh: countFreshReportedPositions(),
    players
  }))
}

export function takePlayerPositionStats(now: number = Date.now()): Record<string, number> {
  let identities = 0
  let identitiesWithTransform = 0
  for (const [entity] of engine.getEntitiesWith(PlayerIdentityData)) {
    identities += 1
    if (Transform.getOrNull(entity)) identitiesWithTransform += 1
  }
  return {
    playerIdentities: identities,
    playerIdentitiesWithTransform: identitiesWithTransform,
    ...takeReportedPositionStats(now)
  }
}

export function registerPlayerPositionHandlers(): void {
  room.onMessage('reportPlayerPos', (data, context) => {
    if (!context) return
    noteClientPosition(context.from.toLowerCase(), data.x, data.y, data.z)
  })
}