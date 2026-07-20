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
  // Cancel any pending removal of this fn so a same-window re-register wins
  // over a deferred removeSystem() call (fixes the removal race).
  removedPerFrame.delete(fn)
  // Dedup: the pending entry may still be in the array (removal is deferred), so pushing
  // unconditionally here would leave a duplicate once the removal is cancelled above.
  if (perFrameSystems.indexOf(fn) === -1) perFrameSystems.push(fn)
}

/**
 * Register a system that runs at most every `interval` seconds.
 * The function receives accumulated dt since last invocation.
 */
export function registerThrottled(fn: SystemFn, interval: number): void {
  // Cancel any pending removal of this fn so a same-window re-register wins
  // over a deferred removeSystem() call (fixes the removal race).
  removedThrottled.delete(fn)
  // Dedup: the pending entry may still be in the array (removal is deferred), so pushing
  // unconditionally here would leave a duplicate once the removal is cancelled above.
  if (!throttledSystems.some(t => t.fn === fn)) throttledSystems.push({ fn, interval, accum: 0 })
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
    // Tick all — isolate each system so one throw doesn't kill the rest this frame
    for (let i = 0; i < perFrameSystems.length; i++) {
      try {
        perFrameSystems[i](dt)
      } catch (e) {
        console.error('[systemManager] system error:', e)
      }
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
    // Tick throttled — isolate each system so one throw doesn't kill the rest
    for (let i = 0; i < throttledSystems.length; i++) {
      const t = throttledSystems[i]
      t.accum += dt
      if (t.accum >= t.interval) {
        try {
          t.fn(t.accum)
        } catch (e) {
          console.error('[systemManager] system error:', e)
        }
        // Reset to zero. fn() receives the FULL accumulated dt, so zeroing delivers
        // exactly the real elapsed time (sum of delivered dt == wall-clock). Subtracting
        // only one interval while still passing the full accum double-counts the leftover,
        // making dt-integrating systems (boost timers, spawn accumulators) run fast.
        t.accum = 0
      }
    }
  })
}
