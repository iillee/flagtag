/**
 * playerTracking.ts — Player join/leave detection and name resolution.
 *
 * Detects connected players via PlayerIdentityData, creates hold-time
 * entities on join, loads wallets, tracks visitor sessions, and resolves
 * display names from AvatarBase.
 */

import { engine, PlayerIdentityData, AvatarBase } from '@dcl/sdk/ecs'
import {
  currentlyConnected, playerNames, visitorSessions, monthlyVisitorSessions,
  playerBoomerangColors, playerCoinBalances, playerUpgradeData, playerLifetimeWinsCache,
  playerLifetimeHoldTimeCache, lastStealTime, lightningStruckAt, deathPenaltyCooldowns,
  sessionDeaths, sessionBananasDropped, sessionBoomerangsFired,
  isRealName, clearPositionHistory, roundParticipants,
  nameChangeCooldowns, feedbackCooldowns,
} from './serverState'
import { persistPlayerNames } from './persistence'
import { updatePlayerName } from './leaderboard'
import { getOrCreateHoldTimeEntity } from './flagLogic'
import { clearPlayerEconomyState } from './economy'
import { ensurePlayerHydrated } from './playerDoc'
import { clearCombatCooldowns } from './combat'
import { clearPlayerMushroomState } from './mushroomSystem'
import { schedulePlayerJoinDiscord, markVisitorDataDirty } from './analytics'
import { capture, identify } from './posthog'
import {
  FEEDBACK_COOLDOWN_MS,
  NAME_CHANGE_COOLDOWN_MS,
  pruneExpiredTimestamps,
} from './cooldownValidation'

// ── Player join/leave detection ──

const COOLDOWN_PRUNE_INTERVAL_MS = 10_000
let nextCooldownPruneMs = 0

export function playerTrackingSystem(): void {
  const now = Date.now()
  if (now >= nextCooldownPruneMs) {
    nextCooldownPruneMs = now + COOLDOWN_PRUNE_INTERVAL_MS
    pruneExpiredTimestamps(nameChangeCooldowns, now, NAME_CHANGE_COOLDOWN_MS)
    pruneExpiredTimestamps(feedbackCooldowns, now, FEEDBACK_COOLDOWN_MS)
  }

  // Build set of currently connected players (normalized to lowercase)
  const nowConnected = new Set<string>()
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    nowConnected.add(identity.address.toLowerCase())
  }

  let changed = false

  // Detect new joins (including reconnections)
  for (const userKey of nowConnected) {
    if (!currentlyConnected.has(userKey)) {
      // Player just connected (or reconnected)
      currentlyConnected.add(userKey)
      roundParticipants.add(userKey)

      // Create synced hold time entity if this is a new player
      getOrCreateHoldTimeEntity(userKey)

      // Hydrate the player's consolidated doc (coins, upgrades, lifetime stats,
      // blessing) NOW so every later handler — wallet, store, pedestal — answers
      // from memory instead of paying a ~2s storage round trip mid-interaction.
      // Failures self-heal: the next handler that needs the data retries hydration.
      ensurePlayerHydrated(userKey).catch(err =>
        console.error('[PlayerDoc] Join-time hydration failed for', userKey.slice(0, 8), '— will retry on demand:', err))

      // Start/restart visitor session — use persisted name if available
      const playerName = playerNames.get(userKey) || userKey.slice(0, 8)
      const existingVisitor = visitorSessions.get(userKey)

      if (existingVisitor) {
        existingVisitor.sessionStartMs = Date.now()
        // Only upgrade the name, never downgrade a real name to 0x...
        if (isRealName(playerName) || !isRealName(existingVisitor.name)) {
          existingVisitor.name = playerName
        }
      } else {
        visitorSessions.set(userKey, {
          name: playerName,
          sessionStartMs: Date.now(),
          totalSecondsToday: 0
        })
      }

      // Monthly visitor tracking
      const existingMonthlyVisitor = monthlyVisitorSessions.get(userKey)
      if (existingMonthlyVisitor) {
        existingMonthlyVisitor.sessionStartMs = Date.now()
        if (isRealName(playerName) || !isRealName(existingMonthlyVisitor.name)) {
          existingMonthlyVisitor.name = playerName
        }
      } else {
        monthlyVisitorSessions.set(userKey, {
          name: playerName,
          sessionStartMs: Date.now(),
          totalSecondsMonth: 0
        })
      }

      console.log('[Server] Player joined:', playerName, '(total visitors today:', visitorSessions.size, ')')
      identify(userKey, { wallet_address: userKey, name: playerName })
      capture(userKey, 'player_joined', {
        name: playerName,
        concurrent_players: currentlyConnected.size,
        total_visitors_today: visitorSessions.size
      })
      schedulePlayerJoinDiscord(playerName, userKey, currentlyConnected.size)
      changed = true
    }
  }

  // Detect disconnects
  for (const userKey of currentlyConnected) {
    if (!nowConnected.has(userKey)) {
      currentlyConnected.delete(userKey)

      const visitor = visitorSessions.get(userKey)
      if (visitor && visitor.sessionStartMs > 0) {
        const sessionMs = Date.now() - visitor.sessionStartMs
        const sessionSeconds = Math.floor(sessionMs / 1000)
        visitor.totalSecondsToday += sessionSeconds
        visitor.sessionStartMs = 0 // Mark as offline

        const totalMin = Math.floor(visitor.totalSecondsToday / 60)
        console.log('[Server] Player left:', visitor.name, 'session:', sessionSeconds, 's, total today:', totalMin, 'min')
        capture(userKey, 'player_left', {
          name: visitor.name,
          session_seconds: sessionSeconds,
          total_seconds_today: visitor.totalSecondsToday,
          deaths: sessionDeaths.get(userKey) ?? 0,
          coin_balance: playerCoinBalances.get(userKey) ?? 0,
          bananas_dropped: sessionBananasDropped.get(userKey) ?? 0,
          boomerangs_fired: sessionBoomerangsFired.get(userKey) ?? 0,
          lifetime_hold_seconds: playerLifetimeHoldTimeCache.get(userKey) ?? 0,
        })
      }

      // Monthly visitor disconnect tracking
      const monthlyVisitor = monthlyVisitorSessions.get(userKey)
      if (monthlyVisitor && monthlyVisitor.sessionStartMs > 0) {
        const sessionMs = Date.now() - monthlyVisitor.sessionStartMs
        const sessionSeconds = Math.floor(sessionMs / 1000)
        monthlyVisitor.totalSecondsMonth += sessionSeconds
        monthlyVisitor.sessionStartMs = 0
      }

      // Session totals were just finalized — force the next visitor-stat flush past
      // the throttle (the server can be torn down without warning once the world empties).
      markVisitorDataDirty()

      // Clean up per-player maps to prevent unbounded growth
      playerLifetimeHoldTimeCache.delete(userKey)
      playerBoomerangColors.delete(userKey)
      playerCoinBalances.delete(userKey)
      playerUpgradeData.delete(userKey)
      playerLifetimeWinsCache.delete(userKey)
      clearCombatCooldowns(userKey)
      lastStealTime.delete(userKey)
      lightningStruckAt.delete(userKey)
      deathPenaltyCooldowns.delete(userKey)
      sessionDeaths.delete(userKey)
      sessionBananasDropped.delete(userKey)
      sessionBoomerangsFired.delete(userKey)
      clearPositionHistory(userKey)
      clearPlayerEconomyState(userKey)
      clearPlayerMushroomState(userKey)
      // Abuse cooldowns intentionally survive reconnects and expire through the
      // periodic timestamp pruning above.

      changed = true
    }
  }


}

// ── Name resolution ──

let nameResolveTimer = 0
const NAME_RESOLVE_INTERVAL = 3.0

/**
 * Server-side name resolver — scans AvatarBase.name for all connected players
 * every few seconds. When a real display name appears (not empty, not 0x...),
 * it updates playerNames, visitorSessions, and leaderboard entries, then persists.
 * This catches names that weren't ready when the player first connected.
 */
export function nameResolverServerSystem(dt: number): void {
  nameResolveTimer += dt
  if (nameResolveTimer < NAME_RESOLVE_INTERVAL) return
  nameResolveTimer = 0

  let anyUpdated = false

  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    const userId = identity.address.toLowerCase()
    if (!userId) continue

    // Already have a real name — skip
    const existing = playerNames.get(userId)
    if (existing && isRealName(existing)) continue

    // Try reading AvatarBase.name
    const avatar = AvatarBase.getOrNull(entity)
    if (avatar && isRealName(avatar.name)) {
      if (updatePlayerName(userId, avatar.name)) {
        console.log('[Server] Name resolved via AvatarBase:', userId.slice(0, 8), '->', avatar.name)
        anyUpdated = true
      }
    }
  }

  if (anyUpdated) {
    persistPlayerNames().catch(e => console.error('[Server] persistPlayerNames error:', e))
  }
}
