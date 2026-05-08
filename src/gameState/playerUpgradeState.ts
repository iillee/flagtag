/**
 * Client-side upgrade state reader.
 * 
 * Reads PlayerUpgrades and PlayerLifetimeWins from CRDT-synced entities
 * for the local player. Also handles buy requests and results.
 */
import { engine, AudioSource, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { PlayerUpgrades, PlayerLifetimeWins, parseUpgrades, type UpgradeData } from '../shared/upgrades'
import { room } from '../shared/messages'
import { setBoomerangColor, type BoomerangColor } from './boomerangColor'

// ── Local cache ──
let localUpgrades: UpgradeData = { boomerangs: ['r'], equipped: 'r' }
let localLifetimeWins = 0
let buyPending = false
let lastBuyError = ''
let lastBuyErrorTimer = 0
let initialEquipApplied = false

// Purchase sound
const purchaseSoundEntity = engine.addEntity()
Transform.create(purchaseSoundEntity, { position: Vector3.Zero() })
AudioSource.create(purchaseSoundEntity, {
  audioClipUrl: 'assets/sounds/purchase.mp3',
  playing: false,
  loop: false,
  volume: 0.6,
  global: true
})

/** Get the local player's upgrade data */
export function getLocalUpgrades(): UpgradeData {
  return localUpgrades
}

/** Get the local player's lifetime wins (flags) */
export function getLocalLifetimeWins(): number {
  return localLifetimeWins
}

/** Whether a purchase is in progress */
export function isBuyPending(): boolean {
  return buyPending
}

/** Get the last buy error message (clears after 3 seconds) */
export function getLastBuyError(): string {
  return lastBuyError
}

/** Request purchase of a boomerang */
export function requestBuyBoomerang(color: BoomerangColor): void {
  if (buyPending) return
  buyPending = true
  lastBuyError = ''
  room.send('buyBoomerang', { color })
  console.log('[Store] Requesting purchase of', color)
}

/** Request equip of an owned boomerang */
export function requestEquipBoomerang(color: BoomerangColor): void {
  if (!localUpgrades.boomerangs.includes(color)) return
  localUpgrades.equipped = color
  setBoomerangColor(color)
  room.send('equipBoomerang', { color })
}

/** Initialize: listen for buy results and request upgrade data from server */
export function initUpgradeListeners(): void {
  // Request our upgrades + lifetime wins from the server on join
  room.send('requestUpgrades', { t: 0 })

  // Direct response with upgrade data (faster than CRDT sync)
  room.onMessage('upgradesResponse', (data) => {
    const parsed = parseUpgrades(data.upgradesJson)
    localUpgrades = parsed
    localLifetimeWins = data.wins ?? 0
    if (!initialEquipApplied && parsed.equipped) {
      initialEquipApplied = true
      setBoomerangColor(parsed.equipped)
    }
    console.log('[Store] Got direct upgrade data - owned:', parsed.boomerangs.join(','), 'wins:', localLifetimeWins)
  })

  room.onMessage('buyResult', (data) => {
    buyPending = false
    if (data.success) {
      // Update local state
      const updated = parseUpgrades(data.upgradesJson)
      localUpgrades = updated
      setBoomerangColor(updated.equipped)
      lastBuyError = ''
      // Play purchase sound
      const a = AudioSource.getMutable(purchaseSoundEntity)
      a.currentTime = 0
      a.playing = true
      console.log('[Store] Purchase successful:', data.color)
    } else {
      lastBuyError = data.reason
      lastBuyErrorTimer = 3
      console.log('[Store] Purchase failed:', data.reason)
    }
  })
}

/** System: read synced upgrade data each frame */
export function upgradeStateSystem(dt: number): void {
  // Clear buy error after timeout
  if (lastBuyError && lastBuyErrorTimer > 0) {
    lastBuyErrorTimer -= dt
    if (lastBuyErrorTimer <= 0) {
      lastBuyError = ''
    }
  }

  const player = getPlayer()
  if (!player) return
  const localId = player.userId.toLowerCase()

  // Read upgrades from synced component
  for (const [, data] of engine.getEntitiesWith(PlayerUpgrades)) {
    if (data.playerId === localId) {
      const parsed = parseUpgrades(data.upgradesJson)
      localUpgrades = parsed
      // Auto-equip saved boomerang on first load
      if (!initialEquipApplied && parsed.equipped) {
        initialEquipApplied = true
        setBoomerangColor(parsed.equipped)
      }
      break
    }
  }

  // Read lifetime wins from synced component
  for (const [, data] of engine.getEntitiesWith(PlayerLifetimeWins)) {
    if (data.playerId === localId) {
      localLifetimeWins = data.wins
      break
    }
  }
}
