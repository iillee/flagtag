/**
 * Speed Boost System
 * 
 * Manages temporary speed boosts from pickups (coins, mushrooms).
 * Uses AvatarLocomotionSettings to increase player movement speed.
 * Refresh only — each pickup resets the timer, doesn't stack speed.
 * Mushroom overrides coin boost (higher tier).
 */
import { engine, AvatarLocomotionSettings } from '@dcl/sdk/ecs'
import { room } from '../shared/messages'

// ── Config ──
const COIN_BOOST_DURATION = 3.0       // seconds
const MUSHROOM_BOOST_DURATION = 20.0  // seconds

// Default speeds (from Decentraland docs)
const BASE_WALK = 1.5
const BASE_JOG = 8.0
const BASE_RUN = 10.0
const BASE_JUMP = 1.0
const BASE_RUN_JUMP = 1.5

// Coin: +20% speed, no jump increase
const COIN_LOCOMOTION = {
  walkSpeed: BASE_WALK * 1.2,
  jogSpeed: BASE_JOG * 1.2,
  runSpeed: BASE_RUN * 1.2,
}

// Mushroom: +50% speed, jump, and glide
const MUSHROOM_LOCOMOTION = {
  walkSpeed: BASE_WALK * 1.5,
  jogSpeed: BASE_JOG * 1.5,
  runSpeed: BASE_RUN * 1.5,
  jumpHeight: BASE_JUMP * 1.5,
  runJumpHeight: BASE_RUN_JUMP * 1.5,
  glideSpeed: 6.0 * 1.5,    // default 6 → 9
  doubleJump: 2.0 * 1.5,    // default 2 → 3
}

// ── State ──
type BoostTier = 'none' | 'coin' | 'mushroom'
let boostTimer = 0
let boostActive = false
let currentTier: BoostTier = 'none'

/** Coin pickup — +20% for 3s. Refreshes timer. Doesn't override active mushroom boost. */
export function addCoinSpeedBoost(): void {
  if (currentTier === 'mushroom') {
    // Don't downgrade from mushroom — just ignore
    console.log('[SpeedBoost] Coin boost ignored (mushroom active)')
    return
  }
  boostTimer = COIN_BOOST_DURATION
  if (currentTier !== 'coin') {
    currentTier = 'coin'
    applyBoost(COIN_LOCOMOTION)
  }
  room.send('reportBoost', { tier: 'coin', duration: COIN_BOOST_DURATION })
  console.log(`[SpeedBoost] ⚡ Coin boost! Timer: ${boostTimer.toFixed(1)}s`)
}

/** Mushroom pickup — +50% for 20s. Always overrides coin boost. Refreshes timer. */
export function addMushroomSpeedBoost(): void {
  boostTimer = MUSHROOM_BOOST_DURATION
  if (currentTier !== 'mushroom') {
    currentTier = 'mushroom'
    applyBoost(MUSHROOM_LOCOMOTION)
  }
  room.send('reportBoost', { tier: 'mushroom', duration: MUSHROOM_BOOST_DURATION })
  console.log(`[SpeedBoost] 🍄 Mushroom boost! Timer: ${boostTimer.toFixed(1)}s`)
}

/** Get remaining boost time (for UI) */
export function getBoostTimeRemaining(): number {
  return boostTimer
}

/** Whether a speed boost is currently active */
export function isSpeedBoosted(): boolean {
  return boostActive
}

/** Get current boost tier */
export function getBoostTier(): string {
  return currentTier
}

/** Clear all boosts (e.g. round end, death) */
export function clearSpeedBoost(): void {
  boostTimer = 0
  currentTier = 'none'
  if (boostActive) {
    removeBoost()
  }
}

function applyBoost(locomotion: typeof COIN_LOCOMOTION): void {
  AvatarLocomotionSettings.createOrReplace(engine.PlayerEntity, locomotion)
  boostActive = true
  console.log('[SpeedBoost] ⚡ BOOST APPLIED — runSpeed:', locomotion.runSpeed)
}

function removeBoost(): void {
  if (AvatarLocomotionSettings.has(engine.PlayerEntity)) {
    AvatarLocomotionSettings.deleteFrom(engine.PlayerEntity)
  }
  boostActive = false
  currentTier = 'none'
  console.log('[SpeedBoost] 🏃 Normal speed restored')
}

/** Per-frame system — counts down boost timer */
export function speedBoostSystem(dt: number): void {
  if (boostTimer <= 0) return

  boostTimer -= dt

  if (boostTimer <= 0) {
    boostTimer = 0
    removeBoost()
  }
}
