/**
 * ghast.ts - Halloween ghasts: tuning knobs + pure math shared by server and
 * client (no engine imports, unit-testable).
 *
 * Paths are deterministic: position = f(index, ms since the server epoch, seed),
 * so the server only sends {seed, elapsedMs} once per joiner (like tree fires)
 * plus charge/fire/impact events. Each ghast orbits the castle centre at its
 * own radius/altitude/speed/direction with slow sinusoidal wobble, flying
 * through anything. Fireball hits are resolved on the server via the bomb
 * explosion code, softened (smaller radius, lighter knockback, short stun,
 * no forced flag drop by default). Ghasts are invulnerable.
 */

export const GHAST_ENABLED = true
/** Number of ghasts (server and client must agree - shared constant). */
export const GHAST_COUNT = 3

// ── Flight: orbit around the castle ──
/** Orbit centre (castle footprint centre). */
export const GHAST_CENTER = { x: 363, z: 347 }
/** Per-ghast base orbit radius is picked in [MIN, MAX]. */
export const GHAST_ORBIT_RADIUS_MIN_M = 50
export const GHAST_ORBIT_RADIUS_MAX_M = 95
/** Radius wobble amplitude (m) and period range (s). */
export const GHAST_ORBIT_RADIUS_WOBBLE_M = 10
export const GHAST_ORBIT_WOBBLE_PERIOD_MIN_S = 25
export const GHAST_ORBIT_WOBBLE_PERIOD_MAX_S = 45
/** Altitude band (world Y). Ground ~50, castle top ~100. Base altitude per ghast sits inside it. */
export const GHAST_ALT_MIN = 80
export const GHAST_ALT_MAX = 110
/** Altitude wobble amplitude (m) and period range (s). */
export const GHAST_ALT_WOBBLE_M = 6
export const GHAST_ALT_WOBBLE_PERIOD_MIN_S = 18
export const GHAST_ALT_WOBBLE_PERIOD_MAX_S = 30
/** Cruise speed along the orbit (m/s), varied ±GHAST_SPEED_VARIANCE per ghast. */
export const GHAST_SPEED = 5
export const GHAST_SPEED_VARIANCE = 0.25
/** Route variety: each ghast gets its own shape (ellipse / trefoil / figure-8),
 *  ellipse ratio (min..1), tilt, and centre offset from the castle centre.
 *  Directions alternate so with 2+ ghasts at least one goes the other way. */
export const GHAST_ROUTE_ELLIPSE_MIN = 0.6
export const GHAST_ROUTE_CENTER_OFFSET_M = 15
export const GHAST_ROUTE_TREFOIL_DEPTH = 0.18
/** Small fast bob on top of the wobble: amplitude (m) and period (s). */
export const GHAST_BOB_M = 1.2
export const GHAST_BOB_PERIOD_S = 3.2
/** Swoops: every so often each ghast dives low (deterministic, still on its
 *  orbit) so players on the ground/walls get a window to hit it. Players can
 *  only reach the 80-110 band from castle tops (~95-105) or updrafts. */
export const GHAST_SWOOP_ENABLED = true
/** Pivot Y at the bottom of a swoop (ground ~50; skull centre ~1.7 m above the pivot). */
export const GHAST_SWOOP_ALT = 54
export const GHAST_SWOOP_PERIOD_MIN_S = 45
export const GHAST_SWOOP_PERIOD_MAX_S = 75
/** Whole dive-and-climb duration (s); the low part is roughly the middle third. */
export const GHAST_SWOOP_DURATION_S = 16

// ── Targeting / firing ──
/** Target the nearest player within this 3D range. */
export const GHAST_RANGE_M = 80
/** Target must be at least this far below the ghast (negative = may be up to that much ABOVE it). */
export const GHAST_MIN_DROP_M = -2
/** Ignore players below this Y (interior level). */
export const GHAST_MIN_TARGET_Y = 40
/** Seconds between shots per ghast (after a shot lands/expires). */
export const GHAST_COOLDOWN_S = 4.5
/** Telegraph: red eyes before firing. */
export const GHAST_TELEGRAPH_S = 0.8
/** Seconds the first shot is delayed after server start, staggered per ghast. */
export const GHAST_FIRST_SHOT_DELAY_S = 10
/** Stop starting shots this many seconds before the round ends. */
export const GHAST_PAUSE_BEFORE_ROUND_END_S = 5
/** Hold fire this long after the round-end splash finishes (respawn cinematic). */
export const GHAST_ROUND_START_GRACE_S = 8

export const GHAST_FIREBALL_SPEED = 20
/** Direct-hit radius around a player's chest (m). */
export const GHAST_FIREBALL_HIT_RADIUS_M = 1.4
/** Lead the target by this many seconds of its velocity (0 = aim at current position). */
export const GHAST_FIREBALL_LEAD_S = 0.3
/** Fireball flies at most this far past the aim point before exploding anyway. */
export const GHAST_FIREBALL_OVERSHOOT_M = 0
/** Visual fireball radius (m). */
export const GHAST_FIREBALL_VISUAL_RADIUS_M = 0.8

// ── Hit (softer than a bomb: bomb = BOMB_EXPLOSION_RADIUS, force 40, 1 s stun, flag drop) ──
/** Explosion radius for ghast fireballs (m). */
export const GHAST_EXPLOSION_RADIUS_M = 4
/** Knockback force (bombs use 40). */
export const GHAST_HIT_KNOCKBACK = 25
/** Stun (input lock) on hit, ms (bombs use BOMB_STAGGER_MS). */
export const GHAST_HIT_STUN_MS = 1000
/** Force the carrier to drop the flag on a hit (bombs always do). */
export const GHAST_HIT_DROPS_FLAG = false
/** Fireballs also kill ghosts / pop bananas in the radius, like bombs. */
export const GHAST_HIT_AFFECTS_TRAPS = true

/** Fireball explosions reuse bombExploded with bombId = -(BASE + fireball id). */
export const GHAST_BOMB_ID_BASE = 1000
export function ghastFireballBombId(fireballId: number): number { return -(GHAST_BOMB_ID_BASE + fireballId) }
export function isGhastFireballBombId(bombId: number): boolean { return bombId <= -GHAST_BOMB_ID_BASE }

// ── Health / death (mirrors ghosts: boomerangs and bananas deal 1, bombs kill) ──
/** Hits to kill (ghosts take 2; ghasts are rarely in reach, so 1). */
export const GHAST_HP = 1
/** Hit sphere: centre this far above the pivot (the GLB origin is the skull's base), radius. */
export const GHAST_BODY_CENTER_Y = 1.7
export const GHAST_BODY_RADIUS_M = 2.0
/** Boomerang hits when its centre is within this of the body centre (ghost: PROJECTILE_HIT_RADIUS 2). */
export const GHAST_BOOMERANG_HIT_RADIUS_M = 3.0
/** A banana touching the body (ghost: TRAP_TRIGGER_RADIUS 2 to a point). */
export const GHAST_BANANA_HIT_RADIUS_M = 2.5
/** Bomb blasts reach the body surface: BOMB_EXPLOSION_RADIUS + this. */
export const GHAST_BOMB_EXTRA_RADIUS_M = GHAST_BODY_RADIUS_M
/** Seconds dead before it pops back in on its orbit. */
export const GHAST_RESPAWN_S = 5
/** Death: sink from the death point to this Y while spinning, shrinking at the end. */
export const GHAST_DEATH_SINK_S = 2.5
export const GHAST_DEATH_SINK_TO_Y = 38
export const GHAST_DEATH_SPIN_DEG_S = 540
export const GHAST_RESPAWN_FADE_S = 0.6
/** Per-ghast re-hit guard for one boomerang pass (ghost: 500 ms). */
export const GHAST_HIT_COOLDOWN_MS = 500

// ── Model ──
/** Names of the Creator Hub template entities (GLB src is read from them at runtime). */
export const GHAST_IDLE_TEMPLATE_NAME = 'Skull 01' // skull_01, no red eyes
export const GHAST_CHARGE_TEMPLATE_NAME = 'Skull 02_2' // skull_02, red emissive eyes
/** Fallback GLBs if the templates are missing. */
export const GHAST_IDLE_FALLBACK_SRC = 'assets/asset-packs/skull_01/HWN20_Skull_01.glb'
export const GHAST_CHARGE_FALLBACK_SRC = 'assets/asset-packs/skull_02/HWN20_Skull_02.glb'
/** Hide the template skulls (client-local) so only the flying copies show. */
export const GHAST_HIDE_TEMPLATES = true
/** Uniform model scale (skull GLB is ~0.25 m tall). */
export const GHAST_MODEL_SCALE = 14
/** Yaw offset so the face points along travel/aim. The GLB root node rotates
 *  the mesh's -X face by +90° about Y, so the model faces +Z = yaw 0. */
export const GHAST_MODEL_YAW_OFFSET_DEG = 0
/** Turn rate toward the facing target (deg/s). */
export const GHAST_TURN_DEG_S = 120
/** Red point light while charging (desktop only). */
export const GHAST_CHARGE_LIGHT = true

// ── Sounds (placeholders generated by script, assets/sounds/ghast/) ──
export const GHAST_SFX_MOAN = 'assets/sounds/ghast/ghast_moan.mp3'
export const GHAST_SFX_CHARGE = 'assets/sounds/ghast/ghast_charge.mp3'
export const GHAST_SFX_FIRE = 'assets/sounds/ghast/ghast_fire.mp3'
export const GHAST_SFX_IMPACT = 'assets/sounds/ghast/ghast_impact.mp3'
export const GHAST_SFX_DEATH = 'assets/sounds/ghast/ghast_death.mp3'
export const GHAST_DEATH_VOLUME = 1
export const GHAST_MOAN_VOLUME = 0.35
export const GHAST_CHARGE_VOLUME = 0.8
export const GHAST_FIRE_VOLUME = 0.9
export const GHAST_IMPACT_VOLUME = 0.9
/** Seconds between moans per ghast (random in range, deterministic per ghast). */
export const GHAST_MOAN_INTERVAL_MIN_S = 7
export const GHAST_MOAN_INTERVAL_MAX_S = 14
/** Only the nearest N ghasts within GHAST_MOAN_MAX_DIST_M moan. */
export const GHAST_MOAN_NEAREST = 2
export const GHAST_MOAN_MAX_DIST_M = 80

// ── Sync / mouth ──
/** Fireball origin relative to the ghast root, in the ghast's facing frame
 *  (+Z = face). The skull GLB's origin is at the BOTTOM of the skull, not its
 *  centre: mesh ~0.24 m tall x 0.18 m front, so at scale 14 the mouth sits
 *  ~0.8 m up and ~2.2 m forward of the pivot. */
export const GHAST_MOUTH_OFFSET = { x: 0, y: 0.8, z: 2.2 }
/** Client fireball visual starts at its own rendered mouth and blends onto the
 *  server trajectory over this many seconds. */
export const GHAST_FIREBALL_BLEND_S = 0.3
/** Re-send requestGhastSync this often until a reply (first one can be lost). */
export const GHAST_SYNC_RETRY_S = 3
export const GHAST_SYNC_MAX_RETRIES = 20
/** Clock: snap if the estimate is off by more than this, else slew at SLEW ms/s. */
export const GHAST_CLOCK_SNAP_MS = 1500
export const GHAST_CLOCK_SLEW_MS_PER_S = 250
/** Min-latency estimator relaxes upward this fast (handles clock drift). */
export const GHAST_CLOCK_RELAX_MS_PER_S = 5

export interface V3 { x: number; y: number; z: number }

/** Deterministic 0..1 hash of (a, b) integers. */
export function ghastHash(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x9e3779b9, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

export type GhastRouteShape = 'ellipse' | 'trefoil' | 'figure8'
export const GHAST_ROUTE_SHAPES: readonly GhastRouteShape[] = ['ellipse', 'trefoil', 'figure8']

export interface OrbitParams {
  shape: GhastRouteShape
  /** Route centre (castle centre + per-ghast offset). */
  cx: number; cz: number
  /** Semi-major radius, minor/major ratio, ellipse tilt (rad). */
  r: number; q: number; tilt: number
  /** Angular rate (rad/s, sign = direction) and start angle. */
  w: number; a0: number
  /** Radius wobble rate/phase, trefoil lobe phase. */
  rw: number; rp: number; lp: number
  /** Altitude, its wobble rate/phase, bob phase. */
  alt: number; aw: number; ap: number; bp: number
}

const TAU = Math.PI * 2
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Seeded permutation of 0..n-1 (distinct slot per ghast for one attribute). */
function shuffled(n: number, seed: number, k: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i)
  return idx.map((i) => ({ i, key: ghastHash(seed * 7 + k, i) })).sort((a, b) => a.key - b.key).map((e) => e.i)
}

/** Centre of slot `s` of `n` across [lo, hi], with a little jitter. */
function slotValue(s: number, n: number, lo: number, hi: number, jitter01: number): number {
  return lerp(lo, hi, n <= 1 ? 0.5 : (s + 0.25 + 0.5 * jitter01) / n)
}

/**
 * Per-ghast route. Every attribute that matters visually is stratified so
 * ghasts are guaranteed distinct (not just "random and probably different"):
 * each gets its own radius slot, altitude slot, speed slot and route shape
 * (seeded permutations), directions alternate (so with 2+ ghasts at least one
 * goes the opposite way), start angles are spread evenly, and each route has
 * its own ellipse ratio, tilt and centre offset so the loops cross but differ.
 */
export function ghastOrbitParams(i: number, seed: number): OrbitParams {
  const n = Math.max(1, GHAST_COUNT)
  const h = (k: number) => ghastHash(seed + i * 101, k)
  const g = (k: number) => ghastHash(seed, 1000 + k) // seed-wide (same for all ghasts)
  const rSlot = shuffled(n, seed, 1)[i % n]
  const aSlot = shuffled(n, seed, 2)[i % n]
  const vSlot = shuffled(n, seed, 3)[i % n]
  const shape = GHAST_ROUTE_SHAPES[(i + Math.floor(g(4) * GHAST_ROUTE_SHAPES.length)) % GHAST_ROUTE_SHAPES.length]
  const r = slotValue(rSlot, n, GHAST_ORBIT_RADIUS_MIN_M, GHAST_ORBIT_RADIUS_MAX_M, h(1))
  const q = lerp(GHAST_ROUTE_ELLIPSE_MIN, 1, h(2))
  const speed = GHAST_SPEED * slotValue(vSlot, n, 1 - GHAST_SPEED_VARIANCE, 1 + GHAST_SPEED_VARIANCE, h(3))
  const dir = (i % 2 === 0 ? 1 : -1) * (g(5) < 0.5 ? 1 : -1)
  // Mean radius of the path so `speed` is roughly the real m/s.
  const meanR = r * (1 + q) / 2 * (shape === 'figure8' ? 1.25 : 1)
  const offA = h(6) * TAU, offR = GHAST_ROUTE_CENTER_OFFSET_M * Math.sqrt(h(7))
  const altLo = GHAST_ALT_MIN + GHAST_ALT_WOBBLE_M + GHAST_BOB_M
  const altHi = GHAST_ALT_MAX - GHAST_ALT_WOBBLE_M - GHAST_BOB_M
  return {
    shape,
    cx: GHAST_CENTER.x + offR * Math.cos(offA),
    cz: GHAST_CENTER.z + offR * Math.sin(offA),
    r, q,
    tilt: (i / n) * Math.PI + h(8) * 0.6,
    w: (dir * speed) / meanR,
    a0: g(9) * TAU + (TAU * i) / n + (h(10) - 0.5) * 0.4,
    rw: TAU / lerp(GHAST_ORBIT_WOBBLE_PERIOD_MIN_S, GHAST_ORBIT_WOBBLE_PERIOD_MAX_S, h(11)),
    rp: h(12) * TAU,
    lp: h(13) * TAU,
    alt: slotValue(aSlot, n, altLo, altHi, h(14)),
    aw: TAU / lerp(GHAST_ALT_WOBBLE_PERIOD_MIN_S, GHAST_ALT_WOBBLE_PERIOD_MAX_S, h(15)),
    ap: h(16) * TAU,
    bp: h(17) * TAU,
  }
}

/** Farthest any route point can be from GHAST_CENTER (m). */
export const GHAST_ROUTE_MAX_EXTENT_M =
  GHAST_ROUTE_CENTER_OFFSET_M + (GHAST_ORBIT_RADIUS_MAX_M + GHAST_ORBIT_RADIUS_WOBBLE_M) * (1 + GHAST_ROUTE_TREFOIL_DEPTH)

/** World position of ghast `i` at `tMs` since the epoch (fly through anything). */
export function ghastPosAt(i: number, tMs: number, seed: number): V3 {
  const P = ghastOrbitParams(i, seed)
  const t = tMs / 1000
  const a = P.a0 + P.w * t
  let R = P.r + GHAST_ORBIT_RADIUS_WOBBLE_M * Math.sin(P.rw * t + P.rp)
  let lx: number, lz: number
  if (P.shape === 'figure8') {
    lx = R * Math.cos(a)
    lz = R * P.q * Math.sin(2 * a) * 0.7
  } else {
    if (P.shape === 'trefoil') R *= 1 + GHAST_ROUTE_TREFOIL_DEPTH * Math.sin(3 * a + P.lp)
    lx = R * Math.cos(a)
    lz = R * P.q * Math.sin(a)
  }
  const c = Math.cos(P.tilt), s = Math.sin(P.tilt)
  const y = P.alt + GHAST_ALT_WOBBLE_M * Math.sin(P.aw * t + P.ap) + GHAST_BOB_M * Math.sin((TAU * t) / GHAST_BOB_PERIOD_S + P.bp)
  const k = ghastSwoopAt(i, tMs, seed)
  const yy = k > 0 ? y + (GHAST_SWOOP_ALT - y) * k : y
  return { x: P.cx + lx * c - lz * s, y: yy, z: P.cz + lx * s + lz * c }
}

/** Facing yaw (deg) along ghast `i`'s own velocity at `tMs`. */
export function ghastTravelYaw(i: number, tMs: number, seed: number): number {
  return yawToward(ghastPosAt(i, tMs - 250, seed), ghastPosAt(i, tMs + 250, seed))
}

/** Swoop depth 0..1 (sin² bump over GHAST_SWOOP_DURATION_S, once per per-ghast period). */
export function ghastSwoopAt(i: number, tMs: number, seed: number): number {
  if (!GHAST_SWOOP_ENABLED) return 0
  const period = lerp(GHAST_SWOOP_PERIOD_MIN_S, GHAST_SWOOP_PERIOD_MAX_S, ghastHash(seed + i * 101, 30)) * 1000
  const off = ghastHash(seed + i * 101, 31) * period
  const u = ((((tMs - off) % period) + period) % period) / (GHAST_SWOOP_DURATION_S * 1000)
  if (u >= 1) return 0
  const s = Math.sin(Math.PI * u)
  return s * s
}

/** Centre of the hit sphere for a ghast whose pivot is at `p`. */
export function ghastBodyCenter(p: V3): V3 { return { x: p.x, y: p.y + GHAST_BODY_CENTER_Y, z: p.z } }

/** True if point `q` is within `radius` of the body centre of a ghast at pivot `p`. */
export function ghastBodyHit(p: V3, q: V3, radius: number): boolean {
  const c = ghastBodyCenter(p)
  const dx = q.x - c.x, dy = q.y - c.y, dz = q.z - c.z
  return dx * dx + dy * dy + dz * dz < radius * radius
}

export type GhastLife = 'alive' | 'dying' | 'dead' | 'respawning'

/** Life phase at elapsed `tMs` given death/respawn times (elapsed ms; diedAt < 0 = never). */
export function ghastLifeAt(tMs: number, diedAt: number, respawnAt: number): GhastLife {
  if (diedAt < 0 || tMs < diedAt) return 'alive'
  if (tMs < respawnAt) return tMs < diedAt + GHAST_DEATH_SINK_S * 1000 ? 'dying' : 'dead'
  return tMs < respawnAt + GHAST_RESPAWN_FADE_S * 1000 ? 'respawning' : 'alive'
}

/** Death pose `msSince` after death: sink fraction (eased), extra spin, scale. */
export function ghastDeathPose(msSince: number): { sink: number; spinDeg: number; scale: number } {
  const u = Math.max(0, Math.min(1, msSince / (GHAST_DEATH_SINK_S * 1000)))
  return {
    sink: u * u,
    spinDeg: (GHAST_DEATH_SPIN_DEG_S * Math.max(0, msSince)) / 1000 * (0.4 + 0.6 * u),
    scale: u < 0.6 ? 1 : Math.max(0, 1 - (u - 0.6) / 0.4),
  }
}

/** Pop-in scale `msSince` after respawn (ease-out back to 1). */
export function ghastRespawnScale(msSince: number): number {
  const u = Math.max(0, Math.min(1, msSince / (GHAST_RESPAWN_FADE_S * 1000)))
  return 1 - (1 - u) * (1 - u)
}

/** Countdown fields the firing gate needs (subset of CountdownTimer). */
export interface RoundTimerLike { roundEndTimeMs: number; roundEndTriggered: boolean; roundEndDisplayUntilMs: number }

/** Ghasts only start shots during an active round: not in the round-end
 *  splash, the post-splash grace (respawn cinematic), or the last seconds. */
export function ghastFiringAllowed(nowMs: number, timer: RoundTimerLike | null): boolean {
  if (!timer) return false
  if (timer.roundEndTriggered) return false
  if (timer.roundEndDisplayUntilMs > 0 && nowMs < timer.roundEndDisplayUntilMs + GHAST_ROUND_START_GRACE_S * 1000) return false
  if (timer.roundEndTimeMs > 0 && timer.roundEndTimeMs - nowMs < GHAST_PAUSE_BEFORE_ROUND_END_S * 1000) return false
  return true
}

/** Moan schedule: true if ghast `i` starts a moan in (prevMs, tMs]. */
export function ghastMoanDue(i: number, prevMs: number, tMs: number, seed: number): boolean {
  const lo = GHAST_MOAN_INTERVAL_MIN_S * 1000, hi = GHAST_MOAN_INTERVAL_MAX_S * 1000
  const period = lerp(lo, hi, ghastHash(seed + i * 101, 20))
  const off = ghastHash(seed + i * 101, 21) * period
  return Math.floor((tMs - off) / period) > Math.floor((prevMs - off) / period)
}

/** Yaw (deg) that faces from `from` toward `to` (atan2(dx, dz), DCL convention). */
export function yawToward(from: V3, to: V3): number {
  return (Math.atan2(to.x - from.x, to.z - from.z) * 180) / Math.PI
}

/** Step `cur` toward `target` yaw by at most `maxDeg`, shortest way round. */
export function turnToward(cur: number, target: number, maxDeg: number): number {
  let d = ((target - cur + 540) % 360) - 180
  if (d > maxDeg) d = maxDeg
  if (d < -maxDeg) d = -maxDeg
  return cur + d
}

export interface TargetCandidate { id: string; pos: V3 }

/** Nearest eligible player for a ghast at `g`, or null. */
export function pickGhastTarget(g: V3, players: readonly TargetCandidate[]): TargetCandidate | null {
  let best: TargetCandidate | null = null
  let bestD = GHAST_RANGE_M * GHAST_RANGE_M
  for (const p of players) {
    if (p.pos.y < GHAST_MIN_TARGET_Y) continue
    if (g.y - p.pos.y < GHAST_MIN_DROP_M) continue
    const dx = p.pos.x - g.x, dy = p.pos.y - g.y, dz = p.pos.z - g.z
    const d = dx * dx + dy * dy + dz * dz
    if (d <= bestD) { bestD = d; best = p }
  }
  return best
}

/** Aim point: target position + lead * velocity. */
export function ghastAim(pos: V3, vel: V3 | null, leadS: number = GHAST_FIREBALL_LEAD_S): V3 {
  if (!vel || leadS <= 0) return { ...pos }
  return { x: pos.x + vel.x * leadS, y: pos.y + vel.y * leadS, z: pos.z + vel.z * leadS }
}

export interface FireballLaunch { start: V3; dir: V3; dist: number }

/** Launch from ghast `g` toward `aim`: unit direction and distance to impact. */
export function fireballLaunch(g: V3, aim: V3): FireballLaunch {
  const dx = aim.x - g.x, dy = aim.y - g.y, dz = aim.z - g.z
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
  return { start: { ...g }, dir: { x: dx / d, y: dy / d, z: dz / d }, dist: d + GHAST_FIREBALL_OVERSHOOT_M }
}

/** Fireball position after `tS` seconds of flight (clamped to the impact point). */
export function fireballPosAt(l: FireballLaunch, tS: number, speed: number = GHAST_FIREBALL_SPEED): V3 {
  const s = Math.min(l.dist, Math.max(0, tS) * speed)
  return { x: l.start.x + l.dir.x * s, y: l.start.y + l.dir.y * s, z: l.start.z + l.dir.z * s }
}

/** Squared distance from point p to segment ab (for swept hit tests between ticks). */
export function segPointDist2(a: V3, b: V3, p: V3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z
  const L = abx * abx + aby * aby + abz * abz
  const t = L > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / L)) : 0
  const cx = a.x + abx * t - p.x, cy = a.y + aby * t - p.y, cz = a.z + abz * t - p.z
  return cx * cx + cy * cy + cz * cz
}

/** World position of the mouth for a ghast root at `p` facing `yawDeg`. */
export function ghastMouthPos(p: V3, yawDeg: number, off: V3 = GHAST_MOUTH_OFFSET): V3 {
  const r = (yawDeg * Math.PI) / 180
  const c = Math.cos(r), s = Math.sin(r)
  // DCL yaw: local +Z maps to (sin, 0, cos).
  return { x: p.x + off.x * c + off.z * s, y: p.y + off.y, z: p.z - off.x * s + off.z * c }
}

/** Remaining fraction (1 -> 0, smoothstep) of the client-mouth offset at flight time tS. */
export function fireballBlend(tS: number, blendS: number = GHAST_FIREBALL_BLEND_S): number {
  if (blendS <= 0 || tS >= blendS) return 0
  if (tS <= 0) return 1
  const u = tS / blendS
  return 1 - u * u * (3 - 2 * u)
}

/**
 * Client estimate of the server's ghast epoch in the client's own Date.now()
 * domain. Every server message carrying its elapsed ms gives a sample
 * `localNow - serverElapsed` = true epoch + one-way latency, so the minimum
 * sample is the best estimate (relaxed upward slowly for drift). The rendered
 * epoch slews toward it so ghasts never jump, except for big errors (snap).
 */
export class GhastClock {
  epoch: number | null = null
  private target: number | null = null

  sample(localNowMs: number, serverElapsedMs: number): void {
    const s = localNowMs - serverElapsedMs
    this.target = this.target === null ? s : Math.min(this.target, s)
    if (this.epoch === null || Math.abs(this.epoch - this.target) > GHAST_CLOCK_SNAP_MS) this.epoch = this.target
  }

  /** Hard reset (new seed / server restart). */
  reset(localNowMs: number, serverElapsedMs: number): void {
    this.target = this.epoch = localNowMs - serverElapsedMs
  }

  tick(dtS: number): void {
    if (this.target === null || this.epoch === null) return
    this.target += GHAST_CLOCK_RELAX_MS_PER_S * dtS
    const d = this.target - this.epoch
    const step = GHAST_CLOCK_SLEW_MS_PER_S * dtS
    this.epoch += Math.abs(d) <= step ? d : Math.sign(d) * step
  }

  elapsed(localNowMs: number): number { return this.epoch === null ? 0 : localNowMs - this.epoch }
}
