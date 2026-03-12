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
  playersInScene.set(userId, name)
  // Cache the name permanently if it's a real display name
  if (isRealName(name)) {
    knownPlayerNames.set(userId, name)
  }
}

export function removePlayer(userId: string): void {
  playersInScene.delete(userId)
  // knownPlayerNames is NOT cleared — names persist for leaderboard
}

/** Get the best-known display name for a userId (scene > cache > null). */
export function getKnownPlayerName(userId: string): string | null {
  const sceneName = playersInScene.get(userId)
  if (sceneName && isRealName(sceneName)) return sceneName
  return knownPlayerNames.get(userId) ?? null
}

/** For UI: list of players with hold times from synced component. */
export function getPlayersWithHoldTimes(): { userId: string; name: string; seconds: number }[] {
  const synced = new Map<string, number>()
  for (const [, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    synced.set(data.playerId, data.seconds)
  }
  const result: { userId: string; name: string; seconds: number }[] = []
  for (const [userId, name] of playersInScene) {
    result.push({
      userId,
      name: name || userId.slice(0, 8),
      seconds: Math.floor(synced.get(userId) ?? 0)
    })
  }
  result.sort((a, b) => {
    if (b.seconds !== a.seconds) return b.seconds - a.seconds
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
