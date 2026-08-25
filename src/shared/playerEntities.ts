/**
 * playerEntities.ts — address → avatar entity, for CLIENT and SERVER alike.
 *
 * The engine-facing half of playerEntityResolution.ts: this module owns the
 * `getEntitiesWith(PlayerIdentityData, Transform)` iteration, the Transform reads, and the
 * per-entity liveness bookkeeping; the pure module owns the choice between candidates. Every
 * consequential address lookup in the scene goes through here, so the rule cannot drift between
 * call sites again — that drift is the defect this module exists to close (see the pure module's
 * header for the full argument).
 *
 * Safe to import from both runtimes: it touches only `@dcl/sdk/ecs`, never
 * `~system/RestrictedActions` or any other client-only surface.
 *
 * ## Liveness, and why it is sampled rather than computed
 *
 * A duplicate avatar entity for one address is a frozen corpse plus a live entity. Nothing about
 * the entity IDS distinguishes them (see `pickNewestId`), but their behaviour does: the runtime
 * has stopped writing to the corpse, so its Transform CRDT timestamp is stuck while the live
 * entity's keeps advancing at avatar-stream rate.
 *
 * `Transform.getCrdtState(entity).timestamp` exposes that counter. It is a per-entity lamport
 * value, so it cannot be compared BETWEEN entities — only its advance carries information —
 * which is why `sampleAvatarLiveness` must run periodically and stamp when each entity was last
 * seen to move forward. Both inbound CRDT paths maintain it (`createUpdateLwwFromCrdt` and
 * `createForceUpdateLwwFromCrdt` both `timestamps.set`), so the signal is present on the client
 * and the server regardless of which PUT variant the runtime uses.
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
import {
  type AvatarSighting,
  LIVENESS_WINDOW_MS,
  selectLivePerAddress
} from './playerEntityResolution'

/**
 * Per-entity liveness state: the last Transform CRDT timestamp seen, and when it last advanced.
 *
 * Keyed by entity, not by address, because that is the granularity the signal has — the whole
 * point is to tell two entities carrying the SAME address apart.
 */
interface LivenessEntry {
  ts: number
  advancedMs: number
}
const liveness = new Map<Entity, LivenessEntry>()

/** address → the entity this scene trusts, rebuilt by each `sampleAvatarLiveness` pass. */
let resolvedByAddress = new Map<string, Entity>()

/**
 * Sample every avatar entity's liveness and rebuild the address → entity index. Call once per
 * tick, BEFORE anything that resolves an address in that tick.
 *
 * `nowMs` is injected rather than read here so the caller's tick shares one clock reading with
 * the position sampling beside it.
 *
 * Cost is one pass over avatar entities. That is strictly cheaper than what it replaces: every
 * `resolvePlayerEntity` call used to scan all entities, and the steal check, ghost targeting and
 * every active trap/bomb/projectile/orbit each made one per tick. Those are now map lookups.
 */
export function sampleAvatarLiveness(nowMs: number): void {
  const sightings: AvatarSighting<Entity>[] = []
  const seen = new Set<Entity>()

  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    seen.add(entity)
    const ts = Transform.getCrdtState(entity)?.timestamp ?? 0
    let entry = liveness.get(entity)
    if (entry === undefined) {
      // First sighting. advancedMs stays 0 — "not yet observed to advance", NOT "advanced now".
      // Stamping it here would make every entity look live on the tick it appears, including a
      // corpse this VM is discovering for the first time (the common case on a client, which
      // loads into a duplicate that predates it).
      entry = { ts, advancedMs: 0 }
      liveness.set(entity, entry)
    } else if (ts > entry.ts) {
      entry.ts = ts
      entry.advancedMs = nowMs
    }
    sightings.push({ addr: identity.address.toLowerCase(), id: entity, lastAdvancedMs: entry.advancedMs })
  }

  // Drop state for entities that have gone away, so a recycled id cannot inherit the liveness
  // history of the occupant before it.
  for (const entity of liveness.keys()) {
    if (!seen.has(entity)) liveness.delete(entity)
  }

  resolvedByAddress = selectLivePerAddress(sightings, nowMs, LIVENESS_WINDOW_MS)
}

/**
 * The avatar entity this scene trusts for `address`, or null when the address has no avatar
 * entity with a Transform (not connected, or not streamed to this client yet).
 *
 * Case-insensitive: callers may pass either casing. Requires `Transform`, not just
 * `PlayerIdentityData`, because every caller ultimately wants a position — an identity with no
 * Transform is not a usable answer for any of them.
 *
 * Serves the sampled index when it has an answer, and falls back to a live scan otherwise. The
 * fallback is load-bearing, not defensive: message handlers can run before the first
 * `sampleAvatarLiveness` of a tick after a join (the same reason `wasEverWithinRadius` keeps a
 * live-position branch), and an entity can depart between the sample and the read.
 */
export function resolvePlayerEntity(address: string): Entity | null {
  const needle = address.toLowerCase()
  const indexed = resolvedByAddress.get(needle)
  if (indexed !== undefined && Transform.has(indexed)) return indexed
  return scanForNewestEntity(needle)
}

/**
 * Live max-id scan for one address — the pre-index behaviour, kept as `resolvePlayerEntity`'s
 * fallback. Takes an already-lowercased address.
 */
function scanForNewestEntity(needle: string): Entity | null {
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
 * Every connected address mapped to its trusted entity.
 *
 * Returns the sampled index directly when it has been built, so a per-tick pass over all
 * players costs nothing beyond the sample itself. Falls back to a fresh scan before the first
 * sample, for the same reason `resolvePlayerEntity` does.
 *
 * The returned map is the live index — callers must treat it as read-only and must not retain it
 * across ticks, since the next sample replaces it.
 */
export function resolveNewestPerAddress(): Map<string, Entity> {
  if (resolvedByAddress.size > 0) return resolvedByAddress
  const sightings: AvatarSighting<Entity>[] = []
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    sightings.push({ addr: identity.address.toLowerCase(), id: entity, lastAdvancedMs: 0 })
  }
  // Every lastAdvancedMs is 0, so this is exactly the max-id rule — see selectLivePerAddress.
  return selectLivePerAddress(sightings, 0)
}
