/**
 * zombieSystem.ts — Ghost AI, spawning, and collisions.
 *
 * Handles zombie (ghost) lifecycle: spawn at night, despawn at dawn,
 * chase nearest player, idle orbit, projectile-zombie collisions,
 * and client-reported hit validation.
 */

import { engine, Transform, PlayerIdentityData } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import {
  Zombie, ZOMBIE_DETECT_RADIUS, ZOMBIE_SPEED, ZOMBIE_FAST_SPEED, ZOMBIE_FAST_DIST, ZOMBIE_HIT_RADIUS,
  getNextZombieSyncId, recycleZombieSyncId,
  PROJECTILE_HIT_RADIUS,
} from '../shared/components'
import { room } from '../shared/messages'
import { isNightTime, updateWorldTime } from '../shared/dayNight'
import {
  activeZombies, zombieRespawnCooldown, setZombieRespawnCooldown, ZOMBIE_RESPAWN_COOLDOWN,
} from './serverState'
import { activeProjectiles } from './combat'

// ── Module-local state ──
const ZOMBIE_SPAWN_POS = Vector3.create(225, 1.25, 287) // Black cube location
let zombieSpawnTimer = 10 // first spawn after 10s
const ZOMBIE_STAGGER_COOLDOWN_MS = 3000 // can only stagger same player every 3s
const ZOMBIE_IDLE_ORBIT_SPEED = 0.5 // rad/s when no target

// ── Message handlers ──
export function registerZombieHandlers(): void {
  room.onMessage('zombieHit', (data, sender) => {
    // Validate: find the zombie entity, reduce HP
    for (let i = activeZombies.length - 1; i >= 0; i--) {
      const z = activeZombies[i]
      // Match by entity ID sent as zombieId (we use entity number)
      if ((z.entity as number) === data.zombieId) {
        z.hp--
        console.log('[Server] 🧟 Zombie hit! HP:', z.hp)
        if (z.hp <= 0) {
          // Kill zombie
          console.log('[Server] 🧟 Zombie killed!')
          room.send('zombieKilled', { x: z.posX, y: z.posY, z: z.posZ })
          engine.removeEntity(z.entity); recycleZombieSyncId(z.syncId)
          activeZombies.splice(i, 1)
          setZombieRespawnCooldown(ZOMBIE_RESPAWN_COOLDOWN)
        }
        break
      }
    }
  })
}

// ── Despawn all zombies ──
export function despawnAllZombies(): void {
  for (const z of activeZombies) {
    Zombie.deleteFrom(z.entity)
    engine.removeEntity(z.entity); recycleZombieSyncId(z.syncId)
  }
  activeZombies.length = 0
}

// ── Spawn a single zombie ──
function spawnZombie(): void {
  const entity = engine.addEntity()
  const pos = ZOMBIE_SPAWN_POS
  Transform.create(entity, {
    position: Vector3.create(pos.x, pos.y, pos.z),
    scale: Vector3.create(1, 1, 1)
  })
  Zombie.create(entity, {
    hp: 2,
    spawnX: pos.x, spawnY: pos.y, spawnZ: pos.z,
    active: true,
    targetX: pos.x, targetY: pos.y, targetZ: pos.z,
  })
  // NOTE: Only sync Zombie component — NOT Transform.
  // Writing Transform every frame (~30 CRDT writes/s) saturates the CRDT buffer
  // and freezes all other synced components (scoreboard, flag state, hold time).
  // Clients interpolate toward Zombie.targetX/Y/Z which is updated at 5Hz.
  const zombieSyncId = getNextZombieSyncId()
  syncEntity(entity, [Zombie.componentId], zombieSyncId)

  activeZombies.push({
    entity,
    syncId: zombieSyncId,
    hp: 2,
    posX: pos.x,
    posY: pos.y,
    posZ: pos.z,
    spawnedAtMs: Date.now(),
    lastStaggerTime: new Map(),
    lastHitMs: 0,
    lastCrdtSyncTime: 0,
  })
  console.log('[Server] 🧟 Zombie spawned at', pos.x, pos.y, pos.z)
}

// ── Main zombie system (called every frame) ──
export function zombieServerSystem(dt: number): void {
  const clampedDt = Math.min(dt, 0.1)
  const now = Date.now()

  // Keep world time cache fresh for night detection
  updateWorldTime()

  // ── Ghost only spawns at night ──
  if (!isNightTime()) {
    if (activeZombies.length > 0) {
      despawnAllZombies()
      console.log('[Server] ☀️ Dawn — despawning ghost')
    }
    zombieSpawnTimer = 5 // ready to spawn quickly when night falls
    return
  }

  // ── Spawn timer (single ghost, 30s respawn cooldown after death) ──
  if (zombieRespawnCooldown > 0) {
    setZombieRespawnCooldown(zombieRespawnCooldown - clampedDt)
  }
  if (activeZombies.length === 0 && zombieRespawnCooldown <= 0) {
    zombieSpawnTimer -= clampedDt
    if (zombieSpawnTimer <= 0) {
      spawnZombie()
      zombieSpawnTimer = 0
    }
  }

  // ── Update each zombie ──
  for (let i = activeZombies.length - 1; i >= 0; i--) {
    const z = activeZombies[i]

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

    if (nearestPos && nearestDist < ZOMBIE_DETECT_RADIUS) {
      // Move toward player
      const speed = nearestDist < ZOMBIE_FAST_DIST ? ZOMBIE_FAST_SPEED : ZOMBIE_SPEED
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
      if (nearestDist < ZOMBIE_HIT_RADIUS) {
        room.send('ghostTouching', { victimId: nearestId })
      }
    } else {
      // Idle: slow orbit around spawn point
      const elapsed = (now - z.spawnedAtMs) / 1000
      const angle = elapsed * ZOMBIE_IDLE_ORBIT_SPEED
      const orbitRadius = 3
      const targetX = ZOMBIE_SPAWN_POS.x + Math.cos(angle) * orbitRadius
      const targetZ = ZOMBIE_SPAWN_POS.z + Math.sin(angle) * orbitRadius
      z.posX += (targetX - z.posX) * 2.0 * clampedDt
      z.posZ += (targetZ - z.posZ) * 2.0 * clampedDt
      z.posY += (ZOMBIE_SPAWN_POS.y - z.posY) * 2.0 * clampedDt
    }

    // Update local Transform (used for server-side collision checks only — NOT synced)
    const t = Transform.getMutable(z.entity)
    t.position = Vector3.create(z.posX, z.posY, z.posZ)

    // Throttled CRDT write (~5Hz) — update Zombie.targetX/Y/Z for client interpolation
    const ZOMBIE_CRDT_INTERVAL_MS = 200
    if (now - z.lastCrdtSyncTime >= ZOMBIE_CRDT_INTERVAL_MS) {
      z.lastCrdtSyncTime = now
      const zm = Zombie.getMutable(z.entity)
      zm.targetX = z.posX
      zm.targetY = z.posY
      zm.targetZ = z.posZ
    }
  }

  // ── Check projectile-zombie collisions ──
  const HIT_COOLDOWN_MS = 500 // prevent same projectile hitting multiple times per pass
  for (const proj of activeProjectiles) {
    const projPos = Transform.get(proj.entity).position
    for (let i = activeZombies.length - 1; i >= 0; i--) {
      const z = activeZombies[i]
      if (now - z.lastHitMs < HIT_COOLDOWN_MS) continue
      const dx = projPos.x - z.posX
      const dy = projPos.y - z.posY
      const dz = projPos.z - z.posZ
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist < PROJECTILE_HIT_RADIUS * (proj.chargeScale || 1)) {
        z.hp--
        z.lastHitMs = now
        console.log('[Server] 🧟 Projectile hit zombie! HP:', z.hp)
        room.send('hitVfx', { x: z.posX, y: z.posY + 1, z: z.posZ })
        if (z.hp <= 0) {
          console.log('[Server] 🧟 Zombie killed by projectile!')
          room.send('zombieKilled', { x: z.posX, y: z.posY, z: z.posZ })
          engine.removeEntity(z.entity); recycleZombieSyncId(z.syncId)
          activeZombies.splice(i, 1)
          setZombieRespawnCooldown(ZOMBIE_RESPAWN_COOLDOWN)
        }
        // Trigger boomerang return (same as hitting a player)
        if (!proj.returning) {
          proj.returning = true
          proj.returnX = projPos.x
          proj.returnY = projPos.y
          proj.returnZ = projPos.z
          room.send('shellTriggered', { x: projPos.x, y: projPos.y, z: projPos.z, victimId: '', peak: true, firedBy: proj.firedBy })
          console.log('[Server] 🧟 Projectile rebounding off zombie')
        }
        break
      }
    }
  }
}
