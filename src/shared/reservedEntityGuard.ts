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
 * ## What it does NOT cover, and why that is still safe
 *
 * `engine.removeEntityWithChildren` is unreachable from here: it closes over the SDK's
 * INTERNAL `removeEntity`, not the `engine.removeEntity` property this module replaces, so
 * patching the property cannot intercept it. `portalSystem.ts` uses it.
 *
 * That is not a hole, because of the ordering: with `addEntity` guarded, no entity this
 * scene OWNS can hold a reserved id in the first place, so any removal of a scene-owned
 * entity — through either entry point — is already safe. The `removeEntity` guard exists
 * for the other source of ids: entities read back out of a `getEntitiesWith` query, where
 * the id came from the runtime rather than from us. `reconcileHoldTimeEntities` and
 * `handleRoundEnd`'s hold-time cleanup are exactly that case, and they go through
 * `engine.removeEntity`, which IS patched.
 *
 * So: keep using `engine.removeEntity` for anything whose id came from a query. If a
 * future caller needs `removeEntityWithChildren` on a query-sourced id, check
 * `isReservedEntity` at that call site — the property patch will not save it.
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
import { isReservedEntity, describeEntityId, RESERVED_ENTITY_NUMBERS } from './entityRange'

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
 * Bound on retries per call, set so the throw below is provably unreachable.
 *
 * Each discarded id is retired: the allocator has already added it to its `usedEntities`
 * set, so it cannot come back. The free list holds at most one entry per entity NUMBER,
 * and there are `RESERVED_ENTITY_NUMBERS` reserved numbers, so at most that many
 * consecutive reserved returns are possible before the supply is exhausted.
 *
 * This was 64, which is NOT sufficient: the runtime allocates remote players from
 * `[32, 256)` — 224 distinct slots — so a busy world can poison well past 64 and the
 * guard would have thrown while the allocator still had good ids to give. A 3 h
 * production log only ever touched 11 distinct slots, which is exactly the kind of
 * observation that makes a too-small bound look fine.
 */
const MAX_RETRIES = RESERVED_ENTITY_NUMBERS

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

// Returns boolean, matching the real signature. Returning void would make the SDK's own
// .d.ts lie about the runtime value for any future caller that branches on the result.
;(engine as any).removeEntity = (entity: Entity): boolean => {
  if (isReservedEntity(entity as number)) {
    blockedRemovalCount++
    console.log(
      `[EntityGuard] blocked engine.removeEntity on renderer-reserved ${describeEntityId(entity as number)}` +
      ` — would have erased a live player's PlayerIdentityData. Total blocked: ${blockedRemovalCount}`
    )
    return false
  }
  return originalRemoveEntity(entity) as unknown as boolean
}
