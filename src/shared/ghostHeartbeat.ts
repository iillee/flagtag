/**
 * ghostHeartbeat.ts — Pure shared logic for the ghost fallback-visual channel.
 *
 * Ghost visuals are driven by the CRDT `Ghost` component. When that component
 * fails to replicate to a client (documented CRDT sync-gap symptom — same
 * family as the "invisible ghost" playtest report and BUG_stale-crdt-transform),
 * the server keeps sending `ghostTouching` over WebSocket, so the ghost can
 * still kill you while remaining invisible.
 *
 * The server broadcasts this heartbeat (~2Hz) with every active ghost's
 * position. If the client's CRDT view says "no ghosts" but the heartbeat says
 * "ghost alive here," the client builds a lightweight fallback visual driven
 * purely by heartbeat updates. As soon as the CRDT catches up, the fallback is
 * torn down and the normal path takes over.
 *
 * Pure module: no engine imports, so it stays unit-testable under jest and can
 * be imported by both server (serialize) and client (parse) bundles.
 */

/** One entry per active server-side ghost. `id` is the server's stable syncId. */
export interface GhostHeartbeatEntry {
  id: number
  x: number
  y: number
  z: number
}

/**
 * Serialize a snapshot of active ghosts for the WS payload. Kept as JSON (not a
 * Schemas.Array) to match the mushroomPositions precedent — dynamic-length
 * arrays in DCL message schemas are painful, and the payload is tiny.
 */
export function serializeGhostHeartbeat(entries: readonly GhostHeartbeatEntry[]): string {
  return JSON.stringify(entries)
}

/**
 * Safe parse: never throws, always returns an array. Filters out entries
 * missing fields or with non-finite numbers so a malformed payload can't crash
 * the client render loop.
 */
export function parseGhostHeartbeat(json: string): GhostHeartbeatEntry[] {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return [] }
  if (!Array.isArray(raw)) return []
  const out: GhostHeartbeatEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { id, x, y, z } = item as Record<string, unknown>
    if (typeof id !== 'number' || !Number.isFinite(id)) continue
    if (typeof x !== 'number' || !Number.isFinite(x)) continue
    if (typeof y !== 'number' || !Number.isFinite(y)) continue
    if (typeof z !== 'number' || !Number.isFinite(z)) continue
    out.push({ id, x, y, z })
  }
  return out
}

/** Fallback visual is stale after this long without a heartbeat mentioning it. */
export const GHOST_HEARTBEAT_STALE_MS = 2000

export type FallbackAction =
  | { kind: 'noop' }
  | { kind: 'create'; entry: GhostHeartbeatEntry }
  | { kind: 'update'; entry: GhostHeartbeatEntry }
  | { kind: 'destroy' }

export interface FallbackDecisionInput {
  /** How many CRDT-driven ghost visuals the client currently has. */
  crdtGhostCount: number
  /** The most recent heartbeat entries, or [] if the last heartbeat was empty. */
  heartbeat: readonly GhostHeartbeatEntry[]
  /** id of the fallback visual we're currently rendering, or null. */
  currentFallbackId: number | null
  /** Date.now() at decision time. */
  nowMs: number
  /** Date.now() of the last heartbeat we received (0 if none yet). */
  lastHeartbeatMs: number
}

/**
 * Given the current CRDT/heartbeat picture, decide what to do with the
 * fallback visual. Rules:
 *   - CRDT has a ghost visual → no fallback needed (the real path wins).
 *   - No CRDT ghost, heartbeat empty OR stale → destroy any fallback we have.
 *   - No CRDT ghost, heartbeat has ≥1 entry → ensure a fallback for the first
 *     entry. Reuse the same fallback across heartbeats if the id matches (just
 *     update its position); recreate if the id changed.
 *
 * Picking "first entry" is fine: the game currently spawns a single ghost at a
 * time (spawnGhost is gated on activeGhosts.length === 0), and multiple ghosts
 * would want richer reconcile logic anyway. Documented here so a future
 * multi-ghost feature is a known follow-up rather than a silent bug.
 */
export function decideFallbackAction(input: FallbackDecisionInput): FallbackAction {
  const { crdtGhostCount, heartbeat, currentFallbackId, nowMs, lastHeartbeatMs } = input

  // Real CRDT visual is in charge; tear down any fallback.
  if (crdtGhostCount > 0) {
    return currentFallbackId !== null ? { kind: 'destroy' } : { kind: 'noop' }
  }

  const heartbeatFresh = lastHeartbeatMs > 0 && nowMs - lastHeartbeatMs <= GHOST_HEARTBEAT_STALE_MS
  if (!heartbeatFresh || heartbeat.length === 0) {
    return currentFallbackId !== null ? { kind: 'destroy' } : { kind: 'noop' }
  }

  const entry = heartbeat[0]
  if (currentFallbackId === null) return { kind: 'create', entry }
  if (currentFallbackId !== entry.id) return { kind: 'create', entry } // caller destroys the old one first
  return { kind: 'update', entry }
}
