/**
 * roundManager.ts — Round lifecycle: countdown, round end, lightning strikes, updraft rotation.
 * This is the orchestrator that touches every domain at round boundaries.
 */

import { engine, Transform, PlayerIdentityData } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { Storage } from '@dcl/sdk/server'
import {
  Flag, FlagState, PlayerFlagHoldTime, CountdownTimer, LeaderboardState, AllTimeLeaderboardState,
  getRandomSpawnPoint, SyncIds, getCurrentMonthString
} from '../shared/components'
import { room } from '../shared/messages'
import {
  flagEntity, countdownEntity,
  leaderboardEntity, allTimeLeaderboardEntity,
  holdTimeEntities, knownPlayers, playerNames,
  lastStealTime, playerLifetimeHoldTimeCache,
  SPLASH_DURATION_MS,
} from './serverState'
import { persistFlagState, persistLeaderboard, persistAllTimeLeaderboard } from './persistence'
import { parseLeaderboardJson, incrementLeaderboardWins, checkLeaderboardDailyReset } from './leaderboard'

import { awardRoundCoins } from './economy'
import { flushHoldTimeAccum, clearHoldTimeAccum, getHoldTimeAccumFor, resetGravityState, computeGravityTarget } from './flagLogic'
import { activeTraps, activeProjectiles, activeOrbits, activeBombs, removeTrap, removeProjectile, removeBomb, clearAllCombatCooldowns } from './combat'
import { spawnMushrooms } from './mushroomSystem'
import { addPlayerLifetimeWin, addPlayerLifetimeHoldTime, loadPlayerUpgrades, loadPlayerLifetimeWins, loadPlayerLifetimeHoldTime } from './economy'
import { serializeUpgrades } from '../shared/upgrades'
import { capture } from './posthog'
import { EnvVar } from '@dcl/sdk/server'
import { isPreview } from './analytics'

const ROUND_WINNER_WEBHOOK_FALLBACK = 'https://discordapp.com/api/webhooks/1519451777831796736/HQjwWnNLW0ejguz5N5FcllRTkkl_DeD3xJ-ISFLDLrV5zlxLhvqFDTeNatjB6iZpxRYa'
let ROUND_WINNER_WEBHOOK = ROUND_WINNER_WEBHOOK_FALLBACK

export async function loadRoundWinnerWebhook(): Promise<void> {
  ROUND_WINNER_WEBHOOK = (await EnvVar.get('DISCORD_ROUND_WINNER_WEBHOOK')) || ROUND_WINNER_WEBHOOK_FALLBACK
  console.log('[Server] ✅ Round winner webhook loaded')
}

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

// ── Updraft state (two updrafts, staggered by 30s) ──
const UPDRAFT_CHIMNEY_COUNT = 49
const UPDRAFT_ROTATE_SEC = 60
const UPDRAFT_STAGGER_SEC = 30

function pickRandom(exclude: number): number {
  let next = Math.floor(Math.random() * (UPDRAFT_CHIMNEY_COUNT - 1))
  if (next >= exclude) next++
  return next
}

let updraftActiveIndex1 = Math.floor(Math.random() * UPDRAFT_CHIMNEY_COUNT)
let updraftActiveIndex2 = pickRandom(updraftActiveIndex1)
let updraftTimer1 = 0
let updraftTimer2 = UPDRAFT_STAGGER_SEC // start staggered

export function updraftServerSystem(dt: number): void {
  updraftTimer1 += dt
  if (updraftTimer1 >= UPDRAFT_ROTATE_SEC) {
    updraftTimer1 = 0
    updraftActiveIndex1 = pickRandom(updraftActiveIndex2)
    room.send('updraftLocation', { slot: 0, index: updraftActiveIndex1 })
    console.log('[Server] 💨 Updraft 1 moved to chimney', updraftActiveIndex1)
  }

  updraftTimer2 += dt
  if (updraftTimer2 >= UPDRAFT_ROTATE_SEC) {
    updraftTimer2 = 0
    updraftActiveIndex2 = pickRandom(updraftActiveIndex1)
    room.send('updraftLocation', { slot: 1, index: updraftActiveIndex2 })
    console.log('[Server] 💨 Updraft 2 moved to chimney', updraftActiveIndex2)
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
        flushHoldTimeAccum()
        const mutable = Flag.getMutable(flagEntity)
        mutable.state = FlagState.Dropped
        mutable.carrierPlayerId = ''
        mutable.dropAnchorX = strikePos.x
        mutable.dropAnchorY = strikePos.y
        mutable.dropAnchorZ = strikePos.z
        const t = Transform.getMutable(flagEntity)
        t.position = Vector3.create(strikePos.x, strikePos.y, strikePos.z)
        computeGravityTarget(strikePos.y)
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
    
    handleRoundEnd(timer.roundEndTimeMs).catch((err) => {
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
/**
 * Compute a deterministic match ID from the round's end time (UTC-aligned to 5-min boundary).
 * Format: YYYYMMDD-HH-NN  where NN is 01–12 (match index within the hour).
 * Example: 20260706-14-03 = 3rd match of the 14:00 UTC hour on July 6, 2026.
 *
 * Derived from the *start* of the match (endMs - 5min) so a match started at 14:04:59
 * that ends at 14:10:00 is still labeled 14-01.
 */
function computeMatchId(roundEndMs: number): string {
  const startMs = roundEndMs - 5 * 60 * 1000
  const d = new Date(startMs)
  const YYYY = d.getUTCFullYear()
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0')
  const DD = String(d.getUTCDate()).padStart(2, '0')
  const HH = String(d.getUTCHours()).padStart(2, '0')
  const NN = String(Math.floor(d.getUTCMinutes() / 5) + 1).padStart(2, '0')
  return `${YYYY}${MM}${DD}-${HH}-${NN}`
}

async function handleRoundEnd(endedRoundEndMs: number): Promise<void> {
  const now = Date.now()
  const matchId = computeMatchId(endedRoundEndMs)
  console.log('[Server] Match ID:', matchId)

  // ══════════════════════════════════════════════════════════════════════
  // CRITICAL: All state mutations that affect holdTimeServerSystem MUST
  // happen synchronously BEFORE any `await`. During `await` gaps, the
  // engine runs systems — if the flag is still Carried, holdTimeServerSystem
  // keeps accumulating time and can write it back AFTER we reset scores.
  // ══════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════
  // FAST PATH: Read scores + send respawnPlayers ASAP, cleanup after.
  // ══════════════════════════════════════════════════════════════════════

  // ── 0. Flush hold time so final scores are accurate ──
  flushHoldTimeAccum()

  // ── 1. Read scores BEFORE resetting ──
  let maxSeconds = 0
  const players: { userId: string; seconds: number }[] = []

  for (const [, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    if (data.seconds > 0) {
      players.push({ userId: data.playerId, seconds: data.seconds })
      if (data.seconds > maxSeconds) maxSeconds = data.seconds
    }
  }

  // ── 2. Compute top 3 ──
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
  const winnersJson = JSON.stringify(topPlayers)

  // ── 2a. Reset flag BEFORE sending respawnPlayers ──
  // Flag must be at base before clients receive the message, so the CRDT
  // update is queued in the same tick and clients never see the old state.
  resetGravityState()
  const spawnPoint = getRandomSpawnPoint()
  console.log('[Server] Round ended, flag respawning at random location')
  
  const flagMutable = Flag.getMutable(flagEntity)
  flagMutable.state = FlagState.AtBase
  flagMutable.carrierPlayerId = ''
  flagMutable.baseX = spawnPoint.x
  flagMutable.baseY = spawnPoint.y
  flagMutable.baseZ = spawnPoint.z
  
  const flagT = Transform.getMutable(flagEntity)
  flagT.position = Vector3.create(spawnPoint.x, spawnPoint.y, spawnPoint.z)

  // ── 2b. Send respawnPlayers AFTER flag reset ──
  room.send('respawnPlayers', { t: 0, winnersJson })
  console.log('[Server] 📍 Respawning all players (flag already reset)')

  // ══════════════════════════════════════════════════════════════════════
  // CLEANUP: Everything below runs during the cinematic (players frozen)
  // ══════════════════════════════════════════════════════════════════════

  // ── 3b. Reset ALL hold times to 0 ──
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

  // ── 3. Release all active traps back to pool ──
  for (const trap of activeTraps) {
    removeTrap(trap)
  }
  activeTraps.length = 0
  for (const bomb of activeBombs) {
    removeBomb(bomb)
  }
  activeBombs.length = 0
  console.log('[Server] 🪤 All traps + bombs released to pool for new round')

  // ── 3b. Release all active projectiles + orbits back to pool ──
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

  for (const p of topPlayers) {
    console.log('[Server] Top player:', p.name, '-', p.seconds, 'seconds')
  }

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

  // ── 7. Update all three leaderboards ──
  if (maxSeconds > 0) {
    const dailyEntries = parseLeaderboardJson(LeaderboardState.getOrNull(leaderboardEntity)?.json)
    incrementLeaderboardWins(dailyEntries, players, maxSeconds)
    const dailyJson = JSON.stringify(dailyEntries)
    LeaderboardState.getMutable(leaderboardEntity).json = dailyJson
    await persistLeaderboard(dailyJson)

    // All-time: read full data from Storage, update, persist full, sync compact
    const atFullJson = (await (async () => { try { return await Storage.get<string>('allTimeLeaderboard') } catch { return null } })()) || '[]'
    const atEntries = parseLeaderboardJson(atFullJson)
    incrementLeaderboardWins(atEntries, players, maxSeconds)
    await persistAllTimeLeaderboard(JSON.stringify(atEntries))
    // Compact format for CRDT sync
    atEntries.sort((a, b) => b.roundsWon - a.roundsWon)
    const atCompact = atEntries.slice(0, 500).map(e => ({ n: e.name, w: e.roundsWon }))
    AllTimeLeaderboardState.getMutable(allTimeLeaderboardEntity).json = JSON.stringify(atCompact)

    const currentMonth = getCurrentMonthString()
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

  // ── 7d. Send updated lifetime stats to each player via WebSocket ──
  for (const p of players) {
    const upgrades = await loadPlayerUpgrades(p.userId)
    const wins = await loadPlayerLifetimeWins(p.userId)
    const holdTime = await loadPlayerLifetimeHoldTime(p.userId)
    room.send('upgradesResponse', { upgradesJson: serializeUpgrades(upgrades), wins, lifetimeHoldTime: holdTime }, { to: [p.userId] })
  }

  // ── 8. Persist flag state ──
  await persistFlagState()

  // ── 8b. Discord webhook: announce round winner(s) ──
  if (maxSeconds > 0) {
    const winners = players.filter(p => p.seconds >= maxSeconds)
    if (winners.length > 0) {
      const label = winners.length > 1 ? '🏆 Tie between' : '🏆 Winner:'
      const content = `\`[${matchId}]\` ${label} ${winners.map(w => `**${w.name}** (${w.userId})`).join(' & ')}`
      if (!ROUND_WINNER_WEBHOOK || isPreview) { /* webhook not configured or preview */ }
      else fetch(ROUND_WINNER_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      }).then(() => {}, () => {})
    }
  }

  // ── 9. Track round completion in PostHog ──
  capture('flagtag-server', 'round_ended', {
    match_id: matchId,
    round_end_utc: new Date(endedRoundEndMs).toISOString(),
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
      room.send('updraftLocation', { slot: 0, index: updraftActiveIndex1 })
      room.send('updraftLocation', { slot: 1, index: updraftActiveIndex2 })
    } catch (err) { console.error('[Server] ❌ requestUpdraftLocation handler error:', err) }
  })

}
