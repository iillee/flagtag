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

  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    const userId = identity.address
    if (!userId) continue
    const key = userId.toLowerCase()

    // Already have a real name cached — skip
    if (knownPlayerNames.has(key)) continue

    // Try to resolve via getPlayer (reads AvatarBase.name)
    const data = getPlayer({ userId })
    if (data && isRealName(data.name)) {
      knownPlayerNames.set(key, data.name)

      // Update playersInScene if they're still here
      if (playersInScene.has(key)) {
        playersInScene.set(key, data.name)
      }

      // Only send registerName to the server for the LOCAL player's own name
      // (context.from on the server is always the sender's userId)
      if (key === localUserId) {
        room.send('registerName', { name: data.name })
      }
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

/**
 * Called every frame (from a system) to keep interpolation state fresh.
 * Tracks when the carrier or their synced seconds change.
 */
export function updateHoldTimeInterpolation(): void {
  let currentCarrierId = ''
  for (const [, flag] of engine.getEntitiesWith(Flag)) {
    if (flag.state === FlagState.Carried && flag.carrierPlayerId) {
      currentCarrierId = flag.carrierPlayerId.toLowerCase()
    }
    break
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
    // When server sends a new value, re-anchor our interpolation
    if (maxSynced > lastCarrierSyncedSeconds) {
      lastCarrierSyncedSeconds = maxSynced
      interpolationStartTime = Date.now()
    }
  }
}

export function getPlayersWithHoldTimes(): { userId: string; name: string; seconds: number }[] {
  // Build lookup from synced hold-time entities, keyed by lowercase playerId.
  // Multiple entities may exist for the same player (e.g. after server restart),
  // so take the MAX seconds to avoid showing stale zero-score duplicates.
  // Store raw float for accurate sorting; floor only for display.
  const synced = new Map<string, number>()
  for (const [, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    const key = data.playerId.toLowerCase()
    const existing = synced.get(key) ?? 0
    synced.set(key, Math.max(existing, data.seconds))
  }

  // Client-side interpolation: add elapsed time since last CRDT update for the current carrier
  if (lastCarrierId && lastCarrierSyncedSeconds > 0) {
    const elapsedSec = (Date.now() - interpolationStartTime) / 1000
    const interpolated = lastCarrierSyncedSeconds + elapsedSec
    const existing = synced.get(lastCarrierId) ?? 0
    synced.set(lastCarrierId, Math.max(existing, interpolated))
  }

  // Build result from players currently in the scene
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

  // Safety net: include any synced players with scores who aren't in playersInScene
  // This handles race conditions where PlayerFlagHoldTime arrives before onEnterScene
  for (const [key, seconds] of synced) {
    if (seen.has(key)) continue
    if (seconds <= 0) continue
    seen.add(key)
    const displayName = getKnownPlayerName(key) || key.slice(0, 8)
    result.push({
      userId: key,
      name: displayName,
      seconds: Math.floor(seconds),
      rawSeconds: seconds
    })
  }

  // Sort by raw float seconds (desc) for accurate ordering, then alphabetically for ties
  result.sort((a, b) => {
    if (a.rawSeconds !== b.rawSeconds) return b.rawSeconds - a.rawSeconds
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
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
