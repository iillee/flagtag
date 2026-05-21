/**
 * roundManager.ts — Round lifecycle: countdown, round end, lightning strikes, updraft rotation.
 * This is the orchestrator that touches every domain at round boundaries.
 */

import { engine, Transform, PlayerIdentityData } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { Storage } from '@dcl/sdk/server'
import {
  Flag, FlagState, PlayerFlagHoldTime, CountdownTimer, LeaderboardState, AllTimeLeaderboardState, MonthlyLeaderboardState,
  getRandomSpawnPoint, SyncIds, getCurrentMonthString
} from '../shared/components'
import { room } from '../shared/messages'
import {
  flagEntity, countdownEntity,
  leaderboardEntity, allTimeLeaderboardEntity, monthlyLeaderboardEntity,
  holdTimeEntities, knownPlayers, playerNames,
  lastStealTime, playerLifetimeHoldTimeCache,
  SPLASH_DURATION_MS,
} from './serverState'
import { persistFlagState, persistLeaderboard, persistAllTimeLeaderboard, persistMonthlyLeaderboard } from './persistence'
import { parseLeaderboardJson, incrementLeaderboardWins, checkLeaderboardDailyReset, checkMonthlyLeaderboardReset } from './leaderboard'

import { awardRoundCoins } from './economy'
import { flushHoldTimeAccum, clearHoldTimeAccum, getHoldTimeAccumFor, resetGravityState } from './flagLogic'
import { activeTraps, activeProjectiles, activeOrbits, removeTrap, removeProjectile, clearAllCombatCooldowns } from './combat'
import { spawnMushrooms } from './mushroomSystem'
import { addPlayerLifetimeWin, addPlayerLifetimeHoldTime } from './economy'
import { capture } from './posthog'

// ── Lightning state ──
const LIGHTNING_ROLL_INTERVAL = 5
const LIGHTNING_WARNING_DURATION = 3
let lightningRollTimer = 0
let lightningStrikeScheduled = false
let lightningWarningTimer = 0
let _lightningOriginalCarrierId = ''

function getLightningStrikeChance(points: number): number {
  if (points < 100) return 0.0
  if (points < 200) return 0.05 + (points - 100) / 100 * 0.05
  if (points < 250) return 0.10 + (points - 200) / 50 * 0.30
  if (points < 280) return 0.40 + (points - 250) / 30 * 0.30
  return 0.70 + (points - 280) / 20 * 0.25
}

function getCarrierHoldSeconds(): number {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag || flag.state !== FlagState.Carried || !flag.carrierPlayerId) return 0
  const key = flag.carrierPlayerId.toLowerCase()
  const entity = holdTimeEntities.get(key)
  if (!entity) return 0
  return (PlayerFlagHoldTime.getOrNull(entity)?.seconds ?? 0) + getHoldTimeAccumFor(key)
}

// ── Updraft state ──
const UPDRAFT_CHIMNEY_COUNT = 49
const UPDRAFT_ROTATE_SEC = 60
let updraftActiveIndex = Math.floor(Math.random() * UPDRAFT_CHIMNEY_COUNT)
let updraftTimer = 0

export function updraftServerSystem(dt: number): void {
  updraftTimer += dt
  if (updraftTimer >= UPDRAFT_ROTATE_SEC) {
    updraftTimer = 0
    let next = Math.floor(Math.random() * (UPDRAFT_CHIMNEY_COUNT - 1))
    if (next >= updraftActiveIndex) next++
    updraftActiveIndex = next
    room.send('updraftLocation', { index: updraftActiveIndex })
    console.log('[Server] 💨 Updraft moved to chimney', updraftActiveIndex)
  }
}

// ── Lightning system ──
export function lightningServerSystem(dt: number): void {
  const flag = Flag.getOrNull(flagEntity)
  const carried = flag && flag.state === FlagState.Carried && !!flag.carrierPlayerId

  if (lightningStrikeScheduled) {
    lightningWarningTimer += dt
    if (lightningWarningTimer >= LIGHTNING_WARNING_DURATION) {
      lightningStrikeScheduled = false
      lightningWarningTimer = 0

      const victimId = carried ? flag!.carrierPlayerId! : ''

      let strikePos = { x: 256, y: 5, z: 256 }
      if (carried && victimId) {
        for (const [entity] of engine.getEntitiesWith(PlayerIdentityData)) {
          const identity = PlayerIdentityData.get(entity)
          if (identity.address.toLowerCase() === victimId.toLowerCase()) {
            const t = Transform.getOrNull(entity)
            if (t) strikePos = { x: t.position.x, y: t.position.y, z: t.position.z }
            break
          }
        }
      } else {
        const flagT = Transform.getOrNull(flagEntity)
        if (flagT) strikePos = { x: flagT.position.x, y: flagT.position.y, z: flagT.position.z }
      }

      console.log('[Server] ⚡ Lightning strike at', strikePos.x.toFixed(1), strikePos.y.toFixed(1), strikePos.z.toFixed(1), 'victim:', victimId || '(none - flag only)')
      room.send('lightningStrike', { x: strikePos.x, y: strikePos.y, z: strikePos.z, victimId })

      if (carried) {
        const mutable = Flag.getMutable(flagEntity)
        mutable.state = FlagState.Dropped
        mutable.carrierPlayerId = ''
        flushHoldTimeAccum()
        persistFlagState().catch(e => console.error('[Server] persistFlagState error:', e))
      }

      _lightningOriginalCarrierId = ''
    }
    return
  }

  if (!carried) {
    lightningRollTimer = 0
    return
  }

  lightningRollTimer += dt
  if (lightningRollTimer >= LIGHTNING_ROLL_INTERVAL) {
    lightningRollTimer = 0
    const score = getCarrierHoldSeconds()
    const chance = getLightningStrikeChance(score)
    if (chance > 0 && Math.random() < chance) {
      console.log(`[Server] ⚡ Lightning roll succeeded! Score: ${score.toFixed(0)}, Chance: ${(chance * 100).toFixed(1)}%`)
      lightningStrikeScheduled = true
      lightningWarningTimer = 0
      _lightningOriginalCarrierId = flag!.carrierPlayerId!
      room.send('lightningWarning', { t: 0 })
    } else if (chance > 0) {
      console.log(`[Server] ⚡ Lightning roll failed. Score: ${score.toFixed(0)}, Chance: ${(chance * 100).toFixed(1)}%`)
    }
  }
}

// ── Countdown system ──
let lastProcessedRoundEndTime = 0
let lastTimerDebugLog = 0

export function countdownServerSystem(): void {
  const now = Date.now()
  const timer = CountdownTimer.getOrNull(countdownEntity)
  if (!timer) {
    console.log('[Server.ERROR] countdownServerSystem: No timer entity!')
    return
  }
  
  const intervalMs = 5 * 60 * 1000
  
  if (now - lastTimerDebugLog > 30000) {
    lastTimerDebugLog = now
    const secondsUntilEnd = Math.floor((timer.roundEndTimeMs - now) / 1000)
    console.log('[Server.Timer] secondsUntilEnd:', secondsUntilEnd, 'roundEndTimeMs:', new Date(timer.roundEndTimeMs).toISOString(), 'triggered:', timer.roundEndTriggered)
  }
  
  if (!timer.roundEndTriggered && now >= timer.roundEndTimeMs) {
    if (timer.roundEndTimeMs === lastProcessedRoundEndTime) {
      return
    }
    lastProcessedRoundEndTime = timer.roundEndTimeMs
    
    const msAfter = now - timer.roundEndTimeMs
    
    console.log('[Server] ⏰ Round end! Triggered at roundEndTimeMs:', new Date(timer.roundEndTimeMs).toISOString(), `(${msAfter}ms after)`)
    
    const nextBoundary = (Math.floor(now / intervalMs) + 1) * intervalMs
    
    const mutable = CountdownTimer.getMutable(countdownEntity)
    mutable.roundEndTimeMs = nextBoundary
    
    console.log('[Server] Next round will end at:', new Date(nextBoundary).toISOString())
    
    handleRoundEnd().catch((err) => {
      console.error('[Server.ERROR] handleRoundEnd failed:', err)
      try {
        const flag = Flag.getOrNull(flagEntity)
        if (flag && flag.state === FlagState.Carried) {
          const mutable = Flag.getMutable(flagEntity)
          mutable.state = FlagState.AtBase
          mutable.carrierPlayerId = ''
        }
        lightningRollTimer = 0
        lightningStrikeScheduled = false
        lightningWarningTimer = 0
        _lightningOriginalCarrierId = ''
        room.send('respawnPlayers', { t: 0, winnersJson: '[]' })
        console.log('[Server] ⚠️ Emergency round-end recovery executed')
      } catch (recoveryErr) {
        console.error('[Server.ERROR] Emergency recovery also failed:', recoveryErr)
      }
    })
  }
  
  if (timer.roundEndTriggered && now >= timer.roundEndDisplayUntilMs) {
    const mutable = CountdownTimer.getMutable(countdownEntity)
    mutable.roundEndTriggered = false
    console.log('[Server] Round splash finished, new round active')
  }
}

// ── Round end orchestrator ──
async function handleRoundEnd(): Promise<void> {
  const now = Date.now()

  // ══════════════════════════════════════════════════════════════════════
  // CRITICAL: All state mutations that affect holdTimeServerSystem MUST
  // happen synchronously BEFORE any `await`. During `await` gaps, the
  // engine runs systems — if the flag is still Carried, holdTimeServerSystem
  // keeps accumulating time and can write it back AFTER we reset scores.
  // ══════════════════════════════════════════════════════════════════════

  // ── 0a. Flush any in-progress hold time so final scores are accurate ──
  flushHoldTimeAccum()

  // ── 0b. Reset flag to random spawn point IMMEDIATELY (before any await) ──
  resetGravityState()
  const spawnPoint = getRandomSpawnPoint()
  console.log('[Server] Round ended, flag respawning at random location to prevent spawn camping')
  
  const flagMutable = Flag.getMutable(flagEntity)
  flagMutable.state = FlagState.AtBase
  flagMutable.carrierPlayerId = ''
  flagMutable.baseX = spawnPoint.x
  flagMutable.baseY = spawnPoint.y
  flagMutable.baseZ = spawnPoint.z
  
  const flagT = Transform.getMutable(flagEntity)
  flagT.position = Vector3.create(spawnPoint.x, spawnPoint.y, spawnPoint.z)

  // ── 1. Determine winner(s) — read scores BEFORE resetting them ──
  let maxSeconds = 0
  const players: { userId: string; seconds: number }[] = []

  for (const [, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    if (data.seconds > 0) {
      players.push({ userId: data.playerId, seconds: data.seconds })
      if (data.seconds > maxSeconds) maxSeconds = data.seconds
    }
  }

  // ── 2. Reset ALL hold times to 0 synchronously ──
  const connectedNow = new Set<string>()
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    connectedNow.add(identity.address.toLowerCase())
  }

  const entitiesToRemove: string[] = []
  for (const [entity, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    const key = data.playerId.toLowerCase()
    if (connectedNow.has(key)) {
      PlayerFlagHoldTime.getMutable(entity).seconds = 0
    } else {
      entitiesToRemove.push(key)
    }
  }
  for (const userKey of entitiesToRemove) {
    const entity = holdTimeEntities.get(userKey)
    if (entity) {
      engine.removeEntity(entity)
      holdTimeEntities.delete(userKey)
      knownPlayers.delete(userKey)
    }
  }
  if (entitiesToRemove.length > 0) {
    console.log('[Server] Cleaned up', entitiesToRemove.length, 'hold-time entities for disconnected players')
  }

  // Force-clear accumulator again (defensive)
  clearHoldTimeAccum()

  // ── 3. Remove all active traps ──
  for (const trap of activeTraps) {
    removeTrap(trap)
  }
  activeTraps.length = 0
  console.log('[Server] 🪤 All traps cleared for new round')

  // ── 3b. Remove all active projectiles + orbits ──
  for (const projectile of activeProjectiles) {
    removeProjectile(projectile)
  }
  activeProjectiles.length = 0
  for (const orbit of activeOrbits) {
    room.send('orbitEnded', { playerId: orbit.playerId })
  }
  activeOrbits.length = 0
  clearAllCombatCooldowns()
  console.log('[Server] 🎯 All projectiles + orbits cleared for new round')

  // ── 3c. Clear combat cooldown maps ──
  lastStealTime.clear()

  // ── 3d. Reset lightning state ──
  lightningRollTimer = 0
  lightningStrikeScheduled = false
  lightningWarningTimer = 0
  _lightningOriginalCarrierId = ''

  // ── 3e. Respawn mushrooms ──
  spawnMushrooms()
  console.log('[Server] 🍄 Mushrooms respawned for new round')

  // ── 3f. Compute top 3 BEFORE sending respawnPlayers ──
  const topPlayers = [...players]
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 3)
    .map(p => {
      const pKey = p.userId.toLowerCase()
      const storedName = playerNames.get(pKey)
      const displayName = storedName || pKey.slice(0, 8)
      return {
        userId: pKey,
        name: displayName,
        seconds: Math.floor(p.seconds)
      }
    })
  
  for (const p of topPlayers) {
    console.log('[Server] Top player:', p.name, '-', p.seconds, 'seconds')
  }

  const winnersJson = JSON.stringify(topPlayers)

  // ── 3g. Respawn all players ──
  room.send('respawnPlayers', { t: 0, winnersJson })
  console.log('[Server] 📍 Respawning all players at spawn point')

  // ══════════════════════════════════════════════════════════════════════
  // All synchronous state mutations done. Safe to await now.
  // ══════════════════════════════════════════════════════════════════════

  // ── 4. Set timer: splash + winner data ──
  const timerMutable = CountdownTimer.getMutable(countdownEntity)
  timerMutable.roundEndTriggered = true
  timerMutable.roundEndDisplayUntilMs = now + SPLASH_DURATION_MS
  timerMutable.roundWinnerJson = winnersJson
  
  console.log('[Server] Round end splash set, displayUntil:', new Date(timerMutable.roundEndDisplayUntilMs).toISOString())

  // ── 5b. Award coins ──
  await awardRoundCoins(players)

  // ── 6. Check for daily/monthly leaderboard reset ──
  await checkLeaderboardDailyReset()
  await checkMonthlyLeaderboardReset()

  // ── 7. Update all three leaderboards ──
  if (maxSeconds > 0) {
    const dailyEntries = parseLeaderboardJson(LeaderboardState.getOrNull(leaderboardEntity)?.json)
    incrementLeaderboardWins(dailyEntries, players, maxSeconds)
    const dailyJson = JSON.stringify(dailyEntries)
    LeaderboardState.getMutable(leaderboardEntity).json = dailyJson
    await persistLeaderboard(dailyJson)

    const atEntries = parseLeaderboardJson(AllTimeLeaderboardState.getOrNull(allTimeLeaderboardEntity)?.json)
    incrementLeaderboardWins(atEntries, players, maxSeconds)
    const atJson = JSON.stringify(atEntries)
    AllTimeLeaderboardState.getMutable(allTimeLeaderboardEntity).json = atJson
    await persistAllTimeLeaderboard(atJson)

    const currentMonth = getCurrentMonthString()
    const mlLb = MonthlyLeaderboardState.getOrNull(monthlyLeaderboardEntity)
    const mlEntries = (mlLb?.month === currentMonth) ? parseLeaderboardJson(mlLb?.json) : []
    incrementLeaderboardWins(mlEntries, players, maxSeconds)
    const mlJson = JSON.stringify(mlEntries)
    const mlMutable = MonthlyLeaderboardState.getMutable(monthlyLeaderboardEntity)
    mlMutable.json = mlJson
    mlMutable.month = currentMonth
    await persistMonthlyLeaderboard(mlJson)
    await Storage.set('monthlyLeaderboardMonth', currentMonth)
  }

  // ── 7b. Award lifetime wins ──
  if (maxSeconds > 0) {
    const winners = players.filter(p => p.seconds >= maxSeconds)
    for (const w of winners) {
      const newWins = await addPlayerLifetimeWin(w.userId)
      console.log('[LifetimeWins] Player', w.userId.slice(0, 8), 'now has', newWins, 'lifetime wins')
    }
  }

  // ── 7c. Accumulate lifetime flag hold time ──
  for (const p of players) {
    if (p.seconds > 0) {
      const newTotal = await addPlayerLifetimeHoldTime(p.userId, p.seconds)
      console.log('[LifetimeHoldTime] Player', p.userId.slice(0, 8), '+', p.seconds.toFixed(1), 's -> total:', newTotal.toFixed(1), 's')
    }
  }

  // ── 8. Persist flag state ──
  await persistFlagState()

  // ── 9. Track round completion in PostHog ──
  capture('flagtag-server', 'round_ended', {
    player_count: players.length,
    max_hold_seconds: Math.floor(maxSeconds),
    winner_name: topPlayers[0]?.name ?? null,
    winner_id: topPlayers[0]?.userId ?? null,
    top_players: topPlayers.map(p => ({ name: p.name, seconds: p.seconds })),
    lifetime_hold_times: players.filter(p => p.seconds > 0).map(p => {
      const pKey = p.userId.toLowerCase()
      return {
        userId: pKey,
        name: playerNames.get(pKey) || pKey.slice(0, 8),
        round_seconds: p.seconds,
        lifetime_seconds: playerLifetimeHoldTimeCache.get(pKey) ?? 0
      }
    })
  })
}

// ── Message handlers ──
const ADMIN_ADDRESSES = ['0x1e93e534c5e26b01ed242410b43ae23dd0faa52b']

export function registerRoundHandlers(): void {
  room.onMessage('requestUpdraftLocation', (_data, _context) => {
    try {
      room.send('updraftLocation', { index: updraftActiveIndex })
    } catch (err) { console.error('[Server] ❌ requestUpdraftLocation handler error:', err) }
  })

}
