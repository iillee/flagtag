/**
 * ghastServer.ts - authoritative ghast AI (Halloween).
 *
 * Ghast positions are a pure function of (index, ms since epoch, seed) - see
 * shared/ghast.ts - so nothing is streamed. The server picks targets, runs the
 * telegraph/cooldown, simulates fireballs, and on impact calls the bomb
 * explosion (explodeAtPosition) with the softer ghast settings (radius, no
 * forced flag drop); clients apply the lighter knockback/stun for ghast ids.
 * Shots only start during an active round (ghastFiringAllowed).
 *
 * Ghasts can be killed like ghosts: boomerangs (checked here against the
 * computed body sphere) and bananas deal 1 damage, bomb blasts kill (both via
 * ghastHitHook from combat.ts). A dead ghast sinks, then respawns after
 * GHAST_RESPAWN_S at its current orbit point; dead ghasts don't fire or get hit.
 *
 * Messages: ghastSync (reply to requestGhastSync, includes dead state),
 * ghastCharge, ghastFire, ghastFireballEnd, ghastKilled.
 */
import { Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { room } from '../shared/messages'
import { HALLOWEEN_MODE } from '../shared/dayNight'
import { CountdownTimer } from '../shared/components'
import {
  GHAST_ENABLED, GHAST_COUNT, GHAST_COOLDOWN_S, GHAST_TELEGRAPH_S, GHAST_FIRST_SHOT_DELAY_S,
  GHAST_FIREBALL_SPEED, GHAST_FIREBALL_HIT_RADIUS_M, GHAST_RANGE_M,
  GHAST_EXPLOSION_RADIUS_M, GHAST_HIT_DROPS_FLAG, GHAST_HIT_AFFECTS_TRAPS,
  ghastPosAt, pickGhastTarget, ghastAim, fireballLaunch, fireballPosAt, segPointDist2,
  ghastFireballBombId, ghastFiringAllowed, ghastMouthPos, yawToward, ghastBodyCenter, ghastBodyHit,
  GHAST_HP, GHAST_RESPAWN_S, GHAST_BOOMERANG_HIT_RADIUS_M, GHAST_HIT_COOLDOWN_MS,
  type FireballLaunch, type TargetCandidate, type V3,
} from '../shared/ghast'
import { getActivePlayerAddresses, getPlayerPosition, countdownEntity } from './serverState'
import { explodeAtPosition, activeProjectiles } from './combat'
import { PROJECTILE_HIT_RADIUS } from '../shared/constants'
import { setGhastHitHandler, type GhastHitCause } from './ghastHitHook'

/** Player chest height above the reported (feet) position. */
const CHEST_Y = 1.0
/** Target re-check interval while idle (s). */
const SCAN_S = 0.5

const seed = 1 + Math.floor(Math.random() * 999_999)
const epochMs = Date.now()

interface GhastState { cooldown: number; charging: number; target: string; aim: V3; hp: number; diedAt: number; respawnAt: number; lastHitMs: number }
interface Fireball { id: number; g: number; launch: FireballLaunch; t: number; last: V3 }

const ghasts: GhastState[] = Array.from({ length: GHAST_COUNT }, (_, i) => ({
  cooldown: GHAST_FIRST_SHOT_DELAY_S + i * (GHAST_COOLDOWN_S / GHAST_COUNT),
  charging: -1, target: '', aim: { x: 0, y: 0, z: 0 },
  hp: GHAST_HP, diedAt: -1, respawnAt: 0, lastHitMs: 0,
}))
const fireballs: Fireball[] = []
let nextFireballId = 1
let scanIn = 0
let wasAllowed = false
const lastPos = new Map<string, { p: V3; ms: number }>()
const velocity = new Map<string, V3>()

function enabled(): boolean { return GHAST_ENABLED && HALLOWEEN_MODE }

function elapsed(): number { return Date.now() - epochMs }

function firingAllowed(now: number): boolean {
  try {
    return ghastFiringAllowed(now, countdownEntity !== undefined ? CountdownTimer.getOrNull(countdownEntity) : null)
  } catch { return false }
}

function alive(i: number, tMs: number): boolean { return tMs >= ghasts[i].respawnAt }

function clampT(t: number): number { return Math.min(2_000_000_000, Math.max(0, Math.round(t))) }

function killGhast(i: number, killer: string, cause: GhastHitCause): void {
  const g = ghasts[i]
  const tMs = elapsed()
  const p = ghastPosAt(i, tMs, seed)
  g.charging = -1
  g.hp = 0
  g.diedAt = tMs
  g.respawnAt = tMs + GHAST_RESPAWN_S * 1000
  g.cooldown = GHAST_COOLDOWN_S
  room.send('ghastKilled', { g: i, killer, cause, seed, t: clampT(tMs), respawnT: clampT(g.respawnAt), x: p.x, y: p.y, z: p.z })
  console.log(`[Server] 👻💀 Ghast ${i} killed by ${cause}${killer ? ' (' + killer.slice(0, 8) + ')' : ''}, respawn in ${GHAST_RESPAWN_S}s`)
}

/** Damage live ghasts whose body centre is within `radius` of `pos`. */
function hitGhastsAt(pos: V3, radius: number, killer: string, cause: GhastHitCause, kill: boolean): number {
  if (!enabled()) return 0
  const tMs = elapsed()
  let hits = 0
  for (let i = 0; i < ghasts.length; i++) {
    if (!alive(i, tMs)) continue
    const p = ghastPosAt(i, tMs, seed)
    if (!ghastBodyHit(p, pos, radius)) continue
    hits++
    const g = ghasts[i]
    g.hp = kill ? 0 : g.hp - 1
    g.lastHitMs = Date.now()
    if (g.hp <= 0) killGhast(i, killer, cause)
    else { const c = ghastBodyCenter(p); room.send('hitVfx', { x: c.x, y: c.y, z: c.z }) }
  }
  return hits
}

/** Boomerangs vs ghasts - mirrors the ghost check in ghostSystem (hit + rebound). */
function checkBoomerangs(tMs: number): void {
  if (activeProjectiles.length === 0) return
  const now = Date.now()
  for (const proj of activeProjectiles) {
    const projPos = Transform.get(proj.entity).position
    const r = GHAST_BOOMERANG_HIT_RADIUS_M + PROJECTILE_HIT_RADIUS * Math.max(0, (proj.chargeScale || 1) - 1)
    for (let i = 0; i < ghasts.length; i++) {
      const g = ghasts[i]
      if (!alive(i, tMs) || now - g.lastHitMs < GHAST_HIT_COOLDOWN_MS) continue
      if (!ghastBodyHit(ghastPosAt(i, tMs, seed), projPos, r)) continue
      g.lastHitMs = now
      g.hp--
      if (g.hp <= 0) killGhast(i, proj.firedBy, 'boomerang')
      else { const c = ghastBodyCenter(ghastPosAt(i, tMs, seed)); room.send('hitVfx', { x: c.x, y: c.y, z: c.z }) }
      if (!proj.returning) {
        proj.returning = true
        proj.returnX = projPos.x
        proj.returnY = projPos.y
        proj.returnZ = projPos.z
        room.send('shellTriggered', { x: projPos.x, y: projPos.y, z: projPos.z, victimId: '', peak: true, firedBy: proj.firedBy, shellId: proj.shellId })
      }
      break
    }
  }
}

function candidates(): TargetCandidate[] {
  const out: TargetCandidate[] = []
  const now = Date.now()
  for (const addr of getActivePlayerAddresses()) {
    const p = getPlayerPosition(addr)
    if (!p) continue
    const prev = lastPos.get(addr)
    if (prev && now > prev.ms) {
      const k = 1000 / (now - prev.ms)
      velocity.set(addr, { x: (p.x - prev.p.x) * k, y: (p.y - prev.p.y) * k, z: (p.z - prev.p.z) * k })
    }
    lastPos.set(addr, { p: { x: p.x, y: p.y, z: p.z }, ms: now })
    out.push({ id: addr, pos: { x: p.x, y: p.y, z: p.z } })
  }
  return out
}

function startCharge(i: number, target: TargetCandidate): void {
  const g = ghasts[i]
  g.charging = GHAST_TELEGRAPH_S
  g.target = target.id
  g.aim = { x: target.pos.x, y: target.pos.y + CHEST_Y * 0.5, z: target.pos.z }
  // seed + t (server elapsed) let clients re-sync their path clock on every event.
  room.send('ghastCharge', { g: i, x: g.aim.x, y: g.aim.y, z: g.aim.z, seed, t: Math.min(2_000_000_000, elapsed()) })
}

function fire(i: number): void {
  const g = ghasts[i]
  g.charging = -1
  g.cooldown = GHAST_COOLDOWN_S
  // Re-aim at the target's current position (+ optional lead); fall back to the telegraph aim.
  const p = getPlayerPosition(g.target)
  const aim = p ? ghastAim({ x: p.x, y: p.y + CHEST_Y * 0.5, z: p.z }, velocity.get(g.target) ?? null) : g.aim
  const tMs = elapsed()
  const body = ghastPosAt(i, tMs, seed)
  // Leave from the mouth (the GLB pivot is at the skull's base), facing the aim.
  const from = ghastMouthPos(body, yawToward(body, aim))
  const launch = fireballLaunch(from, aim)
  if (launch.dist > GHAST_RANGE_M * 1.5) return
  const id = nextFireballId++
  fireballs.push({ id, g: i, launch, t: 0, last: { ...launch.start } })
  room.send('ghastFire', {
    g: i, id,
    sx: launch.start.x, sy: launch.start.y, sz: launch.start.z,
    dx: launch.dir.x, dy: launch.dir.y, dz: launch.dir.z,
    speed: GHAST_FIREBALL_SPEED, dist: launch.dist,
    seed, t: Math.min(2_000_000_000, tMs),
  })
}

function endFireball(idx: number, at: V3): void {
  const fb = fireballs[idx]
  fireballs.splice(idx, 1)
  room.send('ghastFireballEnd', { id: fb.id, x: at.x, y: at.y, z: at.z })
  // Bomb explosion path with the softer ghast settings (clients key the
  // lighter knockback/stun off the ghast bombId range).
  explodeAtPosition(Vector3.create(at.x, at.y, at.z), ghastFireballBombId(fb.id), 'ghast fireball', {
    radius: GHAST_EXPLOSION_RADIUS_M,
    dropFlag: GHAST_HIT_DROPS_FLAG,
    affectsTraps: GHAST_HIT_AFFECTS_TRAPS,
    killsGhasts: false,
  })
}

export function ghastServerSystem(dt: number): void {
  if (!enabled()) return
  const tMs = elapsed()
  const allowed = firingAllowed(Date.now())
  if (allowed !== wasAllowed) {
    wasAllowed = allowed
    console.log('[Server] 👻 Ghast firing', allowed ? 'resumed (round active)' : 'paused (round end / splash / cinematic)')
  }
  scanIn -= dt
  const scan = scanIn <= 0
  if (scan) scanIn = SCAN_S
  const players = scan && allowed ? candidates() : null

  checkBoomerangs(tMs)

  for (let i = 0; i < ghasts.length; i++) {
    const g = ghasts[i]
    if (!alive(i, tMs)) continue
    if (g.diedAt >= 0 && g.hp <= 0) g.hp = GHAST_HP // respawned
    if (g.charging >= 0) {
      // Round ended mid-telegraph: abort the shot (clients' red eyes time out).
      if (!allowed) { g.charging = -1; g.cooldown = GHAST_COOLDOWN_S * 0.5; continue }
      g.charging -= dt
      if (g.charging < 0) fire(i)
      continue
    }
    if (g.cooldown > 0) { g.cooldown -= dt; continue }
    if (!players) continue
    const target = pickGhastTarget(ghastPosAt(i, tMs, seed), players)
    if (target) startCharge(i, target)
  }

  // Fireballs: swept hit test against every player, impact at the aim point.
  const hitR2 = GHAST_FIREBALL_HIT_RADIUS_M * GHAST_FIREBALL_HIT_RADIUS_M
  for (let f = fireballs.length - 1; f >= 0; f--) {
    const fb = fireballs[f]
    fb.t += dt
    const pos = fireballPosAt(fb.launch, fb.t)
    let hit: V3 | null = null
    for (const addr of getActivePlayerAddresses()) {
      const p = getPlayerPosition(addr)
      if (!p) continue
      if (segPointDist2(fb.last, pos, { x: p.x, y: p.y + CHEST_Y, z: p.z }) <= hitR2) { hit = pos; break }
    }
    fb.last = pos
    if (hit) { endFireball(f, hit); continue }
    if (fb.t * GHAST_FIREBALL_SPEED >= fb.launch.dist) endFireball(f, pos)
  }
}

export function registerGhastHandlers(): void {
  setGhastHitHandler(hitGhastsAt)
  room.onMessage('requestGhastSync', (_data, context) => {
    try {
      const to = context ? { to: [context.from] } : undefined
      const tMs = elapsed()
      // [index, diedAt, respawnAt, x, y, z] for ghasts still dying/dead (elapsed ms).
      const dead = ghasts.map((g, i) => ({ g, i })).filter(({ i }) => !alive(i, tMs)).map(({ g, i }) => {
        const p = ghastPosAt(i, g.diedAt, seed)
        return [i, g.diedAt, g.respawnAt, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)]
      })
      room.send('ghastSync', { seed, elapsedMs: clampT(tMs), enabled: enabled() ? 1 : 0, deadJson: JSON.stringify(dead) }, to)
    } catch (err) { console.error('[Server] ❌ requestGhastSync handler error:', err) }
  })
  console.log('[Server] 👻 Ghasts', enabled() ? `enabled (${GHAST_COUNT}, seed ${seed})` : 'disabled')
}
