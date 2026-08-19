/**
 * stealCandidate.ts — Closest-candidate selection for server-authoritative proximity
 * decisions: the flag steal (this module's original purpose) and, since 2026-08-19, the
 * projectile hit check in combat.ts, which used to hand-roll the same min-distance loop.
 * `StealCandidate` is just an (address, distance) pair — the name records where the rule came
 * from, not a restriction on who may use it.
 *
 * The server owns the proximity steal outright: checkProximitySteal compares its own
 * player positions and transfers the flag, on the same position view handlePickup, trap
 * triggers, projectile hits and ghost targeting already act on unconditionally. There is no
 * client corroboration step
 * — the beneficiary's client is not consulted and cannot veto the transfer.
 *
 * History: this module used to hold a `requestSteal` corroboration gate, added as a
 * defense against the CRDT Transform cross-wire (docs/BUG_stale-crdt-transform-in-combat.md).
 * That gate made the attacker's client the deciding authority, and when a carrier's avatar
 * entity was reissued (playtest 2026-08-04: entity 32 version 1) other clients could not
 * resolve the carrier at all, so they never sent requestSteal and the flag became
 * unstealable for the rest of the round. The gate is gone; the cross-wire is handled
 * upstream, with the duplicate-entity and entity-reissue logs in serverState.ts as the
 * remaining tripwires.
 *
 * Pure module: no engine imports, so it stays unit-testable under jest.
 */

export interface StealCandidate {
  addr: string
  /** Distance from the carrier, meters (server view, current tick). */
  dist: number
}

export interface StealSelection {
  /** Closest eligible candidate — the steal beneficiary. */
  closestId: string | null
  closestDist: number
}

/**
 * Pick the closest candidate, ignoring `excludeAddr` and anything at or beyond `radius`.
 *
 * `excludeAddr` is the flag's current carrier, and excluding it is **required for
 * correctness, not an optimization**: the carrier's distance to themselves is 0, so a
 * carrier that slipped through would win every single tick and steal the flag from
 * themselves forever. The comparison is case-insensitive on both sides precisely because
 * that failure is catastrophic and silent — every address in this codebase is lowercased by
 * convention, and this makes the guarantee structural instead of conventional. It is a
 * required parameter so no caller can forget it.
 *
 * The strict `<` keeps a candidate standing exactly at the radius boundary out, matching the
 * long-standing behavior. A non-finite `dist` (NaN) also fails `<` and is therefore skipped,
 * so a corrupt position can never win.
 *
 * Ties resolve to the first candidate the iterable yields — a deliberate consequence of the
 * strict `<`, and asserted in the spec. Which address that is carries no meaning, because the
 * caller builds the list from a Set in engine iteration order; the only realistic tie is two
 * players at an identical distance, where either is an equally valid steal.
 */
export function selectClosestCandidate(
  candidates: Iterable<StealCandidate>,
  radius: number,
  excludeAddr: string
): StealSelection {
  const excluded = excludeAddr.toLowerCase()
  const selection: StealSelection = { closestId: null, closestDist: radius }
  for (const { addr, dist } of candidates) {
    if (addr.toLowerCase() === excluded) continue
    if (dist < selection.closestDist) {
      selection.closestDist = dist
      selection.closestId = addr
    }
  }
  return selection
}
