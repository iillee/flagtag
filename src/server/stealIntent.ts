/**
 * stealIntent.ts — Client corroboration for server-initiated proximity steals.
 *
 * checkProximitySteal transfers the flag based purely on the server's view of
 * player positions. Under the CRDT Transform cross-wire
 * (docs/BUG_stale-crdt-transform-in-combat.md) that view can place a player
 * permanently inside the steal radius of the carrier, teleporting the flag to
 * someone on the other side of the map.
 *
 * The beneficiary's own client already predicts steals and sends `requestSteal`
 * whenever ITS view (comms avatars — an independent position channel) shows the
 * carrier within radius, retrying every ~500ms while adjacent. A cross-wired
 * "victim" never sends one, because their client sees the true distance. So:
 * only let the server-initiated steal fire when the beneficiary corroborated it
 * recently. Trades a rare missed steal (beneficiary client with a fully stalled
 * flag view) for zero false flag transfers.
 *
 * Pure module: no engine imports, so it stays unit-testable under jest.
 */

export type StealIntentStore = Map<string, number>

/**
 * How long a client's requestSteal counts as corroboration. Clients retry every
 * ~500ms (AUTO_PICKUP_COOLDOWN_MS) while in range, so 2s spans several retries
 * without letting a stale intent authorize a much later transfer.
 */
export const STEAL_INTENT_WINDOW_MS = 2000

/** Record that `address`'s client asked to steal at nowMs (any requestSteal counts, even if rejected). */
export function recordStealIntent(store: StealIntentStore, address: string, nowMs: number): void {
  store.set(address.toLowerCase(), nowMs)
}

export function hasRecentStealIntent(
  store: StealIntentStore,
  address: string,
  nowMs: number,
  windowMs: number = STEAL_INTENT_WINDOW_MS
): boolean {
  const t = store.get(address.toLowerCase())
  if (t === undefined) return false
  return nowMs - t <= windowMs
}

export function clearStealIntent(store: StealIntentStore, address: string): void {
  store.delete(address.toLowerCase())
}
