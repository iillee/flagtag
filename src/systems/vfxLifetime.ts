/**
 * vfxLifetime — single unconditional cleanup registry for all one-shot VFX
 * (bomb explosions, combat hit clouds, boomerang impacts, etc.).
 *
 * Why: per-system cleanup loops (activeVfx / activeExplosionVfx) fire only
 * when their system's tick actually runs. During cinematic, spectator, tab
 * background-and-resume, or mid-frame state churn, those ticks can skip
 * frames — the tween's last-written scale/position stays on screen and the
 * VFX "sticks" (mid-air explosion, floating hit cloud, etc.). Observed on
 * mobile 2026-08-15.
 *
 * How: one registry, one system, no gates. Every VFX-creating callsite
 * registers { entity, expiresAt } here. On expiry we forcibly kill any
 * Tween/TweenSequence and hide the entity (position off-map, scale zero) —
 * regardless of what state any other system is in. The 250ms buffer past
 * the tween duration gives the animation its final frame before we force-hide.
 */

import { Transform, Tween, TweenSequence, type Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

const HIDDEN_POS = Vector3.create(0, -1000, 0)
const CLEANUP_BUFFER_MS = 250

interface VfxEntry {
  entity: Entity
  expiresAt: number
  onExpire?: () => void
}

const registry: VfxEntry[] = []

/**
 * Register a VFX entity for auto-cleanup after `lifetimeMs` (+ 250ms buffer).
 * The entity's Transform will be set to hidden/scale-zero and any Tween /
 * TweenSequence removed. Safe to call repeatedly for pooled entities — each
 * call adds a new registry entry, older entries clean up harmlessly (the
 * new tween has already overwritten the pool entity's state).
 */
export function registerVfx(entity: Entity, lifetimeMs: number, onExpire?: () => void): void {
  registry.push({ entity, expiresAt: Date.now() + lifetimeMs + CLEANUP_BUFFER_MS, onExpire })
}

/** Runs every frame. No spectator/cinematic/round-end gate — that's the point. */
export function vfxLifetimeSystem(_dt: number): void {
  const now = Date.now()
  for (let i = registry.length - 1; i >= 0; i--) {
    if (now >= registry[i].expiresAt) {
      const { entity, onExpire } = registry[i]
      registry.splice(i, 1)
      try {
        if (Tween.has(entity)) Tween.deleteFrom(entity)
        if (TweenSequence.has(entity)) TweenSequence.deleteFrom(entity)
        if (Transform.has(entity)) {
          const t = Transform.getMutable(entity)
          t.position = HIDDEN_POS
          t.scale = Vector3.Zero()
        }
        onExpire?.()
      } catch {
        // Entity may have been recycled / removed by another system — safe to ignore.
      }
    }
  }
}


