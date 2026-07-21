/**
 * economy.ts — Coins, wallets, upgrades, store purchases, and coin respawn system.
 */
import { engine, GltfContainer, Transform, type Entity } from '@dcl/sdk/ecs'
import { storageGet } from './safeStorage'
import {
  ensurePlayerHydrated, markPlayerDirty, commitPlayerDocTx, flushDuePlayerDocs,
  clearPlayerDocState, getPlayerBlessingDate, setPlayerBlessingDate,
} from './playerDoc'
import {
  playerCoinBalances, playerUpgradeData, playerLifetimeWinsCache, playerLifetimeHoldTimeCache,
  playerBoomerangColors, deathPenaltyCooldowns, sessionDeaths,
  coinStateEntity, getPlayerPosition
} from './serverState'
import {
  CoinState, COIN_RESPAWN_INTERVAL_SEC,
  ROUND_PARTICIPATION_COINS, ROUND_PLACEMENT_BONUS, COINS_PER_HOLD_SECOND, MAX_COINS,
  coinIdFromPosition,
} from '../shared/coins'
import {
  parseUpgrades, serializeUpgrades, BOOMERANG_STORE, MUSIC_STORE, TRAP_STORE,
  type UpgradeData
} from '../shared/upgrades'
import { room } from '../shared/messages'
import type { BoomerangColor } from '../gameState/boomerangColor'

// ── Coin cooldown state (module-local) ──
/** Set of coinIds currently picked up (empty spots waiting for random respawn) */
const coinCooldowns = new Set<string>()
/** Timer tracking seconds until next random coin respawn */
let coinRespawnTimer = 0

// ── Per-player balance serialization ──
// Every coin balance read-modify-write for a given player must run through this chain,
// or two handlers that both read the old balance before either writes will double-spend
// (buy three 150-coin items with 300 coins, claim the blessing twice, etc). Tasks for the
// same player run strictly one-after-another; a task that throws does not block the next.
const balanceChains = new Map<string, Promise<unknown>>()
function serializePerPlayer<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = balanceChains.get(key) ?? Promise.resolve()
  const next = prev.then(() => task(), () => task())
  balanceChains.set(key, next.then(() => {}, () => {}))
  return next
}

// ── Coin pickup anti-abuse ──
// Only deterministic position-hash ids are legitimate (coinIdFromPosition on the client).
const COIN_ID_RE = /^coin_-?\d{1,7}_-?\d{1,7}_-?\d{1,7}$/
// Hard ceiling on the synced cooldown set so a flood of ids can never bloat the CRDT
// string (the buffer-saturation failure class behind the historical scoreboard/boomerang bugs).
const MAX_COIN_COOLDOWNS = 512
const COIN_PICKUP_WINDOW_MS = 3000
// ~6.7 pickups/sec: generous headroom for a boosted player sprinting through a dense coin
// cluster (avoids silently rejecting legit pickups), while still bounding a spammer. The
// real anti-abuse guards are the finite coin count and the MAX_COIN_COOLDOWNS eviction cap.
// Worth confirming against actual in-scene coin density during playtest.
const COIN_PICKUP_MAX_IN_WINDOW = 20
const coinPickupTimes = new Map<string, number[]>()

// ── Known coin registry ──
// The authoritative server runs the same scene runtime and loads the same static composite
// as clients, so the real coin entities exist in the server engine too. Scan them
// (composite entities load async — coinServerSystem warms the scan up from server start)
// and validate pickup ids against the real set: a fabricated id (arbitrary position hash)
// can then never mint coins, evict real cooldowns, or bloat the synced JSON. Until the
// registry is confirmed stable, pickups FAIL CLOSED: shape-validation alone would let a
// hostile client mint ~20 fabricated coins per 3s for the whole init window. A rejected
// legit pickup during that window self-heals — the client re-requests on its 5s timer.
let knownCoinPositions: Map<string, { x: number; y: number; z: number }> | null = null
// Coin count seen by the previous scan (-1 = never scanned). The registry is only cached
// once two consecutive scans agree: composite entities may instantiate over more than one
// tick, and permanently caching a mid-load partial scan would reject every later-loading
// coin as "unknown id" for the life of the server.
let lastCoinScanCount = -1
// When lastCoinScanCount was FIRST observed. Two scans in the same tick (burst of
// pickup requests) would trivially "agree" on a partial mid-load count — require the
// count to have been stable for a real time window before trusting it.
let lastCoinScanCountSinceMs = 0
const COIN_SCAN_CONFIRM_MS = 5000
let emptyCoinScanLogged = false
// Pickups fail closed until the registry is confirmed, so don't wait for player
// requests to drive the scans: coinServerSystem re-scans once a second from server
// start until the registry is built, keeping the rejection window to roughly
// composite-load time + COIN_SCAN_CONFIRM_MS.
const COIN_SCAN_WARMUP_INTERVAL_SEC = 1
let coinScanWarmupTimer = 0

// Generous slack over the client's 2.5m pickup radius: server-replicated positions lag the
// client's (a boosted player covers several meters before their transform syncs). A false
// rejection self-heals — the client re-requests after its 5s local timeout — but feels bad,
// so err large. The registry check above is the real gate; this only stops a parked bot
// from claiming coins across the map.
const COIN_SERVER_PICKUP_RADIUS = 16

function getKnownCoinPositions(): Map<string, { x: number; y: number; z: number }> | null {
  if (knownCoinPositions) return knownCoinPositions
  const found = new Map<string, { x: number; y: number; z: number }>()
  for (const [entity] of engine.getEntitiesWith(GltfContainer, Transform)) {
    const src = GltfContainer.get(entity).src.toLowerCase()
    if (!src.includes('coin_01') && !src.includes('doubloon')) continue
    // Composite coins are unparented (parent: 0), so their own Transform position IS the
    // world position — the same value the client hashes in coinIdFromPosition. The server
    // never re-parents them (coinBobSpinSystem is client-only), so no parent walk needed.
    const p = Transform.get(entity).position
    found.set(coinIdFromPosition(p.x, p.y, p.z), { x: p.x, y: p.y, z: p.z })
  }
  if (found.size === 0) {
    // Composite not loaded (yet?) — retry on the next scan. Log once so a server
    // runtime that never instantiates the composite is visible: pickups fail closed
    // (all rejected) for as long as this holds, which a playtest catches immediately.
    if (!emptyCoinScanLogged) {
      emptyCoinScanLogged = true
      console.log('[Coins] ⚠️ Server coin scan found 0 coins — pickups fail closed until the composite loads')
    }
    lastCoinScanCount = 0
    return null
  }
  if (found.size !== lastCoinScanCount) {
    // First scan at this count — don't cache yet (see lastCoinScanCount comment). This
    // request degrades to shape-validation; a later one confirms the count and caches.
    console.log('[Coins] Server coin scan found', found.size, 'coins — awaiting a stable confirming scan before caching')
    lastCoinScanCount = found.size
    lastCoinScanCountSinceMs = Date.now()
    return null
  }
  if (Date.now() - lastCoinScanCountSinceMs < COIN_SCAN_CONFIRM_MS) {
    // Same count, but not stable for long enough — same-tick request bursts must not
    // confirm each other while the composite may still be instantiating.
    return null
  }
  knownCoinPositions = found
  console.log('[Coins] Server coin registry built:', found.size, 'coins')
  return found
}

/** Drop per-player economy state on disconnect (called from playerTrackingSystem). */
export function clearPlayerEconomyState(walletAddress: string): void {
  const key = walletAddress.toLowerCase()
  // Delete the balance chain only once it has settled, and only if no new task was queued
  // since (a quick rejoin queues onto the same chain). Deleting a still-pending chain would
  // let a rejoin start a parallel chain and race the in-flight balance write.
  const chain = balanceChains.get(key)
  if (chain) {
    chain.then(() => {
      if (balanceChains.get(key) === chain) balanceChains.delete(key)
    })
  }
  coinPickupTimes.delete(key)
  winsReconciledPlayers.delete(key)
  // Land any pending doc flush immediately and drop the flush chain once settled —
  // the server may be torn down at any moment (no shutdown signal) once the world empties.
  clearPlayerDocState(key)
}

// ── Coin balance helpers ──
// Persistence model: memory is authoritative, storage is write-behind through the
// consolidated per-player doc (see playerDoc.ts). Loads only touch storage via
// join-time hydration (already done by the time a player acts, in the normal
// case); mutations update the caches and mark the doc dirty — immediate flush for
// transactional changes, debounced for the high-frequency +1 pickup path. A
// purchase's deduction and item grant land in ONE doc write, atomically.

/**
 * STRICT load: a failed hydration REJECTS instead of returning 0. Returning a
 * fallback 0 here is a wallet-wipe hazard — addPlayerCoins would compute `0 + N`
 * and flush it over the player's real stored balance. Mutating callers must let
 * the rejection abort the operation; display callers catch and degrade.
 */
export async function loadPlayerCoinBalance(walletAddress: string): Promise<number> {
  const key = walletAddress.toLowerCase()
  const cached = playerCoinBalances.get(key)
  if (cached !== undefined) return cached
  await ensurePlayerHydrated(key)
  return playerCoinBalances.get(key) ?? 0
}

export async function setPlayerCoinBalance(walletAddress: string, amount: number, immediatePersist = true): Promise<void> {
  const key = walletAddress.toLowerCase()
  playerCoinBalances.set(key, amount)
  // Write-behind: resolves as soon as memory is committed, so callers (buys,
  // penalties, awards) respond to the client immediately instead of waiting a
  // ~2s storage round trip. Durability follows via the doc flush + retry.
  markPlayerDirty(key, { debounce: !immediatePersist })
}

export async function addPlayerCoins(walletAddress: string, amount: number, immediatePersist = true): Promise<number> {
  const current = await loadPlayerCoinBalance(walletAddress)
  const newBalance = Math.min(current + amount, MAX_COINS)
  await setPlayerCoinBalance(walletAddress, newBalance, immediatePersist)
  return newBalance
}


// ── Upgrade / progression helpers ──

/**
 * STRICT load: a failed hydration REJECTS instead of returning empty defaults.
 * A silent `{}` fallback is a wipe hazard on read-modify-write paths — a buy/equip
 * would savePlayerUpgrades over the player's real owned items. Mutating callers must
 * abort on rejection; read-only callers (trap type, upgrade display) catch and
 * degrade to defaults at the call site.
 */
export async function loadPlayerUpgrades(walletAddress: string): Promise<UpgradeData> {
  const key = walletAddress.toLowerCase()
  const cached = playerUpgradeData.get(key)
  if (cached) return cached
  await ensurePlayerHydrated(key)
  return playerUpgradeData.get(key) ?? parseUpgrades('{}')
}

export async function savePlayerUpgrades(walletAddress: string, data: UpgradeData): Promise<void> {
  const key = walletAddress.toLowerCase()
  playerUpgradeData.set(key, data)
  // Write-behind (see setPlayerCoinBalance) — and because the doc carries coins AND
  // upgrades, a buy's deduction and item grant hit storage atomically: the old
  // paid-but-item-write-failed window no longer exists.
  markPlayerDirty(key)
}


// Short-lived cache of the full all-time leaderboard JSON — the largest object in
// Storage (500+ entries) — which the lifetime-wins reconciliation used to re-read on
// EVERY new player's first load. Slightly stale data is fine here: the reconciliation
// takes the max of the two sources anyway, and fresh wins go through
// addPlayerLifetimeWin directly.
const ALL_TIME_LB_CACHE_MS = 60_000
let allTimeLbCacheJson: string | null = null
let allTimeLbCacheAtMs = 0

// Players whose lifetime wins were already reconciled against the all-time board
// this session. Join-time hydration always fills the wins cache, so a cache-miss
// -only reconciliation would never run — gate it per session instead. Cleared on
// disconnect (clearPlayerEconomyState).
const winsReconciledPlayers = new Set<string>()

/**
 * STRICT load (see loadPlayerCoinBalance): rejects on hydration failure so
 * addPlayerLifetimeWin can never flush `fallback0 + 1` over a real total.
 */
export async function loadPlayerLifetimeWins(walletAddress: string): Promise<number> {
  const key = walletAddress.toLowerCase()
  let wins = playerLifetimeWinsCache.get(key)
  if (wins === undefined) {
    await ensurePlayerHydrated(key)
    wins = playerLifetimeWinsCache.get(key) ?? 0
  }

  // Reconcile with the all-time leaderboard once per session — always take the
  // higher value (heals undercounts from writes lost in past server lifetimes).
  if (!winsReconciledPlayers.has(key)) {
    winsReconciledPlayers.add(key)
    try {
      if (allTimeLbCacheJson === null || Date.now() - allTimeLbCacheAtMs > ALL_TIME_LB_CACHE_MS) {
        allTimeLbCacheJson = (await storageGet<string>('allTimeLeaderboard')) ?? ''
        allTimeLbCacheAtMs = Date.now()
      }
      const atFull = allTimeLbCacheJson
      if (atFull) {
        const atEntries: { userId: string; roundsWon: number }[] = JSON.parse(atFull)
        const entry = atEntries.find(e => e.userId.toLowerCase() === key)
        // Re-read the live cache — a concurrent win may have landed during the await.
        const current = playerLifetimeWinsCache.get(key) ?? wins
        if (entry && entry.roundsWon > current) {
          console.log('[LifetimeWins] Reconciled', key.slice(0, 8), 'from', current, 'to', entry.roundsWon, '(all-time leaderboard)')
          wins = entry.roundsWon
          playerLifetimeWinsCache.set(key, wins)
          markPlayerDirty(key)
        } else {
          wins = current
        }
      }
    } catch { /* reconciliation is best-effort */ }
  }

  playerLifetimeWinsCache.set(key, wins)
  return wins
}

export async function addPlayerLifetimeWin(walletAddress: string): Promise<number> {
  const key = walletAddress.toLowerCase()
  const current = await loadPlayerLifetimeWins(key)
  const newWins = current + 1
  playerLifetimeWinsCache.set(key, newWins)
  // Write-behind: the doc flush retries failures, instead of the round's progress
  // being silently lost until the player's next win happens to rewrite the total.
  markPlayerDirty(key)
  return newWins
}


// ── Lifetime flag hold time ──

/**
 * STRICT load (see loadPlayerCoinBalance): rejects on hydration failure so
 * addPlayerLifetimeHoldTime can never flush a fallback-derived total.
 */
export async function loadPlayerLifetimeHoldTime(walletAddress: string): Promise<number> {
  const key = walletAddress.toLowerCase()
  const cached = playerLifetimeHoldTimeCache.get(key)
  if (cached !== undefined) return cached
  await ensurePlayerHydrated(key)
  return playerLifetimeHoldTimeCache.get(key) ?? 0
}

export async function addPlayerLifetimeHoldTime(walletAddress: string, additionalSeconds: number): Promise<number> {
  const key = walletAddress.toLowerCase()
  const current = await loadPlayerLifetimeHoldTime(key)
  const newTotal = current + additionalSeconds
  playerLifetimeHoldTimeCache.set(key, newTotal)
  markPlayerDirty(key)
  return newTotal
}


// ── Store purchase ──

// Failure wording for a transactional commit: an INDETERMINATE outcome (write
// timed out and its compensation failed — see PlayerDocTxError) must not read
// like a clean failure, or the player will assume retrying is always safe.
function txFailureReason(err: unknown): string {
  return (err as { indeterminate?: boolean })?.indeterminate
    ? 'Storage error — purchase state uncertain, check your items in a moment'
    : 'Storage unavailable — try again in a moment'
}

async function handleBuyBoomerang(playerId: string, color: string): Promise<void> {
  const key = playerId.toLowerCase()
  const boomerangColor = color as BoomerangColor

  const item = BOOMERANG_STORE.find(i => i.id === boomerangColor)
  if (!item) {
    room.send('buyResult', { success: false, color, reason: 'Invalid item', newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  const upgrades = await loadPlayerUpgrades(key)
  if (upgrades.boomerangs.includes(boomerangColor)) {
    room.send('buyResult', { success: false, color, reason: 'Already owned', newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  const wins = await loadPlayerLifetimeWins(key)
  if (wins < item.flagsRequired) {
    room.send('buyResult', { success: false, color, reason: `Need ${item.flagsRequired} flags (you have ${wins})`, newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  const balance = await loadPlayerCoinBalance(key)
  if (balance < item.coinCost) {
    room.send('buyResult', { success: false, color, reason: `Need ${item.coinCost} coins (you have ${balance})`, newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  // Copy-on-write: never mutate the cached object before the transaction commits —
  // a failed commit must leave memory exactly as it was.
  const newBalance = balance - item.coinCost
  const newUpgrades: UpgradeData = { ...upgrades, boomerangs: [...upgrades.boomerangs, boomerangColor], equipped: boomerangColor }
  // Transactional: deduction + item land in ONE durable write; success is only
  // reported after storage confirms. On failure memory rolls back and the player
  // keeps their coins — retrying later re-runs the whole validation.
  try {
    await commitPlayerDocTx(key, () => {
      playerCoinBalances.set(key, newBalance)
      playerUpgradeData.set(key, newUpgrades)
    })
  } catch (err) {
    console.error('[Store] buyBoomerang persist failed for', key.slice(0, 8), err)
    room.send('buyResult', { success: false, color, reason: txFailureReason(err), newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  playerBoomerangColors.set(key, boomerangColor)

  console.log('[Store] Player', key.slice(0, 8), 'bought', item.label, 'for', item.coinCost, 'coins. New balance:', newBalance)

  room.send('buyResult', {
    success: true,
    color,
    reason: '',
    newBalance,
    upgradesJson: serializeUpgrades(newUpgrades)
  }, { to: [key] })

  room.send('playerColorChanged', { playerId: key, color: boomerangColor })
}

async function handleBuyTape(playerId: string, tapeId: string): Promise<void> {
  const key = playerId.toLowerCase()

  const item = MUSIC_STORE.find(i => i.id === tapeId)
  if (!item) {
    room.send('buyTapeResult', { success: false, tapeId, reason: 'Invalid item', newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  const upgrades = await loadPlayerUpgrades(key)
  if (upgrades.tapes.includes(tapeId)) {
    room.send('buyTapeResult', { success: false, tapeId, reason: 'Already owned', newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  const wins = await loadPlayerLifetimeWins(key)
  if (wins < item.flagsRequired) {
    room.send('buyTapeResult', { success: false, tapeId, reason: `Need ${item.flagsRequired} flags (you have ${wins})`, newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  const balance = await loadPlayerCoinBalance(key)
  if (balance < item.coinCost) {
    room.send('buyTapeResult', { success: false, tapeId, reason: `Need ${item.coinCost} coins (you have ${balance})`, newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  // Copy-on-write + transactional commit — see handleBuyBoomerang.
  const newBalance = balance - item.coinCost
  const newUpgrades: UpgradeData = { ...upgrades, tapes: [...upgrades.tapes, tapeId], equippedTape: tapeId }
  try {
    await commitPlayerDocTx(key, () => {
      playerCoinBalances.set(key, newBalance)
      playerUpgradeData.set(key, newUpgrades)
    })
  } catch (err) {
    console.error('[Store] buyTape persist failed for', key.slice(0, 8), err)
    room.send('buyTapeResult', { success: false, tapeId, reason: txFailureReason(err), newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  console.log('[Store] Player', key.slice(0, 8), 'bought tape', item.label, 'for', item.coinCost, 'coins. New balance:', newBalance)

  room.send('buyTapeResult', {
    success: true,
    tapeId,
    reason: '',
    newBalance,
    upgradesJson: serializeUpgrades(newUpgrades)
  }, { to: [key] })
}

async function handleBuyTrap(playerId: string, trapId: string): Promise<void> {
  const key = playerId.toLowerCase()

  const item = TRAP_STORE.find(i => i.id === trapId)
  if (!item) {
    room.send('buyTrapResult', { success: false, trapId, reason: 'Invalid item', newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  const upgrades = await loadPlayerUpgrades(key)
  if (upgrades.traps.includes(trapId)) {
    room.send('buyTrapResult', { success: false, trapId, reason: 'Already owned', newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  const wins = await loadPlayerLifetimeWins(key)
  if (wins < item.flagsRequired) {
    room.send('buyTrapResult', { success: false, trapId, reason: `Need ${item.flagsRequired} flags (you have ${wins})`, newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  const balance = await loadPlayerCoinBalance(key)
  if (balance < item.coinCost) {
    room.send('buyTrapResult', { success: false, trapId, reason: `Need ${item.coinCost} coins (you have ${balance})`, newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  // Copy-on-write + transactional commit — see handleBuyBoomerang.
  const newBalance = balance - item.coinCost
  const newUpgrades: UpgradeData = { ...upgrades, traps: [...upgrades.traps, trapId], equippedTrap: trapId }
  try {
    await commitPlayerDocTx(key, () => {
      playerCoinBalances.set(key, newBalance)
      playerUpgradeData.set(key, newUpgrades)
    })
  } catch (err) {
    console.error('[Store] buyTrap persist failed for', key.slice(0, 8), err)
    room.send('buyTrapResult', { success: false, trapId, reason: txFailureReason(err), newBalance: 0, upgradesJson: '' }, { to: [key] })
    return
  }

  console.log('[Store] Player', key.slice(0, 8), 'bought trap', item.label, 'for', item.coinCost, 'coins. New balance:', newBalance)

  room.send('buyTrapResult', {
    success: true,
    trapId,
    reason: '',
    newBalance,
    upgradesJson: serializeUpgrades(newUpgrades)
  }, { to: [key] })
}

// ── CRDT sync ──

function updateCoinStateCRDT(): void {
  const obj: Record<string, number> = {}
  for (const coinId of coinCooldowns) {
    obj[coinId] = 1
  }
  CoinState.getMutable(coinStateEntity).cooldownJson = JSON.stringify(obj)
}

// ── Coin server system ──

export function coinServerSystem(dt: number): void {
  // Land any debounced player-doc writes and retry failed ones that are due
  // (independent of coin respawns).
  flushDuePlayerDocs()

  // Warm the coin registry up so pickups stop failing closed as soon as possible.
  if (!knownCoinPositions) {
    coinScanWarmupTimer += dt
    if (coinScanWarmupTimer >= COIN_SCAN_WARMUP_INTERVAL_SEC) {
      coinScanWarmupTimer = 0
      getKnownCoinPositions()
    }
  }

  if (coinCooldowns.size === 0) return

  coinRespawnTimer += dt
  if (coinRespawnTimer < COIN_RESPAWN_INTERVAL_SEC) return
  coinRespawnTimer = 0

  const cooldownArray = Array.from(coinCooldowns)
  const idx = Math.floor(Math.random() * cooldownArray.length)
  const coinId = cooldownArray[idx]

  coinCooldowns.delete(coinId)
  room.send('coinRespawned', { coinId })
  updateCoinStateCRDT()
  console.log('[Coins] Coin respawned (random):', coinId, '| remaining empty:', coinCooldowns.size)
}

// ── Round-end coin awards ──

export async function awardRoundCoins(players: { userId: string; seconds: number }[]): Promise<void> {
  if (players.length === 0) return

  const sorted = [...players].sort((a, b) => b.seconds - a.seconds)

  // All players concurrently: connected players award from memory instantly, and
  // disconnected mid-round players need a ~2s re-hydration each — running those
  // serially would stretch round end by 2s per departed player. safeStorage caps
  // the resulting fan-out.
  await Promise.all(sorted.map(async (p, i) => {
    let coins = ROUND_PARTICIPATION_COINS

    coins += Math.floor(p.seconds * COINS_PER_HOLD_SECOND)

    if (i < ROUND_PLACEMENT_BONUS.length && p.seconds > 0) {
      coins += ROUND_PLACEMENT_BONUS[i]
    }

    if (coins > 0) {
      // Isolate per player: one player's failed hydration (strict load rejects on
      // storage failure) must not abort awards for anyone else.
      let newBalance: number
      try {
        newBalance = await serializePerPlayer(p.userId, () => addPlayerCoins(p.userId, coins))
      } catch (err) {
        console.error('[Coins] Round award failed for', p.userId.slice(0, 8), err)
        return
      }
      room.send('walletBalance', { playerId: p.userId, coins: newBalance }, { to: [p.userId] })
      const holdTimeCoins = Math.floor(p.seconds * COINS_PER_HOLD_SECOND)
      const placementBonus = (i < ROUND_PLACEMENT_BONUS.length && p.seconds > 0) ? ROUND_PLACEMENT_BONUS[i] : 0
      room.send('roundCoinsEarned', {
        playerId: p.userId,
        total: coins,
        participation: ROUND_PARTICIPATION_COINS,
        holdTime: holdTimeCoins,
        placement: placementBonus,
        rank: i + 1,
        newBalance
      }, { to: [p.userId] })
      console.log('[Coins] Awarded', coins, 'coins to', p.userId.slice(0, 8), '(new balance:', newBalance, ')')
    }
  }))
}

// ── Message handler registration ──

const DEATH_PENALTY_COINS = 10

export function registerEconomyHandlers(): void {
  room.onMessage('requestCoinPickup', (data, context) => {
    if (!context || !data.coinId) return
    const from = context.from.toLowerCase()
    const coinId = data.coinId

    // Reject malformed ids — only deterministic position-hash ids are real coins.
    // Blocks arbitrary-string spam that would otherwise bloat the synced cooldown JSON.
    if (!COIN_ID_RE.test(coinId)) return

    if (coinCooldowns.has(coinId)) {
      console.log('[Coins] Pickup rejected — coin already picked up:', coinId)
      return
    }

    // Require a replicated server position — a bot spamming before its avatar syncs is rejected.
    const playerPos = getPlayerPosition(from)
    if (!playerPos) return

    // Per-player sliding-window rate limit: a walking player picks up well under this,
    // but it caps both coin farming speed and CRDT write volume from a hostile client.
    // Checked BEFORE the registry lookup so a spammer can't trigger repeated full-engine
    // scans while the registry is still unbuilt, and every attempt that reaches here
    // consumes budget (not just accepted pickups) so rejected-id spam is bounded too.
    // A legit retry after a false rejection is one request per 5s — negligible.
    const nowMs = Date.now()
    let times = coinPickupTimes.get(from)
    if (!times) { times = []; coinPickupTimes.set(from, times) }
    while (times.length > 0 && nowMs - times[0] > COIN_PICKUP_WINDOW_MS) times.shift()
    if (times.length >= COIN_PICKUP_MAX_IN_WINDOW) return
    times.push(nowMs)

    // Validate against the real placed coins + require rough proximity. FAIL CLOSED
    // while the registry is unconfirmed (see the registry comment above): shape
    // validation alone ties an award to nothing, so fabricated ids could mint coins
    // for the whole init window. The client retries a rejected pickup on its own timer.
    const registry = getKnownCoinPositions()
    if (!registry) {
      console.log('[Coins] Pickup rejected — coin registry not ready yet:', coinId, 'from', from.slice(0, 8))
      return
    }
    const coinPos = registry.get(coinId)
    if (!coinPos) {
      console.log('[Coins] Pickup rejected — unknown coin id:', coinId, 'from', from.slice(0, 8))
      return
    }
    const dx = playerPos.x - coinPos.x
    const dy = playerPos.y - coinPos.y
    const dz = playerPos.z - coinPos.z
    if (dx * dx + dy * dy + dz * dz > COIN_SERVER_PICKUP_RADIUS * COIN_SERVER_PICKUP_RADIUS) {
      console.log('[Coins] Pickup rejected — too far from coin:', coinId, 'from', from.slice(0, 8))
      return
    }

    // Cap the cooldown set so its synced JSON can never grow unbounded. When full, evict the
    // OLDEST entry (respawning that coin early) rather than rejecting — a plain rejection would
    // let one client spamming ids jam pickups for EVERYONE, since the set drains only ~1/30s.
    if (coinCooldowns.size >= MAX_COIN_COOLDOWNS) {
      const oldest = coinCooldowns.values().next().value
      if (oldest !== undefined) {
        coinCooldowns.delete(oldest)
        room.send('coinRespawned', { coinId: oldest })
      }
    }

    coinCooldowns.add(coinId)
    updateCoinStateCRDT()

    // Debounced persist (immediatePersist: false) — the only balance path allowed to
    // ride the debounce; worst case an abrupt teardown loses a few seconds of pickups.
    serializePerPlayer(from, () => addPlayerCoins(from, 1, false)).then(newBalance => {
      room.send('coinPickedUp', { coinId, playerId: from, newBalance })
      console.log('[Coins] Coin picked up:', coinId, 'by', from.slice(0, 8), 'balance:', newBalance)
    }).catch(err => console.error('[Coins] Error awarding coin:', err))
  })

  room.onMessage('requestWalletBalance', async (_data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    try {
      const balance = await loadPlayerCoinBalance(from)
      room.send('walletBalance', { playerId: from, coins: balance }, { to: [from] })
      console.log('[Coins] Sent wallet balance to', from.slice(0, 8), ':', balance)
    } catch (err) {
      // Send nothing on a failed read — a fallback 0 would display a wiped wallet.
      // The client retries the request on its own timer until a balance arrives.
      console.error('[Coins] requestWalletBalance failed for', from.slice(0, 8), err)
    }
  })

  room.onMessage('requestUpgrades', async (_data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    // Hydrate ONCE for the whole request: a failed hydration clears itself for
    // retry, so per-field loads would each kick off a fresh multi-attempt
    // hydration — during an outage that made one request take ~3x the full
    // retry-with-timeouts budget. One attempt, then all-or-nothing fallbacks.
    try {
      await ensurePlayerHydrated(from)
    } catch (err) {
      console.error('[Store] requestUpgrades hydration failed for', from.slice(0, 8), '— sending display defaults:', err)
      // Lenient display fallbacks: the client gates combat on receiving SOME
      // response (isWinsLoaded) — degrading keeps the player playable through a
      // storage outage. Never written back.
      room.send('upgradesResponse', { upgradesJson: serializeUpgrades(parseUpgrades('{}')), wins: 0, lifetimeHoldTime: 0 }, { to: [from] })
      return
    }
    // Hydrated: these are cache hits (plus the once-per-session wins
    // reconciliation); the catches are belt-and-braces only.
    const upgrades = await loadPlayerUpgrades(from).catch(() => parseUpgrades('{}'))
    const wins = await loadPlayerLifetimeWins(from).catch(() => 0)
    const holdTime = await loadPlayerLifetimeHoldTime(from).catch(() => 0)
    room.send('upgradesResponse', { upgradesJson: serializeUpgrades(upgrades), wins, lifetimeHoldTime: holdTime }, { to: [from] })
    console.log('[Store] Sent upgrades to', from.slice(0, 8), '- owned:', upgrades.boomerangs.join(','), 'wins:', wins, 'holdTime:', holdTime.toFixed(1))

    if (upgrades.equipped && upgrades.equipped !== 'r') {
      playerBoomerangColors.set(from, upgrades.equipped)
      room.send('playerColorChanged', { playerId: from, color: upgrades.equipped })
    }
  })

  room.onMessage('buyBoomerang', async (data, context) => {
    if (!context || !data.color) return
    const from = context.from.toLowerCase()
    try {
      await serializePerPlayer(from, () => handleBuyBoomerang(from, data.color))
    } catch (err) {
      console.error('[Store] buyBoomerang error:', err)
    }
  })

  room.onMessage('buyTape', async (data, context) => {
    if (!context || !data.tapeId) return
    const from = context.from.toLowerCase()
    try {
      await serializePerPlayer(from, () => handleBuyTape(from, data.tapeId))
    } catch (err) {
      console.error('[Store] buyTape error:', err)
    }
  })

  room.onMessage('buyTrap', async (data, context) => {
    if (!context || !data.trapId) return
    const from = context.from.toLowerCase()
    try {
      await serializePerPlayer(from, () => handleBuyTrap(from, data.trapId))
    } catch (err) {
      console.error('[Store] buyTrap error:', err)
    }
  })

  room.onMessage('equipTrap', async (data, context) => {
    if (!context || !data.trapId) return
    const from = context.from.toLowerCase()
    try {
      // Serialized with buys (same per-player chain): a concurrent buy + equip during
      // an upgrades cache miss would otherwise load two separate UpgradeData objects
      // and the last save would silently drop the other's mutation.
      await serializePerPlayer(from, async () => {
        // Strict load: abort on read failure rather than equip-and-save over unknown data.
        const upgrades = await loadPlayerUpgrades(from)
        if (!upgrades.traps.includes(data.trapId)) {
          console.log('[Store] equipTrap rejected — not owned:', data.trapId, 'by', from.slice(0, 8))
          return
        }

        upgrades.equippedTrap = data.trapId
        await savePlayerUpgrades(from, upgrades)
        console.log('[Store] Player', from.slice(0, 8), 'equipped trap', data.trapId)
      })
    } catch (err) {
      console.error('[Store] equipTrap error:', err)
    }
  })

  room.onMessage('equipBoomerang', async (data, context) => {
    if (!context || !data.color) return
    const from = context.from.toLowerCase()
    const color = data.color as BoomerangColor
    try {
      // Serialized with buys — see equipTrap.
      await serializePerPlayer(from, async () => {
        // Strict load: abort on read failure rather than equip-and-save over unknown data.
        const upgrades = await loadPlayerUpgrades(from)
        if (!upgrades.boomerangs.includes(color)) {
          console.log('[Store] equipBoomerang rejected — not owned:', color, 'by', from.slice(0, 8))
          return
        }

        upgrades.equipped = color
        await savePlayerUpgrades(from, upgrades)
        playerBoomerangColors.set(from, color)
        room.send('playerColorChanged', { playerId: from, color })
        console.log('[Store] Player', from.slice(0, 8), 'equipped', color)
      })
    } catch (err) {
      console.error('[Store] equipBoomerang error:', err)
    }
  })

  room.onMessage('deathPenalty', async (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const now = Date.now()
      const lastDeath = deathPenaltyCooldowns.get(from) ?? 0
      if (now - lastDeath < 3000) return
      deathPenaltyCooldowns.set(from, now)
      sessionDeaths.set(from, (sessionDeaths.get(from) ?? 0) + 1)

      const { penalty, newBalance } = await serializePerPlayer(from, async () => {
        const current = await loadPlayerCoinBalance(from)
        const pen = Math.min(DEATH_PENALTY_COINS, current)
        const bal = current - pen
        await setPlayerCoinBalance(from, bal)
        return { penalty: pen, newBalance: bal }
      })
      room.send('walletBalance', { playerId: from, coins: newBalance }, { to: [from] })
      room.send('deathPenaltyApplied', { playerId: from, penalty, newBalance }, { to: [from] })
      console.log(`[Server] 💀 Death penalty: ${from.slice(0, 8)} lost ${penalty} coins (new balance: ${newBalance})`)
    } catch (err) { console.error('[Server] ❌ deathPenalty handler error:', err) }
  })

  // ── Blessing (daily pedestal reward) ──
  const BLESSING_COINS = 6

  // Pre-check: client asks if blessing is available before starting the ritual
  room.onMessage('checkBlessing', async (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const today = new Date().toISOString().slice(0, 10)
      // Serialized behind any pending claim: an unserialized read could answer
      // "eligible" while a requestBlessing for the same player is still queued
      // PRE-mutate (its in-memory blessed-marker not set yet), letting the
      // client start a doomed second ritual. Queued behind the claim, the
      // answer always reflects its outcome. Strict hydration — a failure aborts
      // (no response; the client re-asks) rather than reporting "eligible" off
      // unknown state. Still memory-speed whenever the chain is idle, which is
      // the normal case.
      const lastBlessing = await serializePerPlayer(from, async () => {
        await ensurePlayerHydrated(from)
        return getPlayerBlessingDate(from)
      })
      console.log(`[Server] 🙏 checkBlessing: ${from.slice(0, 8)} | today=${today} | lastBlessing=${lastBlessing}`)
      if (lastBlessing === today) {
        room.send('blessingResult', { success: false, reason: 'already_blessed', newBalance: 0 }, { to: [from] })
      } else {
        room.send('blessingResult', { success: true, reason: 'eligible', newBalance: 0 }, { to: [from] })
      }
    } catch (err) {
      console.error('[Server] ❌ checkBlessing handler error:', err)
    }
  })

  // Claim: client sends after completing the full ritual
  room.onMessage('requestBlessing', async (_data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    try {
      // Serialize so two concurrent claims can't both read yesterday's date and
      // double-award the daily blessing before either in-memory commit.
      const outcome = await serializePerPlayer(from, async () => {
        const today = new Date().toISOString().slice(0, 10)
        // Strict hydration: a failure aborts the claim BEFORE anything is marked
        // used, so the player can simply retry.
        await ensurePlayerHydrated(from)
        if (getPlayerBlessingDate(from) === today) return { alreadyBlessed: true, newBalance: 0 }
        const current = playerCoinBalances.get(from) ?? 0
        const bal = Math.min(current + BLESSING_COINS, MAX_COINS)
        // Transactional: award + used-marker are snapshotted together and land in
        // ONE durable write — no window where one persisted without the other, and
        // no success reported for a claim storage never recorded. On failure the
        // mutation rolls back and the rejection propagates to the outer catch,
        // which reports an explicit failure so the client can react.
        await commitPlayerDocTx(from, () => {
          playerCoinBalances.set(from, bal)
          setPlayerBlessingDate(from, today)
        })
        return { alreadyBlessed: false, newBalance: bal }
      })
      if (outcome.alreadyBlessed) {
        room.send('blessingResult', { success: false, reason: 'already_blessed', newBalance: 0 }, { to: [from] })
        return
      }
      room.send('walletBalance', { playerId: from, coins: outcome.newBalance }, { to: [from] })
      room.send('blessingResult', { success: true, reason: '', newBalance: outcome.newBalance }, { to: [from] })
      console.log(`[Server] 🙏 Blessing: ${from.slice(0, 8)} received ${BLESSING_COINS} coins (balance: ${outcome.newBalance})`)
    } catch (err) {
      console.error('[Server] ❌ requestBlessing handler error:', err)
      // Explicit failure — the client defers its reward UI until this response,
      // so silence would leave the player waiting on a timeout for coins that
      // never persisted. 'storage_uncertain' = indeterminate transaction (it may
      // still land; new transactions are locked until resolved);
      // 'storage_error' = confirmed rollback or read failure, safe to retry now.
      const reason = (err as { indeterminate?: boolean })?.indeterminate ? 'storage_uncertain' : 'storage_error'
      room.send('blessingResult', { success: false, reason, newBalance: 0 }, { to: [from] })
    }
  })

  // colorChanged uses economy (loadPlayerUpgrades) so lives here
  room.onMessage('colorChanged', async (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const color = (data.color || 'r') as BoomerangColor
      const upgrades = await loadPlayerUpgrades(from)
      if (!upgrades.boomerangs.includes(color)) {
        console.log(`[Server] colorChanged rejected — ${from.slice(0, 8)} doesn't own ${color}`)
        room.send('playerColorChanged', { playerId: from, color: upgrades.equipped })
        return
      }
      playerBoomerangColors.set(from, color)
      console.log(`[Server] Player ${from.slice(0, 8)} changed boomerang color to ${color}`)
      room.send('playerColorChanged', { playerId: from, color })
    } catch (err) { console.error('[Server] ❌ colorChanged handler error:', err) }
  })
}
