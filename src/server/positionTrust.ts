/**
 * positionTrust.ts — Client position heartbeat store.
 *
 * Defense against the server-side CRDT Transform cross-wire
 * (docs/BUG_stale-crdt-transform-in-combat.md): remote-player Transforms in the
 * server's engine can lockstep-follow ANOTHER player's live position, so they
 * cannot be trusted for consequential decisions. Clients report their own
 * position over WebSocket at ~8Hz; the server prefers that channel while it is
 * fresh and falls back to the CRDT Transform otherwise.
 *
 * Trust model: DCL avatar movement is client-authoritative — the CRDT Transform
 * itself originates from the same client's comms packets — so preferring the
 * heartbeat does not open a new spoofing vector. Samples are still validated
 * (finite, inside world bounds, rate-limited) so a hostile client cannot poison
 * the store with garbage or flood it.
 *
 * Pure module: no engine imports, so it stays unit-testable under jest.
 */

export interface HeartbeatSample {
  x: number
  y: number
  z: number
  /** Server receive time (ms epoch) of the sample. */
  t: number
}

export type HeartbeatStore = Map<string, HeartbeatSample>

/** Client send cadence (seconds) — ~8Hz, per the planned defense in the bug doc. */
export const HEARTBEAT_SEND_INTERVAL_S = 0.125
/** A heartbeat older than this is stale; readers fall back to the CRDT Transform. */
export const HEARTBEAT_FRESH_MS = 1500
/** Defensive rate limit: drop samples arriving faster than the client cadence allows. */
export const HEARTBEAT_MIN_INTERVAL_MS = 50

// Accepted coordinate envelope. Generous on purpose: it only needs to reject
// nonsense (spoofed teleports to infinity, NaN poisoning), not enforce gameplay
// boundaries — those stay with the proximity checks that consume the position.
// The playable terrain sits around Y=48–80 post +48 lift, water/floor below it,
// and the world spans a 50x50 parcel grid.
const MAX_XZ = 1024
const MIN_Y = -32
const MAX_Y = 256

export function isPlausibleHeartbeat(x: number, y: number, z: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false
  if (x < 0 || x > MAX_XZ || z < 0 || z > MAX_XZ) return false
  if (y < MIN_Y || y > MAX_Y) return false
  return true
}

/**
 * Validate and store a heartbeat sample. Returns true if the sample was accepted.
 * Rejections are silent by design — a hostile sender learns nothing, and an honest
 * client's next sample lands ~125ms later anyway.
 */
export function recordHeartbeat(store: HeartbeatStore, address: string, x: number, y: number, z: number, nowMs: number): boolean {
  if (!isPlausibleHeartbeat(x, y, z)) return false
  const key = address.toLowerCase()
  const prev = store.get(key)
  if (prev && nowMs - prev.t < HEARTBEAT_MIN_INTERVAL_MS) return false
  store.set(key, { x, y, z, t: nowMs })
  return true
}

/** The player's last heartbeat position, or null when missing or older than maxAgeMs. */
export function getFreshHeartbeat(
  store: HeartbeatStore,
  address: string,
  nowMs: number,
  maxAgeMs: number = HEARTBEAT_FRESH_MS
): HeartbeatSample | null {
  const sample = store.get(address.toLowerCase())
  if (!sample) return null
  if (nowMs - sample.t > maxAgeMs) return null
  return sample
}

export function clearHeartbeat(store: HeartbeatStore, address: string): void {
  store.delete(address.toLowerCase())
}

/**
 * Entries older than this are dropped by pruneStaleHeartbeats. Player-leave events
 * are the primary cleanup (clearPositionHistory), but they are unreliable on this
 * platform (departed players lingering is a documented symptom of the same CRDT
 * bug), so the store needs its own bound to not grow by one entry per visitor
 * forever on a long-running server.
 */
export const HEARTBEAT_RETENTION_MS = 30_000

/** Drop stale entries; returns the pruned addresses so callers can clean their own per-address state. */
export function pruneStaleHeartbeats(
  store: HeartbeatStore,
  nowMs: number,
  retentionMs: number = HEARTBEAT_RETENTION_MS
): string[] {
  const pruned: string[] = []
  for (const [addr, sample] of store) {
    if (nowMs - sample.t > retentionMs) {
      store.delete(addr)
      pruned.push(addr)
    }
  }
  return pruned
}

/**
 * True when two position readings disagree by more than thresholdM meters.
 * Used to detect the cross-wire in production: a fresh heartbeat that disagrees
 * with the CRDT Transform by several meters is the bug's signature (the victim's
 * own client and the server's view cannot legitimately diverge that far for long).
 */
export function positionsDisagree(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  thresholdM: number
): boolean {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz > thresholdM * thresholdM
}
