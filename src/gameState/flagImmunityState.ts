/**
 * flagImmunityState.ts — Client-side tracker for per-player flag pickup/steal
 * immunity (aka the "shield" grace period).
 *
 * The server broadcasts `flagImmunity { playerId, durationMs }` whenever a
 * player picks up or steals the flag, and treats them as fully immune from all
 * combat for that duration. Prior to this module, individual client prediction
 * paths (trap walk-in, bomb explosion) had no way to check immunity, so they
 * would locally stun the immune player even though the server was correctly
 * ignoring the "real" hit — resulting in shielded carriers getting VFX + stun
 * even though the flag was safe.
 *
 * This module owns a single source of truth for "is player X currently
 * flag-immune?" that every client prediction site can query.
 *
 * Note: `mushroomSystem.ts` also listens to `flagImmunity` to drive the shield
 * visual (fade-out). That's fine — two listeners on the same message coexist.
 * We deliberately don't share state so a refactor here can't accidentally
 * break the shield visual.
 */
import { getPlayer } from '@dcl/sdk/players'
import { room } from '../shared/messages'
import { registerSystem } from '../systems/systemManager'

// Map<lowercased userId, ms-until-expiry (Date.now() timeline)>
const immunityExpiryMs = new Map<string, number>()

room.onMessage('flagImmunity', (data) => {
  const pid = ((data as any).playerId as string || '').toLowerCase()
  const durationMs = (data as any).durationMs as number
  if (!pid || !durationMs || durationMs <= 0) return
  immunityExpiryMs.set(pid, Date.now() + durationMs)
})

// Sweep expired entries once a second to keep the map from growing forever.
// (Not correctness-critical — hasFlagImmunity checks expiry at read time.)
let sweepAccum = 0
registerSystem((dt: number) => {
  sweepAccum += dt
  if (sweepAccum < 1) return
  sweepAccum = 0
  const now = Date.now()
  for (const [pid, exp] of immunityExpiryMs) {
    if (exp <= now) immunityExpiryMs.delete(pid)
  }
})

/** True if the given userId (case-insensitive) currently has flag pickup/steal immunity. */
export function hasFlagImmunity(userId: string | undefined | null): boolean {
  if (!userId) return false
  const exp = immunityExpiryMs.get(userId.toLowerCase())
  return exp !== undefined && exp > Date.now()
}

/** True if the local player currently has flag pickup/steal immunity. */
export function hasLocalFlagImmunity(): boolean {
  const me = getPlayer()?.userId
  return hasFlagImmunity(me)
}
