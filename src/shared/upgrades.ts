/**
 * Shared Upgrade / Store Definitions
 * 
 * Tracks per-player purchased upgrades and lifetime stats.
 * Server-authoritative: only the server can write these components.
 */
import { engine, Schemas } from '@dcl/sdk/ecs'
import { AUTH_SERVER_PEER_ID } from '@dcl/sdk/network/message-bus-sync'
import type { BoomerangColor } from '../gameState/boomerangColor'

// ── Store Categories ──

export type StoreCategory = 'projectiles' | 'music' | 'traps' | 'wearables'

// ── Store Items ──

export interface StoreItem {
  id: string
  category: StoreCategory
  label: string
  coinCost: number
  flagsRequired: number  // lifetime rounds won required
  description: string
  icon: string           // image path for the store card
}

export const BOOMERANG_STORE: StoreItem[] = [
  { id: 'r', category: 'projectiles', label: 'Base',   coinCost: 0,   flagsRequired: 0,  description: 'Standard boomerang', icon: 'assets/images/boomerang.r.png' },
  { id: 'y', category: 'projectiles', label: 'Dubs',   coinCost: 50,  flagsRequired: 1,  description: 'Throws two boomerangs', icon: 'assets/images/boomerang.y.png' },
  { id: 'g', category: 'projectiles', label: 'Orbit',  coinCost: 150, flagsRequired: 5,  description: 'Orbiting boomerang', icon: 'assets/images/boomerang.g.png' },
  { id: 'b', category: 'projectiles', label: 'Charge', coinCost: 300, flagsRequired: 10, description: 'Chargeable boomerang', icon: 'assets/images/boomerang.b.png' },
]

export interface MusicStoreItem extends StoreItem {
  audioSrc: string
  author: string
}

export const MUSIC_STORE: MusicStoreItem[] = [
  { id: 'w', category: 'music', label: 'Sprite Sprint', author: 'Dylan Taylor', coinCost: 0,   flagsRequired: 0, description: 'Default track',       icon: 'assets/images/tape.w.png', audioSrc: 'assets/sounds/SpriteSprint_Loop.mp3' },
  { id: 'o', category: 'music', label: 'Digital Water',  author: 'AuthrAudio',   coinCost: 150, flagsRequired: 3, description: '115 BPM electronic',  icon: 'assets/images/tape.o.png', audioSrc: 'assets/sounds/DigitalWater-AuthrAudio-115Bpm.mp3' },
  { id: 'p', category: 'music', label: 'Home Again',    author: 'Dylan Taylor', coinCost: 150, flagsRequired: 3, description: 'Chill loop',          icon: 'assets/images/tape.p.png', audioSrc: 'assets/sounds/HomeAgain_Loop.mp3' },
  { id: 'b', category: 'music', label: 'Blips Piano',   author: 'AuthrAudio',   coinCost: 150, flagsRequired: 3, description: 'Piano blips',         icon: 'assets/images/tape.b.png', audioSrc: 'assets/sounds/blipspiano153 - AuthrAudio.mp3' },
]

// Placeholder stores for future categories
export const TRAP_STORE: StoreItem[] = [
  { id: 'banana', category: 'traps', label: 'Banana', coinCost: 0, flagsRequired: 0, description: 'Slip trap that stuns', icon: 'assets/images/banana.png' },
  { id: 'bomb', category: 'traps', label: 'Bomb', coinCost: 200, flagsRequired: 5, description: 'Explodes after 5s or on contact', icon: 'assets/images/bomb.png' },
]
export const WEARABLE_STORE: StoreItem[] = []

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

/**
 * Per-player lifetime flag hold time (total seconds across all rounds), synced from server.
 */
export const PlayerLifetimeHoldTime = engine.defineComponent('player-lifetime-hold-time', {
  playerId: Schemas.String,
  totalSeconds: Schemas.Float,
}, { playerId: '', totalSeconds: 0 })

PlayerLifetimeHoldTime.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)

// ── Helpers ──

export interface UpgradeData {
  boomerangs: BoomerangColor[]
  equipped: BoomerangColor
  tapes: string[]              // owned music tape IDs
  equippedTape: string | null  // currently selected tape (null = no music)
  traps: string[]              // owned trap IDs
  equippedTrap: string         // currently selected trap
}

const DEFAULT_UPGRADES: UpgradeData = { boomerangs: ['r'], equipped: 'r', tapes: ['w'], equippedTape: 'w', traps: ['banana'], equippedTrap: 'banana' }

export function parseUpgrades(json: string): UpgradeData {
  try {
    const data = JSON.parse(json)
    return {
      boomerangs: Array.isArray(data.boomerangs) ? data.boomerangs : ['r'],
      equipped: data.equipped || 'r',
      tapes: Array.isArray(data.tapes) ? data.tapes : ['w'],
      equippedTape: data.equippedTape !== undefined ? data.equippedTape : 'w',
      traps: Array.isArray(data.traps) ? data.traps : ['banana'],
      equippedTrap: data.equippedTrap || 'banana',
    }
  } catch {
    return { ...DEFAULT_UPGRADES }
  }
}

export function serializeUpgrades(data: UpgradeData): string {
  return JSON.stringify({
    boomerangs: data.boomerangs,
    equipped: data.equipped,
    tapes: data.tapes,
    equippedTape: data.equippedTape,
    traps: data.traps,
    equippedTrap: data.equippedTrap,
  })
}
