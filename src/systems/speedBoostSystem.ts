/**
 * Speed Boost System
 * 
 * Manages temporary speed boost from mushroom pickup.
 * Uses AvatarLocomotionSettings to increase player movement speed.
 */
import { engine, AvatarLocomotionSettings } from '@dcl/sdk/ecs'
import { room } from '../shared/messages'

// ── Config ──
const MUSHROOM_BOOST_DURATION = 20.0  // seconds

// Default speeds (from Decentraland docs)
const BASE_WALK = 1.5
const BASE_JOG = 8.0
const BASE_RUN = 10.0
const BASE_JUMP = 1.0
const BASE_RUN_JUMP = 1.5

// Mushroom: +50% speed, jump, and glide
const MUSHROOM_LOCOMOTION = {
  walkSpeed: BASE_WALK * 1.5,
  jogSpeed: BASE_JOG * 1.5,
  runSpeed: BASE_RUN * 1.5,
  jumpHeight: BASE_JUMP * 1.5,
  runJumpHeight: BASE_RUN_JUMP * 1.5,
  glideSpeed: 6.0 * 0,    // default 6 → 9
  doubleJump: 2.0 * 1.5,    // default 2 → 3
}

// ── State ──
let boostTimer = 0
let boostActive = false

/** Mushroom pickup — +50% for 20s. Refreshes timer. */
export function addMushroomSpeedBoost(): void {
  boostTimer = MUSHROOM_BOOST_DURATION
  if (!boostActive) {
    applyBoost()
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
  return boostActive ? 'mushroom' : 'none'
}

/** Clear all boosts (e.g. round end, death) */
export function clearSpeedBoost(): void {
  boostTimer = 0
  if (boostActive) {
    removeBoost()
  }
}

function applyBoost(): void {
  AvatarLocomotionSettings.createOrReplace(engine.PlayerEntity, MUSHROOM_LOCOMOTION)
  boostActive = true
  console.log('[SpeedBoost] ⚡ BOOST APPLIED — runSpeed:', MUSHROOM_LOCOMOTION.runSpeed)
}

function removeBoost(): void {
  if (AvatarLocomotionSettings.has(engine.PlayerEntity)) {
    AvatarLocomotionSettings.deleteFrom(engine.PlayerEntity)
  }
  boostActive = false
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
