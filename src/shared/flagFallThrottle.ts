/**
 * flagFallThrottle.ts — Pure helpers for quantizing flag-fall CRDT writes.
 *
 * Why this exists: the server's gravity loop dirties BOTH the synced `Flag`
 * component (`dropAnchorY`) and the synced `Transform.position` on the flag
 * entity every physics frame while the flag is falling. At ~30 server ticks
 * per second, a multi-second water sink produces ~60 CRDT writes/sec on a
 * single entity — the historical CRDT-saturation profile that made
 * scoreboard / hold-time replication stall
 * (docs/CRDT_SATURATION_REDUCTION.md, docs/BUG_stale-crdt-transform-in-combat.md).
 *
 * Design:
 *   - Server physics keeps running at 30 Hz for local collision correctness.
 *   - CRDT promotion is quantized to ~10 Hz (100ms) using
 *     `shouldWriteFallCrdt`. Same decision drives both the Flag component
 *     write AND the Transform re-assert in the same frame — one gate, two
 *     writes.
 *   - The landing frame ALWAYS promotes so the final authoritative rest
 *     position propagates immediately. Otherwise a client could hold a
 *     "flag is still 30cm above ground" view for up to 100ms after the
 *     server considers the fall complete.
 *
 * Client rendering: the flag visual entity is parented to the synced flag
 * entity, so its world position tracks the CRDT Transform directly. A 10 Hz
 * stream means the visual "steps" every 100ms during a fall — measurable in
 * theory but subjectively invisible on a 1–3s drop given the fall speed. If
 * playtest shows visible stepping we can add client-side interpolation, but
 * do the cheap change first.
 */

/**
 * Should the server promote the current fall physics state to CRDT this
 * frame? Returns true iff the fall just ended (must write final rest) OR
 * the throttle interval has elapsed since the last promotion.
 *
 * Callers pass the same `nowMs` used for their `lastWriteMs` bookkeeping so
 * skew inside a frame can't miss a boundary.
 */
export function shouldWriteFallCrdt(
  nowMs: number,
  lastWriteMs: number,
  intervalMs: number,
  landedThisFrame: boolean
): boolean {
  if (landedThisFrame) return true
  return nowMs - lastWriteMs >= intervalMs
}

/**
 * 10 Hz. Chosen because the flag visual entity is parented to the synced
 * Transform, so client render smoothness == CRDT write cadence. 10 Hz gives
 * ~0.3–0.6m of step per update during a typical fall (visually acceptable
 * for a short-duration animation) and saves ~20 msg/s per component vs the
 * old per-frame writes.
 */
export const FALL_CRDT_INTERVAL_MS = 100
