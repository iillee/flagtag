/**
 * identitySweep.ts — Avatar-entity diagnostics for the CRDT cross-wire
 * (docs/BUG_stale-crdt-transform-in-combat.md).
 *
 * Pure module (no engine imports) so the id decode and the branch selection stay
 * unit-testable under jest. serverState.ts does the engine iteration and the logging.
 *
 * These logs are the scene's ONLY remaining cross-wire signal: proximity steal became
 * server-authoritative on 2026-08-04 and no longer defends against the bug itself, so a
 * recurrence has to be visible here or not at all.
 */

/**
 * @dcl/ecs packs an entity id as `(number & 0xffff) | (version << 16)` — see
 * `EntityUtils.toEntityId` in node_modules/@dcl/ecs/dist/engine/entity.js.
 */
export function entityNumberOf(eid: number): number { return eid & 0xffff }

/**
 * A version above 0 means this entity NUMBER was deleted and handed out again. That is the
 * cross-wire trigger — but NOT for the reason this comment used to give.
 *
 * The old explanation — "@dcl/ecs preserves LWW timestamps for numbers < 512 across
 * entityDeleted, so the one-shot PlayerIdentityData PUT loses to the 30Hz Transform PUTs" —
 * is impossible. Every component owns its own `timestamps` map, so Transform's timestamps can
 * never arbitrate a PlayerIdentityData PUT. Verified by execution: an identity PUT at
 * timestamp 1 lands normally on an entity whose Transform the scene already owns.
 *
 * The real trigger: `@dcl/ecs`'s allocator recycles ids from a free list keyed by entity
 * NUMBER, seeded by every inbound DELETE_ENTITY — including the runtime's tombstones for
 * departed peers — with no reserved-range filter. So `engine.addEntity()` can return an id
 * that belongs to a live remote player, and both allocators derive it as
 * `toEntityId(number, storedVersion + 1)` from the same stored version, producing the
 * identical 32-bit value. The identity is not outraced; it is DELETED, by this scene, when it
 * releases what it believes is its own entity.
 *
 * Mitigated scene-side by `src/shared/reservedEntityGuard.ts`, which refuses reserved ids at
 * `engine.addEntity`/`removeEntity`. That is mitigation only — the SDK allocates network
 * entities behind any property patch — so the real fix is upstream. Full write-up in
 * docs/BUG_reserved_entity_transform_block.md. This module only reports the condition.
 */
export function entityVersionOf(eid: number): number { return eid >>> 16 }

/** Render an entity id as `id (#number vVersion)` for logs — e.g. `65568 (#32 v1)`. */
export function describeEntityId(eid: number): string {
  return `${eid} (#${entityNumberOf(eid)} v${entityVersionOf(eid)})`
}

/**
 * Resolve duplicate avatar entities down to one per address: highest entity id wins, matching
 * `getPlayerPosition`'s rule.
 *
 * ## The rule is UNSOUND, and is kept deliberately anyway. Read this before "fixing" it.
 *
 * "Highest id == newest" is false. An id packs the version into the high 16 bits, so ordering
 * by raw id sorts by version first and entity number second — but the version counts how many
 * times that SLOT has been recycled, which says nothing about when its current occupant was
 * assigned. The runtime hands a reconnecting player whichever slot happens to be free, so a
 * player can move from a heavily-recycled slot to a fresh one and see their raw id go DOWN.
 * Measured on a 3 h production log: **37 of 103 consecutive reallocations moved an address to a
 * lower raw id**, e.g. `#35 v21` (1376291) -> `#37 v8` (524325). In each of those, this function
 * returns the corpse. `test/identitySweep.spec.ts` pins that case as a known limitation.
 *
 * Recency is not derivable from the id at all — it has to be observed — so any real fix needs
 * per-entity state (when it was first seen, or when its Transform last changed) maintained on
 * both the server and every client.
 *
 * Kept regardless, for three reasons that a replacement has to beat:
 *
 * 1. **It is wrong SYMMETRICALLY.** The result is a pure function of the entity set, so the
 *    server and every client agree. A per-VM recency signal can make them disagree — the
 *    client's would measure avatar STREAMING order, which is proximity-driven on mobile — and
 *    the beacon pointing somewhere hit detection does not is harder to diagnose than both being
 *    wrong together. An attempted first-sighting fix was rejected for exactly this.
 * 2. **The trigger is vanishingly rare.** A duplicate needs a lost DELETE_ENTITY tombstone,
 *    which the runtime bounds at 4096+ departures during a single VM stall and explicitly
 *    accepts as cosmetic. The `👥 duplicate PlayerIdentityData` tripwire fired ZERO times in
 *    that 3 h log.
 * 3. **Ties would fall back here anyway.** Any recency scheme has no information about a
 *    duplicate that predates the observer — the common case, since a client discovers one on
 *    load — and would degrade to precisely this rule while adding state and divergence.
 *
 * So: if the duplicate tripwire starts firing in the field, fix it with an observed-liveness
 * signal applied at EVERY address lookup (there are ~12, nine of which still take first-match
 * by iteration order) — not by changing this comparison alone.
 *
 * Every consequential read of a player's position MUST go through this same resolution.
 * `recordPlayerPositions` previously sampled per ENTITY into a per-ADDRESS history, so with a
 * duplicate present the corpse entity's positions were interleaved with the live player's under
 * one key — and `wasWithinRadius` accepts if ANY sample matches, so a frozen corpse could
 * authorize projectile hits and client action positions for the live player indefinitely. That
 * is the phantom-combat symptom this whole area exists to chase, produced by the scene's own
 * bookkeeping rather than the platform.
 *
 * Generic over the id so callers can pass branded `Entity` values and get them back unchanged.
 */
export function selectNewestPerAddress<T extends number>(
  entries: Iterable<{ addr: string; id: T }>
): Map<string, T> {
  const newest = new Map<string, T>()
  for (const { addr, id } of entries) {
    const prev = newest.get(addr)
    if (prev === undefined || id > prev) newest.set(addr, id)
  }
  return newest
}

/** One avatar entity's address and world position, for the aliasing scan below. */
export interface IdentityPosition { addr: string; x: number; y: number; z: number }

/** Two distinct addresses whose Transforms coincide. `dist` is horizontal; `dy` is the vertical offset. */
export interface AliasedPair { a: string; b: string; dist: number; dy: number }

/**
 * HORIZONTAL coincidence threshold, in meters. Deliberately tiny: a cross-wire makes two
 * entities report the same player's XZ movement, so their XZ agrees bar float noise.
 *
 * Note that NO value of this alone can separate a cross-wire from ordinary play — DCL avatars
 * have no player-player collision, so two real players can legitimately stand at distance 0.
 * That is what the movement requirement below is for.
 */
export const ALIAS_EPSILON = 0.05

/**
 * Vertical offset tolerated between two aliased entities, in meters.
 *
 * This is NOT slack — it is the recorded fingerprint. Every logged instance of the cross-wire
 * shows a *consistent ~0.8m Y offset* while XZ tracks in lockstep across arbitrary movement
 * (docs/BUG_handover_summary.md:43-48, docs/BUG_stale-crdt-transform-in-combat.md:17). The
 * leading explanation — hedged as "likely" in both of those documents, and NOT verified here —
 * is that the corrupted stream is Babylon-capsule-center-anchored: the hammurabi stack's
 * PLAYER_HEIGHT of 1.7 puts a capsule centre +0.85m above the feet that normal comms movement
 * reports. That constant lives upstream, not in this repo. The tolerance is deliberately ~1m
 * rather than 0.85 so a different anchor offset cannot silence the detector.
 *
 * A full-3D comparison against ALIAS_EPSILON therefore CANNOT detect the real bug — 0.8 is
 * sixteen times 0.05 — which is exactly the trap this constant exists to avoid. The window
 * spans both the aligned (0) and capsule-anchored (~0.85) cases.
 */
export const ALIAS_Y_TOLERANCE = 1.0

/**
 * How far a coincident pair's shared position must travel between sweeps (~1s apart) to count
 * as a cross-wire rather than two players parked on the same spot. Far above float noise and
 * idle jitter, far below the ~10 m/s a walking player covers in one sweep.
 */
export const ALIAS_MOVE_THRESHOLD = 0.5

/**
 * XZ window for the LAGGED-copy tier of the detector. ALIAS_EPSILON above can only catch a
 * cross-wire whose two streams carry the SAME tick's value: a copy that lags its source by
 * even one comms snapshot (~100ms) sits 0.3–1m behind at run speed — 6–20× the exact
 * window — so that detector is structurally blind to a moving lagged copy, which is exactly
 * what the 2026-08-19 playtest presented (victims 0.5–0.7m XZ from a trap dropped at the
 * dropper's feet 130ms earlier, and zero 🔗 lines all session). 1.0m covers a one-snapshot
 * lag at boosted run speed. This window alone would fire on every tight chase, which is why
 * the lagged tier ALSO requires movement-vector lockstep — see ALIAS_LOCKSTEP_TOLERANCE.
 */
export const ALIAS_LAG_EPSILON = 1.0

/**
 * Max divergence between the two sides' per-sweep movement vectors for the lagged tier.
 * A lagged copy replays its source's walk, so across a ~1s sweep the two displacement
 * vectors are near-identical; two players merely near each other turn and throttle
 * independently. NOT zero-false-positive: a stealer glued to an immune carrier for a full
 * sweep while both run straight can match. Accepted — this is an edge-triggered diagnostic
 * log line, and triage has the dy fingerprint and duration to work with. The alternative
 * (staying blind to the moving cross-wire) is what this tier exists to end.
 */
export const ALIAS_LOCKSTEP_TOLERANCE = 0.5

/**
 * Per-pair state carried across sweeps by trackAliasedPositions.
 * `x/y/z` is the first entry's position (legacy exact tier reads only these); `bx/bz` is the
 * OTHER side's position, stored by the lockstep tier so each side's own movement can be
 * measured — present only when that tier is active.
 */
export interface AliasTrackEntry { x: number; y: number; z: number; reported: boolean; bx?: number; bz?: number }

/** Stable key for an unordered pair of addresses. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * Detect the observable *symptom* of the CRDT cross-wire: two DISTINCT addresses reporting one
 * player's position. (The `recycled`/`reissued` events above detect the id-recycling that
 * *triggers* it.) Without this, a cross-wire with no entity recycling produces a flag
 * teleporting across the map and a server log indistinguishable from a legitimate steal.
 *
 * Coincidence alone is NOT sufficient, and assuming it was made this detector unusable: this
 * scene teleports players to hard-coded points and freezes them there, so co-located players
 * are routine. All three death respawns share the literal (385, 96, 392) and hold the avatar
 * there with input disabled — ~8.5s for lightning and water, ~3.5s for ghost
 * (`GHOST_RESPAWN_DURATION 5.0 - GHOST_FADE_IN 1.5`) — the interior uses a single fixed
 * `ROOM_SPAWN` where two players can idle indefinitely, and ladders and the round-end cinematic
 * have fixed destinations too. Every one of those exceeds the ~1s sweep interval.
 *
 * Coincidence is HORIZONTAL (XZ within `epsilon`) with a vertical offset up to
 * `yTolerance` — see ALIAS_Y_TOLERANCE for why a full-3D test cannot detect the real bug.
 *
 * A pair is reported only when it is coincident on CONSECUTIVE sweeps **and** its shared
 * position moved at least `moveThreshold` between them. A cross-wire tracks a live player, so
 * it moves; frozen respawners and idle shoppers do not. Reporting is edge-triggered per pair
 * (`reported`), so a persistent cross-wire logs once rather than once per second, and each
 * unordered pair is emitted at most once per sweep even when duplicate entities put the same
 * address in `entries` twice.
 *
 * `state` is updated in place; the caller owns it across sweeps.
 */
export function trackAliasedPositions(
  entries: readonly IdentityPosition[],
  state: Map<string, AliasTrackEntry>,
  epsilon: number = ALIAS_EPSILON,
  moveThreshold: number = ALIAS_MOVE_THRESHOLD,
  yTolerance: number = ALIAS_Y_TOLERANCE,
  // Non-null activates the LAGGED-copy tier: coincidence may be loose (pass ALIAS_LAG_EPSILON),
  // but BOTH sides must move ≥ moveThreshold with near-identical displacement vectors — see
  // ALIAS_LOCKSTEP_TOLERANCE. Null keeps the original exact-tier semantics untouched.
  lockstepTolerance: number | null = null
): AliasedPair[] {
  const pairs: AliasedPair[] = []
  if (!Number.isFinite(epsilon) || epsilon < 0) { state.clear(); return pairs }
  if (!Number.isFinite(moveThreshold) || moveThreshold < 0) { state.clear(); return pairs }
  if (!Number.isFinite(yTolerance) || yTolerance < 0) { state.clear(); return pairs }
  if (lockstepTolerance !== null && (!Number.isFinite(lockstepTolerance) || lockstepTolerance < 0)) { state.clear(); return pairs }

  const seen = new Set<string>()
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const p = entries[i], q = entries[j]
      if (p.addr === q.addr) continue
      const dx = p.x - q.x, dz = p.z - q.z
      const dy = p.y - q.y
      const dxz2 = dx * dx + dz * dz
      if (!(dxz2 <= epsilon * epsilon)) continue
      if (!(Math.abs(dy) <= yTolerance)) continue

      const key = pairKey(p.addr, q.addr)
      if (seen.has(key)) continue   // duplicate entities for one address — same logical pair
      seen.add(key)

      // Lockstep tier stores each side under a STABLE assignment (lexicographic, matching
      // pairKey) so a swap in entity iteration order between sweeps cannot cross the two
      // sides' movement measurements. The exact tier keeps its original iteration-order
      // storage — its behavior (including the documented swap artifact) is pinned by tests.
      const aSide = p.addr < q.addr ? p : q
      const bSide = p.addr < q.addr ? q : p

      const prev = state.get(key)
      if (prev === undefined) {
        // First sighting: no movement history yet, so we cannot tell a cross-wire from two
        // players standing on the same spot. Wait for the next sweep.
        if (lockstepTolerance !== null) {
          state.set(key, { x: aSide.x, y: aSide.y, z: aSide.z, bx: bSide.x, bz: bSide.z, reported: false })
        } else {
          state.set(key, { x: p.x, y: p.y, z: p.z, reported: false })
        }
        continue
      }

      if (lockstepTolerance !== null) {
        // Both sides must have moved, and moved TOGETHER. Measured horizontally, same
        // rationale as the exact tier below.
        const max_ = aSide.x - prev.x, maz = aSide.z - prev.z
        const mbx = bSide.x - (prev.bx ?? bSide.x), mbz = bSide.z - (prev.bz ?? bSide.z)
        const aMoved = max_ * max_ + maz * maz >= moveThreshold * moveThreshold
        const bMoved = mbx * mbx + mbz * mbz >= moveThreshold * moveThreshold
        const ddx = max_ - mbx, ddz = maz - mbz
        const lockstep = ddx * ddx + ddz * ddz <= lockstepTolerance * lockstepTolerance
        const qualifies = aMoved && bMoved && lockstep
        const report = qualifies && !prev.reported
        state.set(key, { x: aSide.x, y: aSide.y, z: aSide.z, bx: bSide.x, bz: bSide.z, reported: prev.reported || qualifies })
        if (report) pairs.push({ a: p.addr, b: q.addr, dist: Math.sqrt(dxz2), dy })
        continue
      }

      // Movement is measured HORIZONTALLY only, matching the coincidence test. Including Y
      // would let vertical motion supply the "it is moving, so it must be a cross-wire"
      // evidence while the 1m Y window supplies the coincidence — two players riding the same
      // updraft (XZ pinned by the trigger radius, both lifted together) fire on that, as does a
      // stationary pair whose entity iteration order swaps between sweeps, because the stored
      // delta then becomes the 0.85 fingerprint itself. A real cross-wire tracks a live
      // player's horizontal walk, so XZ movement still catches it.
      const mx = p.x - prev.x, mz = p.z - prev.z
      const moved = mx * mx + mz * mz >= moveThreshold * moveThreshold
      const report = moved && !prev.reported
      state.set(key, { x: p.x, y: p.y, z: p.z, reported: prev.reported || moved })
      if (report) pairs.push({ a: p.addr, b: q.addr, dist: Math.sqrt(dxz2), dy })
    }
  }

  // Forget pairs that are no longer coincident, so a later recurrence reports again.
  for (const key of state.keys()) {
    if (!seen.has(key)) state.delete(key)
  }
  return pairs
}

export type IdentitySweepEvent =
  /** More than one PlayerIdentityData entity for one address — a reconnect left a corpse. */
  | { kind: 'duplicate'; addr: string; ids: number[] }
  /** First sight of an address whose entity number was already recycled (version > 0). */
  | { kind: 'recycled'; addr: string; id: number }
  /** An address's entity id changed mid-session. */
  | { kind: 'reissued'; addr: string; prevId: number; id: number }

/**
 * Compare this sweep's address → entity-ids map against the previous sweep and report what
 * changed. `lastSeen` and `lastDuplicateSignature` are updated in place; the caller owns both
 * across sweeps.
 *
 * All three event kinds are edge-triggered, so a persistent condition reports once rather than
 * once per sweep. `lastDuplicateSignature` is what makes that true for `duplicate`; omitting it
 * (the default fresh Map) makes duplicates report on EVERY call, which is only appropriate for
 * a caller that wants one-shot semantics, e.g. a test.
 *
 * Both first-sight and changed cases are reported for recycled/reissued, because the playtest
 * that motivated this presented as the FIRST kind: the affected player was already on a
 * recycled slot (entity 65568 = #32 v1) before the first sweep ran, so a change-detector alone
 * would have seen nothing at all.
 */
export function diffIdentitySweep(
  byAddr: ReadonlyMap<string, readonly number[]>,
  lastSeen: Map<string, number>,
  lastDuplicateSignature: Map<string, string> = new Map()
): IdentitySweepEvent[] {
  const events: IdentitySweepEvent[] = []

  for (const [addr, ids] of byAddr) {
    if (ids.length > 1) {
      // Edge-triggered on the id SET, like the two events below — a lingering corpse entity
      // would otherwise emit one line per second, ~86k lines/day, for a single unchanging fact.
      // Keyed on the sorted ids so a duplicate that gains or loses an entity reports again.
      const signature = [...ids].sort((x, y) => x - y).join(',')
      if (lastDuplicateSignature.get(addr) !== signature) {
        lastDuplicateSignature.set(addr, signature)
        events.push({ kind: 'duplicate', addr, ids: [...ids] })
      }
      // Deliberately leave lastSeen untouched. Recording a single "current" id while two
      // entities compete would flip-flop and emit a spurious `reissued` on every sweep.
      continue
    }
    lastDuplicateSignature.delete(addr)
    if (ids.length === 0) continue

    const id = ids[0]
    const prev = lastSeen.get(addr)
    lastSeen.set(addr, id)
    if (prev === undefined) {
      if (entityVersionOf(id) > 0) events.push({ kind: 'recycled', addr, id })
    } else if (prev !== id) {
      events.push({ kind: 'reissued', addr, prevId: prev, id })
    }
  }

  // Forget departed addresses, so a later rejoin is a first sight rather than a reissue.
  for (const addr of lastSeen.keys()) {
    if (!byAddr.has(addr)) lastSeen.delete(addr)
  }
  for (const addr of lastDuplicateSignature.keys()) {
    if (!byAddr.has(addr)) lastDuplicateSignature.delete(addr)
  }

  return events
}
