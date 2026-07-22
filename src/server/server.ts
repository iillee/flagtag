/**
 * server.ts — Flag Tag server entry point.
 *
 * Thin orchestrator: creates entities, loads persisted state, registers
 * all domain-module handlers and systems. No game logic lives here.
 *
 * Domain modules:
 *   serverState.ts    — shared mutable state, constants, helpers
 *   persistence.ts    — Storage get/set wrappers
 *   leaderboard.ts    — leaderboard types, helpers, resets
 *   analytics.ts      — visitor tracking and player-join Discord notifications
 *   economy.ts        — coins, wallets, upgrades, store
 *   flagLogic.ts      — flag pickup/drop/steal, gravity, hold-time
 *   combat.ts         — traps, projectiles, orbits
 *   ghostSystem.ts   — ghost AI, spawning, collisions
 *   mushroomSystem.ts — mushroom spawning and pickup
 *   playerTracking.ts — join/leave detection, name resolution
 *   roundManager.ts   — countdown, round end, lightning, updraft
 */

import { engine, Transform } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import {
  setFlagEntity, setCountdownEntity,
  currentScoreRoundId, setCurrentScoreRoundId, setScoreRoundSessionId,
  setLeaderboardEntity, setAllTimeLeaderboardEntity,
  setCoinStateEntity,
  flagEntity, countdownEntity,
  leaderboardEntity, allTimeLeaderboardEntity,
  coinStateEntity,
  holdTimeEntities, knownPlayers, playerBoomerangColors,
  recordPlayerPositions, sweepDuplicateIdentities, getPlayerPosition, isRealName,
  nameChangeCooldowns, feedbackCooldowns, recordPlayerHeartbeat,
} from './serverState'
import { persistPlayerNames, loadPlayerNames, loadVisitorData } from './persistence'
import {
  loadDiscordWebhookUrl,
  restoreMonthlyVisitorData,
  visitorTrackingServerSystem,
} from './analytics'
import {
  patchAllLeaderboardNames, checkLeaderboardDailyReset, updatePlayerName,
  markDailyLeaderboardLoaded, isDailyLeaderboardLoaded, recoverDailyLeaderboard,
} from './leaderboard'
import { isValidLeaderboardJson } from './leaderboardData'
import { resetDailyLeaderboardAfterRecovery } from './leaderboardLifecycle'
import { FEEDBACK_COOLDOWN_MS, NAME_CHANGE_COOLDOWN_MS, isRateLimited } from './cooldownValidation'
import { playerNames } from './serverState'
import { syncEntity } from '@dcl/sdk/network'
import { EnvVar } from '@dcl/sdk/server'
import { storageGet, safeStorageSystem } from './safeStorage'
import {
  Flag, FlagState, PlayerFlagHoldTime, CountdownTimer,
  LeaderboardState, AllTimeLeaderboardState,
  FLAG_BASE_POSITION, FLAG_SPAWN_POINTS, SyncIds,
} from '../shared/components'
import { room } from '../shared/messages'
import { CoinState, COIN_STATE_SYNC_ID } from '../shared/coins'
import { registerEconomyHandlers, coinServerSystem } from './economy'
import { flagServerSystem, holdTimeServerSystem, checkProximitySteal, registerFlagHandlers } from './flagLogic'
import { bananaServerSystem, bombServerSystem, shellServerSystem, orbitServerSystem, registerCombatHandlers, activeTraps, activeProjectiles, activeOrbits, activeBombs } from './combat'
import { registerGhostHandlers, ghostServerSystem } from './ghostSystem'
import { registerMushroomHandlers, spawnMushrooms } from './mushroomSystem'
import { playerTrackingSystem, nameResolverServerSystem } from './playerTracking'
import { countdownServerSystem, lightningServerSystem, updraftServerSystem, registerRoundHandlers, loadRoundWinnerWebhook } from './roundManager'
import { initPostHog, capture } from './posthog'
import { buildScoreRoundId, createScoreSessionId } from './scoreRoundId'

// ── Setup ──

export async function setupServer(): Promise<void> {
  console.log('[Server] Starting Flag Tag server...')

  // Register the storage timeout ticker BEFORE the first storage call: the engine keeps
  // ticking frames while setup awaits, so this protects the boot-time loads below too.
  // Registered later (inside registerSystems) it would leave the entire setup path with
  // zero timeout coverage — a wedged storage connection would hang the server at boot,
  // the exact failure safeStorage exists to convert into a rejection.
  engine.addSystem((dt: number) => {
    try { safeStorageSystem(dt) } catch (err) { console.error('[Server] ❌ safeStorageSystem error:', err) }
  })

  // Boot loads run CONCURRENTLY wherever independent: at ~2s per storage round
  // trip, the old strictly-sequential chain took ~10 calls x 2s to become ready.
  // Order constraints that remain: player names must precede the leaderboards
  // (patchAllLeaderboardNames) and the visitor restores (name backfill), and the
  // reset check needs the leaderboard entities.
  await Promise.all([loadDiscordWebhookUrl(), loadRoundWinnerWebhook(), loadMailboxWebhook(), initPostHog()])

  // ── Player names (needed by leaderboards + visitor restores below) ──
  await loadPlayerNames()

  // ── Flag init: always spawn at base. Flag state is NOT persisted to Storage;
  //    nothing else about the round survives a restart, so a "resumed" flag
  //    produced a half-consistent state. See persistence.ts for full rationale.
  const spawnPoint = FLAG_SPAWN_POINTS[0]
  const flagStartPos = Vector3.create(spawnPoint.x, spawnPoint.y, spawnPoint.z)

  setFlagEntity(engine.addEntity())
  Transform.create(flagEntity, {
    position: flagStartPos,
    rotation: Quaternion.fromEulerDegrees(0, 0, 0),
    scale: Vector3.create(1, 1, 1),
  })
  Flag.create(flagEntity, {
    teamId: 0, state: FlagState.AtBase, carrierPlayerId: '',
    baseX: spawnPoint.x, baseY: spawnPoint.y, baseZ: spawnPoint.z,
    dropAnchorX: spawnPoint.x, dropAnchorY: spawnPoint.y, dropAnchorZ: spawnPoint.z,
  })
  syncEntity(flagEntity, [Transform.componentId, Flag.componentId], SyncIds.FLAG)

  // ── Countdown timer ──
  const now = Date.now()
  const intervalMs = 5 * 60 * 1000
  const nextBoundary = (Math.floor(now / intervalMs) + 1) * intervalMs
  const scoreSessionId = createScoreSessionId(now, Math.random())
  setScoreRoundSessionId(scoreSessionId)
  setCurrentScoreRoundId(buildScoreRoundId(scoreSessionId, nextBoundary))
  setCountdownEntity(engine.addEntity())
  CountdownTimer.create(countdownEntity, {
    roundEndTimeMs: nextBoundary, roundEndTriggered: false,
    roundEndDisplayUntilMs: 0, roundWinnerJson: '',
  })
  syncEntity(countdownEntity, [CountdownTimer.componentId], SyncIds.COUNTDOWN)
  console.log('[Server] Timer initialized, next round ends at:', new Date(nextBoundary).toISOString())

  // ── Leaderboards + reset check, visitor tracking — independent, so concurrent ──
  await Promise.all([
    (async () => {
      await initLeaderboards()
      // Never let the reset check abort boot: storageGet/storageSet are strict (they
      // reject on any transient service error, not just a hang), and an uncaught
      // rejection here would propagate out of setupServer and leave the server
      // running with NO handlers or systems registered. A skipped boot-time reset
      // self-heals — handleRoundEnd runs the same check at every round boundary.
      try {
        await resetDailyLeaderboardAfterRecovery({
          isLoaded: isDailyLeaderboardLoaded,
          recover: recoverDailyLeaderboard,
          reset: () => checkLeaderboardDailyReset(),
        })
      } catch (err) {
        console.error('[Server] ❌ Boot-time leaderboard reset check failed — continuing; round-end retries it:', err)
      }
    })(),
    loadVisitorData(),
    restoreMonthlyVisitorData(),
  ])

  // ── Reconcile stale CRDT hold-time entities ──
  reconcileHoldTimeEntities()

  // ── Coin state ──
  setCoinStateEntity(engine.addEntity())
  CoinState.create(coinStateEntity, { cooldownJson: '{}' })
  syncEntity(coinStateEntity, [CoinState.componentId], COIN_STATE_SYNC_ID)

  // ── Register handlers & systems ──
  registerHandlers()
  registerPositionHeartbeatHandler()
  registerFeedbackHandlers()
  registerFlagHandlers()
  registerEconomyHandlers()
  registerCombatHandlers()
  registerGhostHandlers()
  registerMushroomHandlers()
  registerRoundHandlers()
  registerSystems()

  spawnMushrooms()
  console.log('[Server] Flag Tag server ready')
}

// ── Helpers ──

/** Create and sync all three leaderboard entities from Storage. */
async function initLeaderboards() {
  // Strict reads (storageGet retries transient failures internally): json is null
  // only when the key definitively does not exist; ok is false when storage stayed
  // unreachable. The daily seed loaded here is persisted back from the CRDT at
  // round end, so booting with a false-empty '[]' could overwrite real data — on
  // failure, boot with an empty board for display and report ok:false so the daily
  // persist stays DISABLED (isDailyLeaderboardLoaded) until roundManager recovers
  // the real board from Storage.
  const load = async (key: string): Promise<{ ok: boolean; json: string | null }> => {
    try { return { ok: true, json: await storageGet<string>(key) } } catch (err) {
      console.error('[Server] ❌ Failed to load', key, '(after retries) — starting empty:', err)
      return { ok: false, json: null }
    }
  }

  // Both boards concurrently — independent keys.
  const [daily, at] = await Promise.all([load('leaderboard'), load('allTimeLeaderboard')])

  // Daily
  const dailyIsValid = daily.ok && isValidLeaderboardJson(daily.json)
  if (dailyIsValid) markDailyLeaderboardLoaded()
  else if (!daily.ok) console.error('[Server] ⚠️ Daily leaderboard unavailable — round-end daily persists disabled until a Storage read succeeds')
  else console.error('[Server] ⚠️ Daily leaderboard has an invalid shape — displaying empty and refusing to overwrite Storage')
  const dailyJson = patchAllLeaderboardNames(dailyIsValid ? (daily.json || '[]') : '[]', 'leaderboard')
  console.log('[Server] Daily leaderboard JSON size:', dailyJson.length, 'bytes')
  setLeaderboardEntity(engine.addEntity())
  LeaderboardState.create(leaderboardEntity, { json: dailyJson, date: '' })
  syncEntity(leaderboardEntity, [LeaderboardState.componentId], SyncIds.LEADERBOARD)

  // All-time — compact format {n,w} for CRDT sync (full data stays in Storage). No
  // loaded-flag needed: the round-end update re-reads Storage strictly and aborts on
  // failure, so a false-empty seed here only affects the synced display until then.
  if (at.ok && !isValidLeaderboardJson(at.json)) {
    console.error('[Server] ⚠️ All-time leaderboard has an invalid shape — displaying empty and refusing to overwrite Storage')
  }
  const atJsonFull = patchAllLeaderboardNames(at.ok && isValidLeaderboardJson(at.json) ? (at.json || '[]') : '[]', 'all-time leaderboard')
  let atJsonSync = '[]'
  try {
    const atEntries: { userId: string; name: string; roundsWon: number }[] = JSON.parse(atJsonFull)
    atEntries.sort((a, b) => b.roundsWon - a.roundsWon)
    const compact = atEntries.slice(0, 500).map(e => ({ n: e.name, w: e.roundsWon }))
    atJsonSync = JSON.stringify(compact)
    console.log('[Server] All-time leaderboard:', atEntries.length, 'entries,', atJsonFull.length, 'bytes full,', atJsonSync.length, 'bytes compact')
  } catch { console.log('[Server] All-time leaderboard parse failed, using empty') }
  setAllTimeLeaderboardEntity(engine.addEntity())
  AllTimeLeaderboardState.create(allTimeLeaderboardEntity, { json: atJsonSync })
  syncEntity(allTimeLeaderboardEntity, [AllTimeLeaderboardState.componentId], SyncIds.ALLTIME_LEADERBOARD)

}

/** Reclaim hold-time entities left over from a previous server lifetime. */
function reconcileHoldTimeEntities() {
  let count = 0
  for (const [entity, data] of engine.getEntitiesWith(PlayerFlagHoldTime)) {
    // Never treat a reserved/avatar-range entity (< 512) as a hold-time entity.
    // Hold-time entities are always dynamic (engine.addEntity() -> >= 512). If the
    // component ever rides a reserved slot — e.g. an avatar entity the host
    // version-bumps and deletes on reconnect — caching it hands out a handle that
    // goes stale the instant the host recycles the slot (getMutable() then throws
    // "... for <id> not found"), and removeEntity() on it would delete the avatar.
    // Leave it untouched; getOrCreateHoldTimeEntity owns the real hold-time entities.
    if (((entity as number) & 0xffff) < 512) {
      console.log('[Server] Skipped reserved-range hold-time entity', entity, 'for', data.playerId.slice(0, 8))
      continue
    }
    const key = data.playerId.toLowerCase()
    if (!holdTimeEntities.has(key)) {
      holdTimeEntities.set(key, entity)
      knownPlayers.add(key)
      const mutable = PlayerFlagHoldTime.getMutable(entity)
      mutable.seconds = 0
      mutable.roundId = currentScoreRoundId
      count++
    } else {
      engine.removeEntity(entity)
      console.log('[Server] Removed duplicate hold-time entity for', key.slice(0, 8))
    }
  }
  if (count > 0) console.log('[Server] Reconciled', count, 'stale hold-time entities')
}

/** Wrap system in try/catch and register with engine. */
function registerSystems() {
  const safe = (name: string, fn: (dt: number) => void) => (dt: number) => {
    try { fn(dt) } catch (err) { console.error(`[Server] ❌ ${name} error:`, err) }
  }
  // (safeStorageSystem is registered at the very start of setupServer, before the
  // boot-time storage loads.)
  engine.addSystem(safe('flagServerSystem', flagServerSystem))
  engine.addSystem(safe('holdTimeServerSystem', holdTimeServerSystem))
  engine.addSystem(safe('lightningServerSystem', lightningServerSystem))
  engine.addSystem(safe('playerTrackingSystem', playerTrackingSystem))
  // Snapshot player positions each tick BEFORE combat runs — combat uses history for lag-forgiving hits
  engine.addSystem(safe('recordPlayerPositions', () => { recordPlayerPositions() }))
  engine.addSystem(safe('sweepDuplicateIdentities', () => { sweepDuplicateIdentities() }))
  engine.addSystem(safe('countdownServerSystem', countdownServerSystem))
  engine.addSystem(safe('visitorTrackingServerSystem', visitorTrackingServerSystem))
  engine.addSystem(safe('nameResolverServerSystem', nameResolverServerSystem))
  engine.addSystem(safe('proximityStealSystem', checkProximitySteal))
  engine.addSystem(safe('bananaServerSystem', bananaServerSystem))
  engine.addSystem(safe('bombServerSystem', bombServerSystem))
  engine.addSystem(safe('shellServerSystem', shellServerSystem))
  engine.addSystem(safe('orbitServerSystem', orbitServerSystem))
  engine.addSystem(safe('updraftServerSystem', updraftServerSystem))
  engine.addSystem(safe('ghostServerSystem', ghostServerSystem))
  engine.addSystem(safe('coinServerSystem', coinServerSystem))

  // Diagnostic: log entity/combat stats every 60s to PostHog
  let diagTimer = 0
  let entityCreatedTotal = 0
  let shellDenials = 0
  let shellDenialDetails: string[] = []
  const origAddEntity = engine.addEntity.bind(engine)
  ;(engine as any).addEntity = () => { entityCreatedTotal++; return origAddEntity() }
  // Expose denial tracker for combat.ts
  ;(globalThis as any).__diagShellDenied = (detail: string) => { shellDenials++; shellDenialDetails.push(detail) }
  engine.addSystem((dt: number) => {
    diagTimer += dt
    if (diagTimer >= 60) {
      diagTimer = 0
      const props: Record<string, any> = {
        traps: activeTraps.length,
        projectiles: activeProjectiles.length,
        orbits: activeOrbits.length,
        entityCreatedTotal,
        shellDenials,
      }
      if (shellDenialDetails.length > 0) {
        props.shellDenialSamples = shellDenialDetails.slice(-5).join(' | ')
      }
      capture('server', 'server_diag', props)
      console.log('[Server] 📊 DIAG —', JSON.stringify(props))
      shellDenials = 0
      shellDenialDetails = []
    }
  })
}


/** Register the registerName handler (only handler still in server.ts). */
// Secret comes from the environment only — never hardcode a webhook token (public bundles).
let mailboxWebhook = ''

async function loadMailboxWebhook(): Promise<void> {
  mailboxWebhook = (await EnvVar.get('DISCORD_MAILBOX_WEBHOOK')) || ''
  console.log(mailboxWebhook ? '[Server] ✅ Mailbox webhook loaded from env' : '[Server] ℹ️ No DISCORD_MAILBOX_WEBHOOK set — feedback disabled')
}
/**
 * Client position heartbeat (~8Hz). Feeds the trusted position channel that
 * getPlayerPosition prefers over the cross-wire-prone CRDT Transform
 * (docs/BUG_stale-crdt-transform-in-combat.md). Validation and rate limiting
 * live in positionTrust.ts.
 */
function registerPositionHeartbeatHandler(): void {
  room.onMessage('posHeartbeat', (data, context) => {
    try {
      if (!context) return
      recordPlayerHeartbeat(context.from, data.x, data.y, data.z)
    } catch (err) { console.error('[Server] ❌ posHeartbeat handler error:', err) }
  })
}

function registerFeedbackHandlers(): void {
  room.onMessage('sendFeedback', async (data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    const msg = (data.message || '').trim()
    if (!msg || msg.length > 500) {
      room.send('feedbackResult', { success: false, message: 'Message empty or too long (500 char max).' }, { to: [context.from] })
      return
    }
    // Rate limit: 1 message per 60s per player
    const now = Date.now()
    const last = feedbackCooldowns.get(from) || 0
    if (isRateLimited(last, now, FEEDBACK_COOLDOWN_MS)) {
      room.send('feedbackResult', { success: false, message: 'Please wait before sending another message.' }, { to: [context.from] })
      return
    }
    feedbackCooldowns.set(from, now)
    if (!mailboxWebhook) {
      room.send('feedbackResult', { success: false, message: 'Feedback system not configured.' }, { to: [context.from] })
      return
    }
    try {
      const name = playerNames.get(from) || from.slice(0, 10)
      const res = await fetch(mailboxWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [{ description: msg, author: { name: name }, color: 3447003 }] }),
      })
      if (res.ok || res.status === 204) {
        room.send('feedbackResult', { success: true, message: 'Message sent! Thanks for the feedback.' }, { to: [context.from] })
        console.log('[Server] Feedback from', from.slice(0, 8))
      } else {
        room.send('feedbackResult', { success: false, message: 'Failed to send, try again later.' }, { to: [context.from] })
        console.log('[Server] Webhook failed:', res.status)
      }
    } catch (err) {
      console.error('[Server] Feedback error:', err)
      room.send('feedbackResult', { success: false, message: 'Server error, try again later.' }, { to: [context.from] })
    }
  })
}

/**
 * Clean a client-supplied display name before it reaches synced JSON, Storage and Discord.
 * Strips control + markdown + mention characters, collapses whitespace, and caps length so a
 * hostile client can't inject markdown or @everyone/@here pings into webhooks, or bloat
 * CRDT/Storage with a megabyte-long name.
 */
function sanitizePlayerName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[*_`~|\\@]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
}

function registerHandlers(): void {
  room.onMessage('registerName', (data, context) => {
    try {
      if (!context || !data.name) return
      const from = context.from.toLowerCase()
      const name = sanitizePlayerName(data.name)
      if (!name) return
      const now = Date.now()
      const existing = playerNames.get(from) || ''
      // Always allow the initial placeholder -> real-name upgrade. Once a real name is
      // known, cap client-driven changes so one peer cannot hammer global Storage and
      // all-time leaderboard read-modify-writes by alternating names.
      if (isRealName(existing) && existing !== name
        && isRateLimited(nameChangeCooldowns.get(from), now, NAME_CHANGE_COOLDOWN_MS)) return
      if (updatePlayerName(from, name)) {
        nameChangeCooldowns.set(from, now)
        console.log('[Server] registerName: updated', from.slice(0, 8), '->', name)
        persistPlayerNames().catch(e => console.error('[Server] persistPlayerNames error:', e))
      }
      for (const [playerId, color] of playerBoomerangColors) {
        if (playerId !== from) room.send('playerColorChanged', { playerId, color })
      }
    } catch (err) { console.error('[Server] ❌ registerName handler error:', err) }
  })

  room.onMessage('requestAllColors', (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      for (const [playerId, color] of playerBoomerangColors) {
        if (playerId !== from) room.send('playerColorChanged', { playerId, color })
      }
    } catch (err) { console.error('[Server] ❌ requestAllColors handler error:', err) }
  })

  // Relay water lever pulls only from players actually standing in the interior room.
  // The full client cycle is 120s rise + 60s hold + 120s lower.
  let lastWaterLeverPullMs = 0
  const WATER_LEVER_COOLDOWN_MS = 300_000
  const WATER_LEVER_RADIUS = 24
  const WATER_LEVER_POS = Vector3.create(378, 0, 422)
  room.onMessage('waterLeverPulled', (_data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    const now = Date.now()
    if (now - lastWaterLeverPullMs < WATER_LEVER_COOLDOWN_MS) return
    const playerPos = getPlayerPosition(from)
    if (!playerPos || Vector3.distance(playerPos, WATER_LEVER_POS) > WATER_LEVER_RADIUS) return
    lastWaterLeverPullMs = now
    room.send('waterLeverPulled', { t: Date.now() })
  })
}
