/**
 * reservedEntityGuard.ts — refuse to let this scene own or destroy a renderer-reserved
 * entity id.
 *
 * ## Why this exists
 *
 * `@dcl/ecs`'s entity container recycles ids from a free list keyed by entity NUMBER,
 * and that free list is fed by every inbound `DELETE_ENTITY` — including the runtime's
 * own tombstones for departed remote players. Neither the recycling loop nor
 * `updateRemovedEntity` filters the renderer-reserved range, so once any peer
 * disconnects, `engine.addEntity()` can hand this scene an id inside the avatar range.
 *
 * The two allocators then collide *exactly*, not merely in range: the runtime reissues a
 * vacated slot as `toEntityId(number, storedVersion + 1)` and the SDK recycles it as
 * `toEntityId(number, storedVersion + 1)` off the same stored version. Both compute the
 * identical 32-bit id, so the version bits that were supposed to separate them are what
 * synchronises them.
 *
 * Consequences, all observed in production logs:
 *  - Component writes on such an id are dropped by the runtime's scene write guard with
 *    no correction message, so the object exists and ticks server-side while being
 *    invisible to every client.
 *  - `engine.removeEntity()` on such an id purges the LIVE player's components from this
 *    scene's store. `Transform` recovers (the runtime restreams it at 30Hz);
 *    `PlayerIdentityData` does not, because it is sent once per peer. The player becomes
 *    a moving Transform with no identity and vanishes from every
 *    `getEntitiesWith(PlayerIdentityData, ...)` query for the rest of their session —
 *    no steal, no pickup, no projectile hit, no beacon.
 *
 * ## What this module does
 *
 * Wraps `engine.addEntity` and `engine.removeEntity` at import time. Import it FIRST,
 * before any module that allocates at top level. The range test itself lives in the pure,
 * unit-tested `entityRange.ts` and is re-exported here.
 *
 * A reserved id handed to us is **abandoned, never removed**. Calling
 * `engine.removeEntity()` on it would re-arm that slot at version+1 (the SDK's
 * `removeEntity` compares the packed id against 512, so a reserved number with
 * version >= 1 slips through its guard) and turn a one-off collision into a renewable
 * source of them. Dropping the id instead leaves it in the container's `usedEntities`
 * set, which permanently retires that (number, version) pair from the free list.
 *
 * Remove this module once the runtime ships a fixed `@dcl/ecs`; the counters below going
 * to zero across a long session is the signal that it landed.
 */

import { engine, Entity } from '@dcl/sdk/ecs'
import { isReservedEntity, describeEntityId } from './entityRange'

// Re-exported so callers have one import site for the guard and its predicate.
export { isReservedEntity, describeEntityId, RESERVED_ENTITY_NUMBERS } from './entityRange'

/** How many reserved ids the allocator handed us and we discarded. Surfaced in DIAG. */
let abandonedCount = 0
/** How many `removeEntity` calls on a reserved id we blocked. Surfaced in DIAG. */
let blockedRemovalCount = 0

export function getReservedEntityGuardStats(): { abandoned: number; blockedRemovals: number } {
  return { abandoned: abandonedCount, blockedRemovals: blockedRemovalCount }
}

/**
 * Bound on retries per call. The free list holds at most one entry per avatar slot the
 * runtime has vacated, so in practice one or two retries suffice; the cap only exists so
 * a pathological container state degrades into a loud log rather than a hung tick.
 */
const MAX_RETRIES = 64

const originalAddEntity = engine.addEntity.bind(engine)
const originalRemoveEntity = engine.removeEntity.bind(engine)

;(engine as any).addEntity = (): Entity => {
  let entity = originalAddEntity()
  let attempts = 0
  while (isReservedEntity(entity as number) && attempts < MAX_RETRIES) {
    // Abandon, do NOT remove — see the module comment.
    abandonedCount++
    console.log(
      `[EntityGuard] discarded renderer-reserved entity ${describeEntityId(entity as number)} ` +
      `from engine.addEntity() — total discarded: ${abandonedCount}`
    )
    entity = originalAddEntity()
    attempts++
  }
  if (isReservedEntity(entity as number)) {
    // Returning it would be worse than throwing: the caller would write components to a
    // live player's entity and silently corrupt this scene's view of them.
    throw new Error(
      `[EntityGuard] engine.addEntity() returned a renderer-reserved id ${MAX_RETRIES} times in a row ` +
      `(last: ${describeEntityId(entity as number)}); refusing to hand it out`
    )
  }
  return entity
}

;(engine as any).removeEntity = (entity: Entity): void => {
  if (isReservedEntity(entity as number)) {
    blockedRemovalCount++
    console.log(
      `[EntityGuard] blocked engine.removeEntity on renderer-reserved ${describeEntityId(entity as number)}` +
      ` — would have erased a live player's PlayerIdentityData. Total blocked: ${blockedRemovalCount}`
    )
    return
  }
  originalRemoveEntity(entity)
}
