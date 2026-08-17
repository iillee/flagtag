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
 * ## What it does NOT cover — this is mitigation, not a fix
 *
 * **The SDK allocates entities the patch cannot reach.** `Engine()` builds its public object
 * with `addEntity: partialEngine.addEntity` — a COPIED function reference — and hands
 * `partialEngine`, not the public object, to its CRDT system. So when an inbound
 * `PUT_COMPONENT_NETWORK` names a network entity this VM has not seen, the SDK calls
 * `engine.addEntity()` on `partialEngine` and writes to the result immediately, entirely
 * behind this module. Every client hits that path for every `syncEntity`'d entity we have —
 * the flag, countdown, coin state, leaderboards, ghosts, projectiles.
 *
 * There is no reachable reference to patch, so nothing scene-side can close it. **The
 * upstream `@dcl/ecs` fix is the load-bearing one; this module only narrows the window.**
 *
 * `engine.removeEntityWithChildren` is also unreachable — it closes over the SDK's INTERNAL
 * `removeEntity` rather than the property replaced here — and `portalSystem.ts` calls it in
 * `Portal.destroy()`, which currently has no callers.
 *
 * ## Abandonment, and what it does and does not guarantee
 *
 * A reserved id handed to us is **abandoned, never removed**. Calling `engine.removeEntity()`
 * on it would re-arm that slot at version+1 (the SDK's `removeEntity` compares the PACKED id
 * against 512, so a reserved number at version >= 1 slips through its guard) and turn a
 * one-off collision into a renewable source of them.
 *
 * Abandoning leaves the id in the container's `usedEntities` set. That does NOT permanently
 * retire it: the next inbound `DELETE_ENTITY` for that number deletes `usedEntities` entries
 * for versions 0..v, so the same slot can be offered again at a higher version. The retry
 * bound below is sufficient for a different reason — see MAX_RETRIES.
 *
 * One consequence worth knowing, currently unreachable: because the abandoned id sits in
 * `usedEntities`, the container thinks the scene owns it, so a removal routed around this
 * patch would queue a real outbound `DELETE_ENTITY` for a LIVE player's avatar rather than a
 * local-only tombstone. `Portal.destroy()` is the only path there and nothing calls it — but
 * do not add a `removeEntityWithChildren` call on a query-sourced id without checking
 * `isReservedEntity` at the call site first.
 *
 * ## When to delete this module
 *
 * **Check the deployed `@dcl/sdk` version, not the counters.** The counters going quiet does
 * NOT mean the SDK was fixed: the SDK only misbehaves while the allocator has a hole to
 * recycle into (`entityCounter - 512 - usedEntities.size > 0`), and that quantity saturates
 * to zero on its own after enough distinct slots have been consumed. An unpatched SDK and a
 * fixed one both report zero at that point. Delete this module when the installed
 * `@dcl/ecs` contains the reserved-range guard in `engine/entity.ts`.
 */

import { engine, Entity } from '@dcl/sdk/ecs'
import { isReservedEntity, describeEntityId, RESERVED_ENTITY_NUMBERS } from './entityRange'

// Re-exported so callers have one import site for the guard and its predicate.
export { isReservedEntity, describeEntityId, RESERVED_ENTITY_NUMBERS } from './entityRange'

/**
 * Counters, reported per DIAG interval and reset by the read.
 *
 * Per-interval rather than cumulative on purpose: a cumulative counter that stops rising
 * prints the SAME number every interval, which reads as "still happening" when it means
 * "nothing new". Since the whole point of these is to show whether the allocator is STILL
 * handing out reserved ids, the delta is the signal.
 */
let abandonedCount = 0
let blockedRemovalCount = 0
/** Kept alongside so a log line can still say how much has happened overall. */
let abandonedTotal = 0

/** Reads and RESETS the interval counters. Call once per DIAG interval, nowhere else. */
export function takeReservedEntityGuardStats(): { abandoned: number; blockedRemovals: number; abandonedTotal: number } {
  const stats = { abandoned: abandonedCount, blockedRemovals: blockedRemovalCount, abandonedTotal }
  abandonedCount = 0
  blockedRemovalCount = 0
  return stats
}

/**
 * Bound on retries per call, set so the throw below is unreachable.
 *
 * The free list holds at most one entry per entity NUMBER and there are
 * `RESERVED_ENTITY_NUMBERS` of those, so a single call cannot be offered more than that many
 * distinct reserved ids before the supply is exhausted.
 *
 * Note the bound is NOT justified by "each discarded id is retired forever" — it isn't; the
 * next `DELETE_ENTITY` for that number frees the earlier versions again (see the header). The
 * bound holds because it covers the whole reserved number space at once.
 *
 * This was 64, which is NOT sufficient: remote players come from `[32, 256)` — 224 distinct
 * slots — and every slot vacated in one tick is offered before that tick's first allocation
 * returns, so 224 abandonments in a single call is reachable. A 3 h production log only ever
 * touched 11 distinct slots, which is exactly the kind of observation that makes a too-small
 * bound look safe.
 */
const MAX_RETRIES = RESERVED_ENTITY_NUMBERS

const originalAddEntity = engine.addEntity.bind(engine)
const originalRemoveEntity = engine.removeEntity.bind(engine)

;(engine as any).addEntity = (): Entity => {
  let entity = originalAddEntity()
  let attempts = 0
  // Aggregated into ONE line per call rather than one per discard. The engine drains all
  // inbound CRDT before any system runs, so every slot vacated in a tick is already in the
  // free list when that tick's first allocation happens — 40 peers leaving together means 40
  // discards inside a single synchronous call. Every other diagnostic in this scene was moved
  // off per-event logging for exactly this reason.
  const discarded: string[] = []
  while (isReservedEntity(entity as number) && attempts < MAX_RETRIES) {
    // Abandon, do NOT remove — see the module header.
    abandonedCount++
    abandonedTotal++
    if (discarded.length < 8) discarded.push(describeEntityId(entity as number))
    entity = originalAddEntity()
    attempts++
  }
  if (attempts > 0) {
    const shown = discarded.join(', ')
    const elided = attempts > discarded.length ? ` (+${attempts - discarded.length} more)` : ''
    console.log(
      `[EntityGuard] discarded ${attempts} renderer-reserved id(s) from engine.addEntity(): ` +
      `${shown}${elided} — handed out ${describeEntityId(entity as number)}; total discarded: ${abandonedTotal}`
    )
  }
  if (isReservedEntity(entity as number)) {
    // Unreachable: MAX_RETRIES covers the whole reserved number space. Hand it out rather
    // than throw — a throw here fires during top-level module evaluation and takes the whole
    // scene down, whereas returning it risks only the recoverable symptom (writes dropped by
    // the renderer's guard, object invisible). The removeEntity half stays armed either way,
    // so the unrecoverable symptom — purging a live player's components — is still blocked.
    console.error(
      `[EntityGuard] engine.addEntity() returned a renderer-reserved id ${MAX_RETRIES} times in a row ` +
      `(last: ${describeEntityId(entity as number)}); handing it out anyway — removeEntity stays guarded`
    )
  }
  return entity
}

// No current caller can reach the blocked branch: `reconcileHoldTimeEntities` and the
// round-end hold-time cleanup are the only removals of a query-sourced id, and both already
// filter reserved ids upstream. So `reservedRemovalsBlocked` staying at zero is expected — it
// is a tripwire for a future caller that forgets, not a counter we expect to move.
//
// Returns boolean to match the real runtime signature. The installed SDK's .d.ts still says
// `void`, which is why the forwarding call below needs a cast; nothing can branch on the
// result until a release ships the corrected type.
;(engine as any).removeEntity = (entity: Entity): boolean => {
  if (isReservedEntity(entity as number)) {
    blockedRemovalCount++
    console.log(
      `[EntityGuard] blocked engine.removeEntity on renderer-reserved ${describeEntityId(entity as number)}` +
      ` — would have erased a live player's components`
    )
    return false
  }
  return originalRemoveEntity(entity) as unknown as boolean
}
