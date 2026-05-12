// STUB — projectile system removed for Contagion mode
import { type Entity } from '@dcl/sdk/ecs'

export function projectileClientSystem(_dt: number): void {}
export function setHandBoomerangEntity(_e: Entity): void {}
export function setLeftHandBoomerangEntity(_e: Entity): void {}
export function initProjectilePool(): void {}
export function getChargeFraction(): number { return 0 }
export function getChargePhase(): string { return 'idle' }
export function isProjectileOnCooldown(): boolean { return false }
export function getProjectileCooldownRemaining(): number { return 0 }
export function triggerProjectileFromUI(): void {}
export function getIsCharging(): boolean { return false }
export function getBurnoutFlash(): boolean { return false }
