/**
 * ghostContactState.ts — Pure helpers for throttling the `ghostTouching`
 * event stream between server and client.
 *
 * Why this exists: prior to throttling, the server sent `ghostTouching` every
 * server tick (~30 Hz) to ALL clients while any ghost was in contact with any
 * player. On a night with a few players + one active ghost that stream alone
 * eats a big chunk of the ~40 msg/s room budget, starving CRDT replication
 * (scoreboard ghosts, missed flag state). See docs/CRDT_SATURATION_REDUCTION.md.
 *
 * Design:
 *   - Server throttles `ghostTouching` to ~5 Hz PER VICTIM (200ms). Different
 *     victims are independent — the ghost can only contact one player at a
 *     time in practice, but the per-victim key keeps the logic robust if that
 *     ever changes.
 *   - Client no longer flips a per-frame boolean on receipt; it stores a
 *     "last touch received" timestamp and treats itself as "being touched"
 *     for a hold window (300ms) after that. 300 > 200 tolerates one dropped
 *     message without prematurely draining the scare meter.
 *
 * The scare meter fills over ~3 seconds of contact (SCARE_TIME), so 200ms
 * server granularity and 300ms client hold are invisible to the player.
 */

/**
 * Server-side: should we send a `ghostTouching` for this victim right now?
 * Returns true iff at least `intervalMs` has elapsed since we last sent one
 * for this same victim.
 */
export function shouldSendGhostTouching(
  nowMs: number,
  lastSentMs: number | undefined,
  intervalMs: number
): boolean {
  if (lastSentMs === undefined) return true
  return nowMs - lastSentMs >= intervalMs
}

/**
 * Client-side: is the local player considered "being touched" right now,
 * given the last time a `ghostTouching` message arrived for them?
 *
 * The hold window MUST exceed the server's send interval by a comfortable
 * margin, otherwise the meter drains between messages and the "3 seconds of
 * contact = death" invariant breaks. Recommended: server sends every 200ms,
 * client holds for 300ms (one dropped-message tolerance).
 */
export function isTouchingHeld(
  nowMs: number,
  lastReceivedMs: number,
  holdMs: number
): boolean {
  if (lastReceivedMs <= 0) return false
  return nowMs - lastReceivedMs < holdMs
}

/**
 * Interval + hold constants used by the server sender and client receiver.
 * Kept together so any future tuning stays consistent.
 */
export const GHOST_TOUCHING_SEND_INTERVAL_MS = 200
export const GHOST_TOUCHING_HOLD_MS = 300
