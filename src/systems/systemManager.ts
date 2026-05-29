/**
 * systemManager.ts — Central system scheduler.
 *
 * Replaces direct engine.addSystem() calls throughout the codebase.
 * All registered functions are batched into just 2 actual engine systems
 * (one per-frame, one throttled), minimizing engine dispatch overhead.
 *
 * Usage in any file:
 *   import { registerSystem, registerThrottled } from './systemManager'
 *   registerSystem(myPerFrameFn)             // runs every frame
 *   registerThrottled(myCheckFn, 0.5)        // runs every 0.5s
 */
import { engine } from '@dcl/sdk/ecs'

type SystemFn = (dt: number) => void

// ── Per-frame systems ──
const perFrameSystems: SystemFn[] = []

// ── Throttled systems ──
const throttledSystems: { fn: SystemFn; interval: number; accum: number }[] = []

// ── One-shot removal tracking ──
const removedPerFrame = new Set<SystemFn>()
const removedThrottled = new Set<SystemFn>()

/**
 * Register a system that runs every frame.
 * The function receives dt (seconds since last frame).
 */
export function registerSystem(fn: SystemFn): void {
  perFrameSystems.push(fn)
}

/**
 * Register a system that runs at most every `interval` seconds.
 * The function receives accumulated dt since last invocation.
 */
export function registerThrottled(fn: SystemFn, interval: number): void {
  throttledSystems.push({ fn, interval, accum: 0 })
}

/**
 * Remove a previously registered system (per-frame or throttled).
 * Removal happens on next tick to avoid mutation during iteration.
 */
export function removeSystem(fn: SystemFn): void {
  removedPerFrame.add(fn)
  removedThrottled.add(fn)
}

/**
 * Call once from main() after all modules have registered.
 * Registers exactly 2 engine systems — one per-frame, one throttled batch.
 */
export function initSystemManager(): void {
  // Per-frame batch
  engine.addSystem((dt: number) => {
    // Process removals
    if (removedPerFrame.size > 0) {
      for (let i = perFrameSystems.length - 1; i >= 0; i--) {
        if (removedPerFrame.has(perFrameSystems[i])) {
          perFrameSystems.splice(i, 1)
        }
      }
      removedPerFrame.clear()
    }
    // Tick all
    for (let i = 0; i < perFrameSystems.length; i++) {
      perFrameSystems[i](dt)
    }
  })

  // Throttled batch
  engine.addSystem((dt: number) => {
    // Process removals
    if (removedThrottled.size > 0) {
      for (let i = throttledSystems.length - 1; i >= 0; i--) {
        if (removedThrottled.has(throttledSystems[i].fn)) {
          throttledSystems.splice(i, 1)
        }
      }
      removedThrottled.clear()
    }
    // Tick throttled
    for (let i = 0; i < throttledSystems.length; i++) {
      const t = throttledSystems[i]
      t.accum += dt
      if (t.accum >= t.interval) {
        t.fn(t.accum)
        t.accum = 0
      }
    }
  })
}
