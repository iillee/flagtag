/**
 * economy.ts — Coins, wallets, upgrades, store purchases, and coin respawn system.
 */
import { engine, type Entity } from '@dcl/sdk/ecs'
import { Storage } from '@dcl/sdk/server'
import {
  playerCoinBalances, playerUpgradeData, playerLifetimeWinsCache, playerLifetimeHoldTimeCache,
  playerBoomerangColors, deathPenaltyCooldowns, sessionDeaths,
  coinStateEntity, getPlayerPosition
} from './serverState'
import {
  CoinState, COIN_RESPAWN_INTERVAL_SEC,
  ROUND_PARTICIPATION_COINS, ROUND_PLACEMENT_BONUS, COINS_PER_HOLD_SECOND, MAX_COINS,
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

/** Drop per-player economy state on disconnect (called from playerTrackingSystem). */
export function clearPlayerEconomyState(walletAddress: string): void {
  const key = walletAddress.toLowerCase()
  balanceChains.delete(key)
  coinPickupTimes.delete(key)
}

// ── Coin balance helpers ──

export async function loadPlayerCoinBalance(walletAddress: string): Promise<number> {
  const key = walletAddress.toLowerCase()
  const cached = playerCoinBalances.get(key)
  if (cached !== undefined) return cached

  try {
    const saved = await Storage.get<string>(`coins:${key}`)
    const balance = saved ? parseInt(saved, 10) : 0
    playerCoinBalances.set(key, balance)
    return balance
  } catch (err) {
    console.error('[Coins] Failed to load balance for', key.slice(0, 8), err)
    return 0
  }
}

export async function setPlayerCoinBalance(walletAddress: string, amount: number): Promise<void> {
  const key = walletAddress.toLowerCase()
  playerCoinBalances.set(key, amount)

  try {
    await Storage.set(`coins:${key}`, String(amount))
  } catch (err) {
    console.error('[Coins] Failed to persist balance for', key.slice(0, 8), err)
  }
}

export async function addPlayerCoins(walletAddress: string, amount: number): Promise<number> {
  const current = await loadPlayerCoinBalance(walletAddress)
  const newBalance = Math.min(current + amount, MAX_COINS)
  await setPlayerCoinBalance(walletAddress, newBalance)
  return newBalance
}


// ── Upgrade / progression helpers ──

export async function loadPlayerUpgrades(walletAddress: string): Promise<UpgradeData> {
  const key = walletAddress.toLowerCase()
  const cached = playerUpgradeData.get(key)
  if (cached) return cached

  try {
    const saved = await Storage.get<string>(`upgrades:${key}`)
    const data = saved ? parseUpgrades(saved) : parseUpgrades('{}')
    playerUpgradeData.set(key, data)
    return data
  } catch (err) {
    console.error('[Upgrades] Failed to load for', key.slice(0, 8), err)
    return parseUpgrades('{}')
  }
}

export async function savePlayerUpgrades(walletAddress: string, data: UpgradeData): Promise<void> {
  const key = walletAddress.toLowerCase()
  playerUpgradeData.set(key, data)

  try {
    await Storage.set(`upgrades:${key}`, serializeUpgrades(data))
  } catch (err) {
    console.error('[Upgrades] Failed to persist for', key.slice(0, 8), err)
  }
}


export async function loadPlayerLifetimeWins(walletAddress: string): Promise<number> {
  const key = walletAddress.toLowerCase()
  const cached = playerLifetimeWinsCache.get(key)
  if (cached !== undefined) return cached

  try {
    const saved = await Storage.get<string>(`lifetimeWins:${key}`)
    let wins = saved ? parseInt(saved, 10) : 0

    // Reconcile with all-time leaderboard (full format in Storage) — always take the higher value
    try {
      const atFull = await Storage.get<string>('allTimeLeaderboard')
      if (atFull) {
        const atEntries: { userId: string; roundsWon: number }[] = JSON.parse(atFull)
        const entry = atEntries.find(e => e.userId.toLowerCase() === key)
        if (entry && entry.roundsWon > wins) {
          console.log('[LifetimeWins] Reconciled', key.slice(0, 8), 'from', wins, 'to', entry.roundsWon, '(all-time leaderboard)')
          wins = entry.roundsWon
          await Storage.set(`lifetimeWins:${key}`, String(wins))
        }
      }
    } catch { /* reconciliation is best-effort */ }

    playerLifetimeWinsCache.set(key, wins)
    return wins
  } catch (err) {
    console.error('[LifetimeWins] Failed to load for', key.slice(0, 8), err)
    return 0
  }
}

export async function addPlayerLifetimeWin(walletAddress: string): Promise<number> {
  const key = walletAddress.toLowerCase()
  const current = await loadPlayerLifetimeWins(key)
  const newWins = current + 1
  playerLifetimeWinsCache.set(key, newWins)

  try {
    await Storage.set(`lifetimeWins:${key}`, String(newWins))
  } catch (err) {
    console.error('[LifetimeWins] Failed to persist for', key.slice(0, 8), err)
  }

  return newWins
}


// ── Lifetime flag hold time ──

export async function loadPlayerLifetimeHoldTime(walletAddress: string): Promise<number> {
  const key = walletAddress.toLowerCase()
  const cached = playerLifetimeHoldTimeCache.get(key)
  if (cached !== undefined) return cached

  try {
    const saved = await Storage.get<string>(`lifetimeHoldTime:${key}`)
    const seconds = saved ? parseFloat(saved) : 0
    playerLifetimeHoldTimeCache.set(key, seconds)
    return seconds
  } catch (err) {
    console.error('[LifetimeHoldTime] Failed to load for', key.slice(0, 8), err)
    return 0
  }
}

export async function addPlayerLifetimeHoldTime(walletAddress: string, additionalSeconds: number): Promise<number> {
  const key = walletAddress.toLowerCase()
  const current = await loadPlayerLifetimeHoldTime(key)
  const newTotal = current + additionalSeconds
  playerLifetimeHoldTimeCache.set(key, newTotal)

  try {
    await Storage.set(`lifetimeHoldTime:${key}`, String(newTotal))
  } catch (err) {
    console.error('[LifetimeHoldTime] Failed to persist for', key.slice(0, 8), err)
  }

  return newTotal
}


// ── Store purchase ──

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

  const newBalance = balance - item.coinCost
  await setPlayerCoinBalance(key, newBalance)

  upgrades.boomerangs.push(boomerangColor)
  upgrades.equipped = boomerangColor
  await savePlayerUpgrades(key, upgrades)

  playerBoomerangColors.set(key, boomerangColor)

  console.log('[Store] Player', key.slice(0, 8), 'bought', item.label, 'for', item.coinCost, 'coins. New balance:', newBalance)

  room.send('buyResult', {
    success: true,
    color,
    reason: '',
    newBalance,
    upgradesJson: serializeUpgrades(upgrades)
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

  const newBalance = balance - item.coinCost
  await setPlayerCoinBalance(key, newBalance)

  upgrades.tapes.push(tapeId)
  upgrades.equippedTape = tapeId
  await savePlayerUpgrades(key, upgrades)

  console.log('[Store] Player', key.slice(0, 8), 'bought tape', item.label, 'for', item.coinCost, 'coins. New balance:', newBalance)

  room.send('buyTapeResult', {
    success: true,
    tapeId,
    reason: '',
    newBalance,
    upgradesJson: serializeUpgrades(upgrades)
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

  const newBalance = balance - item.coinCost
  await setPlayerCoinBalance(key, newBalance)

  upgrades.traps.push(trapId)
  upgrades.equippedTrap = trapId
  await savePlayerUpgrades(key, upgrades)

  console.log('[Store] Player', key.slice(0, 8), 'bought trap', item.label, 'for', item.coinCost, 'coins. New balance:', newBalance)

  room.send('buyTrapResult', {
    success: true,
    trapId,
    reason: '',
    newBalance,
    upgradesJson: serializeUpgrades(upgrades)
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

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]
    let coins = ROUND_PARTICIPATION_COINS

    coins += Math.floor(p.seconds * COINS_PER_HOLD_SECOND)

    if (i < ROUND_PLACEMENT_BONUS.length && p.seconds > 0) {
      coins += ROUND_PLACEMENT_BONUS[i]
    }

    if (coins > 0) {
      const newBalance = await serializePerPlayer(p.userId, () => addPlayerCoins(p.userId, coins))
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
  }
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
    if (!getPlayerPosition(from)) return

    // Per-player sliding-window rate limit: a walking player picks up well under this,
    // but it caps both coin farming speed and CRDT write volume from a hostile client.
    const nowMs = Date.now()
    let times = coinPickupTimes.get(from)
    if (!times) { times = []; coinPickupTimes.set(from, times) }
    while (times.length > 0 && nowMs - times[0] > COIN_PICKUP_WINDOW_MS) times.shift()
    if (times.length >= COIN_PICKUP_MAX_IN_WINDOW) return

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

    times.push(nowMs)
    coinCooldowns.add(coinId)
    updateCoinStateCRDT()

    serializePerPlayer(from, () => addPlayerCoins(from, 1)).then(newBalance => {
      room.send('coinPickedUp', { coinId, playerId: from, newBalance })
      console.log('[Coins] Coin picked up:', coinId, 'by', from.slice(0, 8), 'balance:', newBalance)
    }).catch(err => console.error('[Coins] Error awarding coin:', err))
  })

  room.onMessage('requestWalletBalance', async (_data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    const balance = await loadPlayerCoinBalance(from)
    room.send('walletBalance', { playerId: from, coins: balance }, { to: [from] })
    console.log('[Coins] Sent wallet balance to', from.slice(0, 8), ':', balance)
  })

  room.onMessage('requestUpgrades', async (_data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    const upgrades = await loadPlayerUpgrades(from)
    const wins = await loadPlayerLifetimeWins(from)
    const holdTime = await loadPlayerLifetimeHoldTime(from)
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

    const upgrades = await loadPlayerUpgrades(from)
    if (!upgrades.traps.includes(data.trapId)) {
      console.log('[Store] equipTrap rejected — not owned:', data.trapId, 'by', from.slice(0, 8))
      return
    }

    upgrades.equippedTrap = data.trapId
    await savePlayerUpgrades(from, upgrades)
    console.log('[Store] Player', from.slice(0, 8), 'equipped trap', data.trapId)
  })

  room.onMessage('equipBoomerang', async (data, context) => {
    if (!context || !data.color) return
    const from = context.from.toLowerCase()
    const color = data.color as BoomerangColor

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
      const lastBlessing = await Storage.get<string>(`blessing:${from}`)
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
    try {
      if (!context) return
      const from = context.from.toLowerCase()

      // Serialize so two concurrent claims can't both read yesterday's date and
      // double-award the daily blessing before either Storage.set lands.
      const outcome = await serializePerPlayer(from, async () => {
        const today = new Date().toISOString().slice(0, 10)
        const lastBlessing = await Storage.get<string>(`blessing:${from}`)
        if (lastBlessing === today) return { alreadyBlessed: true, newBalance: 0 }
        const bal = await addPlayerCoins(from, BLESSING_COINS)
        await Storage.set(`blessing:${from}`, today)
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
