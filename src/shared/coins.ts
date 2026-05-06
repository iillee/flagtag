/**
 * Shared Coin Definitions
 * 
 * Coin pickup system — players collect coins scattered around the map.
 * Coins are multiplayer-synced: when one player picks up a coin, it disappears for everyone
 * and respawns after COIN_RESPAWN_SEC seconds.
 * 
 * Per-player coin balances are persisted server-side via Storage.
 * Coins are also awarded at end of each flag tag round based on hold-time placement.
 */
import { engine, Schemas } from '@dcl/sdk/ecs'
import { AUTH_SERVER_PEER_ID } from '@dcl/sdk/network/message-bus-sync'

// ── Constants ──

/** Seconds between each random coin respawn (one empty spot refills per tick) */
export const COIN_RESPAWN_INTERVAL_SEC = 30

/** Radius in meters for coin pickup detection (server-side) */
export const COIN_PICKUP_RADIUS = 2.5

/** Coins awarded for round participation (everyone who played) */
export const ROUND_PARTICIPATION_COINS = 1

/** Bonus coins for top 3 placements at round end */
export const ROUND_PLACEMENT_BONUS = [5, 3, 1] as const  // 1st, 2nd, 3rd

/** Maximum coins a player can hold (upgradeable in future) */
export const MAX_COINS = 1000

/** Coins per second of flag hold time (fractional, floored at round end) */
export const COINS_PER_HOLD_SECOND = 0.1

// ── Coin State (server-synced, single entity for all coins) ──

/**
 * Tracks which coins are currently on cooldown (picked up and not yet respawned).
 * `cooldownJson` is a JSON object: { [coinId: string]: respawnTimestampMs }
 * Clients read this to hide/show coin entities.
 */
export const CoinState = engine.defineComponent('coin-state', {
  cooldownJson: Schemas.String,
}, { cooldownJson: '{}' })

CoinState.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

/**
 * Per-player coin wallet, synced from server.
 * Each player gets their own entity with their balance.
 * Uses the same hash approach as PlayerFlagHoldTime for deterministic sync IDs.
 */
export const PlayerWallet = engine.defineComponent('coin-player-wallet', {
  playerId: Schemas.String,
  coins: Schemas.Int,
}, { playerId: '', coins: 0 })

PlayerWallet.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Sync IDs ──

/** Sync ID for the single CoinState entity */
export const COIN_STATE_SYNC_ID = 300

/** Sync ID base for player wallets — uses same hash approach as hold times */
const WALLET_SYNC_ID_BASE = 4000000

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return h >>> 0
}

export function getWalletSyncId(userId: string): number {
  return WALLET_SYNC_ID_BASE + (hashString(userId.toLowerCase()) % 100000)
}
