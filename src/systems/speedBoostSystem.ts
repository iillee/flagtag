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
  glideSpeed: 6.0 * 1.5,    // default 6 → 9
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
  // Write to BOTH PlayerEntity and RootEntity to cover the mid-rollout window
  // of godot-explorer PR #2792:
  //   - Protocol-correct target is engine.PlayerEntity (SceneEntityId::PLAYER,
  //     id 1). Desktop has always honoured this; post-#2792 mobile does too.
  //   - Pre-#2792 mobile clients read from engine.RootEntity by mistake and
  //     ignored PlayerEntity writes entirely. Our own mobile_test scene
  //     reproduces this today: writing only to PlayerEntity works on desktop
  //     but not on the mobile build we can install, and vice versa.
  //   - Per the #2792 reviewer's P2 note, writes to the non-honoured entity
  //     are 'ignored with no log' — no error, no side effect — so the dual
  //     write is safe on every current and future client. Once every player is
  //     on a post-#2792 client we can drop the RootEntity write, but there's
  //     no upside to rushing that.
  //
  // Mobile caveat unrelated to the entity issue: mobile has no ia_sprint input,
  // so mobile's effective top speed caps at jogSpeed. Mushroom scales both, so
  // mobile players get +50% jog (8 → 12 m/s) and desktop gets +50% run
  // (10 → 15 m/s). The mobile boost is real, just ~20% smaller in absolute
  // terms by design of the client's input scheme.
  AvatarLocomotionSettings.createOrReplace(engine.PlayerEntity, MUSHROOM_LOCOMOTION)
  AvatarLocomotionSettings.createOrReplace(engine.RootEntity, MUSHROOM_LOCOMOTION)
  boostActive = true
  console.log('[SpeedBoost] ⚡ BOOST APPLIED — runSpeed:', MUSHROOM_LOCOMOTION.runSpeed)
}

function removeBoost(): void {
  if (AvatarLocomotionSettings.has(engine.PlayerEntity)) {
    AvatarLocomotionSettings.deleteFrom(engine.PlayerEntity)
  }
  if (AvatarLocomotionSettings.has(engine.RootEntity)) {
    AvatarLocomotionSettings.deleteFrom(engine.RootEntity)
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
