/**
 * combat.ts — Traps (bananas), projectiles (boomerangs), and green orbit attacks.
 * Handles placement, movement, collision detection, and cleanup.
 */

import { engine, Transform, PlayerIdentityData, type Entity } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import {
  Flag, FlagState,
  TRAP_LIFETIME_SEC, TRAP_COOLDOWN_SEC, TRAP_MAX_ACTIVE, TRAP_TRIGGER_RADIUS,
  PROJECTILE_LIFETIME_SEC, PROJECTILE_COOLDOWN_SEC, PROJECTILE_MAX_ACTIVE, PROJECTILE_SPEED, PROJECTILE_MAX_RANGE, PROJECTILE_HIT_RADIUS,
  BOMB_FUSE_SEC, BOMB_COOLDOWN_SEC, BOMB_EXPLOSION_RADIUS, BOMB_STAGGER_MS, BOMB_IMPACT_HEIGHT,
  recycleGhostSyncId,
} from '../shared/components'
import { dropFloorY } from '../shared/constants'
import { loadPlayerUpgrades } from './economy'
import { room } from '../shared/messages'
import {
  flagEntity, getPlayerPosition, wasWithinRadius, FLAG_GRAVITY, SCENE_FLOOR_Y,
  activeGhosts, ghostRespawnCooldown, setGhostRespawnCooldown, GHOST_RESPAWN_COOLDOWN,
  sessionBananasDropped, sessionBoomerangsFired, lastStealTime, STEAL_IMMUNITY_MS,
  playerBoomerangColors,
} from './serverState'
import { handleDrop } from './flagLogic'
import { consumePendingMushroomBoost } from './mushroomSystem'
import { canUseBoomerangAbility } from './combatValidation'

// Full combat immunity while the carrier's pickup/steal shield is active.
// Matches STEAL_IMMUNITY_MS so shield visual = actual protection.
// IMPORTANT: only the CURRENT carrier gets combat immunity. A player who
// recently held the flag but lost it must be vulnerable again — otherwise
// they can chase the new carrier through bananas/bombs and re-steal via
// proximity as soon as the new carrier's immunity expires.
function isFlagImmune(playerId: string): boolean {
  const flag = Flag.getOrNull(flagEntity)
  if (!flag || flag.state !== FlagState.Carried || flag.carrierPlayerId !== playerId) return false
  const t = lastStealTime.get(playerId) ?? 0
  return Date.now() - t < STEAL_IMMUNITY_MS
}

// Force-drop the flag from a combat victim, isolated so a flag-logic error can't
// abort the calling combat system mid-loop (which would freeze every active
// projectile/trap/bomb for the rest of the frame — and repeat every frame).
function safeForceDrop(addr: string): void {
  try {
    handleDrop(addr, true)
  } catch (err) {
    console.error('[Server] ❌ forced flag drop failed for', addr.slice(0, 8), err)
  }
}

// ══════════════════════════════════════════════════════════════════════
// SERVER ENTITY POOLS
// Pre-create a fixed set of entities at startup. Reuse by toggling
// position between active and hidden. ZERO entity create/destroy
// during gameplay = zero CRDT tombstone accumulation.
// ══════════════════════════════════════════════════════════════════════

const SERVER_HIDDEN_POS = Vector3.create(0, -500, 0)

// ── Trap entity pool ──
const TRAP_POOL_SIZE = 40  // matches sync ID pool size
const trapEntityPool: Entity[] = []
let trapPoolReady = false

function initTrapEntityPool(): void {
  if (trapPoolReady) return
  trapPoolReady = true
  for (let i = 0; i < TRAP_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: SERVER_HIDDEN_POS, scale: Vector3.create(1, 1, 1) })
    trapEntityPool.push(e)
  }
  console.log('[Server] 🪤 Pre-created trap entity pool of', TRAP_POOL_SIZE)
}

function acquireTrapEntity(): Entity | null {
  initTrapEntityPool()
  // Find entity not currently in use (check against activeTraps)
  const inUse = new Set(activeTraps.map(t => t.entity))
  for (let idx = 0; idx < trapEntityPool.length; idx++) {
    let e = trapEntityPool[idx]
    if (inUse.has(e)) continue
    // Self-heal: a pooled entity can lose its Transform when the engine recycles
    // its slot (same stale-entity class as the ghost-trap/hold-time bugs).
    // Handing it out would make Transform.getMutable throw — replace it instead.
    if (!Transform.has(e)) {
      e = engine.addEntity()
      Transform.create(e, { position: SERVER_HIDDEN_POS, scale: Vector3.create(1, 1, 1) })
      trapEntityPool[idx] = e
      console.log('[Server] 🪤⚠️ Replaced dead trap pool entity at slot', idx)
    }
    return e
  }
  console.error('[Server] 🪤 Trap entity pool exhausted!')
  return null
}

function releaseTrapEntity(entity: Entity): void {
  // getMutableOrNull: the entity may have died while active (stale slot) —
  // a throw here would leave the item stuck in its active list forever.
  const t = Transform.getMutableOrNull(entity)
  if (t) t.position = SERVER_HIDDEN_POS
}

// ── Projectile entity pool ──
const PROJECTILE_POOL_SIZE = 30  // matches sync ID pool size
const projectileEntityPool: Entity[] = []
let projectilePoolReady = false

function initProjectileEntityPool(): void {
  if (projectilePoolReady) return
  projectilePoolReady = true
  for (let i = 0; i < PROJECTILE_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: SERVER_HIDDEN_POS, scale: Vector3.create(1, 1, 1) })
    projectileEntityPool.push(e)
  }
  console.log('[Server] 🎯 Pre-created projectile entity pool of', PROJECTILE_POOL_SIZE)
}

function acquireProjectileEntity(): Entity | null {
  initProjectileEntityPool()
  const inUse = new Set(activeProjectiles.map(p => p.entity))
  for (let idx = 0; idx < projectileEntityPool.length; idx++) {
    let e = projectileEntityPool[idx]
    if (inUse.has(e)) continue
    // Self-heal dead pool slots (see acquireTrapEntity)
    if (!Transform.has(e)) {
      e = engine.addEntity()
      Transform.create(e, { position: SERVER_HIDDEN_POS, scale: Vector3.create(1, 1, 1) })
      projectileEntityPool[idx] = e
      console.log('[Server] 🎯⚠️ Replaced dead projectile pool entity at slot', idx)
    }
    return e
  }
  console.error('[Server] 🎯 Projectile entity pool exhausted!')
  return null
}

function releaseProjectileEntity(entity: Entity): void {
  const t = Transform.getMutableOrNull(entity)
  if (t) t.position = SERVER_HIDDEN_POS
}

// ── Bomb entity pool ──
const BOMB_POOL_SIZE = 12
const bombEntityPool: Entity[] = []
let bombPoolReady = false

function initBombEntityPool(): void {
  if (bombPoolReady) return
  bombPoolReady = true
  for (let i = 0; i < BOMB_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: SERVER_HIDDEN_POS, scale: Vector3.create(1, 1, 1) })
    bombEntityPool.push(e)
  }
  console.log('[Server] 💣 Pre-created bomb entity pool of', BOMB_POOL_SIZE)
}

function acquireBombEntity(): Entity | null {
  initBombEntityPool()
  const inUse = new Set(activeBombs.map(b => b.entity))
  for (let idx = 0; idx < bombEntityPool.length; idx++) {
    let e = bombEntityPool[idx]
    if (inUse.has(e)) continue
    // Self-heal dead pool slots (see acquireTrapEntity)
    if (!Transform.has(e)) {
      e = engine.addEntity()
      Transform.create(e, { position: SERVER_HIDDEN_POS, scale: Vector3.create(1, 1, 1) })
      bombEntityPool[idx] = e
      console.log('[Server] 💣⚠️ Replaced dead bomb pool entity at slot', idx)
    }
    return e
  }
  console.error('[Server] 💣 Bomb entity pool exhausted!')
  return null
}

function releaseBombEntity(entity: Entity): void {
  const t = Transform.getMutableOrNull(entity)
  if (t) t.position = SERVER_HIDDEN_POS
}

// ══════════════════════════════════════════════════════════════════════

// ── Trap state ──

const lastTrapDropTime = new Map<string, number>()

export interface ActiveTrap {
  entity: Entity
  droppedBy: string
  droppedAtMs: number
  falling: boolean
  fallVelocity: number
  targetY: number
  groundResolved: boolean
  dropY: number  // Y at drop time — reference for landing clamps (floor via dropFloorY, ceiling for ground reports)
}
export const activeTraps: ActiveTrap[] = []

function removeTrap(trap: ActiveTrap): void {
  releaseTrapEntity(trap.entity)
}

// ── Bomb state ──

let nextBombId = 1

export interface ActiveBomb {
  entity: Entity
  bombId: number
  droppedBy: string
  droppedAtMs: number
  falling: boolean
  fallVelocity: number
  targetY: number
  groundResolved: boolean
  dropY: number  // initial Y when dropped (for impact explosion check)
  exploded: boolean
}
export const activeBombs: ActiveBomb[] = []

function removeBomb(bomb: ActiveBomb): void {
  releaseBombEntity(bomb.entity)
}

function explodeBomb(bomb: ActiveBomb): void {
  if (bomb.exploded) return
  bomb.exploded = true

  const bombPos = Transform.get(bomb.entity).position
  const victims: string[] = []

  // Check all players in explosion radius
  for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    const addr = identity.address.toLowerCase()
    const playerPos = getPlayerPosition(addr)
    if (!playerPos) continue

    const dist = Vector3.distance(playerPos, bombPos)
    if (dist < BOMB_EXPLOSION_RADIUS) {
      if (isFlagImmune(addr)) {
        console.log('[Server] 🛡️ Bomb ignored — player has flag immunity')
        continue
      }
      victims.push(addr)

      // Drop flag if carrying
      const flag = Flag.getOrNull(flagEntity)
      if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === addr) {
        console.log('[Server] 💣 Bomb victim was carrying flag — forcing drop!')
        safeForceDrop(addr)
      }
    }
  }

  // Kill ghosts in blast radius
  for (let gi = activeGhosts.length - 1; gi >= 0; gi--) {
    const z = activeGhosts[gi]
    const dx = z.posX - bombPos.x
    const dy = z.posY - bombPos.y
    const dz = z.posZ - bombPos.z
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (dist < BOMB_EXPLOSION_RADIUS) {
      console.log('[Server] 💣 Bomb killed ghost!')
      room.send('ghostKilled', { x: z.posX, y: z.posY, z: z.posZ })
      engine.removeEntity(z.entity)
      recycleGhostSyncId(z.syncId)
      activeGhosts.splice(gi, 1)
      setGhostRespawnCooldown(GHOST_RESPAWN_COOLDOWN)
    }
  }

  // Destroy nearby banana traps
  for (let ti = activeTraps.length - 1; ti >= 0; ti--) {
    const trap = activeTraps[ti]
    const trapPos = Transform.get(trap.entity).position
    const dist = Vector3.distance(trapPos, bombPos)
    if (dist < BOMB_EXPLOSION_RADIUS) {
      room.send('bananaTriggered', { x: trapPos.x, y: trapPos.y, z: trapPos.z, victimId: '' })
      removeTrap(trap)
      activeTraps.splice(ti, 1)
    }
  }

  room.send('bombExploded', {
    x: bombPos.x, y: bombPos.y, z: bombPos.z,
    bombId: bomb.bombId,
    victimsJson: JSON.stringify(victims)
  })

  console.log('[Server] 💣 Bomb exploded at', bombPos.x.toFixed(1), bombPos.y.toFixed(1), bombPos.z.toFixed(1), '— victims:', victims.length)
}

// ── Projectile state ──

const lastProjectileFireTime = new Map<string, number>()

let nextShellId = 1

export interface ActiveProjectile {
  entity: Entity
  shellId: number
  firedBy: string
  firedAtMs: number
  startX: number
  startY: number
  startZ: number
  dirX: number
  dirZ: number
  distanceTraveled: number
  maxDistance: number
  wallDistReported: boolean
  hitWall: boolean
  currentY: number
  fallVelocity: number
  groundY: number
  onGround: boolean
  returning: boolean
  returnX: number
  returnY: number
  returnZ: number
  chargeSpeed: number
  chargeScale: number
}
export const activeProjectiles: ActiveProjectile[] = []

function removeProjectile(projectile: ActiveProjectile): void {
  releaseProjectileEntity(projectile.entity)
}

// ── Green orbit state ──

const ORBIT_DURATION_MS = 3500
const ORBIT_RADIUS = 4.0
const ORBIT_HIT_RADIUS = 2.0
const ORBIT_COOLDOWN_SEC = 7

export interface ActiveOrbit {
  playerId: string
  startedAtMs: number
  hitPlayers: Set<string>
}
export const activeOrbits: ActiveOrbit[] = []
const lastOrbitTime = new Map<string, number>()
const chargingPlayers = new Set<string>()
const lastChargeRelayTime = new Map<string, number>()
const lastChargeStopTime = new Map<string, number>()
const CHARGE_RELAY_MIN_INTERVAL_MS = 100

// ── Action position resolution ──

// How far a client-reported action position may diverge from the server's replicated
// view (or its ~500ms position history) before we distrust it. Two tiers:
// - FIRE (projectiles): the position is just the spawn origin — the projectile flies a
//   client-chosen direction anyway, so a generous 16m adds little abuse surface.
// - DROP (traps/bombs): the position IS the placement. 16m would let a hostile client
//   pin an explosive directly onto a nearby victim, so drops get half the slack —
//   beyond it the item falls back to the server-view position (the old behavior).
const ACTION_POS_TOLERANCE_FIRE = 16
const ACTION_POS_TOLERANCE_DROP = 8

/**
 * The position an item action (fire/drop) should happen at. The server's replicated
 * avatar transform can lag several meters under CRDT load — spawning at the STALE
 * position made boomerangs fly from where the shooter used to be (hitting bystanders
 * "regardless of aim") and dropped traps/bombs onto other players. Prefer the client's
 * fresher self-reported position when it's plausibly close to the server view;
 * otherwise fall back to the server position — never reject the action outright.
 * Returns null only when the player has no replicated position at all (kept as a
 * bot/pre-sync rejection, same as before).
 */
function resolveActionPosition(playerId: string, cx: number | undefined, cy: number | undefined, cz: number | undefined, tolerance: number): Vector3 | null {
  const serverPos = getPlayerPosition(playerId)
  if (!serverPos) return null
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) return serverPos
  // (0,0,0) is the schema default for a client that had no Transform yet — treat as absent.
  if (cx === 0 && cy === 0 && cz === 0) return serverPos
  const clientPos = Vector3.create(cx as number, cy as number, cz as number)
  if (Vector3.distance(clientPos, serverPos) <= tolerance ||
      wasWithinRadius(playerId, clientPos, tolerance, 1000)) {
    return clientPos
  }
  console.log('[Server] ⚠️ Client action position rejected (too far from server view) for', playerId.slice(0, 8))
  return serverPos
}

// ── Trap logic ──

// Synchronous in-flight guard. Without it, a burst of requestBanana messages in one tick
// all suspend at the loadPlayerUpgrades await below, then all read the same pre-update
// cooldown + active-count and each drops a trap — bypassing both the cooldown and TRAP_MAX_ACTIVE.
// Timestamped so a hung inner call (e.g. a wedged storage read before the timeout wrapper
// existed) can never jam a player's traps permanently — stale entries are ignored.
const trapDropInFlight = new Map<string, number>()
const TRAP_DROP_IN_FLIGHT_MAX_MS = 10_000

async function handleTrapDrop(playerId: string, cx?: number, cy?: number, cz?: number): Promise<void> {
  const now = Date.now()
  const since = trapDropInFlight.get(playerId)
  if (since !== undefined && now - since < TRAP_DROP_IN_FLIGHT_MAX_MS) return
  trapDropInFlight.set(playerId, now)
  try {
    await handleTrapDropInner(playerId, cx, cy, cz)
  } finally {
    trapDropInFlight.delete(playerId)
  }
}

async function handleTrapDropInner(playerId: string, cx?: number, cy?: number, cz?: number): Promise<void> {
  const now = Date.now()

  // Check equipped trap type first so we use the right cooldown. Lenient read: on a
  // failed/timed-out storage read, fall back to the default banana rather than dropping
  // nothing — a storage outage must degrade traps, not disable them (this exact await
  // hanging forever was the "traps never drop, cooldown still ticks" incident).
  const upgrades = await loadPlayerUpgrades(playerId).catch(() => null)
  const trapType = upgrades?.equippedTrap || 'banana'
  const cooldown = trapType === 'bomb' ? BOMB_COOLDOWN_SEC : TRAP_COOLDOWN_SEC

  const lastDrop = lastTrapDropTime.get(playerId) ?? 0
  if (now - lastDrop < cooldown * 1000) {
    console.log('[Server] Trap denied: cooldown active, wait', ((cooldown * 1000 - (now - lastDrop)) / 1000).toFixed(1), 's')
    room.send('bananaDenied', { reason: 'cooldown' }, { to: [playerId] })
    return
  }

  const playerPos = resolveActionPosition(playerId, cx, cy, cz, ACTION_POS_TOLERANCE_DROP)
  if (!playerPos) {
    console.log('[Server] Trap denied: player position not found')
    room.send('bananaDenied', { reason: 'no_position' }, { to: [playerId] })
    return
  }

  if (trapType === 'bomb') {
    // Bomb: count active bombs toward the same max
    const playerBombs = activeBombs.filter(b => b.droppedBy === playerId)
    if (playerBombs.length >= TRAP_MAX_ACTIVE) {
      console.log('[Server] Bomb denied: max active reached (', TRAP_MAX_ACTIVE, ')')
      room.send('bananaDenied', { reason: 'max_active' }, { to: [playerId] })
      return
    }

    const dropPos = Vector3.create(playerPos.x, playerPos.y - 0.2, playerPos.z)
    const bombId = nextBombId++

    const bombEntity = acquireBombEntity()
    if (!bombEntity) {
      console.log('[Server] Bomb denied: pool exhausted')
      room.send('bananaDenied', { reason: 'pool_exhausted' }, { to: [playerId] })
      return
    }
    const bt = Transform.getMutable(bombEntity)
    bt.position = dropPos
    bt.scale = Vector3.create(1, 1, 1)

    // Impact-explosion height is computed from the SERVER-replicated Y (with 1m jitter
    // slack), not the client-reported one: the client position is trusted within the
    // drop tolerance sphere, so a client at ground level could otherwise claim +8m of
    // altitude and turn every bomb into an instant impact explosion, bypassing the
    // fuse (the victim's counterplay window).
    const serverView = getPlayerPosition(playerId)
    const impactDropY = Math.min(dropPos.y, (serverView?.y ?? dropPos.y) + 1)

    activeBombs.push({
      entity: bombEntity,
      bombId,
      droppedBy: playerId,
      droppedAtMs: now,
      falling: true,
      fallVelocity: 0,
      // Fallback landing height: just under the drop point (players usually drop from
      // ground level), floored via dropFloorY so interior-room drops (Y<48) land at
      // Y=0 and main-terrain drops land at Y=48. A lost/missed ground-raycast reply
      // then leaves the bomb roughly where it was dropped instead of sinking it ~50m
      // under the lifted map — where the huge fall distance also faked an "impact
      // explosion". The raycast reply refines this to the true ground within ~300ms.
      targetY: Math.max(dropFloorY(dropPos.y), dropPos.y - 2),
      groundResolved: false,
      dropY: impactDropY,
      exploded: false,
    })
    lastTrapDropTime.set(playerId, now)
    sessionBananasDropped.set(playerId, (sessionBananasDropped.get(playerId) ?? 0) + 1)

    room.send('bombDropped', { x: dropPos.x, y: dropPos.y, z: dropPos.z, ownerId: playerId, bombId })
    console.log('[Server] 💣 Bomb dropped by', playerId.slice(0, 8), 'at', dropPos.x.toFixed(1), dropPos.y.toFixed(1), dropPos.z.toFixed(1))
    return
  }

  // Default: banana trap
  const playerTraps = activeTraps.filter(b => b.droppedBy === playerId)
  if (playerTraps.length >= TRAP_MAX_ACTIVE) {
    console.log('[Server] Trap denied: max active traps reached (', TRAP_MAX_ACTIVE, ')')
    room.send('bananaDenied', { reason: 'max_active' }, { to: [playerId] })
    return
  }

  const dropPos = Vector3.create(playerPos.x, playerPos.y - 0.2, playerPos.z)

  const trapEntity = acquireTrapEntity()
  if (!trapEntity) {
    console.log('[Server] Trap denied: pool exhausted')
    room.send('bananaDenied', { reason: 'pool_exhausted' }, { to: [playerId] })
    return
  }
  const tt = Transform.getMutable(trapEntity)
  tt.position = dropPos
  tt.scale = Vector3.create(1, 1, 1)
  activeTraps.push({
    entity: trapEntity,
    droppedBy: playerId,
    droppedAtMs: now,
    falling: true,
    fallVelocity: 0,
    // Fallback landing height just under the drop point (see the bomb equivalent) — a
    // lost/missed ground reply must not sink the trap under the map (or, on elevated
    // terrain, below the walkable surface) where nobody can ever trigger it.
    // Uses dropFloorY so interior drops land at Y=0 and main terrain at Y=48.
    targetY: Math.max(dropFloorY(dropPos.y), dropPos.y - 2),
    groundResolved: false,
    dropY: dropPos.y,
  })
  lastTrapDropTime.set(playerId, now)

  sessionBananasDropped.set(playerId, (sessionBananasDropped.get(playerId) ?? 0) + 1)
  room.send('bananaDropped', { x: dropPos.x, y: dropPos.y, z: dropPos.z, ownerId: playerId })
  console.log('[Server] 🪤 Trap dropped by', playerId.slice(0, 8), 'at', dropPos.x.toFixed(1), dropPos.y.toFixed(1), dropPos.z.toFixed(1), '— active traps:', activeTraps.length)
}

/** Server system: check trap gravity, triggers (player proximity), and expiry. */
export function bananaServerSystem(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = activeTraps.length - 1; i >= 0; i--) {
    const trap = activeTraps[i]

    if (!Transform.has(trap.entity)) {
      console.log('[Server] 🪤⚠️ Ghost trap detected (no Transform) — cleaning up. droppedBy:', trap.droppedBy.slice(0, 8))
      activeTraps.splice(i, 1)
      continue
    }

    // Gravity
    if (trap.falling) {
      trap.fallVelocity += FLAG_GRAVITY * clampedDt
      const pos = Transform.get(trap.entity).position
      let newY = pos.y - trap.fallVelocity * clampedDt
      if (newY <= trap.targetY) {
        newY = trap.targetY
        trap.falling = false
        trap.fallVelocity = 0
      }
      const t = Transform.getMutable(trap.entity)
      t.position = Vector3.create(pos.x, newY, pos.z)
    }

    // Expiry
    const ageMs = now - trap.droppedAtMs
    if (ageMs > TRAP_LIFETIME_SEC * 1000) {
      console.log('[Server] 🪤 Trap expired, removing')
      removeTrap(trap)
      activeTraps.splice(i, 1)
      continue
    }

    const trapPos = Transform.get(trap.entity).position
    let trapConsumed = false

    // Ghost-trap collision
    for (let gi = activeGhosts.length - 1; gi >= 0; gi--) {
      const z = activeGhosts[gi]
      const dx = z.posX - trapPos.x
      const dy = z.posY - trapPos.y
      const dz = z.posZ - trapPos.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist < TRAP_TRIGGER_RADIUS) {
        z.hp--
        console.log('[Server] 🪤👻 Trap hit ghost! HP:', z.hp)
        room.send('bananaTriggered', { x: trapPos.x, y: trapPos.y, z: trapPos.z, victimId: '' })
        room.send('hitVfx', { x: z.posX, y: z.posY + 1, z: z.posZ })
        if (z.hp <= 0) {
          console.log('[Server] 🪤👻 Ghost killed by trap!')
          room.send('ghostKilled', { x: z.posX, y: z.posY, z: z.posZ })
          engine.removeEntity(z.entity); recycleGhostSyncId(z.syncId)
          activeGhosts.splice(gi, 1)
          setGhostRespawnCooldown(GHOST_RESPAWN_COOLDOWN)
        }
        removeTrap(trap)
        activeTraps.splice(i, 1)
        trapConsumed = true
        break
      }
    }
    if (trapConsumed) continue

    // Player-trap collision
    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      const addr = identity.address.toLowerCase()
      if (addr === trap.droppedBy && (now - trap.droppedAtMs) < 2000) continue

      const playerPos = getPlayerPosition(addr)
      if (!playerPos) continue

      const dist = Vector3.distance(playerPos, trapPos)
      if (dist < TRAP_TRIGGER_RADIUS) {
        if (isFlagImmune(addr)) {
          console.log('[Server] 🛡️ Trap ignored — player has flag immunity')
          continue
        }
        console.log('[Server] 🪤 Trap triggered by', addr.slice(0, 8), '! Staggering...')

        const flag = Flag.getOrNull(flagEntity)
        if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === addr) {
          console.log('[Server] 🪤 Victim was carrying flag — forcing drop!')
          safeForceDrop(addr)
        }

        room.send('bananaTriggered', { x: trapPos.x, y: trapPos.y, z: trapPos.z, victimId: addr })
        removeTrap(trap)
        activeTraps.splice(i, 1)
        break
      }
    }
  }
}

/** Server system: bomb gravity, fuse timer, proximity trigger, and impact explosion. */
export function bombServerSystem(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = activeBombs.length - 1; i >= 0; i--) {
    const bomb = activeBombs[i]
    if (bomb.exploded) { removeBomb(bomb); activeBombs.splice(i, 1); continue }

    if (!Transform.has(bomb.entity)) {
      console.log('[Server] 💣⚠️ Ghost bomb detected — cleaning up')
      activeBombs.splice(i, 1)
      continue
    }

    // Gravity
    if (bomb.falling) {
      bomb.fallVelocity += FLAG_GRAVITY * clampedDt
      const pos = Transform.get(bomb.entity).position
      let newY = pos.y - bomb.fallVelocity * clampedDt
      if (newY <= bomb.targetY) {
        newY = bomb.targetY
        bomb.falling = false
        bomb.fallVelocity = 0

        // Impact explosion if dropped from sufficient height
        const dropHeight = bomb.dropY - bomb.targetY
        if (dropHeight >= BOMB_IMPACT_HEIGHT) {
          console.log('[Server] 💣 Bomb impact explosion! Drop height:', dropHeight.toFixed(1), 'm')
          explodeBomb(bomb)
          removeBomb(bomb)
          activeBombs.splice(i, 1)
          continue
        }
      }
      const t = Transform.getMutable(bomb.entity)
      t.position = Vector3.create(pos.x, newY, pos.z)
    }

    // Fuse timer — explode after BOMB_FUSE_SEC
    const ageMs = now - bomb.droppedAtMs
    if (ageMs >= BOMB_FUSE_SEC * 1000) {
      console.log('[Server] 💣 Bomb fuse expired — exploding!')
      explodeBomb(bomb)
      removeBomb(bomb)
      activeBombs.splice(i, 1)
      continue
    }

    // Proximity trigger — any player walks into it (1s grace for dropper)
    const bombPos = Transform.get(bomb.entity).position
    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      const addr = identity.address.toLowerCase()
      if (addr === bomb.droppedBy && ageMs < 2000) continue  // grace period for dropper

      const playerPos = getPlayerPosition(addr)
      if (!playerPos) continue

      const dist = Vector3.distance(playerPos, bombPos)
      if (dist < TRAP_TRIGGER_RADIUS) {
        console.log('[Server] 💣 Bomb proximity triggered by', addr.slice(0, 8))
        explodeBomb(bomb)
        removeBomb(bomb)
        activeBombs.splice(i, 1)
        break
      }
    }
  }
}

// ── Projectile logic ──

function handleProjectileFire(playerId: string, dirX: number, dirZ: number, color: string = 'r', chargeSpeed: number = PROJECTILE_SPEED, chargeRange: number = 20, chargeScale: number = 1, cx?: number, cy?: number, cz?: number): void {
  const now = Date.now()

  const lastFire = lastProjectileFireTime.get(playerId) ?? 0
  const effectiveCd = color === 'y' ? 0.2 : PROJECTILE_COOLDOWN_SEC
  if (now - lastFire < effectiveCd * 1000) {
    console.log('[Server] Projectile denied: cooldown active')
    room.send('shellDenied', { reason: 'cooldown' }, { to: [playerId] })
    return
  }

  const playerProjectiles = activeProjectiles.filter(s => s.firedBy === playerId)
  const maxActive = color === 'y' ? 2 : PROJECTILE_MAX_ACTIVE
  if (playerProjectiles.length >= maxActive) {
    const detail = playerId.slice(0, 8) + ' ' + color + ' ' + playerProjectiles.map(p => 'id=' + p.shellId + ' age=' + ((Date.now() - p.firedAtMs) / 1000).toFixed(1) + 's ret=' + p.returning).join(',')
    console.log('[Server] ⚠️ Projectile denied: max active reached (' + playerProjectiles.length + '/' + maxActive + ') —', detail)
    if (typeof (globalThis as any).__diagShellDenied === 'function') (globalThis as any).__diagShellDenied(detail)
    room.send('shellDenied', { reason: 'max_active' }, { to: [playerId] })
    return
  }

  const playerPos = resolveActionPosition(playerId, cx, cy, cz, ACTION_POS_TOLERANCE_FIRE)
  if (!playerPos) {
    console.log('[Server] Projectile denied: player position not found')
    room.send('shellDenied', { reason: 'no_position' }, { to: [playerId] })
    return
  }

  const len = Math.sqrt(dirX * dirX + dirZ * dirZ)
  // Reject non-finite direction explicitly: `NaN < 0.01` is false, so a NaN/Infinity dir
  // would slip past the magnitude check and produce a NaN spawn position + rotation that
  // gets broadcast to every client.
  if (!Number.isFinite(dirX) || !Number.isFinite(dirZ) || len < 0.01) {
    console.log('[Server] Projectile denied: invalid direction')
    room.send('shellDenied', { reason: 'invalid_direction' }, { to: [playerId] })
    return
  }
  const nDirX = dirX / len
  const nDirZ = dirZ / len

  const spawnPos = Vector3.create(
    playerPos.x + nDirX * 1.0,
    playerPos.y + 0.8,
    playerPos.z + nDirZ * 1.0
  )

  const projectileEntity = acquireProjectileEntity()
  if (!projectileEntity) {
    console.log('[Server] Projectile denied: pool exhausted')
    room.send('shellDenied', { reason: 'pool_exhausted' }, { to: [playerId] })
    return
  }
  const pt = Transform.getMutable(projectileEntity)
  pt.position = spawnPos
  pt.scale = Vector3.create(1, 1, 1)
  pt.rotation = Quaternion.fromEulerDegrees(0, Math.atan2(nDirX, nDirZ) * (180 / Math.PI), 0)
  const shellId = nextShellId++
  activeProjectiles.push({
    entity: projectileEntity,
    shellId,
    firedBy: playerId,
    firedAtMs: now,
    startX: spawnPos.x,
    startY: spawnPos.y,
    startZ: spawnPos.z,
    dirX: nDirX,
    dirZ: nDirZ,
    distanceTraveled: 0,
    maxDistance: chargeRange,
    wallDistReported: false,
    hitWall: false,
    currentY: spawnPos.y,
    fallVelocity: 0,
    groundY: Math.max(0, playerPos.y - 0.88),
    onGround: false,
    returning: false,
    returnX: spawnPos.x,
    returnY: spawnPos.y,
    returnZ: spawnPos.z,
    chargeSpeed,
    chargeScale,
  })
  lastProjectileFireTime.set(playerId, now)

  room.send('shellDropped', { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z, dirX: nDirX, dirZ: nDirZ, color, firedBy: playerId, chargeSpeed, chargeRange, chargeScale, shellId })
  console.log('[Server] 🎯 Projectile fired by', playerId.slice(0, 8), 'dir:', nDirX.toFixed(2), nDirZ.toFixed(2))
}

/** Server system: move projectiles forward (and return), check player hits, and handle expiry. */
export function shellServerSystem(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = activeProjectiles.length - 1; i >= 0; i--) {
    const projectile = activeProjectiles[i]

    // Ghost-projectile guard (same class as ghost traps/bombs): if the pooled
    // entity lost its Transform, every Transform.get below would throw — which
    // aborts this whole system every frame, so NO projectile ever expires or
    // returns, and with PROJECTILE_MAX_ACTIVE=1 the shooter can never fire again.
    if (!Transform.has(projectile.entity)) {
      console.log('[Server] 🎯⚠️ Ghost projectile detected (no Transform) — cleaning up. firedBy:', projectile.firedBy.slice(0, 8))
      room.send('shellReturned', { firedBy: projectile.firedBy, shellId: projectile.shellId })
      activeProjectiles.splice(i, 1)
      continue
    }

    // Safety expiry
    if (now - projectile.firedAtMs > PROJECTILE_LIFETIME_SEC * 1000) {
      console.log('[Server] 🎯 Projectile expired (timeout)')
      room.send('shellReturned', { firedBy: projectile.firedBy, shellId: projectile.shellId })
      removeProjectile(projectile)
      activeProjectiles.splice(i, 1)
      continue
    }

    const moveDistance = (projectile.chargeSpeed || PROJECTILE_SPEED) * clampedDt

    if (!projectile.returning) {
      // Outbound flight
      projectile.distanceTraveled += moveDistance

      if (projectile.distanceTraveled >= projectile.maxDistance) {
        console.log('[Server] 🎯 Projectile reached max range at', projectile.distanceTraveled.toFixed(1), 'm — returning')
        projectile.returning = true
        projectile.returnX = projectile.startX + projectile.dirX * projectile.distanceTraveled
        projectile.returnY = projectile.startY
        projectile.returnZ = projectile.startZ + projectile.dirZ * projectile.distanceTraveled
        const projectilePos = Transform.get(projectile.entity).position
        room.send('shellTriggered', { x: projectilePos.x, y: projectilePos.y, z: projectilePos.z, victimId: '', peak: !projectile.hitWall, firedBy: projectile.firedBy, shellId: projectile.shellId })
      } else {
        const newX = projectile.startX + projectile.dirX * projectile.distanceTraveled
        const newZ = projectile.startZ + projectile.dirZ * projectile.distanceTraveled
        const t = Transform.getMutable(projectile.entity)
        t.position = Vector3.create(newX, projectile.startY, newZ)
        projectile.returnX = newX
        projectile.returnY = projectile.startY
        projectile.returnZ = newZ
      }
    } else {
      // Return flight — home in on shooter
      const CHEST_OFFSET = 0.8
      const shooterPos = getPlayerPosition(projectile.firedBy)
      const rawTarget = shooterPos || Vector3.create(projectile.startX, projectile.startY, projectile.startZ)
      const targetPos = Vector3.create(rawTarget.x, rawTarget.y + CHEST_OFFSET, rawTarget.z)

      const dx = targetPos.x - projectile.returnX
      const dy = targetPos.y - projectile.returnY
      const dz = targetPos.z - projectile.returnZ
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

      if (dist < PROJECTILE_HIT_RADIUS) {
        console.log('[Server] 🎯 Projectile returned to shooter')
        room.send('shellReturned', { firedBy: projectile.firedBy, shellId: projectile.shellId })
        removeProjectile(projectile)
        activeProjectiles.splice(i, 1)
        continue
      }

      const nx = dx / dist, ny = dy / dist, nz = dz / dist
      projectile.returnX += nx * moveDistance
      projectile.returnY += ny * moveDistance
      projectile.returnZ += nz * moveDistance
      const t = Transform.getMutable(projectile.entity)
      t.position = Vector3.create(projectile.returnX, projectile.returnY, projectile.returnZ)
    }

    // Check player hits
    const projectilePos = Transform.get(projectile.entity).position
    let shellConsumed = false

    // Lag-forgiving hit check: first pass uses current position (cheap, exact).
    // Second pass checks the last ~300ms of positions per player — the shooter's
    // client predicted a hit against a slightly-lagged victim Transform, so if
    // the victim *was* within radius recently, we count it. Prevents "red star
    // but no stagger/drop" from position desync during chases.
    const hitRadius = PROJECTILE_HIT_RADIUS * projectile.chargeScale
    const LOOKBACK_MS = 300
    let hitAddr: string | null = null
    let hitMode: 'current' | 'lookback' = 'current'
    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      const addr = identity.address.toLowerCase()
      if (addr === projectile.firedBy) continue
      const playerPos = getPlayerPosition(addr)
      if (!playerPos) continue
      if (Vector3.distance(playerPos, projectilePos) < hitRadius) { hitAddr = addr; break }
    }
    if (!hitAddr) {
      for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
        const addr = identity.address.toLowerCase()
        if (addr === projectile.firedBy) continue
        if (wasWithinRadius(addr, projectilePos, hitRadius, LOOKBACK_MS)) {
          hitAddr = addr; hitMode = 'lookback'; break
        }
      }
    }
    if (hitAddr && isFlagImmune(hitAddr)) {
      console.log('[Server] 🛡️ Projectile ignored — player has flag immunity')
      hitAddr = null
    }
    if (hitAddr) {
      const addr = hitAddr
      {
        console.log('[Server] 🎯 Projectile hit player', addr.slice(0, 8), projectile.returning ? '(return)' : '(outbound)', hitMode === 'lookback' ? '(lookback)' : '')

        const flag = Flag.getOrNull(flagEntity)
        if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === addr) {
          console.log('[Server] 🎯 Victim was carrying flag — forcing drop!')
          safeForceDrop(addr)
        }

        room.send('shellTriggered', { x: projectilePos.x, y: projectilePos.y, z: projectilePos.z, victimId: addr, firedBy: projectile.firedBy, shellId: projectile.shellId })

        if (projectile.returning) {
          room.send('shellReturned', { firedBy: projectile.firedBy, shellId: projectile.shellId })
          removeProjectile(projectile)
          activeProjectiles.splice(i, 1)
          shellConsumed = true
        } else {
          projectile.returning = true
          projectile.returnX = projectilePos.x
          projectile.returnY = projectilePos.y
          projectile.returnZ = projectilePos.z
          console.log('[Server] 🎯 Projectile hit on outbound — returning to shooter')
        }
      }
    }
    if (shellConsumed) continue

    // Trap collision — projectile destroys the trap
    for (let j = activeTraps.length - 1; j >= 0; j--) {
      const trap = activeTraps[j]
      const trapPos = Transform.get(trap.entity).position
      const dist = Vector3.distance(projectilePos, trapPos)
      if (dist < PROJECTILE_HIT_RADIUS * projectile.chargeScale) {
        console.log('[Server] 🎯🪤 Projectile hit trap!', projectile.returning ? 'Both destroyed.' : 'Trap destroyed, projectile returning.')
        room.send('shellTriggered', { x: projectilePos.x, y: projectilePos.y, z: projectilePos.z, victimId: '', firedBy: projectile.firedBy, shellId: projectile.shellId })
        room.send('bananaTriggered', { x: trapPos.x, y: trapPos.y, z: trapPos.z, victimId: '' })
        removeTrap(trap)
        activeTraps.splice(j, 1)

        if (projectile.returning) {
          room.send('shellReturned', { firedBy: projectile.firedBy, shellId: projectile.shellId })
          removeProjectile(projectile)
          activeProjectiles.splice(i, 1)
          shellConsumed = true
        } else {
          projectile.returning = true
          projectile.returnX = projectilePos.x
          projectile.returnY = projectilePos.y
          projectile.returnZ = projectilePos.z
        }
        break
      }
    }

    // Bomb collision — projectile detonates the bomb
    if (!shellConsumed) {
      for (let j = activeBombs.length - 1; j >= 0; j--) {
        const bomb = activeBombs[j]
        if (bomb.exploded) continue
        const bPos = Transform.get(bomb.entity).position
        const dist = Vector3.distance(projectilePos, bPos)
        if (dist < PROJECTILE_HIT_RADIUS * projectile.chargeScale) {
          console.log('[Server] 🎯💣 Projectile detonated bomb!')
          room.send('shellTriggered', { x: projectilePos.x, y: projectilePos.y, z: projectilePos.z, victimId: '', firedBy: projectile.firedBy, shellId: projectile.shellId })
          explodeBomb(bomb)
          removeBomb(bomb)
          activeBombs.splice(j, 1)

          if (projectile.returning) {
            room.send('shellReturned', { firedBy: projectile.firedBy, shellId: projectile.shellId })
            removeProjectile(projectile)
            activeProjectiles.splice(i, 1)
            shellConsumed = true
          } else {
            projectile.returning = true
            projectile.returnX = projectilePos.x
            projectile.returnY = projectilePos.y
            projectile.returnZ = projectilePos.z
          }
          break
        }
      }
    }
  }
}

// ── Green orbit logic ──

function handleOrbitRequest(playerId: string, startAngle: number = 0): void {
  const now = Date.now()

  if (!canUseBoomerangAbility(playerBoomerangColors.get(playerId), 'g')) {
    console.log('[Server] Orbit denied: green boomerang not equipped')
    return
  }
  if (!Number.isFinite(startAngle)) startAngle = 0

  const lastOrb = lastOrbitTime.get(playerId) ?? 0
  if (now - lastOrb < ORBIT_COOLDOWN_SEC * 1000) {
    console.log('[Server] Orbit denied: cooldown active')
    return
  }

  if (activeOrbits.some(o => o.playerId === playerId)) {
    console.log('[Server] Orbit denied: already orbiting')
    return
  }

  if (activeProjectiles.some(p => p.firedBy === playerId)) {
    console.log('[Server] Orbit denied: projectile in flight')
    return
  }

  const playerPos = getPlayerPosition(playerId)
  if (!playerPos) {
    console.log('[Server] Orbit denied: player position not found')
    return
  }

  activeOrbits.push({
    playerId,
    startedAtMs: now,
    hitPlayers: new Set()
  })
  lastOrbitTime.set(playerId, now)

  room.send('orbitStarted', { playerId, durationMs: ORBIT_DURATION_MS, startAngle })
  console.log('[Server] 🌀 Orbit started by', playerId.slice(0, 8))
}

/** Server system: check orbit hits and expiry. */
export function orbitServerSystem(_dt: number): void {
  const now = Date.now()

  for (let i = activeOrbits.length - 1; i >= 0; i--) {
    const orbit = activeOrbits[i]

    if (now - orbit.startedAtMs > ORBIT_DURATION_MS) {
      console.log('[Server] 🌀 Orbit ended for', orbit.playerId.slice(0, 8))
      room.send('orbitEnded', { playerId: orbit.playerId })
      activeOrbits.splice(i, 1)
      continue
    }

    const orbiterPos = getPlayerPosition(orbit.playerId)
    if (!orbiterPos) continue

    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      const addr = identity.address.toLowerCase()
      if (addr === orbit.playerId) continue
      if (orbit.hitPlayers.has(addr)) continue

      const victimPos = getPlayerPosition(addr)
      if (!victimPos) continue

      const dist = Vector3.distance(orbiterPos, victimPos)
      if (dist < ORBIT_RADIUS + ORBIT_HIT_RADIUS && dist > 0.5) {
        if (isFlagImmune(addr)) {
          console.log('[Server] 🛡️ Orbit hit ignored — player has flag immunity')
          continue
        }
        orbit.hitPlayers.add(addr)
        console.log('[Server] 🌀 Orbit hit player', addr.slice(0, 8), '— ending orbit')

        const flag = Flag.getOrNull(flagEntity)
        if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === addr) {
          console.log('[Server] 🌀 Orbit victim was carrying flag — forcing drop!')
          safeForceDrop(addr)
        }

        room.send('orbitHit', { x: victimPos.x, y: victimPos.y, z: victimPos.z, victimId: addr, attackerId: orbit.playerId })
        room.send('orbitEnded', { playerId: orbit.playerId })
        activeOrbits.splice(i, 1)
        break
      }
    }
  }
}

// ── Cleanup helpers (used by roundManager) ──

export { removeTrap, removeProjectile, removeBomb }

// ── Cooldown map cleanup (called on player disconnect) ──

export function clearCombatCooldowns(playerId: string): void {
  lastTrapDropTime.delete(playerId)
  lastProjectileFireTime.delete(playerId)
  lastOrbitTime.delete(playerId)
  chargingPlayers.delete(playerId)
  lastChargeRelayTime.delete(playerId)
  lastChargeStopTime.delete(playerId)
}

/** Clear all combat cooldown maps (called at round end). */
export function clearAllCombatCooldowns(): void {
  lastTrapDropTime.clear()
  lastProjectileFireTime.clear()
  lastOrbitTime.clear()
  chargingPlayers.clear()
  lastChargeRelayTime.clear()
  lastChargeStopTime.clear()
}

// ── Message handler registration ──

export function registerCombatHandlers(): void {
  room.onMessage('requestBanana', (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      // Entry log: during the "traps silently never drop" incident there was no way to
      // tell from logs whether the request even reached the server. Keep this line.
      console.log('[Server] 🪤 requestBanana from', from.slice(0, 8))
      // handleTrapDrop is async — without .catch, a rejection is silently swallowed
      // (no drop, no denial, client cooldown stuck) and never reaches this try/catch.
      handleTrapDrop(from, data.x, data.y, data.z).catch(err => {
        // Always answer — bananaDenied resets the client's local cooldown so the
        // player can retry instead of staring at a dead hotbar.
        console.error('[Server] ❌ handleTrapDrop failed:', err)
        room.send('bananaDenied', { reason: 'error' }, { to: [from] })
      })
    } catch (err) { console.error('[Server] ❌ requestBanana handler error:', err) }
  })
  room.onMessage('requestShell', (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      // Authoritative equipped color — never trust data.color, or a client could claim
      // 'y' for 5x fire rate + double shot, or 'b' charge params, without owning either.
      const color = playerBoomerangColors.get(from) || 'r'
      // Charge params only apply to the Charge boomerang ('b'); ignore them otherwise.
      const canCharge = color === 'b'
      // Number.isFinite (not typeof === 'number') so NaN/Infinity fall back to defaults —
      // Math.max/min propagate NaN, so an unchecked NaN would become the actual param.
      const chargeSpeed = canCharge && Number.isFinite(data.chargeSpeed) ? Math.max(PROJECTILE_SPEED, Math.min(60, data.chargeSpeed)) : PROJECTILE_SPEED
      const chargeRange = canCharge && Number.isFinite(data.chargeRange) ? Math.max(20, Math.min(PROJECTILE_MAX_RANGE, data.chargeRange)) : 20
      const chargeScale = canCharge && Number.isFinite(data.chargeScale) ? Math.max(1, Math.min(3, data.chargeScale)) : 1
      sessionBoomerangsFired.set(from, (sessionBoomerangsFired.get(from) ?? 0) + 1)
      handleProjectileFire(from, data.dirX, data.dirZ, color, chargeSpeed, chargeRange, chargeScale, data.x, data.y, data.z)
    } catch (err) { console.error('[Server] ❌ requestShell handler error:', err) }
  })
  room.onMessage('reportShellWallDist', (data, context) => {
    try {
      if (!context) return
      // Math.min propagates NaN — an unchecked NaN maxDist would make the shell's
      // travel-distance termination check permanently false.
      if (!Number.isFinite(data.maxDist)) return
      const from = context.from.toLowerCase()
      for (const projectile of activeProjectiles) {
        if (projectile.firedBy === from && !projectile.wallDistReported) {
          const oldMax = projectile.maxDistance
          projectile.maxDistance = Math.min(projectile.maxDistance, Math.max(0, data.maxDist))
          if (projectile.maxDistance < oldMax) projectile.hitWall = true
          projectile.wallDistReported = true
          console.log('[Server] 🎯 Projectile wall distance updated:', data.maxDist.toFixed(1), 'm')
          break
        }
      }
    } catch (err) { console.error('[Server] ❌ reportShellWallDist handler error:', err) }
  })
  room.onMessage('reportShellGroundY', (data, context) => {
    try {
      if (!context) return
      // Finite-check every client float: Math.max propagates NaN, and a NaN groundY
      // makes the landing comparison permanently false — the shell would never land.
      if (!Number.isFinite(data.shellX) || !Number.isFinite(data.shellZ) || !Number.isFinite(data.groundY)) return
      const from = context.from.toLowerCase()
      let closest: ActiveProjectile | null = null
      let closestDist = 5
      for (const projectile of activeProjectiles) {
        // Owner-only: every client raycasts the broadcast shells, but accepting
        // whichever report arrives first would let a hostile client poison other
        // players' shells. The owner's client always reports its own.
        if (projectile.firedBy !== from) continue
        const pos = Transform.get(projectile.entity).position
        const dx = pos.x - data.shellX
        const dz = pos.z - data.shellZ
        const dist = Math.sqrt(dx * dx + dz * dz)
        if (dist < closestDist) {
          closestDist = dist
          closest = projectile
        }
      }
      if (closest) {
        // The client raycasts DOWNWARD from the shell, so the ground can't be above
        // it — cap the raise or a hostile report could park the shell in the sky.
        const shellY = Transform.get(closest.entity).position.y
        closest.groundY = Math.min(shellY + 1, Math.max(0, data.groundY))
      }
    } catch (err) { console.error('[Server] ❌ reportShellGroundY handler error:', err) }
  })
  room.onMessage('reportBananaGroundY', (data, context) => {
    try {
      if (!context) return
      // Finite-check every client float — a NaN targetY poisons the fall loop's
      // comparison (never true) and the trap falls forever, neutralized.
      if (!Number.isFinite(data.bananaX) || !Number.isFinite(data.bananaZ) || !Number.isFinite(data.groundY)) return
      const from = context.from.toLowerCase()
      let closest: ActiveTrap | null = null
      let closestDist = 3
      for (const trap of activeTraps) {
        // Owner-only (see reportShellGroundY): groundResolved is first-report-wins,
        // so without this any client could poison another player's trap before the
        // honest reports land. The owner's client always reports its own drops.
        if (trap.droppedBy !== from) continue
        const pos = Transform.get(trap.entity).position
        const dx = pos.x - data.bananaX
        const dz = pos.z - data.bananaZ
        const dist = Math.sqrt(dx * dx + dz * dz)
        if (dist < closestDist) {
          closestDist = dist
          closest = trap
        }
      }
      // Finite-check the client float — a NaN targetY would poison the fall loop
      if (!Number.isFinite(data.groundY)) return
      if (closest && !closest.groundResolved) {
        // Clamp BOTH ways: floor via dropFloorY (interior-aware — a missed client
        // raycast reports groundY=0, which is ~50m under the lifted main-terrain map
        // but valid for interior-room drops), and cap the raise just above the
        // drop point — ground can't legitimately be above where the trap was dropped,
        // and an uncapped raise would park the trap unreachable in the sky.
        closest.targetY = Math.min(closest.dropY + 1, Math.max(dropFloorY(closest.dropY), data.groundY))
        closest.groundResolved = true
        const currentY = Transform.get(closest.entity).position.y
        if (currentY <= closest.targetY) {
          const t = Transform.getMutable(closest.entity)
          t.position = Vector3.create(t.position.x, closest.targetY, t.position.z)
          closest.falling = false
          closest.fallVelocity = 0
        }
      }
    } catch (err) { console.error('[Server] ❌ reportBananaGroundY handler error:', err) }
  })
  room.onMessage('reportBombGroundY', (data, context) => {
    try {
      if (!context) return
      // Finite-check the client float (see reportBananaGroundY).
      if (!Number.isFinite(data.groundY)) return
      const from = context.from.toLowerCase()
      const bombId = data.bombId
      if (!Number.isFinite(data.groundY)) return
      const bomb = activeBombs.find(b => b.bombId === bombId)
      if (bomb && !bomb.groundResolved) {
        // Owner-only: bomb ids are broadcast, and groundResolved is first-report-wins.
        if (bomb.droppedBy !== from) return
        // Clamp BOTH ways: floor via dropFloorY (interior-aware — a missed client
        // raycast reports groundY=0, which for main-terrain drops both sinks the bomb
        // under the map AND fakes a 50m "impact explosion" drop), and cap the raise
        // just above the drop point (ground can't be above the drop; an uncapped
        // raise parks the bomb in the sky and suppresses its impact explosion).
        bomb.targetY = Math.min(bomb.dropY + 1, Math.max(dropFloorY(bomb.dropY), data.groundY))
        bomb.groundResolved = true
        if (!bomb.exploded) {
          const currentY = Transform.get(bomb.entity).position.y
          if (currentY <= bomb.targetY) {
            const t = Transform.getMutable(bomb.entity)
            t.position = Vector3.create(t.position.x, bomb.targetY, t.position.z)
            // Check impact explosion
            const dropHeight = bomb.dropY - bomb.targetY
            if (dropHeight >= BOMB_IMPACT_HEIGHT) {
              console.log('[Server] 💣 Bomb impact explosion on ground resolve! Height:', dropHeight.toFixed(1))
              explodeBomb(bomb)
              removeBomb(bomb)
              const idx = activeBombs.indexOf(bomb)
              if (idx !== -1) activeBombs.splice(idx, 1)
            } else {
              bomb.falling = false
              bomb.fallVelocity = 0
            }
          }
        }
      }
    } catch (err) { console.error('[Server] ❌ reportBombGroundY handler error:', err) }
  })
  room.onMessage('requestOrbit', (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const startAngle = typeof _data.startAngle === 'number' ? _data.startAngle : 0
      handleOrbitRequest(from, startAngle)
    } catch (err) { console.error('[Server] ❌ requestOrbit handler error:', err) }
  })
  room.onMessage('orbitHitWall', (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const idx = activeOrbits.findIndex(o => o.playerId === from)
      if (idx === -1) return
      console.log('[Server] 🌀 Orbit hit wall for', from.slice(0, 8), '— ending orbit')
      room.send('orbitEnded', { playerId: from })
      activeOrbits.splice(idx, 1)
    } catch (err) { console.error('[Server] ❌ orbitHitWall handler error:', err) }
  })
  room.onMessage('chargeBurnout', (data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    if (!canUseBoomerangAbility(playerBoomerangColors.get(from), 'b') || Date.now() - (lastChargeStopTime.get(from) ?? 0) > 1000) return
    lastChargeStopTime.delete(from)
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y) || !Number.isFinite(data.z)) return
    const playerPos = getPlayerPosition(from)
    if (!playerPos || Vector3.distance(playerPos, Vector3.create(data.x, data.y, data.z)) > 10) return
    room.send('hitVfx', { x: data.x, y: data.y, z: data.z })
  })
  room.onMessage('reportBoost', (_data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    if (!consumePendingMushroomBoost(from)) return
    room.send('playerBoosted', { playerId: from, tier: 'mushroom', duration: 20 })
  })
  room.onMessage('chargeStart', (data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    const now = Date.now()
    if (!canUseBoomerangAbility(playerBoomerangColors.get(from), 'b') || chargingPlayers.has(from)) return
    if (now - (lastChargeRelayTime.get(from) ?? 0) < CHARGE_RELAY_MIN_INTERVAL_MS) return
    chargingPlayers.add(from)
    lastChargeRelayTime.set(from, now)
    room.send('playerChargeStart', { playerId: from, t: data.t || 0 })
  })
  room.onMessage('chargeStop', (data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    const now = Date.now()
    if (!chargingPlayers.has(from)) return
    chargingPlayers.delete(from)
    lastChargeRelayTime.set(from, now)
    lastChargeStopTime.set(from, now)
    room.send('playerChargeStop', { playerId: from, t: data.t || 0 })
  })
}
