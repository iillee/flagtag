import { engine, PlayerIdentityData } from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/players'
import { PlayerFlagHoldTime, Flag, FlagState } from '../shared/components'
import { room } from '../shared/messages'

/** Players in the scene (userId -> display name). Updated via onEnterScene / onLeaveScene. */
const playersInScene = new Map<string, string>()

/**
 * Permanent name cache — never evicted. Stores the best-known display name
 * for every player seen this session. Used to resolve leaderboard names
 * even after players leave the scene.
 */
const knownPlayerNames = new Map<string, string>()
// Track previous sort order so ties preserve existing positions (no flickering)
const previousRank = new Map<string, number>()

function isRealName(name: string): boolean {
  return name.length > 0 && !name.startsWith('0x')
}

export function addPlayer(userId: string, name: string): void {
  const key = userId.toLowerCase()
  playersInScene.set(key, name)
  // Cache the name permanently if it's a real display name
  if (isRealName(name)) {
    knownPlayerNames.set(key, name)
  }
}

export function removePlayer(userId: string): void {
  playersInScene.delete(userId.toLowerCase())
  // knownPlayerNames is NOT cleared — names persist for leaderboard
}

/** Get the best-known display name for a userId (scene > cache > null). */
export function getKnownPlayerName(userId: string): string | null {
  const key = userId.toLowerCase()
  const sceneName = playersInScene.get(key)
  if (sceneName && isRealName(sceneName)) return sceneName
  return knownPlayerNames.get(key) ?? null
}

/**
 * Client-side name resolution system.
 * Periodically scans all players in the scene via getPlayer() and updates
 * the local name cache when a real display name is resolved. This catches
 * names that weren't ready when onEnterScene first fired.
 *
 * For the LOCAL player, it also sends registerName to the server so that
 * leaderboard/visitor data gets updated. For OTHER players, the client-side
 * cache is sufficient since UI applies overrides at render time.
 */
let nameResolvTimer = 0
const NAME_RESOLVE_INTERVAL = 2.0 // seconds between scans

export function nameResolverSystem(dt: number): void {
  nameResolvTimer += dt
  if (nameResolvTimer < NAME_RESOLVE_INTERVAL) return
  nameResolvTimer = 0

  const localPlayer = getPlayer()
  const localUserId = localPlayer?.userId?.toLowerCase() ?? ''

  // Build set of players actually present in the scene (from engine entities)
  const presentPlayers = new Set<string>()
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    const userId = identity.address
    if (!userId) continue
    const key = userId.toLowerCase()
    presentPlayers.add(key)

    // Name resolution: try to resolve unknown names
    if (!knownPlayerNames.has(key)) {
      const data = getPlayer({ userId })
      if (data && isRealName(data.name)) {
        knownPlayerNames.set(key, data.name)

        if (playersInScene.has(key)) {
          playersInScene.set(key, data.name)
        }

        if (key === localUserId) {
          room.send('registerName', { name: data.name })
        }
      }
    }
  }

  // Reconciliation: remove stale entries from playersInScene that no longer
  // have a PlayerIdentityData entity. onLeaveScene can miss disconnects/teleports,
  // so this periodic cleanup prevents ghost names on the scoreboard.
  // Always keep the local player (their own entity is always present).
  for (const [userId] of playersInScene) {
    const key = userId.toLowerCase()
    if (key === localUserId) continue
    if (!presentPlayers.has(key)) {
      playersInScene.delete(userId)
      console.log('[FlagHoldTime] Reconciliation: removed stale player', key.slice(0, 8), 'from playersInScene')
    }
  }
}

/** For UI: list of players with hold times from synced component. */
// ── Client-side interpolation for smooth scoreboard counting ──
// The server syncs hold time every ~0.2s via CRDT. Between updates, we locally
// extrapolate the carrier's score so the UI counts up smoothly every frame.
let lastCarrierId = ''
let lastCarrierSyncedSeconds = 0
let interpolationStartTime = 0

// Server-confirmed carrier — used as fallback when CRDT Flag state is stale.
// Set by flagSystem when pickupConfirmed arrives, cleared when CRDT catches up or drop confirmed.
let confirmedCarrierIdForInterpolation = ''
let confirmedCarrierTimestamp = 0

/** Called by flagSystem when pickupConfirmed message arrives. */
export function setConfirmedCarrier(carrierId: string): void {
  confirmedCarrierIdForInterpolation = carrierId.toLowerCase()
  confirmedCarrierTimestamp = Date.now()
}

/** Called by flagSystem when CRDT confirms Carried state or a drop is confirmed. */
export function clearConfirmedCarrier(): void {
  confirmedCarrierIdForInterpolation = ''
  confirmedCarrierTimestamp = 0
}

/**
 * Called every frame (from a system) to keep interpolation state fresh.
 * Tracks when the carrier or their synced seconds change.
 * Also detects round resets (all scores drop to 0) to prevent stale interpolation.
 */
export function updateHoldTimeInterpolation(): void {
  let currentCarrierId = ''
  for (const [, flag] of engine.getEntitiesWith(Flag)) {
    if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
      currentCarrierId = flag.carrierPlayerId.toLowerCase()
    }
    break
  }

  // If CRDT doesn't show a carrier but the server confirmed one recently (< 3s ago),
  // trust the confirmation so interpolation doesn't reset during the CRDT gap.
  if (!currentCarrierId && confirmedCarrierIdForInterpolation) {
    if (Date.now() - confirmedCarrierTimestamp < 3000) {
      currentCarrierId = confirmedCarrierIdForInterpolation
    } else {
      // Grace expired — clear stale confirmation
      confirmedCarrierIdForInterpolation = ''
      confirmedCarrierTimestamp = 0
    }
  }

  if (currentCarrierId !== lastCarrierId) {
    // Carrier changed — reset interpolation
    lastCarrierId = currentCarrierId
    lastCarrierSyncedSeconds = 0
    interpolationStartTime = Date.now()
  }

  if (currentCarrierId) {
    // Read the latest synced seconds for the carrier
    let maxSynced = 0
    for (const [, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
      if (data.playerId.toLowerCase() === currentCarrierId) {
        maxSynced = Math.max(maxSynced, data.seconds)
      }
    }
    // Detect round reset: if server synced value drops below our last known value,
    // the round was reset. Re-anchor interpolation to the new (lower) value.
    if (maxSynced < lastCarrierSyncedSeconds) {
      lastCarrierSyncedSeconds = maxSynced
      interpolationStartTime = Date.now()
    }
    // When server sends a new value, re-anchor our interpolation
    if (maxSynced > lastCarrierSyncedSeconds) {
      lastCarrierSyncedSeconds = maxSynced
      interpolationStartTime = Date.now()
    }
  }
}

export function getPlayersWithHoldTimes(): { userId: string; name: string; seconds: number }[] {
  // Build lookup from synced hold-time entities, keyed by lowercase playerId.
  // If duplicates exist (shouldn't after server cleanup), SUM them — but if
  // ANY entity for a player has seconds=0, treat the whole player as 0
  // (the server reset scores to 0 at round end; stale entities must not override).
  const synced = new Map<string, number>()
  const hasZero = new Set<string>()
  for (const [, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    const key = data.playerId.toLowerCase()
    if (data.seconds === 0) hasZero.add(key)
    const existing = synced.get(key) ?? 0
    synced.set(key, Math.max(existing, data.seconds))
  }
  // If the server reset a player's score to 0, force it to 0 regardless of stale duplicates
  for (const key of hasZero) {
    synced.set(key, 0)
  }

  // Client-side interpolation: add elapsed time since last CRDT update for the current carrier.
  // Only apply if the synced value is still > 0 — if the server reset scores to 0 (round end)
  // but updateHoldTimeInterpolation hasn't run yet this frame, we must not inject stale data.
  if (lastCarrierId && lastCarrierSyncedSeconds > 0) {
    const carrierSynced = synced.get(lastCarrierId) ?? 0
    if (carrierSynced > 0) {
      const elapsedSec = (Date.now() - interpolationStartTime) / 1000
      const interpolated = lastCarrierSyncedSeconds + elapsedSec
      synced.set(lastCarrierId, Math.max(carrierSynced, interpolated))
    }
  }

  // Build result ONLY from players currently in the scene.
  // We no longer include "synced-but-not-in-scene" players because the server
  // now cleans up hold-time entities for disconnected players at round end,
  // and showing stale ghost entries was causing the duplicate name bug.
  const seen = new Set<string>()
  const result: { userId: string; name: string; seconds: number; rawSeconds: number }[] = []
  for (const [userId, name] of playersInScene) {
    const key = userId.toLowerCase()
    if (seen.has(key)) continue  // Defensive dedup
    seen.add(key)

    const raw = synced.get(key) ?? 0
    const displayName = getKnownPlayerName(userId) || name || userId.slice(0, 8)
    result.push({
      userId,
      name: displayName,
      seconds: Math.floor(raw),
      rawSeconds: raw
    })
  }

  // Sort by floored seconds (what the user sees) so sub-second interpolation
  // jitter doesn't cause visible reordering.  Ties preserve previous order
  // (whoever was higher first stays higher) to prevent flickering.
  result.sort((a, b) => {
    const floorDiff = Math.floor(b.rawSeconds) - Math.floor(a.rawSeconds)
    if (floorDiff !== 0) return floorDiff
    // Tie: preserve previous rank order (lower rank index = higher position)
    const prevA = previousRank.get(a.userId.toLowerCase()) ?? 9999
    const prevB = previousRank.get(b.userId.toLowerCase()) ?? 9999
    return prevA - prevB
  })

  // Update previous rank for next frame
  previousRank.clear()
  result.forEach((p, i) => previousRank.set(p.userId.toLowerCase(), i))
  return result
}

/** Who is currently holding the flag. Null if no one is carrying. */
export function getCurrentFlagCarrierUserId(): string | null {
  for (const [, flag] of engine.getEntitiesWith(Flag)) {
    if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
      return flag.carrierPlayerId
    }
  }
  return null
}
