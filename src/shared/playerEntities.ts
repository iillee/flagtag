/**
 * playerEntities.ts — address → avatar entity, for CLIENT and SERVER alike.
 *
 * The engine-facing half of playerEntityResolution.ts: this module owns the
 * `getEntitiesWith(PlayerIdentityData, Transform)` iteration and the Transform reads, the pure
 * module owns the choice between candidates. Every consequential address lookup in the scene
 * goes through here, so the rule cannot drift between call sites again — that drift is the
 * defect this module exists to close (see the pure module's header for the full argument).
 *
 * Safe to import from both runtimes: it touches only `@dcl/sdk/ecs`, never
 * `~system/RestrictedActions` or any other client-only surface.
 *
 * ## What this does NOT cover
 *
 * The LOCAL player. `engine.PlayerEntity` is a reserved id that always resolves to the local
 * avatar directly, so callers that special-case themselves (beacon, lightning) must keep doing
 * so BEFORE consulting this module. Resolving the local player by address would work, but it
 * would read a comms-replicated copy of a position the client already knows exactly.
 */
import { engine, Transform, PlayerIdentityData, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { type AddressedEntity, selectNewestPerAddress } from './playerEntityResolution'

/**
 * The avatar entity this scene trusts for `address`, or null when the address has no avatar
 * entity with a Transform (not connected, or not streamed to this client yet).
 *
 * Case-insensitive: callers may pass either casing. Requires `Transform`, not just
 * `PlayerIdentityData`, because every caller ultimately wants a position — an identity with no
 * Transform is not a usable answer for any of them.
 *
 * O(entities) per call, same as the `getPlayerPosition` it replaces. Callers resolving many
 * addresses in one pass should use `resolveNewestPerAddress` instead.
 */
export function resolvePlayerEntity(address: string): Entity | null {
  const needle = address.toLowerCase()
  let best: Entity | null = null
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (identity.address.toLowerCase() !== needle) continue
    if (best === null || (entity as number) > (best as number)) best = entity
  }
  return best
}

/**
 * Position of the avatar entity this scene trusts for `address`, or null when there is none.
 *
 * This is the authoritative read for every consequential proximity decision. The value is the
 * CRDT-replicated Transform — i.e. whatever that peer's client last reported, at whatever lag —
 * so it is authoritative in the sense that everyone resolves the same entity, not in the sense
 * that it cannot be stale or spoofed.
 */
export function getPlayerEntityPosition(address: string): Vector3 | null {
  const entity = resolvePlayerEntity(address)
  if (entity === null) return null
  return Transform.get(entity).position
}

/**
 * Every connected address mapped to its trusted entity, in one walk.
 *
 * For per-tick passes over all players (position history sampling, per-frame indexes) where a
 * per-address `resolvePlayerEntity` call would re-scan every entity per address.
 */
export function resolveNewestPerAddress(): Map<string, Entity> {
  const entries: AddressedEntity<Entity>[] = []
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    entries.push({ addr: identity.address.toLowerCase(), id: entity })
  }
  return selectNewestPerAddress(entries)
}
