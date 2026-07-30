/**
 * ghostSystem.ts — Ghost AI, spawning, collisions, and despawning.
 *
 * Handles ghost (ghost) lifecycle: spawn at night, despawn at dawn,
 * chase nearest player, idle orbit, projectile-ghost collisions,
 * and client-reported hit validation.
 */

import { engine, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import {
  Ghost, GHOST_DETECT_RADIUS, GHOST_SPEED, GHOST_FAST_SPEED, GHOST_FAST_DIST, GHOST_HIT_RADIUS,
  getNextGhostSyncId, recycleGhostSyncId,
  PROJECTILE_HIT_RADIUS,
} from '../shared/components'
import { room } from '../shared/messages'
import { isNightTime, updateWorldTime, getCurrentSkyTime } from '../shared/dayNight'
import { serializeGhostHeartbeat, type GhostHeartbeatEntry } from '../shared/ghostHeartbeat'
import {
  shouldSendGhostTouching,
  GHOST_TOUCHING_SEND_INTERVAL_MS,
} from '../shared/ghostContactState'
import {
  activeGhosts, ghostRespawnCooldown, setGhostRespawnCooldown, GHOST_RESPAWN_COOLDOWN,
  getPlayerPosition, getActivePlayerAddresses,
} from './serverState'
import { type GhostTargetCandidate, findNearestGhostTarget } from './ghostTargeting'
import { activeProjectiles } from './combat'

// ── Module-local state ──
const GHOST_SPAWN_POS = Vector3.create(347, 49.25, 381) // Black cube location
let ghostSpawnTimer = 10 // first spawn after 10s
const GHOST_STAGGER_COOLDOWN_MS = 3000 // can only stagger same player every 3s
const GHOST_IDLE_ORBIT_SPEED = 0.5 // rad/s when no target
// Fallback-visual heartbeat cadence. 500ms is fast enough that a fallback ghost
// moves smoothly (client lerps between updates) and slow enough that it costs
// far less than the CRDT stream this backstops — typical payload is one entry.
const GHOST_HEARTBEAT_INTERVAL_MS = 500
let lastGhostHeartbeatMs = 0
// DIAG (day-night-spawn-unreliable bug): characterize whether the server's
// getWorldTime() clock actually advances on the headless realm. If this logs a
// stuck value across playtests, isNightTime() is the root cause of "ghost
// rarely spawns" and we file a separate fix; if it advances normally, the
// complaint is a UX issue with the 24-minute cycle length. Throttled to 30s.
const DAYNIGHT_DIAG_INTERVAL_MS = 30_000
let lastDayNightDiagMs = 0

// ── ghostTouching throttle state ──
// Per-victim last-sent timestamp. Server ticks at ~30 Hz; without throttling
// this fires every tick to ALL clients while a ghost is in contact. Throttled
// to ~5 Hz per victim (see GHOST_TOUCHING_SEND_INTERVAL_MS). Client holds the
// "being touched" state for a window longer than this interval so one dropped
// message doesn't visibly drain the scare meter. See
// docs/CRDT_SATURATION_REDUCTION.md and src/shared/ghostContactState.ts.
const lastGhostTouchingSentMs = new Map<string, number>()
// Diagnostic counters — logged every 30s so we can characterize the
// send/throttle ratio during playtest and confirm the reduction landed.
let ghostTouchingSentCount = 0
let ghostTouchingThrottledCount = 0
const GHOST_TOUCHING_DIAG_INTERVAL_MS = 30_000
let lastGhostTouchingDiagMs = 0

// ── Message handlers ──
export function registerGhostHandlers(): void {
  // (Removed the client-trusted `ghostHit` handler: no client ever sent it — ghost damage
  // is resolved by authoritative server-side boomerang/ghost collision — and accepting it
  // let any client kill any ghost from across the map by guessing entity ids.)
}

// ── Despawn all ghosts ──
export function despawnAllGhosts(): void {
  const hadGhosts = activeGhosts.length > 0
  for (const z of activeGhosts) {
    Ghost.deleteFrom(z.entity)
    engine.removeEntity(z.entity); recycleGhostSyncId(z.syncId)
  }
  activeGhosts.length = 0
  // Same reasoning as the projectile-kill path: without an explicit empty
  // heartbeat the last one stays fresh and a fallback flashes at dawn.
  if (hadGhosts) {
    room.send('ghostHeartbeat', { ghostsJson: serializeGhostHeartbeat([]) })
    lastGhostHeartbeatMs = Date.now()
  }
}

// Backoff after a syncEntity failure so we don't retry every frame (~30Hz)
// and flood the log stream with identical stack traces. See spawnGhost().
const GHOST_SPAWN_FAILURE_BACKOFF_S = 5

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
  try {
    syncEntity(entity, [Ghost.componentId], ghostSyncId)
  } catch (err) {
    // `syncEntity failed because the id provided is already in use` — the SDK
    // still considers this ID claimed (CRDT tombstone from the previous ghost
    // that used this slot hasn't cleared). Without this guard the outer
    // system-level try/catch just logs and we retry every frame, producing
    // ~30 identical stacks/s that drown the log stream (playtest 2026-07-29).
    // Clean up the orphan entity, drop the tainted ID (do NOT recycle — it
    // clearly isn't ready for reuse), and back off so night-time isn't a
    // permanent error firehose.
    console.error('[Server] 🧟 spawnGhost failed (id=', ghostSyncId, '), backing off', GHOST_SPAWN_FAILURE_BACKOFF_S, 's:', err)
    Ghost.deleteFrom(entity)
    engine.removeEntity(entity)
    setGhostRespawnCooldown(GHOST_SPAWN_FAILURE_BACKOFF_S)
    return
  }

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
  // Candidate positions once per tick, from trusted heartbeat-preferred reads:
  // ghostTouching fills the victim's scare meter, so targeting off the raw CRDT
  // Transform would phantom-hit cross-wired players just like traps did
  // (BUG_stale-crdt-transform-in-combat.md). Selection itself is pure and tested
  // (ghostTargeting.ts).
  const targetCandidates: GhostTargetCandidate[] = []
  if (activeGhosts.length > 0) {
    for (const addr of getActivePlayerAddresses()) {
      const pPos = getPlayerPosition(addr)
      if (!pPos) continue
      targetCandidates.push({ addr, x: pPos.x, y: pPos.y, z: pPos.z })
    }
  }
  for (let i = activeGhosts.length - 1; i >= 0; i--) {
    const z = activeGhosts[i]

    // Find nearest player (XZ distance, ±20m vertical band)
    const nearest = findNearestGhostTarget(targetCandidates, z.posX, z.posY, z.posZ)

    if (nearest && nearest.distXZ < GHOST_DETECT_RADIUS) {
      // Move toward player
      const speed = nearest.distXZ < GHOST_FAST_DIST ? GHOST_FAST_SPEED : GHOST_SPEED
      const dx = nearest.x - z.posX
      const dz = nearest.z - z.posZ
      const dist2d = Math.sqrt(dx * dx + dz * dz)
      if (dist2d > 0.1) {
        z.posX += (dx / dist2d) * speed * clampedDt
        z.posZ += (dz / dist2d) * speed * clampedDt
      }
      // Match target Y (float above ground at player level)
      z.posY += (nearest.y - z.posY) * 2.0 * clampedDt

      // Check contact → send ghostTouching (scare meter fills on client).
      // Throttled to ~5 Hz per victim to stay within the room msg/s budget;
      // the client holds the touched state between messages so the 3-second
      // scare meter still fills smoothly. See ghostContactState.ts.
      if (nearest.distXZ < GHOST_HIT_RADIUS) {
        const lastSent = lastGhostTouchingSentMs.get(nearest.addr)
        if (shouldSendGhostTouching(now, lastSent, GHOST_TOUCHING_SEND_INTERVAL_MS)) {
          room.send('ghostTouching', { victimId: nearest.addr })
          lastGhostTouchingSentMs.set(nearest.addr, now)
          ghostTouchingSentCount++
        } else {
          ghostTouchingThrottledCount++
        }
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

  // ── ghostTouching throttle diagnostic ──
  // Logs how many ghostTouching messages we actually sent vs. suppressed
  // over the last 30s window. Under normal contact the throttled count
  // should dominate (30 Hz raw → 5 Hz sent = 25 suppressed for every 5 sent).
  // If sent >> throttled, the throttle isn't engaging as expected.
  if (now - lastGhostTouchingDiagMs >= GHOST_TOUCHING_DIAG_INTERVAL_MS) {
    lastGhostTouchingDiagMs = now
    if (ghostTouchingSentCount > 0 || ghostTouchingThrottledCount > 0) {
      console.log('[Server] 👻 ghostTouching diag (30s): sent=', ghostTouchingSentCount,
        '| throttled=', ghostTouchingThrottledCount,
        '| activeVictims=', lastGhostTouchingSentMs.size)
    }
    ghostTouchingSentCount = 0
    ghostTouchingThrottledCount = 0
    // Prune per-victim entries that haven't been touched in a while so this
    // map doesn't grow unbounded with visitor churn. 10s is well past the
    // throttle window and any realistic contact episode.
    for (const [addr, ts] of lastGhostTouchingSentMs) {
      if (now - ts > 10_000) lastGhostTouchingSentMs.delete(addr)
    }
  }

  // ── Day/night clock diagnostic (see DAYNIGHT_DIAG_INTERVAL_MS) ──
  if (now - lastDayNightDiagMs >= DAYNIGHT_DIAG_INTERVAL_MS) {
    lastDayNightDiagMs = now
    console.log('[Server] 🌓 day/night diag: worldSeconds=', getCurrentSkyTime().toFixed(0),
      '| isNight=', isNightTime(),
      '| activeGhosts=', activeGhosts.length)
  }

  // ── Fallback-visual heartbeat (server → all clients, ~2Hz) ──
  // Independent of the CRDT `Ghost` component so a client whose CRDT sync
  // dropped the ghost entity can still render a visual. Send only while at
  // least one ghost is alive; empty payloads would just be noise (a client
  // with no fallback visual has nothing to reconcile).
  if (activeGhosts.length > 0 && now - lastGhostHeartbeatMs >= GHOST_HEARTBEAT_INTERVAL_MS) {
    lastGhostHeartbeatMs = now
    const entries: GhostHeartbeatEntry[] = []
    for (const z of activeGhosts) {
      entries.push({ id: z.syncId, x: z.posX, y: z.posY, z: z.posZ })
    }
    room.send('ghostHeartbeat', { ghostsJson: serializeGhostHeartbeat(entries) })
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
          // Immediate empty heartbeat: without this, the last non-empty heartbeat
          // stays "fresh" for GHOST_HEARTBEAT_STALE_MS and pops up a fallback
          // visual the moment the CRDT sink animation completes and clientGhosts
          // empties (playtest report: "ghost glb flashes above for a split second"
          // on death). Also resets our own throttle so the next tick's regular
          // heartbeat isn't suppressed.
          room.send('ghostHeartbeat', { ghostsJson: serializeGhostHeartbeat([]) })
          lastGhostHeartbeatMs = now
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
