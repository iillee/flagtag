import { engine } from '@dcl/sdk/ecs'
import { PlayerFlagHoldTime, Flag, FlagState } from '../shared/components'

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

/** For UI: list of players with hold times from synced component. */
export function getPlayersWithHoldTimes(): { userId: string; name: string; seconds: number }[] {
  // Build lookup from synced hold-time entities, keyed by lowercase playerId
  const synced = new Map<string, number>()
  for (const [, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    synced.set(data.playerId.toLowerCase(), data.seconds)
  }
  const result: { userId: string; name: string; seconds: number }[] = []
  for (const [userId, name] of playersInScene) {
    result.push({
      userId,
      name: name || userId.slice(0, 8),
      seconds: Math.floor(synced.get(userId) ?? 0)
    })
  }
  // Sort: players with points first (desc), then 0-score players at the bottom
  result.sort((a, b) => {
    // Players with score always above players without
    if (a.seconds > 0 && b.seconds === 0) return -1
    if (a.seconds === 0 && b.seconds > 0) return 1
    // Both have score: highest first
    if (a.seconds !== b.seconds) return b.seconds - a.seconds
    // Tie-breaker: alphabetical by userId
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0
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
