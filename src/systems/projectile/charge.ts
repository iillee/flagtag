/**
 * Charge mechanic — state queries, speed/range calculations, movement restriction.
 */
import { engine, InputModifier } from '@dcl/sdk/ecs'
import {
  charge, CHARGE_TIME_SEC, CHARGE_MIN_SPEED, CHARGE_MAX_SPEED,
  CHARGE_MIN_RANGE, CHARGE_MAX_RANGE
} from './state'

/** Returns current charge fraction 0..1 (0 if not charging) */
export function getChargeFraction(): number {
  if (!charge.isCharging || charge.startMs === 0) return 0
  const elapsed = (Date.now() - charge.startMs) / 1000
  return Math.min(1, elapsed / CHARGE_TIME_SEC)
}

/** Returns true if the player is currently charging a throw */
export function getIsCharging(): boolean { return charge.isCharging }

/** Returns true if burnout flash is active */
export function getBurnoutFlash(): boolean { return Date.now() < charge.burnoutFlashUntil }

/** Returns charge phase: 'charging' | 'none' */
export function getChargePhase(): 'charging' | 'none' {
  if (!charge.isCharging || charge.startMs === 0) return 'none'
  return 'charging'
}

export function applyChargeSlow(): void {
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({
      disableRun: true,
      disableJump: true,
      disableGliding: true,
    })
  })
}

export function removeChargeSlow(): void {
  if (InputModifier.has(engine.PlayerEntity)) {
    InputModifier.deleteFrom(engine.PlayerEntity)
  }
}

/** Compute speed from charge fraction */
export function chargeToSpeed(fraction: number): number {
  return CHARGE_MIN_SPEED + fraction * (CHARGE_MAX_SPEED - CHARGE_MIN_SPEED)
}

/** Compute range from charge fraction */
export function chargeToRange(fraction: number): number {
  return CHARGE_MIN_RANGE + fraction * (CHARGE_MAX_RANGE - CHARGE_MIN_RANGE)
}
