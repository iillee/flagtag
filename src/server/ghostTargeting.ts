/**
 * ghostTargeting.ts — Ghost AI nearest-target selection.
 *
 * Pure module (no engine imports) so the selection stays unit-testable under
 * jest, mirroring stealIntent.ts. The ghost system builds candidates from
 * getPlayerPosition rather than reading player Transforms directly, so every
 * consequential position read goes through the one lookup.
 */

export interface GhostTargetCandidate {
  addr: string
  x: number
  y: number
  z: number
}

export interface NearestGhostTarget {
  addr: string
  x: number
  y: number
  z: number
  /** Distance from the ghost on the XZ plane (chase/contact checks are 2D). */
  distXZ: number
}

/** Players more than this far above/below the ghost are not targetable. */
export const GHOST_TARGET_MAX_Y_DELTA = 20

/**
 * Nearest candidate by XZ-plane distance, ignoring candidates outside the
 * vertical band. Returns null when nobody is targetable. Ties keep the
 * first-seen candidate (matching the original inline loop).
 */
export function findNearestGhostTarget(
  candidates: Iterable<GhostTargetCandidate>,
  ghostX: number,
  ghostY: number,
  ghostZ: number,
  maxYDelta: number = GHOST_TARGET_MAX_Y_DELTA
): NearestGhostTarget | null {
  let nearest: NearestGhostTarget | null = null
  for (const c of candidates) {
    if (Math.abs(c.y - ghostY) > maxYDelta) continue // ignore players too far above/below
    const dx = c.x - ghostX
    const dz = c.z - ghostZ
    const distXZ = Math.sqrt(dx * dx + dz * dz)
    if (nearest === null || distXZ < nearest.distXZ) {
      nearest = { addr: c.addr, x: c.x, y: c.y, z: c.z, distXZ }
    }
  }
  return nearest
}
