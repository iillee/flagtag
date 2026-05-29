/**
 * combat.ts — Traps (bananas), projectiles (boomerangs), and green orbit attacks.
 * Handles placement, movement, collision detection, and cleanup.
 */

import { engine, Transform, PlayerIdentityData, type Entity } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import {
  Flag, FlagState,
  Trap, TRAP_LIFETIME_SEC, TRAP_COOLDOWN_SEC, TRAP_MAX_ACTIVE, TRAP_TRIGGER_RADIUS,
  Projectile, PROJECTILE_LIFETIME_SEC, PROJECTILE_COOLDOWN_SEC, PROJECTILE_MAX_ACTIVE, PROJECTILE_SPEED, PROJECTILE_MAX_RANGE, PROJECTILE_HIT_RADIUS,
  recycleGhostSyncId,
} from '../shared/components'
import { room } from '../shared/messages'
import {
  flagEntity, getPlayerPosition, FLAG_GRAVITY,
  activeGhosts, ghostRespawnCooldown, setGhostRespawnCooldown, GHOST_RESPAWN_COOLDOWN,
  sessionBananasDropped, sessionBoomerangsFired,
} from './serverState'
import { handleDrop } from './flagLogic'

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
}
export const activeTraps: ActiveTrap[] = []

function removeTrap(trap: ActiveTrap): void {
  engine.removeEntity(trap.entity)
}

// ── Projectile state ──

const lastProjectileFireTime = new Map<string, number>()

export interface ActiveProjectile {
  entity: Entity
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
  engine.removeEntity(projectile.entity)
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

// ── Trap logic ──

function handleTrapDrop(playerId: string): void {
  const now = Date.now()

  const lastDrop = lastTrapDropTime.get(playerId) ?? 0
  if (now - lastDrop < TRAP_COOLDOWN_SEC * 1000) {
    console.log('[Server] Trap denied: cooldown active, wait', ((TRAP_COOLDOWN_SEC * 1000 - (now - lastDrop)) / 1000).toFixed(1), 's')
    room.send('bananaDenied', { reason: 'cooldown' }, { to: [playerId] })
    return
  }

  const playerTraps = activeTraps.filter(b => b.droppedBy === playerId)
  if (playerTraps.length >= TRAP_MAX_ACTIVE) {
    console.log('[Server] Trap denied: max active traps reached (', TRAP_MAX_ACTIVE, ')')
    room.send('bananaDenied', { reason: 'max_active' }, { to: [playerId] })
    return
  }

  const playerPos = getPlayerPosition(playerId)
  if (!playerPos) {
    console.log('[Server] Trap denied: player position not found')
    room.send('bananaDenied', { reason: 'no_position' }, { to: [playerId] })
    return
  }

  const dropPos = Vector3.create(playerPos.x, playerPos.y - 0.2, playerPos.z)

  const trapEntity = engine.addEntity()
  Transform.create(trapEntity, {
    position: dropPos,
    scale: Vector3.create(1, 1, 1)
  })
  Trap.create(trapEntity, {
    droppedByPlayerId: playerId,
    droppedAtMs: now,
  })
  activeTraps.push({
    entity: trapEntity,
    droppedBy: playerId,
    droppedAtMs: now,
    falling: true,
    fallVelocity: 0,
    targetY: 0,
    groundResolved: false,
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
        console.log('[Server] 🪤 Trap triggered by', addr.slice(0, 8), '! Staggering...')

        const flag = Flag.getOrNull(flagEntity)
        if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === addr) {
          console.log('[Server] 🪤 Victim was carrying flag — forcing drop!')
          handleDrop(addr)
        }

        room.send('bananaTriggered', { x: trapPos.x, y: trapPos.y, z: trapPos.z, victimId: addr })
        removeTrap(trap)
        activeTraps.splice(i, 1)
        break
      }
    }
  }
}

// ── Projectile logic ──

function handleProjectileFire(playerId: string, dirX: number, dirZ: number, color: string = 'r', chargeSpeed: number = PROJECTILE_SPEED, chargeRange: number = 20, chargeScale: number = 1): void {
  const now = Date.now()

  const lastFire = lastProjectileFireTime.get(playerId) ?? 0
  const effectiveCd = color === 'y' ? 0.2 : PROJECTILE_COOLDOWN_SEC
  if (now - lastFire < effectiveCd * 1000) {
    console.log('[Server] Projectile denied: cooldown active')
    return
  }

  const playerProjectiles = activeProjectiles.filter(s => s.firedBy === playerId)
  const maxActive = color === 'y' ? 2 : PROJECTILE_MAX_ACTIVE
  if (playerProjectiles.length >= maxActive) {
    console.log('[Server] Projectile denied: max active projectiles reached')
    return
  }

  const playerPos = getPlayerPosition(playerId)
  if (!playerPos) {
    console.log('[Server] Projectile denied: player position not found')
    return
  }

  const len = Math.sqrt(dirX * dirX + dirZ * dirZ)
  if (len < 0.01) {
    console.log('[Server] Projectile denied: invalid direction')
    return
  }
  const nDirX = dirX / len
  const nDirZ = dirZ / len

  const spawnPos = Vector3.create(
    playerPos.x + nDirX * 1.0,
    playerPos.y + 0.8,
    playerPos.z + nDirZ * 1.0
  )

  const projectileEntity = engine.addEntity()
  Transform.create(projectileEntity, {
    position: spawnPos,
    scale: Vector3.create(1, 1, 1),
    rotation: Quaternion.fromEulerDegrees(0, Math.atan2(nDirX, nDirZ) * (180 / Math.PI), 0)
  })
  Projectile.create(projectileEntity, {
    firedByPlayerId: playerId,
    firedAtMs: now,
    startX: spawnPos.x,
    startY: spawnPos.y,
    startZ: spawnPos.z,
    dirX: nDirX,
    dirZ: nDirZ,
    distanceTraveled: 0,
    maxDistance: chargeRange,
    active: true,
  })
  activeProjectiles.push({
    entity: projectileEntity,
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

  room.send('shellDropped', { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z, dirX: nDirX, dirZ: nDirZ, color, firedBy: playerId, chargeSpeed, chargeRange, chargeScale })
  console.log('[Server] 🎯 Projectile fired by', playerId.slice(0, 8), 'dir:', nDirX.toFixed(2), nDirZ.toFixed(2))
}

/** Server system: move projectiles forward (and return), check player hits, and handle expiry. */
export function shellServerSystem(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = activeProjectiles.length - 1; i >= 0; i--) {
    const projectile = activeProjectiles[i]

    // Safety expiry
    if (now - projectile.firedAtMs > PROJECTILE_LIFETIME_SEC * 1000) {
      console.log('[Server] 🎯 Projectile expired (timeout)')
      room.send('shellReturned', { firedBy: projectile.firedBy })
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
        room.send('shellTriggered', { x: projectilePos.x, y: projectilePos.y, z: projectilePos.z, victimId: '', peak: !projectile.hitWall, firedBy: projectile.firedBy })
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
        room.send('shellReturned', { firedBy: projectile.firedBy })
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

    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      const addr = identity.address.toLowerCase()
      if (addr === projectile.firedBy) continue

      const playerPos = getPlayerPosition(addr)
      if (!playerPos) continue

      const dist = Vector3.distance(playerPos, projectilePos)
      if (dist < PROJECTILE_HIT_RADIUS * projectile.chargeScale) {
        console.log('[Server] 🎯 Projectile hit player', addr.slice(0, 8), projectile.returning ? '(return)' : '(outbound)')

        const flag = Flag.getOrNull(flagEntity)
        if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === addr) {
          console.log('[Server] 🎯 Victim was carrying flag — forcing drop!')
          handleDrop(addr)
        }

        room.send('shellTriggered', { x: projectilePos.x, y: projectilePos.y, z: projectilePos.z, victimId: addr, firedBy: projectile.firedBy })

        if (projectile.returning) {
          room.send('shellReturned', { firedBy: projectile.firedBy })
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
        break
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
        room.send('shellTriggered', { x: projectilePos.x, y: projectilePos.y, z: projectilePos.z, victimId: '', firedBy: projectile.firedBy })
        room.send('bananaTriggered', { x: trapPos.x, y: trapPos.y, z: trapPos.z, victimId: '' })
        removeTrap(trap)
        activeTraps.splice(j, 1)

        if (projectile.returning) {
          room.send('shellReturned', { firedBy: projectile.firedBy })
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

// ── Green orbit logic ──

function handleOrbitRequest(playerId: string, startAngle: number = 0): void {
  const now = Date.now()

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
        orbit.hitPlayers.add(addr)
        console.log('[Server] 🌀 Orbit hit player', addr.slice(0, 8), '— ending orbit')

        const flag = Flag.getOrNull(flagEntity)
        if (flag && flag.state === FlagState.Carried && flag.carrierPlayerId === addr) {
          console.log('[Server] 🌀 Orbit victim was carrying flag — forcing drop!')
          handleDrop(addr)
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

export { removeTrap, removeProjectile }

// ── Cooldown map cleanup (called on player disconnect) ──

export function clearCombatCooldowns(playerId: string): void {
  lastTrapDropTime.delete(playerId)
  lastProjectileFireTime.delete(playerId)
  lastOrbitTime.delete(playerId)
}

/** Clear all combat cooldown maps (called at round end). */
export function clearAllCombatCooldowns(): void {
  lastTrapDropTime.clear()
  lastProjectileFireTime.clear()
  lastOrbitTime.clear()
}

// ── Message handler registration ──

export function registerCombatHandlers(): void {
  room.onMessage('requestBanana', (_data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      handleTrapDrop(from)
    } catch (err) { console.error('[Server] ❌ requestBanana handler error:', err) }
  })
  room.onMessage('requestShell', (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      const chargeSpeed = typeof data.chargeSpeed === 'number' ? Math.max(PROJECTILE_SPEED, Math.min(60, data.chargeSpeed)) : PROJECTILE_SPEED
      const chargeRange = typeof data.chargeRange === 'number' ? Math.max(20, Math.min(PROJECTILE_MAX_RANGE, data.chargeRange)) : 20
      const chargeScale = typeof data.chargeScale === 'number' ? Math.max(1, Math.min(3, data.chargeScale)) : 1
      sessionBoomerangsFired.set(from, (sessionBoomerangsFired.get(from) ?? 0) + 1)
      handleProjectileFire(from, data.dirX, data.dirZ, data.color || 'r', chargeSpeed, chargeRange, chargeScale)
    } catch (err) { console.error('[Server] ❌ requestShell handler error:', err) }
  })
  room.onMessage('reportShellWallDist', (data, context) => {
    try {
      if (!context) return
      const from = context.from.toLowerCase()
      for (const projectile of activeProjectiles) {
        if (projectile.firedBy === from && !projectile.wallDistReported) {
          const oldMax = projectile.maxDistance
          projectile.maxDistance = Math.min(projectile.maxDistance, data.maxDist)
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
      let closest: ActiveProjectile | null = null
      let closestDist = 5
      for (const projectile of activeProjectiles) {
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
        closest.groundY = Math.max(0, data.groundY)
      }
    } catch (err) { console.error('[Server] ❌ reportShellGroundY handler error:', err) }
  })
  room.onMessage('reportBananaGroundY', (data, context) => {
    try {
      if (!context) return
      let closest: ActiveTrap | null = null
      let closestDist = 3
      for (const trap of activeTraps) {
        const pos = Transform.get(trap.entity).position
        const dx = pos.x - data.bananaX
        const dz = pos.z - data.bananaZ
        const dist = Math.sqrt(dx * dx + dz * dz)
        if (dist < closestDist) {
          closestDist = dist
          closest = trap
        }
      }
      if (closest && !closest.groundResolved) {
        closest.targetY = Math.max(0, data.groundY)
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
    room.send('hitVfx', { x: data.x || 0, y: data.y || 0, z: data.z || 0 })
  })
  room.onMessage('reportBoost', (data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    room.send('playerBoosted', { playerId: from, tier: data.tier || 'coin', duration: data.duration || 3 })
  })
  room.onMessage('chargeStart', (data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    room.send('playerChargeStart', { playerId: from, t: data.t || 0 })
  })
  room.onMessage('chargeStop', (data, context) => {
    if (!context) return
    const from = context.from.toLowerCase()
    room.send('playerChargeStop', { playerId: from, t: data.t || 0 })
  })
}
