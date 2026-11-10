/**
 * treeFire.ts - pure tuning + placement math for the Halloween burning trees
 * (see systems/treeFireSystem.ts). No engine imports, so it is unit-testable.
 */

/** Master switch (also gated by HALLOWEEN_MODE). */
export const TREE_FIRE_ENABLED = true
/** Fraction of trees that are ever lit (deterministic per tree position). */
export const TREE_FIRE_LIT_FRACTION = 1 / 3
/**
 * Rotation: one swap every TREE_FIRE_SWAP_SEC - one lit tree fades out, one
 * unlit tree fades in. Trees sit in a fixed seeded order; the lit set is a
 * sliding window of ~LIT_FRACTION * n trees over it, advanced by one per swap,
 * so a tree that just went out only returns after (n - lit) swaps.
 * 56 trees @ 4 s: full cycle 224 s (~3.7 min).
 */
export const TREE_FIRE_SWAP_SEC = 4
/** Flames scale down over this when a tree leaves the lit set. */
export const TREE_FIRE_FADE_OUT_SEC = 2
/** Wait after the swap before the new tree starts fading in (smoke-style gap). */
export const TREE_FIRE_SWITCH_DELAY_SEC = 0.5
/** Flames scale up over this on a newly lit tree. */
export const TREE_FIRE_FADE_IN_SEC = 2
/** No server seed after this long (local preview w/o server): use seed 0. */
export const TREE_FIRE_SEED_FALLBACK_SEC = 5
/** Entities whose Name matches this get a flame ("Tree  4", "Tree  4_37", ...). */
export const TREE_FIRE_NAME_RE = /^tree\b/i
/** HWN20_Tree_04.glb top in GLB-local metres (mesh bounds max Y = 4.81). */
export const TREE_GLB_TOP_M = 4.81
/** Flame bed height as a fraction of the scaled tree height (1 = very top). */
export const TREE_FIRE_HEIGHT_FRAC = 0.55
/** Extra world-space Y nudge (m) after the fraction. */
export const TREE_FIRE_Y_OFFSET_M = 0
/** Flame cluster scale per metre of scaled tree height (cluster is ~1.4 m tall at scale 1). */
export const TREE_FIRE_SCALE_PER_M = 0.9
export const TREE_FIRE_MIN_SCALE = 0.4
export const TREE_FIRE_MAX_SCALE = 4
/** Max visible flames: nearest N to the player. */
export const TREE_FIRE_MAX_DESKTOP = 60
export const TREE_FIRE_MAX_MOBILE = 15
/** Flames further than this (XZ) keep their last pose instead of animating. */
export const TREE_FIRE_ANIMATE_RADIUS_DESKTOP_M = 90
export const TREE_FIRE_ANIMATE_RADIUS_MOBILE_M = 45
/** One radial (point) orb light per fire, gated by the scene-light night window (lightsEnabledAt). */
export const TREE_FIRE_LIGHTS_ENABLED = true
/** Perf cap: only the nearest N fires' lights actually emit (Explorer light budget; proximityLights already uses 8). */
export const TREE_FIRE_LIGHTS_DESKTOP = 4
export const TREE_FIRE_LIGHTS_MOBILE = 1
export const TREE_FIRE_LIGHT_INTENSITY = 6000
export const TREE_FIRE_LIGHT_RANGE_M = 14
/** Range flicker depth: range = RANGE_M * (1 + this * noise), noise in [-1, 1]. */
export const TREE_FIRE_LIGHT_RANGE_FLICKER = 0.25
/** Intensity flicker depth (same noise family, offset so it doesn't mirror range). */
export const TREE_FIRE_LIGHT_INTENSITY_FLICKER = 0.15
/** Time multiplier for the flicker (1 = default fire speed). */
export const TREE_FIRE_LIGHT_FLICKER_SPEED = 1
/** Flicker writes per second (emitting lights only). */
export const TREE_FIRE_LIGHT_FLICKER_HZ = 15
/** Light height above the flame bed, in flame-scale units. */
export const TREE_FIRE_LIGHT_Y = 0.8
/** Per-tree variety (deterministic from position). Billboard size 1 +/- this. */
export const TREE_FIRE_SIZE_VARIANCE = 0.3
/** Animation speed multiplier range per tree. */
export const TREE_FIRE_SPEED_MIN = 0.75
export const TREE_FIRE_SPEED_MAX = 1.3
/** Roaming spatial crackle sources (nearest trees). */
export const TREE_FIRE_SOUND_SRC = 'assets/sounds/campfire.mp3'
export const TREE_FIRE_SOUNDS = 2
export const TREE_FIRE_SOUND_VOLUME = 0.6
/** Seconds between nearest-set / light / sound re-ranking. */
export const TREE_FIRE_RERANK_S = 1.5

export interface Vec3 { x: number; y: number; z: number }

/** World position of the flame bed and the cluster scale for one tree. */
export function treeFirePlacement(pos: Vec3, scale: Vec3): { position: Vec3; flameScale: number } {
  const h = TREE_GLB_TOP_M * Math.abs(scale.y)
  const raw = h * TREE_FIRE_SCALE_PER_M
  const flameScale = Math.min(TREE_FIRE_MAX_SCALE, Math.max(TREE_FIRE_MIN_SCALE, raw))
  return {
    position: { x: pos.x, y: pos.y + h * TREE_FIRE_HEIGHT_FRAC + TREE_FIRE_Y_OFFSET_M, z: pos.z },
    flameScale,
  }
}

/** Indices of the `n` points nearest (XZ) to `from`, nearest first. */
export function nearestIndices(points: readonly Vec3[], from: Vec3, n: number): number[] {
  const ranked = points.map((p, i) => ({ i, d: (p.x - from.x) ** 2 + (p.z - from.z) ** 2 }))
  ranked.sort((a, b) => a.d - b.d)
  return ranked.slice(0, Math.max(0, n)).map((r) => r.i)
}

/** Deterministic 0..1 hash of a position (stable across clients and reloads). */
export function hash01(x: number, y: number, z: number, salt = 0): number {
  let h = Math.imul(Math.round(x * 100) | 0, 73856093) ^ Math.imul(Math.round(y * 100) | 0, 19349663) ^ Math.imul(Math.round(z * 100) | 0, 83492791) ^ Math.imul(salt + 1, 2654435761 | 0)
  h = Math.imul(h ^ (h >>> 16), 2246822507 | 0)
  h = Math.imul(h ^ (h >>> 13), 3266489909 | 0)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Per-tree size multiplier, speed multiplier and phase offset (0..1). */
export function treeFireVariant(pos: Vec3): { size: number; speed: number; phase: number } {
  return {
    size: 1 + TREE_FIRE_SIZE_VARIANCE * (hash01(pos.x, pos.y, pos.z, 1) * 2 - 1),
    speed: TREE_FIRE_SPEED_MIN + (TREE_FIRE_SPEED_MAX - TREE_FIRE_SPEED_MIN) * hash01(pos.x, pos.y, pos.z, 2),
    phase: hash01(pos.x, pos.y, pos.z, 3),
  }
}

/**
 * Fire-like noise in [-1, 1]: three incommensurate sines (slow sway, mid
 * lick, fast crackle) plus a hashed step that jumps ~8x/s. `seed` 0..1
 * shifts every layer's phase so trees never line up.
 */
export function fireNoise(t: number, seed: number): number {
  const p = seed * 6283.19
  const tt = t * TREE_FIRE_LIGHT_FLICKER_SPEED
  const slow = Math.sin(tt * 1.7 + p)
  const mid = Math.sin(tt * 4.3 + p * 1.3)
  const fast = Math.sin(tt * 11.9 + p * 0.7)
  const step = Math.floor(tt * 8 + seed * 97)
  const crackle = hash01(step, seed * 1000, 7, 99) * 2 - 1
  const n = 0.35 * slow + 0.25 * mid + 0.15 * fast + 0.25 * crackle
  return Math.max(-1, Math.min(1, n))
}

/** Range and intensity multipliers for one light at time t (s). */
export function treeFireLightFlicker(t: number, seed: number): { range: number; intensity: number } {
  return {
    range: 1 + TREE_FIRE_LIGHT_RANGE_FLICKER * fireNoise(t, seed),
    intensity: 1 + TREE_FIRE_LIGHT_INTENSITY_FLICKER * fireNoise(t + 3.71, (seed + 0.5) % 1),
  }
}

/** Whether this tree (by its own world position) is one of the lit subset. Same on every client/reload. */
export function isTreeLit(pos: Vec3, seed: number = 0): boolean {
  // seed 0 reproduces the earlier fixed subset.
  const salt = seed === 0 ? 7 : 1000 + (Math.abs(seed) % 1_000_000)
  return hash01(pos.x, pos.y, pos.z, salt) < TREE_FIRE_LIT_FRACTION
}


/** Number of lit trees for n trees. */
export function treeFireLitCount(n: number): number {
  return Math.max(0, Math.min(n, Math.round(n * TREE_FIRE_LIT_FRACTION)))
}

/**
 * Rank of each point in the seeded rotation order (0..n-1). Stable for the
 * same positions + seed on every client (ties broken by coordinates).
 */
export function treeFireOrder(points: readonly Vec3[], seed: number): number[] {
  const salt = 2000 + (Math.abs(seed) % 1_000_000)
  const keyed = points.map((p, i) => ({ i, k: hash01(p.x, p.y, p.z, salt), p }))
  keyed.sort((a, b) => a.k - b.k || a.p.x - b.p.x || a.p.z - b.p.z || a.p.y - b.p.y)
  const rank = new Array<number>(points.length)
  keyed.forEach((e, r) => { rank[e.i] = r })
  return rank
}

/** Whether the tree at `rank` is lit at swap `step` (window [step, step+lit) mod n). */
export function isRankLit(rank: number, n: number, step: number): boolean {
  if (n <= 0) return false
  const lit = treeFireLitCount(n)
  const start = ((step % n) + n) % n
  const off = (rank - start + n) % n
  return off < lit
}

/** Swap index at `elapsedMs` since the server epoch. */
export function treeFireStepAt(elapsedMs: number): number {
  return Math.floor(Math.max(0, elapsedMs) / (TREE_FIRE_SWAP_SEC * 1000))
}
