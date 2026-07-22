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

/**
 * Drop intents too old to ever corroborate a steal again. The store otherwise
 * grows by one entry per address that ever pressed a steal on a long-running
 * server (same bound-the-maps standard as pruneStaleHeartbeats).
 */
export function pruneStaleIntents(
  store: StealIntentStore,
  nowMs: number,
  windowMs: number = STEAL_INTENT_WINDOW_MS
): void {
  for (const [addr, t] of store) {
    if (nowMs - t > windowMs) store.delete(addr)
  }
}

// ── Steal candidate selection ──

export interface StealCandidate {
  addr: string
  /** Distance from the carrier, meters (server view, heartbeat-preferred). */
  dist: number
}

export interface StealSelection {
  /** Closest in-radius candidate WITH client corroboration — the steal beneficiary. */
  closestId: string | null
  closestDist: number
  /** Closest in-radius candidate WITHOUT corroboration — logged, never stealed to. */
  blockedId: string | null
  blockedDist: number
}

/**
 * Two-track selection for server-initiated proximity steals. Corroborated and
 * uncorroborated candidates compete separately so an uncorroborated candidate can
 * never shadow a corroborated one: a cross-wired ghost can sit at a fake "0.85m"
 * from the carrier for an entire session, and it must not stop a real stealer at
 * 1.5m from taking the flag through the server-side fallback path.
 */
export function selectStealCandidate(
  candidates: Iterable<StealCandidate>,
  hasIntent: (addr: string) => boolean,
  radius: number
): StealSelection {
  const selection: StealSelection = {
    closestId: null,
    closestDist: radius,
    blockedId: null,
    blockedDist: radius
  }
  for (const { addr, dist } of candidates) {
    if (hasIntent(addr)) {
      if (dist < selection.closestDist) {
        selection.closestDist = dist
        selection.closestId = addr
      }
    } else if (dist < selection.blockedDist) {
      selection.blockedDist = dist
      selection.blockedId = addr
    }
  }
  return selection
}
