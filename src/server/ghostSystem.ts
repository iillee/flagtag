/**
 * ghostSystem.ts — Ghost AI, spawning, collisions, and despawning.
 *
 * Handles ghost (ghost) lifecycle: spawn at night, despawn at dawn,
 * chase nearest player, idle orbit, projectile-ghost collisions,
 * and client-reported hit validation.
 */

import { engine, Transform, PlayerIdentityData } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import {
  Ghost, GHOST_DETECT_RADIUS, GHOST_SPEED, GHOST_FAST_SPEED, GHOST_FAST_DIST, GHOST_HIT_RADIUS,
  getNextGhostSyncId, recycleGhostSyncId,
  PROJECTILE_HIT_RADIUS,
} from '../shared/components'
import { room } from '../shared/messages'
import { isNightTime, updateWorldTime } from '../shared/dayNight'
import {
  activeGhosts, ghostRespawnCooldown, setGhostRespawnCooldown, GHOST_RESPAWN_COOLDOWN,
} from './serverState'
import { activeProjectiles } from './combat'

// ── Module-local state ──
const GHOST_SPAWN_POS = Vector3.create(395, 1.25, 429) // Black cube location
let ghostSpawnTimer = 10 // first spawn after 10s
const GHOST_STAGGER_COOLDOWN_MS = 3000 // can only stagger same player every 3s
const GHOST_IDLE_ORBIT_SPEED = 0.5 // rad/s when no target

// ── Message handlers ──
export function registerGhostHandlers(): void {
  room.onMessage('ghostHit', (data, sender) => {
    // Validate: find the ghost entity, reduce HP
    for (let i = activeGhosts.length - 1; i >= 0; i--) {
      const z = activeGhosts[i]
      // Match by entity ID sent as ghostId (we use entity number)
      if ((z.entity as number) === data.ghostId) {
        z.hp--
        console.log('[Server] 🧟 Ghost hit! HP:', z.hp)
        if (z.hp <= 0) {
          // Kill ghost
          console.log('[Server] 🧟 Ghost killed!')
          room.send('ghostKilled', { x: z.posX, y: z.posY, z: z.posZ })
          engine.removeEntity(z.entity); recycleGhostSyncId(z.syncId)
          activeGhosts.splice(i, 1)
          setGhostRespawnCooldown(GHOST_RESPAWN_COOLDOWN)
        }
        break
      }
    }
  })
}

// ── Despawn all ghosts ──
export function despawnAllGhosts(): void {
  for (const z of activeGhosts) {
    Ghost.deleteFrom(z.entity)
    engine.removeEntity(z.entity); recycleGhostSyncId(z.syncId)
  }
  activeGhosts.length = 0
}

// ── Spawn a single ghost ──
function spawnGhost(): void {
  const entity = engine.addEntity()
  const pos = GHOST_SPAWN_POS
  Transform.create(entity, {
    position: Vector3.create(pos.x, pos.y, pos.z),
    scale: Vector3.create(1, 1, 1)
  })
  Ghost.create(entity, {
    hp: 2,
    spawnX: pos.x, spawnY: pos.y, spawnZ: pos.z,
    active: true,
    targetX: pos.x, targetY: pos.y, targetZ: pos.z,
  })
  // NOTE: Only sync Ghost component — NOT Transform.
  // Writing Transform every frame (~30 CRDT writes/s) saturates the CRDT buffer
  // and freezes all other synced components (scoreboard, flag state, hold time).
  // Clients interpolate toward Ghost.targetX/Y/Z which is updated at 5Hz.
  const ghostSyncId = getNextGhostSyncId()
  syncEntity(entity, [Ghost.componentId], ghostSyncId)

  activeGhosts.push({
    entity,
    syncId: ghostSyncId,
    hp: 2,
    posX: pos.x,
    posY: pos.y,
    posZ: pos.z,
    spawnedAtMs: Date.now(),
    lastStaggerTime: new Map(),
    lastHitMs: 0,
    lastCrdtSyncTime: 0,
  })
  console.log('[Server] 🧟 Ghost spawned at', pos.x, pos.y, pos.z)
}

// ── Main ghost system (called every frame) ──
export function ghostServerSystem(dt: number): void {
  const clampedDt = Math.min(dt, 0.1)
  const now = Date.now()

  // Keep world time cache fresh for night detection (no skybox on server)
  updateWorldTime(clampedDt, false)

  // ── Ghost only spawns at night ──
  if (!isNightTime()) {
    if (activeGhosts.length > 0) {
      despawnAllGhosts()
      console.log('[Server] ☀️ Dawn — despawning ghost')
    }
    ghostSpawnTimer = 5 // ready to spawn quickly when night falls
    return
  }

  // ── Spawn timer (single ghost, 30s respawn cooldown after death) ──
  if (ghostRespawnCooldown > 0) {
    setGhostRespawnCooldown(ghostRespawnCooldown - clampedDt)
  }
  if (activeGhosts.length === 0 && ghostRespawnCooldown <= 0) {
    ghostSpawnTimer -= clampedDt
    if (ghostSpawnTimer <= 0) {
      spawnGhost()
      ghostSpawnTimer = 0
    }
  }

  // ── Update each ghost ──
  for (let i = activeGhosts.length - 1; i >= 0; i--) {
    const z = activeGhosts[i]

    // Find nearest player
    let nearestDist = Infinity
    let nearestPos: Vector3 | null = null
    let nearestId = ''

    for (const [, identity, transform] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      const pPos = transform.position
      const dx = pPos.x - z.posX
      const dy = Math.abs(pPos.y - z.posY)
      const dz = pPos.z - z.posZ
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dy > 20) continue // ignore players too far above/below
      if (dist < nearestDist) {
        nearestDist = dist
        nearestPos = pPos
        nearestId = identity.address.toLowerCase()
      }
    }

    if (nearestPos && nearestDist < GHOST_DETECT_RADIUS) {
      // Move toward player
      const speed = nearestDist < GHOST_FAST_DIST ? GHOST_FAST_SPEED : GHOST_SPEED
      const dx = nearestPos.x - z.posX
      const dz = nearestPos.z - z.posZ
      const dist2d = Math.sqrt(dx * dx + dz * dz)
      if (dist2d > 0.1) {
        z.posX += (dx / dist2d) * speed * clampedDt
        z.posZ += (dz / dist2d) * speed * clampedDt
      }
      // Match target Y (float above ground at player level)
      z.posY += (nearestPos.y - z.posY) * 2.0 * clampedDt

      // Check contact → send ghostTouching (scare meter fills on client)
      if (nearestDist < GHOST_HIT_RADIUS) {
        room.send('ghostTouching', { victimId: nearestId })
      }
    } else {
      // Idle: slow orbit around spawn point
      const elapsed = (now - z.spawnedAtMs) / 1000
      const angle = elapsed * GHOST_IDLE_ORBIT_SPEED
      const orbitRadius = 3
      const targetX = GHOST_SPAWN_POS.x + Math.cos(angle) * orbitRadius
      const targetZ = GHOST_SPAWN_POS.z + Math.sin(angle) * orbitRadius
      z.posX += (targetX - z.posX) * 2.0 * clampedDt
      z.posZ += (targetZ - z.posZ) * 2.0 * clampedDt
      z.posY += (GHOST_SPAWN_POS.y - z.posY) * 2.0 * clampedDt
    }

    // Update local Transform (used for server-side collision checks only — NOT synced)
    const t = Transform.getMutable(z.entity)
    t.position = Vector3.create(z.posX, z.posY, z.posZ)

    // Throttled CRDT write (~5Hz) — update Ghost.targetX/Y/Z for client interpolation
    const GHOST_CRDT_INTERVAL_MS = 200
    if (now - z.lastCrdtSyncTime >= GHOST_CRDT_INTERVAL_MS) {
      z.lastCrdtSyncTime = now
      const zm = Ghost.getMutable(z.entity)
      zm.targetX = z.posX
      zm.targetY = z.posY
      zm.targetZ = z.posZ
    }
  }

  // ── Check projectile-ghost collisions ──
  const HIT_COOLDOWN_MS = 500 // prevent same projectile hitting multiple times per pass
  for (const proj of activeProjectiles) {
    const projPos = Transform.get(proj.entity).position
    for (let i = activeGhosts.length - 1; i >= 0; i--) {
      const z = activeGhosts[i]
      if (now - z.lastHitMs < HIT_COOLDOWN_MS) continue
      const dx = projPos.x - z.posX
      const dy = projPos.y - z.posY
      const dz = projPos.z - z.posZ
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist < PROJECTILE_HIT_RADIUS * (proj.chargeScale || 1)) {
        z.hp--
        z.lastHitMs = now
        console.log('[Server] 🧟 Projectile hit ghost! HP:', z.hp)
        room.send('hitVfx', { x: z.posX, y: z.posY + 1, z: z.posZ })
        if (z.hp <= 0) {
          console.log('[Server] 🧟 Ghost killed by projectile!')
          room.send('ghostKilled', { x: z.posX, y: z.posY, z: z.posZ })
          engine.removeEntity(z.entity); recycleGhostSyncId(z.syncId)
          activeGhosts.splice(i, 1)
          setGhostRespawnCooldown(GHOST_RESPAWN_COOLDOWN)
        }
        // Trigger boomerang return (same as hitting a player)
        if (!proj.returning) {
          proj.returning = true
          proj.returnX = projPos.x
          proj.returnY = projPos.y
          proj.returnZ = projPos.z
          room.send('shellTriggered', { x: projPos.x, y: projPos.y, z: projPos.z, victimId: '', peak: true, firedBy: proj.firedBy })
          console.log('[Server] 🧟 Projectile rebounding off ghost')
        }
        break
      }
    }
  }
}
