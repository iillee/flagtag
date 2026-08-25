/**
 * playerEntityResolution.ts — the ONE rule that maps a player's wallet address to the avatar
 * entity this scene trusts for them.
 *
 * Pure module: no engine imports, so the rule is unit-testable under jest (mirroring
 * positionHistory.ts / stealCandidate.ts / identitySweep.ts). `playerEntities.ts` owns the
 * engine iteration; every per-candidate decision lives here.
 *
 * ## Why this exists as its own module
 *
 * An address maps to more than one avatar entity whenever a reconnect leaves a corpse entity
 * behind (a lost `DELETE_ENTITY` tombstone — `entityDeleted` does a real `data.delete`, so a
 * properly tombstoned corpse leaves the component store entirely). The scene had THREE
 * different answers to "which entity?" scattered across ~12 lookups:
 *
 *  1. Highest raw entity id — `getPlayerPosition`, `recordPlayerPositions`, the beacon.
 *  2. First match by iteration order — seven visual/targeting lookups.
 *  3. `getPlayer({ userId })` from `@dcl/sdk/players`, which is itself (2) internally.
 *
 * (2) is not an arbitrary pick, which is what made it worth consolidating. `getEntitiesWith`
 * iterates its FIRST component's backing store (`getComponentDefGroup` walks
 * `firstComponentDef.iterator()`), that store is a plain `Map`, and `Map` preserves insertion
 * order — `data.set` on an existing key does not reorder. `PlayerIdentityData` is PUT once per
 * peer per join, so its insertion order IS join order, and the corpse joined first by
 * definition. So first-match is not "sometimes the corpse": it is ALWAYS the corpse, every
 * tick, for the rest of that session.
 *
 * Rules (1) and (2) therefore disagreed on roughly two thirds of reallocations — precisely the
 * subset where (1) happens to be right — which put outcome logic (steal, hit detection, ghost
 * targeting) on one entity and visuals (lightning, projectiles, trails, spectator camera) on
 * the other, for the same player, at the same instant.
 *
 * One rule, one place. What the rule IS is a separate question, addressed below.
 */

/** An avatar entity sighting: whose it is, and which entity id carries it. */
export interface AddressedEntity<T extends number> {
  addr: string
  id: T
}

/**
 * Highest raw id among `ids`, or null when empty.
 *
 * ## This rule is unsound, and that is a known, bounded compromise
 *
 * "Highest raw id == newest" is FALSE. The version occupies the high 16 bits and counts how
 * many times that SLOT was recycled, not when its current occupant was assigned. The runtime
 * hands a reconnecting player whichever slot is free, so an address can move to a LOWER raw id
 * — 37 of 103 consecutive reallocations did exactly that in the 2026-08-15 production log
 * (e.g. `#35 v21` = 1376291 → `#37 v8` = 524325), and in each of those this returns the corpse.
 *
 * It is preserved verbatim here rather than fixed, because consolidating the call sites and
 * changing the rule are separate changes and mixing them makes both unreviewable. This module
 * is where a real fix lands: give every caller a liveness signal (which of the candidate
 * entities is still being streamed) and fall back to this comparison only when no candidate has
 * one. Until then the compromise is at least symmetric — the result is a pure function of the
 * entity set, so the server and every client resolve identically.
 */
export function pickNewestId<T extends number>(ids: Iterable<T>): T | null {
  let best: T | null = null
  for (const id of ids) {
    if (best === null || id > best) best = id
  }
  return best
}

/**
 * One entity per address, applying `pickNewestId` within each address.
 *
 * Callers that resolve MANY addresses in a pass (position sampling, per-tick indexes) want this
 * rather than a per-address scan: it is one walk instead of one walk per address.
 *
 * Every consequential read of a player's position MUST go through this same resolution — the
 * concrete reason, not a stylistic one. `recordPlayerPositions` once sampled per ENTITY into a
 * per-ADDRESS history, so with a duplicate present the corpse entity's positions were
 * interleaved with the live player's under one key, and `wasWithinRadius` accepts if ANY sample
 * matches. A frozen corpse could therefore keep authorizing projectile hits and client action
 * positions for the live player indefinitely: the phantom-combat symptom, produced by the
 * scene's own bookkeeping rather than by the platform.
 *
 * Generic over the id so callers can pass branded `Entity` values and get them back unchanged.
 */
export function selectNewestPerAddress<T extends number>(
  entries: Iterable<AddressedEntity<T>>
): Map<string, T> {
  const newest = new Map<string, T>()
  for (const { addr, id } of entries) {
    const prev = newest.get(addr)
    if (prev === undefined || id > prev) newest.set(addr, id)
  }
  return newest
}
