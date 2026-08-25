/**
 * Projectile flight — local projectiles (offline), message-driven visuals (online),
 * and wall raycasts.
 */
import {
  engine, Transform, GltfContainer, Raycast, RaycastResult, RaycastQueryType,
  PlayerIdentityData
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { getPlayer as getPlayerData } from '@dcl/sdk/players'
import {
  PROJECTILE_SPEED, PROJECTILE_LIFETIME_SEC, PROJECTILE_MAX_RANGE, PROJECTILE_HIT_RADIUS
} from '../../shared/components'
import { room } from '../../shared/messages'
import { getPlayerEntityPosition } from '../../shared/playerEntities'
import {
  localProjectiles, msgProjectileVisuals, pendingWallRays, localThrow,
  PROJECTILE_SCALE, PROJECTILE_SPIN_SPEED, PROJECTILE_CHEST_OFFSET,
  predictedHitShellIds,
  type LocalProjectile, type MsgProjectileVisual
} from './state'
import { attachProjectileSound, stopProjectileSound } from './sound'
import { showHitEffect, playHitSound } from '../combatSystem'
import { hasFlagImmunity } from '../../gameState/flagImmunityState'
import { acquireProjectileFromPool, releaseProjectileToPool } from './pool'
import { updateHandBoomerangVisibility } from './handVisual'
import { getBoomerangModelSrc } from '../../gameState/boomerangColor'
import { getPlayerForward } from './utils'

// ── Wall raycasts ──
// Raycast entities don't have GltfContainer, so create/destroy is safe
// (won't trigger the rendering bug that affects GLB models).

export function fireWallRaycast(pos: Vector3, dirX: number, dirZ: number): void {
  const rayEntity = engine.addEntity()
  Transform.create(rayEntity, { position: pos })
  Raycast.create(rayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(dirX, 0, dirZ) },
    maxDistance: PROJECTILE_MAX_RANGE,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false
  })
  pendingWallRays.push({ entity: rayEntity })
}

export function processWallRaycasts(): void {
  for (let i = pendingWallRays.length - 1; i >= 0; i--) {
    const ray = pendingWallRays[i]
    const result = RaycastResult.getOrNull(ray.entity)
    if (result) {
      if (result.hits.length > 0) {
        const hitDist = result.hits[0].length
        room.send('reportShellWallDist', { shellId: 0, maxDist: hitDist })
      }
      engine.removeEntity(ray.entity)
      pendingWallRays.splice(i, 1)
    }
  }
}

// ── Local projectiles (offline mode) ──

export function fireProjectileLocally(speed: number = PROJECTILE_SPEED, maxDist: number = 20): void {
  if (!Transform.has(engine.PlayerEntity)) return
  const playerPos = Transform.get(engine.PlayerEntity).position
  const { dirX, dirZ } = getPlayerForward()

  const spawnPos = Vector3.create(
    playerPos.x + dirX * 1.0,
    playerPos.y + 0.8,
    playerPos.z + dirZ * 1.0
  )

  const shellEntity = engine.addEntity()
  Transform.create(shellEntity, {
    position: spawnPos,
    scale: PROJECTILE_SCALE,
    rotation: Quaternion.fromEulerDegrees(0, Math.atan2(dirX, dirZ) * (180 / Math.PI), 0)
  })
  GltfContainer.create(shellEntity, {
    src: getBoomerangModelSrc(),
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0
  })

  const wallRayEntity = engine.addEntity()
  Transform.create(wallRayEntity, { position: spawnPos })
  Raycast.create(wallRayEntity, {
    direction: { $case: 'globalDirection', globalDirection: Vector3.create(dirX, 0, dirZ) },
    maxDistance: maxDist,
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false
  })

  attachProjectileSound(shellEntity)

  localProjectiles.push({
    entity: shellEntity,
    firedAtMs: Date.now(),
    startX: spawnPos.x, startY: spawnPos.y, startZ: spawnPos.z,
    dirX, dirZ,
    distanceTraveled: 0, maxDistance: maxDist, speed,
    wallRayEntity,
    currentY: spawnPos.y, fallVelocity: 0, groundY: 0, onGround: false,
    groundRayEntity: null, lastGroundRayTime: 0,
    spinAngle: 0, returning: false, returnDistance: 0,
  })
  console.log('[Projectile] 🎯 LOCAL projectile fired dir:', dirX.toFixed(2), dirZ.toFixed(2), 'speed:', speed, 'range:', maxDist)
  updateHandBoomerangVisibility()
}

function removeLocalProjectile(index: number): void {
  const projectile = localProjectiles[index]
  stopProjectileSound(projectile.entity)
  if (projectile.wallRayEntity !== null) engine.removeEntity(projectile.wallRayEntity)
  if (projectile.groundRayEntity !== null) engine.removeEntity(projectile.groundRayEntity)
  engine.removeEntity(projectile.entity)
  localProjectiles.splice(index, 1)
  if (localProjectiles.length === 0) {
    localThrow.active = false
  }
  updateHandBoomerangVisibility()
}

export function updateLocalProjectiles(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = localProjectiles.length - 1; i >= 0; i--) {
    const projectile = localProjectiles[i]

    // Check wall raycast result
    if (projectile.wallRayEntity !== null) {
      const result = RaycastResult.getOrNull(projectile.wallRayEntity)
      if (result) {
        if (result.hits.length > 0) {
          projectile.maxDistance = Math.min(projectile.maxDistance, result.hits[0].length)
        }
        engine.removeEntity(projectile.wallRayEntity)
        projectile.wallRayEntity = null
      }
    }

    if (now - projectile.firedAtMs > PROJECTILE_LIFETIME_SEC * 1000) {
      console.log('[Projectile] 🎯 LOCAL projectile expired')
      removeLocalProjectile(i)
      continue
    }

    const moveDistance = projectile.speed * clampedDt
    if (!projectile.returning) {
      projectile.distanceTraveled += moveDistance
      if (projectile.distanceTraveled >= projectile.maxDistance) {
        projectile.returning = true
        projectile.returnDistance = 0
        console.log('[Projectile] 🎯 LOCAL projectile reached max range, returning')
      }
    }

    projectile.spinAngle += PROJECTILE_SPIN_SPEED * clampedDt

    if (!projectile.returning) {
      const headingDeg = Math.atan2(projectile.dirX, projectile.dirZ) * (180 / Math.PI)
      const newX = projectile.startX + projectile.dirX * projectile.distanceTraveled
      const newZ = projectile.startZ + projectile.dirZ * projectile.distanceTraveled
      const t = Transform.getMutable(projectile.entity)
      t.position = Vector3.create(newX, projectile.startY, newZ)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + projectile.spinAngle, 0)
    } else {
      const shellPos = Transform.get(projectile.entity).position
      const rawPlayerPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : Vector3.create(projectile.startX, projectile.startY, projectile.startZ)
      const playerPos = Vector3.create(rawPlayerPos.x, rawPlayerPos.y + PROJECTILE_CHEST_OFFSET, rawPlayerPos.z)
      const dx = playerPos.x - shellPos.x
      const dy = playerPos.y - shellPos.y
      const dz = playerPos.z - shellPos.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

      if (dist < 2.0) {
        console.log('[Projectile] 🎯 LOCAL projectile returned to player')
        removeLocalProjectile(i)
        continue
      }

      const nx = dx / dist, ny = dy / dist, nz = dz / dist
      const headingDeg = Math.atan2(nx, nz) * (180 / Math.PI)
      const t = Transform.getMutable(projectile.entity)
      t.position = Vector3.create(shellPos.x + nx * moveDistance, shellPos.y + ny * moveDistance, shellPos.z + nz * moveDistance)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + projectile.spinAngle, 0)
    }
  }
}

// ── Message-driven visuals (online mode) ──

/**
 * Look up a remote player's position by wallet address (case-insensitive).
 *
 * Was a first-match scan, which under a duplicate avatar entity resolved to the corpse every
 * time (see shared/playerEntityResolution.ts) — so projectile visuals flew to a frozen position
 * while the server's hit detection tracked the live one.
 */
function getRemotePlayerPosition(userId: string): Vector3 | null {
  return getPlayerEntityPosition(userId)
}

export function createMsgProjectileVisual(x: number, y: number, z: number, dirX: number, dirZ: number, color?: string, firedBy?: string, chargeSpeed?: number, chargeRange?: number, chargeScale?: number, shellId?: number): void {
  const validColors = ['r', 'y', 'b', 'g']
  const c = (color && validColors.includes(color)) ? color : 'r'
  const localEntity = acquireProjectileFromPool(c)
  if (!localEntity) return

  const scaleMult = (chargeScale && chargeScale > 0) ? chargeScale : 1
  const t = Transform.getMutable(localEntity)
  t.position = Vector3.create(x, y, z)
  t.scale = Vector3.create(PROJECTILE_SCALE.x * scaleMult, PROJECTILE_SCALE.y * scaleMult, PROJECTILE_SCALE.z * scaleMult)
  t.rotation = Quaternion.fromEulerDegrees(0, Math.atan2(dirX, dirZ) * (180 / Math.PI), 0)

  attachProjectileSound(localEntity)

  msgProjectileVisuals.push({
    entity: localEntity,
    shellId: shellId || 0,
    firedBy: firedBy?.toLowerCase() || '',
    startX: x, startY: y, startZ: z,
    dirX, dirZ,
    createdAtMs: Date.now(),
    distanceTraveled: 0,
    maxDistance: (chargeRange && chargeRange > 0) ? chargeRange : PROJECTILE_MAX_RANGE,
    speed: (chargeSpeed && chargeSpeed > 0) ? chargeSpeed : PROJECTILE_SPEED,
    currentY: y, fallVelocity: 0, groundY: 0, onGround: false,
    groundRayEntity: null, lastGroundRayTime: 0,
    spinAngle: 0, returning: false, returnDistance: 0,
  })
  console.log('[Projectile] 🎯 Created message-driven projectile visual at:', x.toFixed(1), y.toFixed(1), z.toFixed(1), 'speed:', ((chargeSpeed && chargeSpeed > 0) ? chargeSpeed : PROJECTILE_SPEED))
}

export function removeMsgProjectileVisualByThrower(firedBy: string, x: number, y: number, z: number, isPeak: boolean = false, shellId: number = 0): void {
  const throwerId = (firedBy || '').toLowerCase()
  let closestIdx = -1

  // Prefer exact shellId match
  if (shellId > 0) {
    for (let i = 0; i < msgProjectileVisuals.length; i++) {
      if (msgProjectileVisuals[i].shellId === shellId) { closestIdx = i; break }
    }
    // If shellId provided but not found, visual was already removed — don't fall through
    if (closestIdx === -1) return
  }

  // Legacy fallback: only for messages without shellId
  if (closestIdx === -1 && shellId === 0) {
    let closestDist = Infinity
    for (let i = 0; i < msgProjectileVisuals.length; i++) {
      const vis = msgProjectileVisuals[i]
      if (throwerId && vis.firedBy !== throwerId) continue
      const pos = Transform.get(vis.entity).position
      const dx = pos.x - x, dy = pos.y - y, dz = pos.z - z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist < closestDist) { closestDist = dist; closestIdx = i }
    }
    if (closestIdx === -1 && throwerId) {
      for (let i = 0; i < msgProjectileVisuals.length; i++) {
        const vis = msgProjectileVisuals[i]
        const pos = Transform.get(vis.entity).position
        const dx = pos.x - x, dy = pos.y - y, dz = pos.z - z
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (dist < closestDist) { closestDist = dist; closestIdx = i }
      }
    }
  }
  if (closestIdx === -1) return

  const vis = msgProjectileVisuals[closestIdx]
  if (vis.returning) {
    if (isPeak) {
      console.log('[Projectile] 🎯 Peak message arrived but already returning — ignoring')
      return
    }
    if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
    releaseProjectileToPool(vis.entity)
    msgProjectileVisuals.splice(closestIdx, 1)
  } else {
    vis.returning = true
    vis.returnDistance = 0
  }
}

export function updateMsgProjectileVisuals(dt: number): void {
  const now = Date.now()
  const clampedDt = Math.min(dt, 0.1)

  for (let i = msgProjectileVisuals.length - 1; i >= 0; i--) {
    const vis = msgProjectileVisuals[i]

    if (now - vis.createdAtMs > PROJECTILE_LIFETIME_SEC * 1000) {
      if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
      releaseProjectileToPool(vis.entity)
      msgProjectileVisuals.splice(i, 1)
      continue
    }

    const moveDist = vis.speed * clampedDt
    if (!vis.returning) {
      vis.distanceTraveled += moveDist
      if (vis.distanceTraveled >= vis.maxDistance) {
        vis.returning = true
        vis.returnDistance = 0
      }
    }

    vis.spinAngle += PROJECTILE_SPIN_SPEED * clampedDt

    if (!vis.returning) {
      const headingDeg = Math.atan2(vis.dirX, vis.dirZ) * (180 / Math.PI)
      const t = Transform.getMutable(vis.entity)
      t.position = Vector3.create(vis.startX + vis.dirX * vis.distanceTraveled, vis.startY, vis.startZ + vis.dirZ * vis.distanceTraveled)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + vis.spinAngle, 0)
    } else {
      const shellPos = Transform.get(vis.entity).position
      const localUserId = getPlayerData()?.userId?.toLowerCase() || ''
      const isLocalThrower = vis.firedBy === localUserId || vis.firedBy === ''

      let targetPos: Vector3
      if (isLocalThrower) {
        const rawPlayerPos = Transform.has(engine.PlayerEntity) ? Transform.get(engine.PlayerEntity).position : Vector3.create(vis.startX, vis.startY, vis.startZ)
        targetPos = Vector3.create(rawPlayerPos.x, rawPlayerPos.y + PROJECTILE_CHEST_OFFSET, rawPlayerPos.z)
      } else {
        const remotePos = getRemotePlayerPosition(vis.firedBy)
        if (remotePos) {
          targetPos = Vector3.create(remotePos.x, remotePos.y + PROJECTILE_CHEST_OFFSET, remotePos.z)
        } else {
          targetPos = Vector3.create(vis.startX, vis.startY + PROJECTILE_CHEST_OFFSET, vis.startZ)
        }
      }

      const dx = targetPos.x - shellPos.x
      const dy = targetPos.y - shellPos.y
      const dz = targetPos.z - shellPos.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

      if (dist < 2.0) {
        if (vis.groundRayEntity !== null) engine.removeEntity(vis.groundRayEntity)
        releaseProjectileToPool(vis.entity)
        msgProjectileVisuals.splice(i, 1)
        continue
      }

      const nx = dx / dist, ny = dy / dist, nz = dz / dist
      const headingDeg = Math.atan2(nx, nz) * (180 / Math.PI)
      const t = Transform.getMutable(vis.entity)
      t.position = Vector3.create(shellPos.x + nx * moveDist, shellPos.y + ny * moveDist, shellPos.z + nz * moveDist)
      t.rotation = Quaternion.fromEulerDegrees(0, headingDeg + vis.spinAngle, 0)
    }

    // ── Client-side hit prediction ──
    // If this is OUR projectile, check proximity to other players for instant feedback.
    // The server still validates — we just show VFX immediately.
    const localUserId = getPlayerData()?.userId?.toLowerCase() || ''
    if (vis.firedBy === localUserId && !vis.returning) {
      const shellPos = Transform.get(vis.entity).position
      for (const [, identity, transform] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
        const addr = identity.address.toLowerCase()
        if (addr === localUserId) continue
        // Skip flag-immune carriers — the server ignores the hit for them, so
        // producing hit VFX/sound + starting the return here would be a false positive.
        if (hasFlagImmunity(addr)) continue
        const playerDist = Vector3.distance(shellPos, transform.position)
        if (playerDist < PROJECTILE_HIT_RADIUS) {
          // Predict hit: show VFX immediately
          showHitEffect(shellPos)
          playHitSound(shellPos)
          if (vis.shellId > 0) predictedHitShellIds.add(vis.shellId)
          console.log('[Projectile] 🎯 Client hit prediction on', addr.slice(0, 8))
          // Start returning — server will confirm and send shellTriggered
          vis.returning = true
          vis.returnDistance = 0
          break
        }
      }
    }
  }
}
