/**
 * Shared Upgrade / Store Definitions
 * 
 * Tracks per-player purchased upgrades and lifetime stats.
 * Server-authoritative: only the server can write these components.
 */
import { engine, Schemas } from '@dcl/sdk/ecs'
import { AUTH_SERVER_PEER_ID } from '@dcl/sdk/network/message-bus-sync'
import type { BoomerangColor } from '../gameState/boomerangColor'

// ── Store Items ──

export interface StoreItem {
  id: BoomerangColor
  label: string
  coinCost: number
  flagsRequired: number  // lifetime rounds won required
  description: string
}

export const BOOMERANG_STORE: StoreItem[] = [
  { id: 'r', label: 'Base',   coinCost: 0,   flagsRequired: 0,  description: 'Standard boomerang' },
  { id: 'y', label: 'Dubs',   coinCost: 50,  flagsRequired: 1,  description: 'Throws two boomerangs' },
  { id: 'g', label: 'Orbit',  coinCost: 150, flagsRequired: 5,  description: 'Orbiting boomerang' },
  { id: 'b', label: 'Charge', coinCost: 300, flagsRequired: 10, description: 'Chargeable boomerang' },
]

// ── Components ──

/**
 * Per-player upgrade data, synced from server.
 * upgradesJson: JSON string like {"boomerangs":["r","y"],"equipped":"r"}
 */
export const PlayerUpgrades = engine.defineComponent('player-upgrades', {
  playerId: Schemas.String,
  upgradesJson: Schemas.String,
}, { playerId: '', upgradesJson: '{"boomerangs":["r"],"equipped":"r"}' })

PlayerUpgrades.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

/**
 * Per-player lifetime wins (flags), synced from server.
 */
export const PlayerLifetimeWins = engine.defineComponent('player-lifetime-wins', {
  playerId: Schemas.String,
  wins: Schemas.Int,
}, { playerId: '', wins: 0 })

PlayerLifetimeWins.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Sync IDs ──

const UPGRADES_SYNC_ID_BASE = 5000000
const LIFETIME_WINS_SYNC_ID_BASE = 6000000

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return h >>> 0
}

export function getUpgradesSyncId(userId: string): number {
  return UPGRADES_SYNC_ID_BASE + (hashString(userId.toLowerCase()) % 100000)
}

export function getLifetimeWinsSyncId(userId: string): number {
  return LIFETIME_WINS_SYNC_ID_BASE + (hashString(userId.toLowerCase()) % 100000)
}

// ── Helpers ──

export interface UpgradeData {
  boomerangs: BoomerangColor[]
  equipped: BoomerangColor
}

export function parseUpgrades(json: string): UpgradeData {
  try {
    const data = JSON.parse(json)
    return {
      boomerangs: Array.isArray(data.boomerangs) ? data.boomerangs : ['r'],
      equipped: data.equipped || 'r',
    }
  } catch {
    return { boomerangs: ['r'], equipped: 'r' }
  }
}

export function serializeUpgrades(data: UpgradeData): string {
  return JSON.stringify({ boomerangs: data.boomerangs, equipped: data.equipped })
}
