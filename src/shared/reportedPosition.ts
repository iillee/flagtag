/**
 * Validation for client-reported player positions.
 *
 * Used when the multiplayer server has no replicated PlayerIdentityData+Transform
 * for a player (live 2026-11-12: every request was rejected with no-position
 * while the server was otherwise healthy). Pixelwars on the same SDK pin never
 * reads avatar Transforms on the server and instead accepts client-reported
 * feet positions (`botAim` in its server.ts), with the comment "Positions are
 * not visible here".
 *
 * These helpers keep the fallback conservative: finite, in-scene, not the
 * (0,0,0) schema default, and not a teleport faster than a generous glider
 * cap when a fresh previous sample exists.
 */

export type ReportedPos = { x: number; y: number; z: number; t: number }

/** 50x50 parcels is 800m; leave a little slack for boundary movement. */
export const SCENE_POS_MIN_X = -16
export const SCENE_POS_MAX_X = 816
export const SCENE_POS_MIN_Z = -16
export const SCENE_POS_MAX_Z = 816
/** Interior rooms sit near Y=0; the main floor is Y=48; gliders go much higher. */
export const SCENE_POS_MIN_Y = -10
export const SCENE_POS_MAX_Y = 400

/** A report older than this is not used as a live position. */
export const REPORTED_POS_MAX_AGE_MS = 2500

/**
 * Generous cap covering run, double-jump, and glider, plus a little slack for
 * a dropped packet stretching the interval between reports.
 */
export const REPORTED_POS_MAX_SPEED_MPS = 60

export function isPlausibleScenePosition(x: number, y: number, z: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false
  if (x === 0 && y === 0 && z === 0) return false
  return (
    x >= SCENE_POS_MIN_X && x <= SCENE_POS_MAX_X &&
    y >= SCENE_POS_MIN_Y && y <= SCENE_POS_MAX_Y &&
    z >= SCENE_POS_MIN_Z && z <= SCENE_POS_MAX_Z
  )
}

export function isFreshReportedPosition(pos: ReportedPos | undefined, now: number): boolean {
  if (!pos) return false
  return now - pos.t <= REPORTED_POS_MAX_AGE_MS
}

export type ReportedPosDecision =
  | { ok: true; pos: ReportedPos }
  | { ok: false; reason: 'non-finite' | 'origin-default' | 'out-of-bounds' | 'too-fast' }

export function acceptReportedPosition(
  prev: ReportedPos | undefined,
  x: number,
  y: number,
  z: number,
  now: number
): ReportedPosDecision {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return { ok: false, reason: 'non-finite' }
  }
  if (x === 0 && y === 0 && z === 0) {
    return { ok: false, reason: 'origin-default' }
  }
  if (!isPlausibleScenePosition(x, y, z)) {
    return { ok: false, reason: 'out-of-bounds' }
  }
  if (prev && isFreshReportedPosition(prev, now)) {
    const dtSec = Math.max((now - prev.t) / 1000, 1 / 60)
    const dx = x - prev.x
    const dy = y - prev.y
    const dz = z - prev.z
    const speed = Math.sqrt(dx * dx + dy * dy + dz * dz) / dtSec
    if (speed > REPORTED_POS_MAX_SPEED_MPS) {
      return { ok: false, reason: 'too-fast' }
    }
  }
  return { ok: true, pos: { x, y, z, t: now } }
}