/**
 * economy.ts — Coins, wallets, upgrades, store purchases, and coin respawn system.
 */
import { engine, type Entity } from '@dcl/sdk/ecs'
import { syncEntity } from '@dcl/sdk/network'
import { Storage } from '@dcl/sdk/server'
import {
  walletEntities, upgradeEntities, lifetimeWinsEntities,
  playerCoinBalances, playerUpgradeData, playerLifetimeWinsCache,
  playerBoomerangColors, deathPenaltyCooldowns,
  coinStateEntity, allTimeLeaderboardEntity
} from './serverState'
import { parseLeaderboardJson } from './leaderboard'
import {
  CoinState, PlayerWallet, COIN_RESPAWN_INTERVAL_SEC,
  ROUND_PARTICIPATION_COINS, ROUND_PLACEMENT_BONUS, COINS_PER_HOLD_SECOND, MAX_COINS,
  getWalletSyncId
} from '../shared/coins'
import {
  PlayerUpgrades, PlayerLifetimeWins,
  getUpgradesSyncId, getLifetimeWinsSyncId,
  parseUpgrades, serializeUpgrades, BOOMERANG_STORE,
  type UpgradeData
} from '../shared/upgrades'
import { AllTimeLeaderboardState } from '../shared/components'
import { room } from '../shared/messages'
import type { BoomerangColor } from '../gameState/boomerangColor'

// ── Coin cooldown state (module-local) ──
/** Set of coinIds currently picked up (empty spots waiting for random respawn) */
const coinCooldowns = new Set<string>()
/** Timer tracking seconds until next random coin respawn */
let coinRespawnTimer = 0

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

  const walletEntity = getOrCreateWalletEntity(key)
  PlayerWallet.getMutable(walletEntity).coins = amount

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

export function getOrCreateWalletEntity(walletAddress: string): Entity {
  const key = walletAddress.toLowerCase()
  let entity = walletEntities.get(key)
  if (entity) return entity

  entity = engine.addEntity()
  const balance = playerCoinBalances.get(key) ?? 0
  PlayerWallet.create(entity, { playerId: key, coins: balance })
  syncEntity(entity, [PlayerWallet.componentId], getWalletSyncId(key))
  walletEntities.set(key, entity)
  console.log('[Coins] Created wallet entity for', key.slice(0, 8), 'balance:', balance)
  return entity
}

// ── Upgrade / progression helpers ──

export async function loadPlayerUpgrades(walletAddress: string): Promise<UpgradeData> {
  const key = walletAddress.toLowerCase()
  const cached = playerUpgradeData.get(key)
  if (cached) return cached

  try {
    const saved = await Storage.get<string>(`upgrades:${key}`)
    const data = saved ? parseUpgrades(saved) : { boomerangs: ['r'] as BoomerangColor[], equipped: 'r' as BoomerangColor }
    playerUpgradeData.set(key, data)
    return data
  } catch (err) {
    console.error('[Upgrades] Failed to load for', key.slice(0, 8), err)
    return { boomerangs: ['r'], equipped: 'r' }
  }
}

export async function savePlayerUpgrades(walletAddress: string, data: UpgradeData): Promise<void> {
  const key = walletAddress.toLowerCase()
  playerUpgradeData.set(key, data)

  const entity = getOrCreateUpgradeEntity(key)
  PlayerUpgrades.getMutable(entity).upgradesJson = serializeUpgrades(data)

  try {
    await Storage.set(`upgrades:${key}`, serializeUpgrades(data))
  } catch (err) {
    console.error('[Upgrades] Failed to persist for', key.slice(0, 8), err)
  }
}

export function getOrCreateUpgradeEntity(walletAddress: string): Entity {
  const key = walletAddress.toLowerCase()
  let entity = upgradeEntities.get(key)
  if (entity) return entity

  entity = engine.addEntity()
  const data = playerUpgradeData.get(key) ?? { boomerangs: ['r'], equipped: 'r' }
  PlayerUpgrades.create(entity, { playerId: key, upgradesJson: serializeUpgrades(data) })
  syncEntity(entity, [PlayerUpgrades.componentId], getUpgradesSyncId(key))
  upgradeEntities.set(key, entity)
  console.log('[Upgrades] Created entity for', key.slice(0, 8))
  return entity
}

export async function loadPlayerLifetimeWins(walletAddress: string): Promise<number> {
  const key = walletAddress.toLowerCase()
  const cached = playerLifetimeWinsCache.get(key)
  if (cached !== undefined) return cached

  try {
    const saved = await Storage.get<string>(`lifetimeWins:${key}`)
    let wins = saved ? parseInt(saved, 10) : 0

    // Reconcile with all-time leaderboard — always take the higher value
    const atEntries = parseLeaderboardJson(AllTimeLeaderboardState.getOrNull(allTimeLeaderboardEntity)?.json)
    const entry = atEntries.find(e => e.userId.toLowerCase() === key)
    if (entry && entry.roundsWon > wins) {
      console.log('[LifetimeWins] Reconciled', key.slice(0, 8), 'from', wins, 'to', entry.roundsWon, '(all-time leaderboard)')
      wins = entry.roundsWon
      await Storage.set(`lifetimeWins:${key}`, String(wins))
    }

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

  const entity = getOrCreateLifetimeWinsEntity(key)
  PlayerLifetimeWins.getMutable(entity).wins = newWins

  try {
    await Storage.set(`lifetimeWins:${key}`, String(newWins))
  } catch (err) {
    console.error('[LifetimeWins] Failed to persist for', key.slice(0, 8), err)
  }

  return newWins
}

export function getOrCreateLifetimeWinsEntity(walletAddress: string): Entity {
  const key = walletAddress.toLowerCase()
  let entity = lifetimeWinsEntities.get(key)
  if (entity) return entity

  entity = engine.addEntity()
  const wins = playerLifetimeWinsCache.get(key) ?? 0
  PlayerLifetimeWins.create(entity, { playerId: key, wins })
  syncEntity(entity, [PlayerLifetimeWins.componentId], getLifetimeWinsSyncId(key))
  lifetimeWinsEntities.set(key, entity)
  console.log('[LifetimeWins] Created entity for', key.slice(0, 8), 'wins:', wins)
  return entity
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
      const newBalance = await addPlayerCoins(p.userId, coins)
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

    if (coinCooldowns.has(coinId)) {
      console.log('[Coins] Pickup rejected — coin already picked up:', coinId)
      return
    }

    coinCooldowns.add(coinId)
    updateCoinStateCRDT()

    addPlayerCoins(from, 1).then(newBalance => {
      room.send('coinPickedUp', { coinId, playerId: from, newBalance })
      console.log('[Coins] Coin picked up:', coinId, 'by', from.slice(0, 8), 'balance:', newBalance)
    }).catch(err => console.error('[Coins] Error awarding coin:', err))
  })

  room.onMessage('requestWalletBalance', async (_data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    const balance = await loadPlayerCoinBalance(from)
    getOrCreateWalletEntity(from)
    room.send('walletBalance', { playerId: from, coins: balance }, { to: [from] })
    console.log('[Coins] Sent wallet balance to', from.slice(0, 8), ':', balance)
  })

  room.onMessage('requestUpgrades', async (_data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    const upgrades = await loadPlayerUpgrades(from)
    getOrCreateUpgradeEntity(from)
    const wins = await loadPlayerLifetimeWins(from)
    getOrCreateLifetimeWinsEntity(from)
    room.send('upgradesResponse', { upgradesJson: serializeUpgrades(upgrades), wins }, { to: [from] })
    console.log('[Store] Sent upgrades to', from.slice(0, 8), '- owned:', upgrades.boomerangs.join(','), 'wins:', wins)

    if (upgrades.equipped && upgrades.equipped !== 'r') {
      playerBoomerangColors.set(from, upgrades.equipped)
      room.send('playerColorChanged', { playerId: from, color: upgrades.equipped })
    }
  })

  room.onMessage('buyBoomerang', async (data, context) => {
    if (!context || !data.color) return
    const from = context.from.toLowerCase()
    try {
      await handleBuyBoomerang(from, data.color)
    } catch (err) {
      console.error('[Store] buyBoomerang error:', err)
    }
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

      const current = await loadPlayerCoinBalance(from)
      const penalty = Math.min(DEATH_PENALTY_COINS, current)
      const newBalance = current - penalty
      await setPlayerCoinBalance(from, newBalance)
      room.send('walletBalance', { playerId: from, coins: newBalance }, { to: [from] })
      room.send('deathPenaltyApplied', { playerId: from, penalty, newBalance }, { to: [from] })
      console.log(`[Server] 💀 Death penalty: ${from.slice(0, 8)} lost ${penalty} coins (${current} → ${newBalance})`)
    } catch (err) { console.error('[Server] ❌ deathPenalty handler error:', err) }
  })

  // ── Blessing (daily pedestal reward) ──
  const BLESSING_COINS = 5
  room.onMessage('requestBlessing', async (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()

      // TODO: Re-enable daily limit after testing
      // const today = new Date().toISOString().slice(0, 10) // UTC date
      // const lastBlessing = await Storage.get<string>(`blessing:${from}`)
      // if (lastBlessing === today) {
      //   room.send('blessingResult', { success: false, reason: 'already_blessed', newBalance: 0 }, { to: [from] })
      //   return
      // }

      // Award coins
      const newBalance = await addPlayerCoins(from, BLESSING_COINS)
      // await Storage.set(`blessing:${from}`, today)
      room.send('walletBalance', { playerId: from, coins: newBalance }, { to: [from] })
      room.send('blessingResult', { success: true, reason: '', newBalance }, { to: [from] })
      console.log(`[Server] 🙏 Blessing: ${from.slice(0, 8)} received ${BLESSING_COINS} coins (balance: ${newBalance})`)
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
