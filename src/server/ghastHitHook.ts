/**
 * ghastHitHook.ts - lets combat.ts (bombs, bananas) damage ghasts without
 * importing ghastServer (which already imports combat). ghastServer installs
 * the handler at startup.
 */
export type GhastHitCause = 'bomb' | 'banana' | 'boomerang'
export type GhastHitFn = (pos: { x: number; y: number; z: number }, radius: number, killer: string, cause: GhastHitCause, kill: boolean) => number

let handler: GhastHitFn | null = null

export function setGhastHitHandler(fn: GhastHitFn): void { handler = fn }

/** Damage every live ghast whose body centre is within `radius` of `pos`. Returns hits. */
export function hitGhasts(pos: { x: number; y: number; z: number }, radius: number, killer: string, cause: GhastHitCause, kill: boolean): number {
  return handler ? handler(pos, radius, killer, cause, kill) : 0
}
