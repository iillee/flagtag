/**
 * Client-side upgrade state reader.
 * 
 * Reads upgrades, lifetime wins, and lifetime hold time from WebSocket messages.
 * Also handles buy requests and results.
 */
import { engine, AudioSource, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { parseUpgrades, type UpgradeData } from '../shared/upgrades'
import { room } from '../shared/messages'
import { setBoomerangColor, type BoomerangColor } from './boomerangColor'

// ── Local cache ──
let localUpgrades: UpgradeData = { boomerangs: ['r'], equipped: 'r' }
let localLifetimeWins = 0
let localLifetimeHoldTime = 0
let winsReceived = false
let winsRetryTimer = 0
let winsRetryCount = 0
const WINS_RETRY_INTERVAL = 3
const WINS_MAX_RETRIES = 20
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

/** Get the local player's lifetime flag hold time in seconds */
export function getLocalLifetimeHoldTime(): number {
  return localLifetimeHoldTime
}

/** Whether lifetime wins have been loaded from server */
export function isWinsLoaded(): boolean {
  return winsReceived
}

/** Whether a purchase is in progress */
export function isBuyPending(): boolean {
  return buyPending
}

/** Get the last buy error message (clears after 3 seconds) */
export function getLastBuyError(): string {
  return lastBuyError
}

/** Re-request upgrade data from server (call when opening store) */
export function refreshUpgradesFromServer(): void {
  room.send('requestUpgrades', { t: 0 })
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
  // Register listener BEFORE sending request to avoid race condition
  room.onMessage('upgradesResponse', (data) => {
    const parsed = parseUpgrades(data.upgradesJson)
    localUpgrades = parsed
    localLifetimeWins = data.wins ?? 0
    localLifetimeHoldTime = data.lifetimeHoldTime ?? 0
    winsReceived = true
    if (!initialEquipApplied && parsed.equipped) {
      initialEquipApplied = true
      setBoomerangColor(parsed.equipped)
    }
    console.log('[Store] Got upgrade data - owned:', parsed.boomerangs.join(','), 'wins:', localLifetimeWins, 'holdTime:', localLifetimeHoldTime.toFixed(1))
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
      AudioSource.createOrReplace(purchaseSoundEntity, { audioClipUrl: 'assets/sounds/purchase.mp3', playing: true, loop: false, volume: 1, global: true })
      console.log('[Store] Purchase successful:', data.color)
    } else {
      lastBuyError = data.reason
      lastBuyErrorTimer = 3
      console.log('[Store] Purchase failed:', data.reason)
    }
  })

  // Now send the request (after listeners are registered)
  room.send('requestUpgrades', { t: 0 })
}

/** System: read synced upgrade data each frame */
export function upgradeStateSystem(dt: number): void {
  // Retry wins/upgrades request if not received yet
  if (!winsReceived && winsRetryCount < WINS_MAX_RETRIES) {
    winsRetryTimer += dt
    if (winsRetryTimer >= WINS_RETRY_INTERVAL) {
      winsRetryTimer = 0
      winsRetryCount++
      room.send('requestUpgrades', { t: winsRetryCount })
      console.log(`[Store] Retrying requestUpgrades (attempt ${winsRetryCount})`)
    }
  }

  // Clear buy error after timeout
  if (lastBuyError && lastBuyErrorTimer > 0) {
    lastBuyErrorTimer -= dt
    if (lastBuyErrorTimer <= 0) {
      lastBuyError = ''
    }
  }
}
