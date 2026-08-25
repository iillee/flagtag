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
 * One rule, one place — `selectLivePerAddress`, which prefers whichever candidate entity is
 * still being streamed and falls back to `pickNewestId` when none of them is.
 */

/** An avatar entity sighting: whose it is, and which entity id carries it. */
export interface AddressedEntity<T extends number> {
  addr: string
  id: T
}

/**
 * An avatar entity sighting plus when it was last observed to be alive.
 *
 * `lastAdvancedMs` is a `Date.now()` reading from the moment this entity's Transform CRDT
 * timestamp was last seen to increase, or 0 if it has never been seen to increase. It is NOT
 * the timestamp itself: per-entity lamport counters are not comparable across entities (a
 * long-lived corpse can sit far above a freshly joined entity), so only the *advance* carries
 * information. `playerEntities.sampleAvatarLiveness` maintains it.
 */
export interface AvatarSighting<T extends number> extends AddressedEntity<T> {
  lastAdvancedMs: number
}

/**
 * How recently an entity must have been observed to advance to count as live.
 *
 * One second, against a ~30 Hz avatar Transform stream: long enough to absorb a stalled tick,
 * a slow frame, or a congested CRDT batch without flapping, short enough that a corpse ages out
 * well inside a single round.
 */
export const LIVENESS_WINDOW_MS = 1000

/**
 * One entity per address, preferring the one still being streamed.
 *
 * The ordering, strongest first:
 *
 *  1. An entity observed to advance within `windowMs` beats one that has not. This is the whole
 *     point: a corpse is frozen — the runtime stopped writing to it — while the live entity's
 *     Transform keeps arriving, so "is it still moving?" is an actual liveness signal where
 *     `pickNewestId`'s id arithmetic is not.
 *  2. Among entities on the same side of that line, the more recent advance wins.
 *  3. Ties fall back to the highest raw id — `pickNewestId`'s rule.
 *
 * Rule (3) is what makes this safe to deploy. When NOTHING has been observed to advance, every
 * candidate is equally stale and the result is exactly what `selectNewestPerAddress` would have
 * returned. So the two cases where the liveness signal is unavailable — the index has not been
 * sampled yet, and (if the runtime turns out to suppress redundant Transform writes) a player
 * standing perfectly still — degrade to the previous behaviour rather than to something new.
 *
 * ## What this gives up, deliberately
 *
 * The old rule was a pure function of the entity SET, so the server and every client resolved
 * identically — wrong together rather than wrong apart. Liveness is per-VM, so they can now
 * briefly disagree while converging. That is the better trade: they disagreed two thirds of the
 * time already (max-id vs first-match across call sites), and they now disagree only during the
 * sample interval it takes each VM to notice the same frozen entity, having converged on the
 * LIVE one rather than agreeing on the corpse.
 *
 * A client that has not streamed the live avatar at all (mobile streams on demand, by
 * proximity) sees only one candidate and has no choice to make — unchanged from before.
 */
export function selectLivePerAddress<T extends number>(
  sightings: Iterable<AvatarSighting<T>>,
  nowMs: number,
  windowMs: number = LIVENESS_WINDOW_MS
): Map<string, T> {
  const best = new Map<string, { id: T; advanced: number; fresh: boolean }>()
  for (const { addr, id, lastAdvancedMs } of sightings) {
    // A non-finite or future-dated clock reading must not manufacture liveness, so the window
    // test is written to deny rather than admit on garbage — same posture as
    // proximityInputsUsable in positionHistory.ts.
    const age = nowMs - lastAdvancedMs
    const fresh = lastAdvancedMs > 0 && Number.isFinite(age) && age >= 0 && age <= windowMs
    const prev = best.get(addr)
    const wins =
      prev === undefined ||
      (fresh && !prev.fresh) ||
      (fresh === prev.fresh && lastAdvancedMs > prev.advanced) ||
      (fresh === prev.fresh && lastAdvancedMs === prev.advanced && id > prev.id)
    if (wins) best.set(addr, { id, advanced: lastAdvancedMs, fresh })
  }
  const resolved = new Map<string, T>()
  for (const [addr, pick] of best) resolved.set(addr, pick.id)
  return resolved
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
 * It is no longer the primary rule — `selectLivePerAddress` prefers an entity observed to be
 * still streaming, and reaches this comparison only to break a tie or when no candidate has a
 * liveness signal at all. It is kept as that fallback rather than deleted precisely because the
 * no-signal case must degrade to the behaviour that shipped before, not to something new.
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
