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
 *   analytics.ts      — visitor tracking, Discord webhooks, daily reports
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
  setLeaderboardEntity, setAllTimeLeaderboardEntity,
  setCoinStateEntity,
  flagEntity, countdownEntity,
  leaderboardEntity, allTimeLeaderboardEntity,
  coinStateEntity,
  holdTimeEntities, knownPlayers, playerBoomerangColors,
  recordPlayerPositions,
} from './serverState'
import { persistPlayerNames, loadPlayerNames, loadVisitorData } from './persistence'
import {
  loadDiscordWebhookUrl,
  restoreMonthlyVisitorData,
  visitorTrackingServerSystem,
} from './analytics'
import { patchAllLeaderboardNames, checkLeaderboardDailyReset, updatePlayerName } from './leaderboard'
import { playerNames } from './serverState'
import { syncEntity } from '@dcl/sdk/network'
import { Storage, EnvVar } from '@dcl/sdk/server'
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

// ── Setup ──

export async function setupServer(): Promise<void> {
  console.log('[Server] Starting Flag Tag server...')

  await loadDiscordWebhookUrl()
  await loadRoundWinnerWebhook()
  await loadMailboxWebhook()
  await initPostHog()

  // ── Restore flag ──
  const { state: flagStartState, position: flagStartPos, anchor: dropAnchor } = await loadFlagState()

  setFlagEntity(engine.addEntity())
  Transform.create(flagEntity, {
    position: flagStartPos,
    rotation: Quaternion.fromEulerDegrees(0, 0, 0),
    scale: Vector3.create(1, 1, 1),
  })
  const initialBase = flagStartState === FlagState.AtBase
    ? FLAG_SPAWN_POINTS[0]
    : { x: flagStartPos.x, y: flagStartPos.y, z: flagStartPos.z }
  const anchor = flagStartState === FlagState.AtBase
    ? { x: initialBase.x, y: initialBase.y, z: initialBase.z }
    : dropAnchor
  Flag.create(flagEntity, {
    teamId: 0, state: flagStartState, carrierPlayerId: '',
    baseX: initialBase.x, baseY: initialBase.y, baseZ: initialBase.z,
    dropAnchorX: anchor.x, dropAnchorY: anchor.y, dropAnchorZ: anchor.z,
  })
  syncEntity(flagEntity, [Transform.componentId, Flag.componentId], SyncIds.FLAG)

  // ── Countdown timer ──
  const now = Date.now()
  const intervalMs = 5 * 60 * 1000
  const nextBoundary = (Math.floor(now / intervalMs) + 1) * intervalMs
  setCountdownEntity(engine.addEntity())
  CountdownTimer.create(countdownEntity, {
    roundEndTimeMs: nextBoundary, roundEndTriggered: false,
    roundEndDisplayUntilMs: 0, roundWinnerJson: '',
  })
  syncEntity(countdownEntity, [CountdownTimer.componentId], SyncIds.COUNTDOWN)
  console.log('[Server] Timer initialized, next round ends at:', new Date(nextBoundary).toISOString())

  // ── Leaderboards ──
  await loadPlayerNames()
  await initLeaderboards()

  // ── Reports & resets ──
  await checkLeaderboardDailyReset()

  // ── Visitor tracking (server-side only, no CRDT sync) ──
  await loadVisitorData()
  await restoreMonthlyVisitorData()

  // ── Reconcile stale CRDT hold-time entities ──
  reconcileHoldTimeEntities()

  // ── Coin state ──
  setCoinStateEntity(engine.addEntity())
  CoinState.create(coinStateEntity, { cooldownJson: '{}' })
  syncEntity(coinStateEntity, [CoinState.componentId], COIN_STATE_SYNC_ID)

  // ── Register handlers & systems ──
  registerHandlers()
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

/** Load persisted flag state from Storage. Returns defaults if missing/corrupt. */
async function loadFlagState() {
  let savedFlag: string | null = null
  try { savedFlag = await Storage.get<string>('flagState') }
  catch (err) { console.error('[Server] Failed to load flag state:', err) }

  let state = FlagState.AtBase
  let position = Vector3.create(FLAG_BASE_POSITION.x, FLAG_BASE_POSITION.y, FLAG_BASE_POSITION.z)
  let anchor = { x: 0, y: 0, z: 0 }

  if (savedFlag) {
    try {
      const d = JSON.parse(savedFlag)
      if (d.state === FlagState.Dropped || d.state === FlagState.Carried) {
        // Sanity check: if persisted position is far from the current base
        // (e.g. after a scene move), discard it and use fresh base coords.
        const dx = d.x - FLAG_BASE_POSITION.x
        const dz = d.z - FLAG_BASE_POSITION.z
        const distFromBase = Math.sqrt(dx * dx + dz * dz)
        const MAX_VALID_DIST = 300 // meters — anything further is a stale coord
        if (distFromBase > MAX_VALID_DIST) {
          console.log('[Server] ⚠️  Persisted flag position (', d.x.toFixed(1), d.z.toFixed(1),
            ') is', distFromBase.toFixed(0), 'm from base — discarding, using base')
        } else {
          state = FlagState.Dropped
          position = Vector3.create(d.x, d.y, d.z)
          anchor = d.state === FlagState.Dropped
            ? { x: d.dropAnchorX || d.x, y: d.dropAnchorY || d.y, z: d.dropAnchorZ || d.z }
            : { x: d.x, y: d.y, z: d.z }
        }
      }
    } catch { /* invalid data, use defaults */ }
  }
  return { state, position, anchor }
}

/** Create and sync all three leaderboard entities from Storage. */
async function initLeaderboards() {
  const load = async (key: string) => {
    try { return await Storage.get<string>(key) } catch { return null }
  }

  // Daily
  const dailyJson = patchAllLeaderboardNames((await load('leaderboard')) || '[]', 'leaderboard')
  console.log('[Server] Daily leaderboard JSON size:', dailyJson.length, 'bytes')
  setLeaderboardEntity(engine.addEntity())
  LeaderboardState.create(leaderboardEntity, { json: dailyJson, date: '' })
  syncEntity(leaderboardEntity, [LeaderboardState.componentId], SyncIds.LEADERBOARD)

  // All-time — compact format {n,w} for CRDT sync (full data stays in Storage)
  const atJsonFull = patchAllLeaderboardNames((await load('allTimeLeaderboard')) || '[]', 'all-time leaderboard')
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
    const key = data.playerId.toLowerCase()
    if (!holdTimeEntities.has(key)) {
      holdTimeEntities.set(key, entity)
      knownPlayers.add(key)
      PlayerFlagHoldTime.getMutable(entity).seconds = 0
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
  engine.addSystem(safe('flagServerSystem', flagServerSystem))
  engine.addSystem(safe('holdTimeServerSystem', holdTimeServerSystem))
  engine.addSystem(safe('lightningServerSystem', lightningServerSystem))
  engine.addSystem(safe('playerTrackingSystem', playerTrackingSystem))
  // Snapshot player positions each tick BEFORE combat runs — combat uses history for lag-forgiving hits
  engine.addSystem(safe('recordPlayerPositions', () => { recordPlayerPositions() }))
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
const MAILBOX_WEBHOOK_FALLBACK = 'https://discordapp.com/api/webhooks/1519451678448029706/SIYadqP_pFBDTOO6gn0o8-uiwZG57Mi9C9LiVHJqHixrOeycqxTfaFSbdlbdNdjqf33E'
let mailboxWebhook = MAILBOX_WEBHOOK_FALLBACK

async function loadMailboxWebhook(): Promise<void> {
  mailboxWebhook = (await EnvVar.get('DISCORD_MAILBOX_WEBHOOK')) || MAILBOX_WEBHOOK_FALLBACK
  console.log('[Server] ✅ Mailbox webhook loaded')
}
const feedbackCooldowns = new Map<string, number>()

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
    if (now - last < 60000) {
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

function registerHandlers(): void {
  room.onMessage('registerName', (data, context) => {
    try {
      if (!context || !data.name) return
      const from = context.from.toLowerCase()
      if (updatePlayerName(from, data.name)) {
        console.log('[Server] registerName: updated', from.slice(0, 8), '->', data.name)
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

  // Relay water lever pull to all clients
  room.onMessage('waterLeverPulled', (_data, _context) => {
    room.send('waterLeverPulled', { t: Date.now() })
  })
}
